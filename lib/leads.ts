import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { hash, token } from "./auth";
import { membership } from "./service";
function requireLeadsEnabled() {
  if (process.env.CRM_LEADS_ENABLED !== "true")
    throw new HttpError(404, "Not found.");
}
import { recordSchema, HttpError } from "./model";
import {
  briefSchema,
  candidateSchema,
  validateCandidates,
  domain,
  leadDescription,
  type Candidate,
} from "./lead-model";
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
async function search(db: PoolClient, user: string | null, credential: string) {
  const column = user ? "id" : "token_hash";
  if (user) z.uuid().parse(credential);
  else if (!/^[a-f0-9]{64}$/.test(credential))
    throw new HttpError(401, "Lead connection required.");
  const found = (
    await db.query(`SELECT * FROM lead_searches WHERE ${column}=$1`, [
      user ? credential : hash(credential),
    ])
  ).rows[0];
  if (!found || (user && found.user_id !== user))
    throw new HttpError(404, "Lead search unavailable.");
  // Same lock ordering as CRM mutations; initial pilot requires a current owner.
  await membership(found.workspace_id, found.user_id, true, true, db);
  const current = (
    await db.query("SELECT * FROM lead_searches WHERE id=$1 FOR UPDATE", [
      found.id,
    ])
  ).rows[0];
  if (
    !current ||
    current.revoked_at ||
    new Date(current.expires_at).getTime() <= Date.now()
  )
    throw new HttpError(401, "Lead search expired or revoked.");
  return current;
}
export async function createSearch(user: string, raw: unknown) {
  requireLeadsEnabled();
  const input = z
    .strictObject({ workspaceId: z.uuid(), brief: briefSchema })
    .parse(raw);
  return transaction(async (db) => {
    await membership(input.workspaceId, user, true, true, db);
    const id = randomUUID(),
      bearer = token();
    const row = (
      await db.query(
        "INSERT INTO lead_searches(id,user_id,workspace_id,brief,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day') RETURNING id,expires_at",
        [id, user, input.workspaceId, input.brief, hash(bearer)],
      )
    ).rows[0];
    return { ...row, token: bearer };
  });
}
export async function listSearches(user: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    const rows = (
      await db.query(
        "SELECT s.id,s.workspace_id,s.brief,s.expires_at,s.revoked_at,p.id AS preview_id,p.decision,p.record_ids FROM lead_searches s JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id LEFT JOIN lead_previews p ON p.search_id=s.id WHERE s.user_id=$1 AND m.role='owner' ORDER BY s.created_at DESC LIMIT 50",
        [user],
      )
    ).rows;
    return rows;
  });
}
export async function revokeSearch(user: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    // Revocation remains available if ownership or feature availability changed.
    await db.query(
      "UPDATE lead_searches SET revoked_at=COALESCE(revoked_at,now()),token_hash=NULL WHERE id=$1 AND user_id=$2",
      [id, user],
    );
    return { ok: true };
  });
}
async function duplicates(
  db: PoolClient,
  workspace: string,
  candidates: Candidate[],
) {
  // Owner-only scope: bounded organization projection, never descriptions or private notes.
  const rows = (
    await db.query(
      "SELECT id,data->>'name' AS name,data->>'website' AS website,data->>'communication' AS communication FROM records WHERE workspace_id=$1 AND kind='organizations' AND (lower(trim(data->>'name'))=ANY($2::text[]) OR regexp_replace(substring(lower(data->>'website') from '^https?://([^/:?#]+)'), '^www\\.', '')=ANY($3::text[])) LIMIT 201",
      [
        workspace,
        candidates.map((c) => c.name.toLowerCase()),
        candidates.map((c) => domain(c.website)),
      ],
    )
  ).rows;
  if (rows.length > 200)
    throw new HttpError(409, "Too many potential matches. Narrow the search.");
  return candidates.map((c) =>
    rows
      .filter(
        (r) =>
          r.name?.trim().toLowerCase() === c.name.toLowerCase() ||
          (() => {
            try {
              return domain(r.website) === domain(c.website);
            } catch {
              return false;
            }
          })(),
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        doNotContact: r.communication === "Do not contact",
      })),
  );
}
export async function agentBrief(bearer: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    const s = await search(db, null, bearer);
    return {
      brief: s.brief,
      expiresAt: s.expires_at,
      instructions:
        "Research public organizations only. Use the permitted domains and source retrieval times. Do not send private CRM information to research providers. Source claims remain unverified. Submit one batch; the user reviews and imports in CRM. No outreach is authorized.",
    };
  });
}
export async function prepare(bearer: string, raw: unknown) {
  requireLeadsEnabled();
  const input = z
    .strictObject({
      operationId: z.uuid(),
      candidates: z.array(candidateSchema).min(1).max(20),
    })
    .parse(raw);
  return transaction(async (db) => {
    const s = await search(db, null, bearer);
    const prior = (
      await db.query(
        "SELECT id,operation_id,payload_hash FROM lead_previews WHERE search_id=$1",
        [s.id],
      )
    ).rows[0];
    const fingerprint = digest(input);
    if (prior) {
      if (
        prior.operation_id !== input.operationId ||
        prior.payload_hash !== fingerprint
      )
        throw new HttpError(
          409,
          "This search already has a preview. Start a new search to change the batch.",
        );
      return {
        reviewId: prior.id,
        reviewPath: "/connect/ai/leads?review=" + prior.id,
      };
    }
    try {
      validateCandidates(briefSchema.parse(s.brief), input.candidates);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    input.candidates.forEach((c) =>
      recordSchema.parse({
        name: c.name,
        website: c.website,
        description: leadDescription(c),
      }),
    );
    const id = randomUUID();
    await db.query(
      "INSERT INTO lead_previews(id,search_id,operation_id,payload_hash,candidates) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        s.id,
        input.operationId,
        fingerprint,
        JSON.stringify(input.candidates),
      ],
    );
    return { reviewId: id, reviewPath: "/connect/ai/leads?review=" + id };
  });
}
async function inspect(db: PoolClient, user: string, id: string) {
  z.uuid().parse(id);
  const p = (
    await db.query(
      "SELECT p.* FROM lead_previews p JOIN lead_searches s ON s.id=p.search_id WHERE p.id=$1 AND s.user_id=$2",
      [id, user],
    )
  ).rows[0];
  if (!p) throw new HttpError(404, "Preview unavailable.");
  const s = await search(db, user, p.search_id);
  const candidates = z.array(candidateSchema).parse(p.candidates);
  const matches = await duplicates(db, s.workspace_id, candidates);
  const owners = (
    await db.query(
      "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.role='owner' ORDER BY u.id",
      [s.workspace_id],
    )
  ).rows;
  const reviewDigest = digest({ id, hash: p.payload_hash, matches, owners });
  return { p, s, candidates, matches, reviewDigest, owners };
}
export async function review(user: string, id: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    const { p, s, candidates, matches, reviewDigest, owners } = await inspect(
      db,
      user,
      id,
    );
    const workspace = (
      await db.query("SELECT name FROM workspaces WHERE id=$1", [
        s.workspace_id,
      ])
    ).rows[0];
    return {
      id,
      workspace: workspace.name,
      brief: s.brief,
      candidates,
      matches,
      digest: reviewDigest,
      decision: p.decision,
      audience:
        "Workspace owners only: " + owners.map((o) => o.name).join(", "),
      expiresAt: s.expires_at,
    };
  });
}
export async function approve(user: string, raw: unknown) {
  requireLeadsEnabled();
  const input = z
    .strictObject({
      reviewId: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      accept: z.array(z.number().int().min(0).max(19)).max(20),
      reason: z
        .enum(["not_relevant", "insufficient_evidence", "duplicate", "other"])
        .default("other"),
    })
    .parse(raw);
  if (new Set(input.accept).size !== input.accept.length)
    throw new HttpError(400, "Select distinct candidates.");
  input.accept.sort((a, b) => a - b);
  return transaction(async (db) => {
    const { p, s, candidates, matches, reviewDigest, owners } = await inspect(
      db,
      user,
      input.reviewId,
    );
    if (p.decision) {
      if (JSON.stringify(p.decision.accept) !== JSON.stringify(input.accept))
        throw new HttpError(409, "This preview has already been decided.");
      return {
        ok: true,
        recordIds: p.record_ids,
        accepted: input.accept.length,
      };
    }
    if (input.digest !== reviewDigest)
      throw new HttpError(
        409,
        "Potential duplicates changed or the owner audience changed. Reload and review again.",
      );
    if (input.accept.some((i) => !candidates[i] || matches[i].length))
      throw new HttpError(
        409,
        "Resolve potential matches before importing. Matching candidates cannot be imported here.",
      );
    const ids: string[] = [];
    for (const i of input.accept) {
      const c = candidates[i],
        id = randomUUID();
      const data = recordSchema.parse({
        name: c.name,
        website: c.website,
        description: leadDescription(c),
        source: "AI research",
        communication: "Unknown",
        ownerId: user,
      });
      await db.query(
        "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,'organizations',$3,'{}'::uuid[])",
        [id, s.workspace_id, data],
      );
      await db.query(
        "INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) VALUES($1,$2,'Lead imported',$3,$4)",
        [s.workspace_id, user, id, JSON.stringify({ reviewId: p.id })],
      );
      ids.push(id);
    }
    await db.query(
      "UPDATE lead_previews SET decision=$2,record_ids=$3 WHERE id=$1",
      [
        p.id,
        JSON.stringify({
          accept: input.accept,
          rejected: candidates.length - input.accept.length,
          reason: input.reason,
        }),
        ids,
      ],
    );
    return { ok: true, recordIds: ids, accepted: ids.length };
  });
}
