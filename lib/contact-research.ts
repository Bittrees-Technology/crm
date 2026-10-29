import { createHmac } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { membership } from "./service";
import { HttpError, recordSchema } from "./model";
import {
  contactKey,
  contactUploadSchema,
  type PublicContact,
} from "./contact-research-model";
function canonical(value: any): any {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export async function reviewPeopleContacts(
  userId: string,
  workspace: string,
  input: unknown,
) {
  const body = z
    .strictObject({
      upload: contactUploadSchema,
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .parse(input);
  const ids = body.upload.rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length)
    throw new HttpError(400, "Each person must appear once.");
  return transaction(async (db) => {
    await membership(workspace, userId, true, true, db);
    const existing = (
      await db.query(
        "SELECT id,data,version FROM records WHERE workspace_id=$1 AND kind='people' AND archived_at IS NULL AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
        [workspace, ids],
      )
    ).rows;
    const matches = body.upload.rows.map((row) => {
      const record = existing.find((r) => r.id === row.id);
      if (
        !record ||
        record.data.name !== row.name ||
        (record.data.organizationId || "") !== row.expected.organizationId
      )
        throw new HttpError(
          409,
          `Identity differs for ${row.name}. Reconcile the record before applying. No contacts were changed.`,
        );
      const before = {
        email: record.data.email || "",
        website: record.data.website || "",
        description: record.data.description || "",
        organizationId: record.data.organizationId || "",
      };
      const known = new Map<string, PublicContact>(
        (record.data.publicContacts || []).map((c: PublicContact) => [
          contactKey(c),
          c,
        ]),
      );
      const additions = row.contacts.filter((c) => !known.has(contactKey(c)));
      if (additions.length && !same(before, row.expected))
        throw new HttpError(
          409,
          `Current contact or context differs for ${row.name}. Review a fresh file. No contacts were changed.`,
        );
      const email = additions.filter((c) => c.kind === "email");
      if (
        new Set(email.map(contactKey)).size > 1 ||
        email.some(
          (c) =>
            before.email &&
            before.email.toLowerCase() !== c.value.toLowerCase(),
        )
      )
        throw new HttpError(
          409,
          `Conflicting personal email for ${row.name}. No contacts were changed.`,
        );
      for (const c of additions) known.set(contactKey(c), c);
      const publicContacts = [...known.values()];
      const website = !before.website
        ? additions.find((c) => c.kind === "LinkedIn")?.value || ""
        : before.website;
      const after = {
        email: before.email || email[0]?.value || "",
        website,
        publicContacts,
      };
      recordSchema.parse({ ...record.data, ...after });
      return {
        id: row.id,
        name: row.name,
        version: record.version,
        before: {
          email: before.email,
          website: before.website,
          publicContacts: record.data.publicContacts || [],
        },
        after,
        changed: additions.length > 0,
      };
    });
    const changes = matches.filter((m) => m.changed);
    const digest = createHmac("sha256", process.env.AUTH_SECRET!)
      .update(
        JSON.stringify(
          canonical({ userId, workspace, upload: body.upload, matches }),
        ),
      )
      .digest("hex");
    if (!body.digest)
      return {
        digest,
        matched: matches.length,
        changed: changes.length,
        rows: matches,
      };
    if (!changes.length)
      return { matched: matches.length, updated: 0, unchanged: matches.length };
    if (body.digest !== digest)
      throw new HttpError(
        409,
        "Records or contact evidence changed after preview. Review them again before applying.",
      );
    const saved = await db.query(
      "UPDATE records r SET data=r.data||v.patch,version=r.version+1,updated_at=now() FROM jsonb_to_recordset($2::jsonb) AS v(id uuid,patch jsonb) WHERE r.workspace_id=$1 AND r.id=v.id RETURNING r.id",
      [
        workspace,
        JSON.stringify(changes.map((m) => ({ id: m.id, patch: m.after }))),
      ],
    );
    await db.query(
      "INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) SELECT $1,$2,'Public contact research reviewed',v.id,v.detail FROM jsonb_to_recordset($3::jsonb) AS v(id uuid,detail jsonb)",
      [
        workspace,
        userId,
        JSON.stringify(
          changes.map((m) => ({
            id: m.id,
            detail: {
              kind: "people",
              name: m.name,
              version: m.version + 1,
              before: m.before,
              after: m.after,
            },
          })),
        ),
      ],
    );
    return {
      matched: matches.length,
      updated: saved.rowCount,
      unchanged: matches.length - changes.length,
    };
  });
}
