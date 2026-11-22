import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { hash } from "./auth";
import { HttpError } from "./model";
import { membership, lockActiveAccount } from "./service";
import { workflowAssignmentSourceBinding } from "./workflow-assignment-source-guard.mjs";
import { assignmentDigest } from "./workflow-assignment-transport.mjs";

type Binding = z.infer<typeof workflowAssignmentSourceBinding>;
const denied = () =>
  new HttpError(403, "Current owner approval for these tasks is required.");
export function configuredWorkflowBindings(bytes: string): Binding[] {
  if (bytes.length > 128000) throw denied();
  try {
    return z
      .array(workflowAssignmentSourceBinding)
      .max(20)
      .parse(JSON.parse(bytes));
  } catch {
    throw new HttpError(
      503,
      "Native workflow source configuration unavailable.",
    );
  }
}

async function ownerDataset(db: PoolClient, owner: string, dataset: string) {
  await lockActiveAccount(db, owner);
  const draft = await db.query(
    "SELECT id FROM lead_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE",
    [dataset, owner],
  );
  if (!draft.rowCount) throw denied();
}

async function connection(db: PoolClient, owner: string, dataset: string) {
  return (
    await db.query(
      "SELECT c.token_hash,c.expires_at FROM dataset_connections c JOIN lead_drafts d ON d.id=c.draft_id WHERE c.draft_id=$1 AND c.user_id=$2 AND c.expires_at>clock_timestamp() AND d.shared_search_id IS NULL AND NOT EXISTS (SELECT 1 FROM crm_backlog_consents b WHERE b.draft_id=d.id) FOR SHARE OF c",
      [dataset, owner],
    )
  ).rows[0];
}

const fingerprint = (binding: Binding, tokenHash: string) =>
  assignmentDigest({ binding, tokenHash });

export async function selectedTaskAuthority(
  db: PoolClient,
  bearer: string,
  binding: Binding,
  project: string,
) {
  if (
    binding.sourceConsent !== "selected-tasks" ||
    !/^[a-f0-9]{64}$/.test(bearer)
  )
    throw denied();
  if (process.env.CRM_LEADS_ENABLED !== "true") throw denied();
  await ownerDataset(db, binding.ownerId, binding.datasetId);
  await membership(binding.sourceWorkspace, binding.ownerId, true, true, db);
  const live = await connection(db, binding.ownerId, binding.datasetId);
  if (!live || live.token_hash !== hash(bearer)) throw denied();
  const row = (
    await db.query(
      `SELECT c.expires_at FROM crm_workflow_task_consents c
    JOIN records p ON p.id=$4 AND p.kind='projects' AND p.workspace_id=$5 AND p.archived_at IS NULL
    WHERE c.review_id=$1 AND c.owner_id=$2 AND c.dataset_id=$3 AND c.revoked_at IS NULL
    AND c.expires_at>clock_timestamp() FOR SHARE OF c,p`,
      [
        fingerprint(binding, live.token_hash),
        binding.ownerId,
        binding.datasetId,
        project,
        binding.sourceWorkspace,
      ],
    )
  ).rows[0];
  if (!row) throw denied();
  return {
    deadline: Math.min(
      new Date(row.expires_at).getTime(),
      new Date(live.expires_at).getTime(),
      binding.expiresAt,
    ),
  };
}

