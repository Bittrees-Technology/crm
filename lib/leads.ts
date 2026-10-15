import { checkWorkflowAuthority } from "./workflow-authority";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { hash, token } from "./auth";
import { accessIds } from "./access";
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
  if (
    !found ||
    (user && found.user_id !== user && found.researcher_id !== user)
  )
    throw new HttpError(404, "Lead search unavailable.");
  // Serialize assignment checks and publication with workspace permission changes.
  await membership(found.workspace_id, found.user_id, true, true, db);
  const current = (
    await db.query("SELECT * FROM lead_searches WHERE id=$1 FOR UPDATE", [
      found.id,
    ])
  ).rows[0];
  if (
    !current ||
    current.revoked_at ||
    (!user && current.token_hash !== hash(credential)) ||
    (!(
      current.standing &&
      current.authority_managed &&
      current.expires_at === null
    ) &&
      new Date(current.expires_at).getTime() <= Date.now())
  )
    throw new HttpError(401, "Lead search expired or revoked.");
  await checkAssignment(db, current);
  if (!user && current.authority_managed)
    await checkWorkflowAuthority(credential, "crm", "propose");
  return current;
}
async function checkAssignment(db: PoolClient, s: any) {
  const researcher = s.researcher_id || s.user_id;
  await membership(s.workspace_id, researcher, false, false, db);
  const owner = (
    await db.query(
      "SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.role='owner' AND u.merged_into IS NULL",
      [s.workspace_id, s.user_id],
    )
  ).rowCount;
  if (!owner)
    throw new HttpError(
      403,
      "The assigning owner no longer has authority in this workspace.",
    );
  if (researcher !== s.user_id && !s.project_id)
    throw new HttpError(403, "Research assignments require a project.");
  if (s.project_id) {
    const project = (
      await db.query(
        "SELECT id FROM records WHERE id=$1 AND workspace_id=$2 AND kind='projects' AND archived_at IS NULL",
        [s.project_id, s.workspace_id],
      )
    ).rows[0];
    const ids = await accessIds(db, researcher, s.workspace_id);
    if (!project || (ids !== null && !ids.includes(project.id)))
      throw new HttpError(
        403,
        "Researcher no longer has access to the active project.",
      );
  }
}
export async function assignmentOptions(user: string, workspace: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    await membership(workspace, user, false, true, db);
    return {
      projects: (
        await db.query(
          "SELECT id,data->>'name' AS name FROM records WHERE workspace_id=$1 AND kind='projects' AND archived_at IS NULL ORDER BY data->>'name' LIMIT 500",
          [workspace],
        )
      ).rows,
      members: (
        await db.query(
          "SELECT u.id,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name",
          [workspace],
        )
      ).rows,
    };
  });
}
export async function connectSearch(user: string, id: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    const s = await search(db, user, id);
    if ((s.researcher_id || s.user_id) !== user)
      throw new HttpError(
        403,
        "Only the assigned researcher can connect an agent.",
      );
    if (s.brief.method === "manual")
      throw new HttpError(
        400,
        "This is a manually submitted list, not an agent assignment.",
      );
    if (s.authority_managed)
      throw new HttpError(
        403,
        "Managed connections must be rotated by the workflow operator.",
      );
    const bearer = token();
    await db.query("UPDATE lead_searches SET token_hash=$2 WHERE id=$1", [
      id,
      hash(bearer),
    ]);
    return { token: bearer };
  });
}
export async function createSearch(user: string, raw: unknown) {
  requireLeadsEnabled();
  const input = z
    .strictObject({
      workspaceId: z.uuid(),
      brief: briefSchema,
      researcherId: z.uuid().optional(),
      projectId: z.uuid().optional(),
    })
    .parse(raw);
  return transaction(async (db) => {
    await membership(input.workspaceId, user, true, true, db);
    const researcher = input.researcherId || user;
    await checkAssignment(db, {
      workspace_id: input.workspaceId,
      user_id: user,
      researcher_id: researcher,
      project_id: input.projectId,
    });
    const id = randomUUID(),
      bearer = token();
    const row = (
      await db.query(
        "INSERT INTO lead_searches(id,user_id,workspace_id,brief,token_hash,expires_at,researcher_id,project_id) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6,$7) RETURNING id,expires_at",
        [
          id,
          user,
          input.workspaceId,
          input.brief,
          researcher === user ? hash(bearer) : null,
          researcher,
          input.projectId || null,
        ],
      )
    ).rows[0];
    return { ...row, token: researcher === user ? bearer : "" };
  });
}
export async function listSearches(user: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    const rows = (
      await db.query(
        "SELECT s.id,s.user_id,s.researcher_id,s.project_id,s.workspace_id,s.brief,s.expires_at,s.standing,s.authority_managed,s.revoked_at,p.id AS preview_id,p.decision,p.record_ids FROM lead_searches s JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id LEFT JOIN lead_previews p ON p.search_id=s.id WHERE (s.user_id=$1 OR s.researcher_id=$1) AND m.role='owner' ORDER BY s.created_at DESC LIMIT 50",
        [user],
      )
    ).rows;
    const allowed = [];
    const checked = new Set<string>();
    for (const row of rows) {
      try {
        const key = [
          row.workspace_id,
          row.researcher_id || row.user_id,
          row.project_id || "",
        ].join(":");
        if (!checked.has(key)) {
          await checkAssignment(db, row);
          checked.add(key);
        }
        allowed.push({
          ...row,
          record_ids: row.user_id === user ? row.record_ids : undefined,
          decision:
            row.user_id === user
              ? row.decision
              : row.decision
                ? {
                    rejected: row.decision.rejected,
                    accepted: row.record_ids?.length || 0,
                  }
                : null,
          canApprove: row.user_id === user,
          canConnect:
            !row.authority_managed &&
            row.brief.method !== "manual" &&
            (row.researcher_id || row.user_id) === user,
        });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (row.user_id === user)
          allowed.push({
            ...row,
            blocked: true,
            canApprove: true,
            canConnect: false,
          });
      }
    }
    return allowed;
  });
}
export async function revokeSearch(user: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    // Revocation remains available if ownership or feature availability changed.
    await db.query(
      "UPDATE lead_searches SET revoked_at=COALESCE(revoked_at,now()),token_hash=NULL WHERE id=$1 AND (user_id=$2 OR researcher_id=$2)",
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
      "SELECT id,kind,version,archived_at,data->>'email' AS email,data->>'name' AS name,data->>'website' AS website,data->>'communication' AS communication FROM records WHERE workspace_id=$1 AND kind IN ('organizations','people','tasks') AND (lower(trim(data->>'name'))=ANY($2::text[]) OR (kind='organizations' AND regexp_replace(substring(lower(data->>'website') from '^https?://([^/:?#]+)'), '^www\\.', '')=ANY($3::text[])) OR lower(data->>'email')=ANY($4::text[])) ORDER BY id LIMIT 201",
      [
        workspace,
        candidates.map((c) => c.name.toLowerCase()),
        candidates.map((c) => domain(c.website)),
        candidates.map((c) => c.email.toLowerCase()).filter(Boolean),
      ],
    )
  ).rows;
  if (rows.length > 200)
    throw new HttpError(409, "Too many potential matches. Narrow the search.");
  return candidates.map((c) =>
    rows
      .filter(
        (r) =>
          r.kind === c.kind &&
          (r.name?.trim().toLowerCase() === c.name.toLowerCase() ||
            (() => {
              try {
                return c.kind === "organizations"
                  ? !!c.website &&
                      !!r.website &&
                      domain(r.website) === domain(c.website)
                  : !!c.email &&
                      c.email.toLowerCase() === r.email?.toLowerCase();
              } catch {
                return false;
              }
            })()),
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        archived: !!r.archived_at,
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
      projectId: s.project_id,
      expiresAt: s.expires_at,
      instructions:
        "Research public organizations and business contacts matching the approved brief. Tasks are permitted only when brief.allowTasks is true. Link tasks with contactIndex and/or organizationIndex; never invent deadlines. Link people using organizationIndex, the zero-based index of an organization in the same batch. Include only sourced professional email addresses; never infer them. Use the permitted domains and source retrieval times. Do not send private CRM information to research providers. Source claims remain unverified. Submit one batch; the user reviews and imports in CRM. No outreach is authorized.",
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
  if (input.candidates.some((c) => c.researchMethod !== "agent"))
    throw new HttpError(400, "Agent submissions must use sourced research.");
  return transaction(async (db) => {
    const s = await search(db, null, bearer);
    const prior = (
      await db.query(
        "SELECT id,operation_id,payload_hash,candidates,decision FROM lead_previews WHERE search_id=$1 AND ($2::boolean=false OR operation_id=$3)",
        [s.id, s.standing, input.operationId],
      )
    ).rows[0];
    const fingerprint = digest(input);
    if (prior) {
      if (
        prior.operation_id !== input.operationId ||
        digest(z.array(candidateSchema).parse(prior.candidates)) !==
          digest(input.candidates)
      )
        throw new HttpError(
          409,
          "This search already has a preview. Start a new search to change the batch.",
        );
      return {
        state: prior.decision ? "decided" : "awaiting_review",
        reviewId: prior.id,
        reviewPath: "/connect/ai/leads?review=" + prior.id,
      };
    }
    if (s.standing) {
      const budget = (
        await db.query(
          "SELECT count(*) FILTER (WHERE decision IS NULL)::int AS pending, count(*) FILTER (WHERE created_at>now()-interval '1 day')::int AS daily FROM lead_previews WHERE search_id=$1",
          [s.id],
        )
      ).rows[0];
      if (budget.pending >= 10 || budget.daily >= 5)
        throw new HttpError(
          429,
          "Standing assignment review or daily limit reached.",
        );
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
        category: c.category,
        email: c.email,
        title: c.title,
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
    return {
      state: "awaiting_review",
      reviewId: id,
      reviewPath: "/connect/ai/leads?review=" + id,
    };
  });
}
async function inspect(db: PoolClient, user: string, id: string) {
  z.uuid().parse(id);
  let p = (
    await db.query(
      "SELECT p.* FROM lead_previews p JOIN lead_searches s ON s.id=p.search_id WHERE p.id=$1 AND (s.user_id=$2 OR s.researcher_id=$2)",
      [id, user],
    )
  ).rows[0];
  if (!p) throw new HttpError(404, "Preview unavailable.");
  const s = await search(db, user, p.search_id);
  p = (await db.query("SELECT * FROM lead_previews WHERE id=$1", [id])).rows[0];
  const candidates = z.array(candidateSchema).parse(p.candidates);
  const canApprove = s.user_id === user;
  const matches = canApprove
    ? await duplicates(db, s.workspace_id, candidates)
    : candidates.map(() => []);
  const owners = (
    await db.query(
      "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.role='owner' ORDER BY u.id",
      [s.workspace_id],
    )
  ).rows;
  const reviewDigest = digest({ id, hash: p.payload_hash, matches, owners });
  return { p, s, candidates, matches, reviewDigest, owners, canApprove };
}
export async function review(user: string, id: string) {
  requireLeadsEnabled();
  return transaction(async (db) => {
    const { p, s, candidates, matches, reviewDigest, owners, canApprove } =
      await inspect(db, user, id);
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
      digest: canApprove ? reviewDigest : "",
      canApprove,
      projectId: s.project_id,
      decision: canApprove
        ? p.decision
        : p.decision
          ? {
              accepted: p.record_ids?.length || 0,
              rejected: p.decision.rejected,
            }
          : null,
      audience: canApprove
        ? "Workspace owners only: " + owners.map((o) => o.name).join(", ")
        : "Workspace owners only",
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
      reuse: z
        .record(z.string().regex(/^(?:[0-9]|1[0-9])$/), z.uuid())
        .default({}),
      accept: z.array(z.number().int().min(0).max(19)).max(20),
      reason: z
        .enum(["not_relevant", "insufficient_evidence", "duplicate", "other"])
        .default("other"),
    })
    .parse(raw);
  if (new Set(input.accept).size !== input.accept.length)
    throw new HttpError(400, "Select distinct candidates.");
  input.accept.sort((a, b) => a - b);
  input.reuse = Object.fromEntries(
    Object.entries(input.reuse).sort(([a], [b]) => Number(a) - Number(b)),
  );
  return transaction(async (db) => {
    const { p, s, candidates, matches, reviewDigest, owners, canApprove } =
      await inspect(db, user, input.reviewId);
    if (!canApprove)
      throw new HttpError(
        403,
        "Only the owner who assigned this research can publish it.",
      );
    if (p.decision) {
      if (
        JSON.stringify(p.decision.accept) !== JSON.stringify(input.accept) ||
        digest(p.decision.reuse || {}) !== digest(input.reuse)
      )
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
    for (const [index, id] of Object.entries(input.reuse)) {
      const i = Number(index);
      const match = matches[i]?.find((m) => m.id === id);
      if (
        !input.accept.includes(i) ||
        candidates[i]?.kind !== "organizations" ||
        !match ||
        match.archived ||
        match.doNotContact
      )
        throw new HttpError(
          409,
          "Only an active matching organization without a do-not-contact restriction can be reused.",
        );
    }
    if (
      input.accept.some(
        (i) => !candidates[i] || (matches[i].length && !input.reuse[String(i)]),
      )
    )
      throw new HttpError(
        409,
        "Resolve potential matches before importing. Matching candidates cannot be imported here.",
      );
    for (const i of input.accept) {
      const contact = candidates[i].contactIndex;
      if (contact !== undefined && !input.accept.includes(contact))
        throw new HttpError(
          400,
          "Select the linked contact before publishing this task.",
        );
      const linked = candidates[i].organizationIndex;
      if (linked !== undefined && !input.accept.includes(linked))
        throw new HttpError(
          400,
          "Select the linked organization before publishing this person.",
        );
    }
    const newIds = new Map(
      input.accept.map((i) => [i, input.reuse[String(i)] || randomUUID()]),
    );
    const ids: string[] = [];
    for (const i of input.accept) {
      const c = candidates[i],
        id = newIds.get(i)!;
      if (input.reuse[String(i)]) {
        ids.push(id);
        continue;
      }
      const data = recordSchema.parse({
        name: c.name,
        website: c.website,
        category: c.category,
        email: c.email,
        title: c.title,
        description: leadDescription(c),
        source: c.researchMethod === "manual" ? "Research list" : "AI research",
        communication: "Unknown",
        ownerId: user,
        projectId: s.project_id || "",
        personId:
          c.contactIndex === undefined ? "" : newIds.get(c.contactIndex),
        organizationId:
          c.organizationIndex === undefined
            ? ""
            : newIds.get(c.organizationIndex),
      });
      await db.query(
        "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,$4,$3,'{}'::uuid[])",
        [id, s.workspace_id, data, c.kind],
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
          reuse: input.reuse,
          rejected: candidates.length - input.accept.length,
          reason: input.reason,
        }),
        ids,
      ],
    );
    return { ok: true, recordIds: ids, accepted: ids.length };
  });
}

// Metadata only: an agent may reconcile its own proposal, never approve it.
export async function agentStatus(bearer: string, raw: unknown) {
  requireLeadsEnabled();
  const input = z.strictObject({ operationId: z.uuid() }).parse(raw);
  return transaction(async (db) => {
    const s = await search(db, null, bearer);
    const p = (
      await db.query(
        "SELECT id,decision,record_ids FROM lead_previews WHERE search_id=$1 AND operation_id=$2",
        [s.id, input.operationId],
      )
    ).rows[0];
    if (!p) return { state: "not_found" };
    return {
      state: p.decision ? "decided" : "awaiting_review",
      reviewId: p.id,
      reviewPath: "/connect/ai/leads?review=" + p.id,
      accepted: p.decision ? p.record_ids?.length || 0 : 0,
    };
  });
}
