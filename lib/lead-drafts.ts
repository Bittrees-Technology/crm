import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { membership, lockActiveAccount } from "./service";
import { accessIds } from "./access";
import { HttpError, recordSchema } from "./model";
import {
  candidateSchema,
  publicUrl,
  leadDescription,
  validateCandidates,
  briefSchema,
} from "./lead-model";
const field = z.string().trim().max(200).default("");
export const draftEntrySchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["people", "organizations"]),
  name: z.string().trim().min(1).max(200),
  category: field,
  email: z.union([z.email(), z.literal("")]).default(""),
  title: field,
  website: z.union([publicUrl, z.literal("")]).default(""),
  organizationId: z.union([z.uuid(), z.literal("")]).default(""),
  description: z.string().trim().max(500).default(""),
});
export type DraftEntry = z.infer<typeof draftEntrySchema>;
function enabled() {
  if (process.env.CRM_LEADS_ENABLED !== "true")
    throw new HttpError(404, "Not found.");
}
export async function listDrafts(user: string) {
  enabled();
  return transaction(async (db) => {
    await lockActiveAccount(db, user);
    return (
      await db.query(
        "SELECT id,name,version,shared_search_id,jsonb_array_length(entries) AS count,updated_at FROM lead_drafts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100",
        [user],
      )
    ).rows;
  });
}
export async function getDraft(user: string, id: string) {
  enabled();
  z.uuid().parse(id);
  return transaction(async (db) => {
    await lockActiveAccount(db, user);
    const row = (
      await db.query(
        "SELECT id,name,entries,version,shared_search_id FROM lead_drafts WHERE id=$1 AND user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Private list not found.");
    return row;
  });
}
export async function saveDraft(user: string, raw: unknown) {
  enabled();
  const input = z
    .strictObject({
      id: z.uuid(),
      name: z.string().trim().min(1).max(200),
      version: z.number().int().min(0),
      entries: z.array(draftEntrySchema).max(20),
    })
    .parse(raw);
  if (new Set(input.entries.map((e) => e.id)).size !== input.entries.length)
    throw new HttpError(400, "Each entry needs a distinct ID.");
  for (const e of input.entries)
    if (
      e.organizationId &&
      (e.kind !== "people" ||
        !input.entries.some(
          (o) => o.id === e.organizationId && o.kind === "organizations",
        ))
    )
      throw new HttpError(
        400,
        "Choose an organization in this list, or leave the link empty.",
      );
  return transaction(async (db) => {
    // Serialize creation/retries per account, including a duplicate first save.
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
    await lockActiveAccount(db, user);
    const prior = (
      await db.query("SELECT * FROM lead_drafts WHERE id=$1 FOR UPDATE", [
        input.id,
      ])
    ).rows[0];
    if (prior && prior.user_id !== user)
      throw new HttpError(404, "Private list not found.");
    if (prior?.shared_search_id)
      throw new HttpError(
        409,
        "This list was submitted and cannot be edited. Start a new list.",
      );
    if (
      prior &&
      prior.version === input.version + 1 &&
      prior.name === input.name &&
      JSON.stringify(z.array(draftEntrySchema).parse(prior.entries)) ===
        JSON.stringify(input.entries)
    )
      return { id: prior.id, version: prior.version };
    if ((prior?.version || 0) !== input.version)
      throw new HttpError(
        409,
        "This list changed in another tab. Reload it before saving.",
      );
    if (
      !prior &&
      (
        await db.query(
          "SELECT count(*)::int AS count FROM lead_drafts WHERE user_id=$1",
          [user],
        )
      ).rows[0].count >= 100
    )
      throw new HttpError(
        409,
        "You have reached 100 lists. Remove an unused private list first.",
      );
    const row = (
      await db.query(
        "INSERT INTO lead_drafts(id,user_id,name,entries) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,entries=EXCLUDED.entries,version=lead_drafts.version+1,updated_at=now() RETURNING id,version",
        [input.id, user, input.name, JSON.stringify(input.entries)],
      )
    ).rows[0];
    return row;
  });
}
export async function deleteDraft(user: string, raw: unknown) {
  enabled();
  const input = z
    .strictObject({ id: z.uuid(), version: z.number().int().positive() })
    .parse(raw);
  return transaction(async (db) => {
    await lockActiveAccount(db, user);
    const deleted = await db.query(
      "DELETE FROM lead_drafts WHERE id=$1 AND user_id=$2 AND version=$3",
      [input.id, user, input.version],
    );
    if (!deleted.rowCount)
      throw new HttpError(
        409,
        "This list changed or is unavailable. Reload before removing it.",
      );
    return { ok: true };
  });
}
export async function shareTargets(user: string) {
  enabled();
  return transaction(async (db) => {
    await lockActiveAccount(db, user);
    const workspaces = (
      await db.query(
        "SELECT w.id,w.name FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.id LIMIT 100",
        [user],
      )
    ).rows;
    const targets = [];
    for (const w of workspaces) {
      await membership(w.id, user, false, false, db);
      const ids = await accessIds(db, user, w.id);
      const projects = (
        await db.query(
          "SELECT id,data->>'name' AS name FROM records WHERE workspace_id=$1 AND kind='projects' AND archived_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY data->>'name' LIMIT 100",
          [w.id, ids],
        )
      ).rows;
      if (projects.length)
        targets.push({
          ...w,
          projects,
          owners: (
            await db.query(
              "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.role='owner' AND u.merged_into IS NULL ORDER BY u.id",
              [w.id],
            )
          ).rows,
        });
    }
    return targets;
  });
}
export async function shareDraft(user: string, raw: unknown) {
  enabled();
  const input = z
    .strictObject({
      id: z.uuid(),
      version: z.number().int().positive(),
      workspaceId: z.uuid(),
      projectId: z.uuid(),
      ownerId: z.uuid(),
    })
    .parse(raw);
  return transaction(async (db) => {
    await membership(input.workspaceId, input.ownerId, true, true, db);
    await membership(input.workspaceId, user, false, false, db);
    const ids = await accessIds(db, user, input.workspaceId);
    const project = (
      await db.query(
        "SELECT id FROM records WHERE workspace_id=$1 AND id=$2 AND kind='projects' AND archived_at IS NULL",
        [input.workspaceId, input.projectId],
      )
    ).rows[0];
    if (!project || (ids !== null && !ids.includes(input.projectId)))
      throw new HttpError(403, "Choose an active project you can access.");
    const draft = (
      await db.query(
        "SELECT * FROM lead_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [input.id, user],
      )
    ).rows[0];
    if (!draft) throw new HttpError(404, "Private list not found.");
    if (draft.version !== input.version)
      throw new HttpError(
        409,
        "The list changed. Reload and review it before sharing.",
      );
    if (draft.shared_search_id) {
      const receipt = (
        await db.query(
          "SELECT s.workspace_id,s.project_id,s.user_id,p.id FROM lead_searches s JOIN lead_previews p ON p.search_id=s.id WHERE s.id=$1",
          [draft.shared_search_id],
        )
      ).rows[0];
      if (
        !receipt ||
        receipt.workspace_id !== input.workspaceId ||
        receipt.project_id !== input.projectId ||
        receipt.user_id !== input.ownerId
      )
        throw new HttpError(409, "This list has already been shared.");
      return { reviewId: receipt.id };
    }
    const entries = z
      .array(draftEntrySchema)
      .min(1)
      .max(20)
      .parse(draft.entries);
    const candidates = entries.map((e) =>
      candidateSchema.parse({
        researchMethod: "manual",
        kind: e.kind,
        name: e.name,
        category: e.category,
        title: e.title,
        email: e.email,
        website: e.website,
        summary: e.description || "Added by the researcher.",
        relevance: "Submitted for owner review.",
        uncertainties: "Not independently verified.",
        fit: "medium",
        evidence: "unconfirmed",
        sources: [],
        ...(e.organizationId
          ? {
              organizationIndex: entries.findIndex(
                (o) => o.id === e.organizationId,
              ),
            }
          : {}),
      }),
    );
    try {
      validateCandidates(
        briefSchema.parse({
          target: draft.name,
          sourceDomains: ["bittrees.org"],
        }),
        candidates,
      );
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    candidates.forEach((c) =>
      recordSchema.parse({ name: c.name, description: leadDescription(c) }),
    );
    const searchId = randomUUID(),
      reviewId = randomUUID();
    await db.query(
      "INSERT INTO lead_searches(id,user_id,workspace_id,researcher_id,project_id,brief,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days')",
      [
        searchId,
        input.ownerId,
        input.workspaceId,
        user,
        input.projectId,
        JSON.stringify({ target: draft.name, method: "manual" }),
      ],
    );
    await db.query(
      "INSERT INTO lead_previews(id,search_id,operation_id,payload_hash,candidates) VALUES($1,$2,$3,$4,$5)",
      [
        reviewId,
        searchId,
        randomUUID(),
        createHash("sha256").update(JSON.stringify(candidates)).digest("hex"),
        JSON.stringify(candidates),
      ],
    );
    await db.query(
      "UPDATE lead_drafts SET shared_search_id=$2,updated_at=now() WHERE id=$1",
      [draft.id, searchId],
    );
    return { reviewId };
  });
}