function enabled(env: NodeJS.ProcessEnv) {
  return (
    env.CRM_LEADS_ENABLED === "true" &&
    env.CRM_WORKFLOW_ASSIGNMENTS_ENABLED === "1"
  );
}
async function proposals(
  db: PoolClient,
  owner: string,
  dataset: string,
  env: NodeJS.ProcessEnv,
) {
  if (!enabled(env)) return [];
  const bindings = configuredWorkflowBindings(
    env.CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON ?? "[]",
  );
  const live = await connection(db, owner, dataset);
  if (!live) return [];
  const out = [];
  for (const b of bindings) {
    if (
      b.sourceConsent !== "selected-tasks" ||
      b.ownerId !== owner ||
      b.datasetId !== dataset ||
      b.approvedAt > Date.now() ||
      b.expiresAt <= Date.now()
    )
      continue;
    if (
      bindings.filter((other) => other.connectionId === b.connectionId)
        .length !== 1
    )
      continue;
    const first = b.assignments[0];
    if (
      b.assignments.some(
        (a) =>
          a.projectId !== first.projectId ||
          a.workflowId !== first.workflowId ||
          a.workflowRevision !== first.workflowRevision,
      ) ||
      new Set(b.assignments.map((a) => a.taskId)).size !== b.assignments.length
    )
      continue;
    const tasks = (
      await db.query(
        `SELECT t.id,t.version,t.data->>'name' AS name,p.data->>'name' AS project
      FROM records t JOIN records p ON p.id=$3 AND p.kind='projects' AND p.archived_at IS NULL AND p.workspace_id=t.workspace_id
      JOIN members m ON m.workspace_id=t.workspace_id AND m.user_id=$1 AND m.role='owner'
      WHERE t.workspace_id=$2 AND t.kind='tasks' AND t.archived_at IS NULL AND t.id=ANY($4::uuid[])
      AND t.data->>'ownerId'=$1::text AND t.data->>'projectId'=$3::text AND t.data->>'status'='Open'
      AND t.data->>'category' IN ('AI review','AI draft') AND COALESCE((t.data->>'supplierResearch')::text,'') IN ('','false')
      AND COALESCE((t.data->>'supplierPreparation')::text,'') IN ('','false') ORDER BY t.id FOR SHARE OF t,p,m`,
        [
          owner,
          b.sourceWorkspace,
          first.projectId,
          b.assignments.map((a) => a.taskId),
        ],
      )
    ).rows;
    if (
      !b.assignments.every((a) =>
        tasks.some((t) => t.id === a.taskId && t.version === a.taskRevision),
      )
    )
      continue;
    out.push({
      reviewId: fingerprint(b, live.token_hash),
      device: b.principal,
      credential: b.credentialId,
      workflow: first.workflowId,
      workflowRevision: first.workflowRevision,
      project: tasks[0].project,
      tasks: tasks.map(({ id, version, name }) => ({ id, version, name })),
      completeTask: b.completeTask,
      expiresAt: Math.min(b.expiresAt, new Date(live.expires_at).getTime()),
    });
  }
  return out;
}

export async function reviewTaskConsents(
  owner: string,
  raw: unknown,
  env = process.env,
) {
  const dataset = z.uuid().parse(raw);
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock_shared(73492017)");
    await ownerDataset(db, owner, dataset);
    const schema = await db.query(
      "SELECT to_regclass('crm_workflow_task_consents') IS NOT NULL AS ready",
    );
    if (!schema.rows[0].ready)
      return { requests: [], active: [], unavailable: true };
    let requests: Awaited<ReturnType<typeof proposals>> = [];
    let unavailable = false;
    try {
      requests = await proposals(db, owner, dataset, env);
    } catch (error) {
      // An invalid replacement configuration cannot prevent revoking an earlier approval.
      if (!(error instanceof HttpError)) throw error;
      unavailable = true;
    }
    const saved = (
      await db.query(
        "SELECT review_id,expires_at,revoked_at FROM crm_workflow_task_consents WHERE owner_id=$1 AND dataset_id=$2 AND expires_at>clock_timestamp() ORDER BY expires_at",
        [owner, dataset],
      )
    ).rows;
    return {
      unavailable,
      requests: requests.filter(
        (r) => !saved.some((s) => s.review_id === r.reviewId),
      ),
      active: saved
        .filter((s) => !s.revoked_at)
        .map((s) => ({
          request: requests.find((r) => r.reviewId === s.review_id) ?? null,
          reviewId: s.review_id,
          expiresAt: new Date(s.expires_at).getTime(),
        })),
    };
  });
}

export async function changeTaskConsent(
  owner: string,
  raw: unknown,
  env = process.env,
) {
  const a = z
    .strictObject({
      datasetId: z.uuid(),
      action: z.enum(["approve", "revoke"]),
      reviewId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(raw);
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock_shared(73492017)");
    await ownerDataset(db, owner, a.datasetId);
    if (a.action === "revoke") {
      const result = await db.query(
        "UPDATE crm_workflow_task_consents SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=$1 AND dataset_id=$2 AND review_id=$3 RETURNING review_id",
        [owner, a.datasetId, a.reviewId],
      );
      if (!result.rowCount) throw denied();
      return { status: "revoked" };
    }
    const request = (await proposals(db, owner, a.datasetId, env)).find(
      (r) => r.reviewId === a.reviewId,
    );
    if (!request) throw denied();
    const result = await db.query(
      `INSERT INTO crm_workflow_task_consents(owner_id,dataset_id,review_id,expires_at,review)
      SELECT $1,$2,$3,to_timestamp($4/1000.0),$5::jsonb WHERE to_timestamp($4/1000.0)>clock_timestamp()
      ON CONFLICT(review_id) DO NOTHING RETURNING review_id`,
      [
        owner,
        a.datasetId,
        a.reviewId,
        request.expiresAt,
        JSON.stringify(request),
      ],
    );
    if (!result.rowCount)
      throw new HttpError(
        409,
        "This review has already been decided. Refresh the task list.",
      );
    return { status: "approved" };
  });
}
