import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { researchSchema } from "./dataset-model";
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
  kind: z.enum(["people", "organizations", "projects"]),
  name: z.string().trim().min(1).max(200),
  category: field,
  source: field,
  email: z.union([z.email(), z.literal("")]).default(""),
  title: field,
  website: z.union([publicUrl, z.literal("")]).default(""),
  organizationId: z.union([z.uuid(), z.literal("")]).default(""),
  description: z.string().trim().max(500).default(""),
  research: researchSchema.optional(),
});
export type DraftEntry = z.infer<typeof draftEntrySchema>;
export const draftPatchSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  changes: z.array(draftEntrySchema),
  removeIds: z.array(z.uuid()).default([]),
  entryOrder: z.array(z.uuid()).optional(),
});
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
        "SELECT d.id,d.name,d.version,d.shared_search_id,jsonb_array_length(d.entries) AS count,d.updated_at,CASE WHEN d.shared_search_id IS NULL THEN 'private' WHEN s.id IS NULL THEN 'unavailable' WHEN p.decision IS NOT NULL THEN 'reviewed' WHEN s.revoked_at IS NOT NULL THEN 'withdrawn' WHEN s.expires_at <= now() THEN 'expired' ELSE 'awaiting_review' END AS status FROM lead_drafts d LEFT JOIN lead_searches s ON s.id=d.shared_search_id LEFT JOIN lead_previews p ON p.search_id=s.id WHERE d.user_id=$1 ORDER BY d.updated_at DESC",
        [user],
      )
    ).rows;
  });
}
export async function getDraft(user: string, id: string, page?: unknown) {
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
    if (page !== undefined) {
      const a = z
        .strictObject({
          offset: z.number().int().nonnegative(),
          pageSize: z.number().int().min(1).max(100),
          version: z.number().int().positive().optional(),
        })
        .parse(page);
      if (a.version !== undefined && a.version !== row.version)
        throw new HttpError(
          409,
          "The list changed while loading. Read it again.",
        );
      const totalEntries = row.entries.length;
      return {
        ...row,
        entries: row.entries.slice(a.offset, a.offset + a.pageSize),
        pagination: {
          totalEntries,
          nextOffset:
            a.offset + a.pageSize < totalEntries ? a.offset + a.pageSize : null,
        },
      };
    }
    return row;
  });
}
export async function saveDraft(user: string, raw: unknown) {
  if (raw && typeof raw === "object" && "changes" in raw)
    return transaction((db) => patchDraftInTransaction(db, user, raw));
  if (raw && typeof raw === "object" && "copyFrom" in raw)
    return transaction(async (db) => {
      const a = z
        .strictObject({
          id: z.uuid(),
          name: z.string().trim().min(1).max(200),
          version: z.literal(0),
          copyFrom: z.uuid(),
          copyVersion: z.number().int().positive(),
        })
        .parse(raw);
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
      await lockActiveAccount(db, user);
      const source = (
        await db.query(
          "SELECT entries,version FROM lead_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [a.copyFrom, user],
        )
      ).rows[0];
      if (!source) throw new HttpError(404, "Private list not found.");
      if (source.version !== a.copyVersion)
        throw new HttpError(409, "The list changed. Reload before copying.");
      return saveDraftInTransaction(db, user, {
        id: a.id,
        name: a.name,
        version: 0,
        entries: source.entries,
      });
    });
  return transaction((db) => saveDraftInTransaction(db, user, raw));
}
export async function patchDraftInTransaction(
  db: PoolClient,
  user: string,
  raw: unknown,
) {
  enabled();
  const a = draftPatchSchema.parse(raw);
  await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
  await lockActiveAccount(db, user);
  const prior = (
    await db.query(
      "SELECT * FROM lead_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [a.id, user],
    )
  ).rows[0];
  if (!prior) throw new HttpError(404, "Private list not found.");
  const changes = new Map(a.changes.map((e) => [e.id, e])),
    removed = new Set(a.removeIds);
  if (
    changes.size !== a.changes.length ||
    removed.size !== a.removeIds.length ||
    a.removeIds.some((id) => changes.has(id))
  )
    throw new HttpError(400, "Choose distinct entry changes and removals.");
  const existing = new Set<string>(prior.entries.map((e: DraftEntry) => e.id));
  let entries = prior.entries
    .filter((e: DraftEntry) => !removed.has(e.id))
    .map((e: DraftEntry) => changes.get(e.id) || e);
  entries = entries.concat(a.changes.filter((e) => !existing.has(e.id)));
  if (a.entryOrder) {
    const byId = new Map(entries.map((e: DraftEntry) => [e.id, e]));
    if (
      a.entryOrder.length !== entries.length ||
      new Set(a.entryOrder).size !== entries.length ||
      a.entryOrder.some((id) => !byId.has(id))
    )
      throw new HttpError(
        400,
        "Entry order must include every resulting entry exactly once.",
      );
    entries = a.entryOrder.map((id) => byId.get(id)!);
  }
  return saveDraftInTransaction(db, user, {
    id: a.id,
    version: a.version,
    name: a.name,
    entries,
  });
}
export async function saveDraftInTransaction(
  db: PoolClient,
  user: string,
  raw: unknown,
) {
  enabled();
  const input = z
    .strictObject({
      id: z.uuid(),
      name: z.string().trim().min(1).max(200),
      version: z.number().int().min(0),
      entries: z.array(draftEntrySchema),
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
  {
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
    // Editing content invalidates a prior human training decision.
    for (const e of input.entries) {
      const old = prior?.entries.find((x: any) => x.id === e.id);
      if (
        old?.research?.training === "eligible" &&
        e.research?.training === "eligible"
      ) {
        const normalized = draftEntrySchema.parse(old);
        if (JSON.stringify(normalized) !== JSON.stringify(e))
          e.research.training = "pending";
      }
    }
    const row = (
      await db.query(
        "INSERT INTO lead_drafts(id,user_id,name,entries) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,entries=EXCLUDED.entries,version=lead_drafts.version+1,updated_at=now() RETURNING id,version",
        [input.id, user, input.name, JSON.stringify(input.entries)],
      )
    ).rows[0];
    await db.query(
      "DELETE FROM dataset_record_links WHERE draft_id=$1 AND NOT(entry_id=ANY($2::uuid[]))",
      [input.id, input.entries.map((e) => e.id)],
    );
    return row;
  }
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
        "SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.id LIMIT 100",
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
      if (projects.length || w.role === "owner")
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
  return transaction((db) => shareDraftInTransaction(db, user, raw));
}
export async function shareDraftInTransaction(
  db: PoolClient,
  user: string,
  raw: unknown,
) {
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
  {
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
    const entries = z.array(draftEntrySchema).min(1).parse(draft.entries);
    if (entries.some((e) => e.kind === "projects"))
      throw new HttpError(
        400,
        "Review project imports separately; submit only people and organizations here.",
      );
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
        relevance: e.research?.relevance || "Submitted for owner review.",
        uncertainties:
          e.research?.uncertainties || "Not independently verified.",
        fit: "medium",
        evidence: "unconfirmed",
        sources:
          e.research?.sources.map(({ url, retrievedAt }) => ({
            url,
            retrievedAt,
          })) || [],
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
        {
          ...briefSchema.parse({
            target: draft.name,
            sourceDomains: ["bittrees.org"],
            maxResults: entries.length,
            freshnessDays: 365,
          }),
          sourceDomains: [
            ...new Set(
              entries.flatMap(
                (e) =>
                  e.research?.sources.map((s) => new URL(s.url).hostname) || [],
              ),
            ),
          ],
        },
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
  }
}
