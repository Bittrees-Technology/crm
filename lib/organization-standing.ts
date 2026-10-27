import { createHmac } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { membership } from "./service";
import { HttpError } from "./model";
import { standingUploadSchema } from "./organization-standing-model";

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
const key = (name: string) => name.trim().normalize("NFKC").toLowerCase();
function host(raw: string) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
export async function reviewOrganizationStanding(
  userId: string,
  workspace: string,
  input: unknown,
) {
  const body = z
    .strictObject({
      upload: standingUploadSchema,
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .parse(input);
  const names = body.upload.rows.map((r) => key(r.name));
  if (new Set(names).size !== names.length)
    throw new HttpError(400, "Each organization must appear once.");
  return transaction(async (db) => {
    await membership(workspace, userId, true, true, db);
    const existing = (
      await db.query(
        "SELECT id,data,version FROM records WHERE workspace_id=$1 AND kind='organizations' AND archived_at IS NULL ORDER BY id FOR UPDATE",
        [workspace],
      )
    ).rows;
    const matches = body.upload.rows.map((row) => {
      const candidates = existing.filter(
        (r) => key(r.data.name) === key(row.name),
      );
      if (candidates.length !== 1)
        throw new HttpError(
          409,
          `Cannot uniquely match ${row.name}. No rankings were changed.`,
        );
      const record = candidates[0];
      if (host(row.website) !== host(record.data.website || ""))
        throw new HttpError(
          409,
          `Website differs for ${row.name}. Reconcile its identity before applying. No rankings were changed.`,
        );
      return {
        id: record.id as string,
        name: record.data.name as string,
        version: record.version as number,
        before: record.data.organizationStanding ?? null,
        after: row.assessment,
      };
    });
    const changes = matches.filter((m) => !same(m.before, m.after));
    const digest = createHmac("sha256", process.env.AUTH_SECRET!)
      .update(JSON.stringify(canonical({ userId, workspace, matches })))
      .digest("hex");
    if (!body.digest)
      return {
        digest,
        matched: matches.length,
        changed: changes.length,
        rows: matches.map((m) => ({
          id: m.id,
          name: m.name,
          version: m.version,
          before: m.before,
          after: m.after,
        })),
      };
    if (!changes.length)
      return { matched: matches.length, updated: 0, unchanged: matches.length };
    if (body.digest !== digest)
      throw new HttpError(
        409,
        "Records or assessments changed after preview. Review them again before applying.",
      );
    const payload = changes.map((m) => ({ id: m.id, assessment: m.after }));
    const saved = await db.query(
      `UPDATE records r SET data=jsonb_set(r.data,'{organizationStanding}',v.assessment),version=r.version+1,updated_at=now() FROM jsonb_to_recordset($2::jsonb) AS v(id uuid,assessment jsonb) WHERE r.workspace_id=$1 AND r.id=v.id RETURNING r.id`,
      [workspace, JSON.stringify(payload)],
    );
    await db.query(
      `INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) SELECT $1,$2,'Organization standing reviewed',v.id,v.detail FROM jsonb_to_recordset($3::jsonb) AS v(id uuid,detail jsonb)`,
      [
        workspace,
        userId,
        JSON.stringify(
          changes.map((m) => ({
            id: m.id,
            detail: {
              kind: "organizations",
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
