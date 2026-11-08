import type { PoolClient } from "pg";
import {
  workflowAssignmentSchema,
  workflowAssignmentCompletionConstraints,
} from "./workflow-assignment-schema.mjs";
async function coreSnapshot(db: PoolClient) {
  const snapshot: Record<string, unknown> = {};
  for (const name of [
    "users",
    "identities",
    "members",
    "workspaces",
    "records",
  ]) {
    snapshot[name] = (
      await db.query(
        `SELECT count(*)::text AS count,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint::numeric),0)::text AS digest FROM ${name} t`,
      )
    ).rows[0];
  }
  return snapshot;
}
async function sourceSnapshot(
  db: PoolClient,
  name: "crm_workflow_assignments" | "crm_workflow_result_receipts",
) {
  const present = (
    await db.query("SELECT to_regclass($1) IS NOT NULL AS present", [name])
  ).rows[0].present;
  if (!present) return null;
  const fields =
    name === "crm_workflow_assignments"
      ? "id,task_id,workspace_id,task_revision,connection_id,assignment,expires_at,revoked_at"
      : "operation_id,assignment_id,assignment_digest,run_id,lease_id,result,result_digest,created_at";
  return (
    await db.query(
      `SELECT count(*)::text AS count,coalesce(sum(('x'||substr(md5(jsonb_build_array(${fields})::text),1,16))::bit(64)::bigint::numeric),0)::text AS digest FROM ${name}`,
    )
  ).rows[0];
}
/** Call only inside an explicitly reviewed migration transaction. No serving
 * request creates tables, edits source rows, activates a feature or grants rights. */
export async function migrateWorkflowAssignments(db: PoolClient) {
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(73492017)");
  await db.query(
    "LOCK TABLE users,identities,members,workspaces,records IN SHARE ROW EXCLUSIVE MODE",
  );
  const before = await coreSnapshot(db),
    receiptsBefore = await sourceSnapshot(db, "crm_workflow_result_receipts"),
    assignmentsBefore = await sourceSnapshot(db, "crm_workflow_assignments");
  await db.query(workflowAssignmentSchema);
  await db.query(workflowAssignmentCompletionConstraints);
  const after = await coreSnapshot(db),
    receiptsAfter = await sourceSnapshot(db, "crm_workflow_result_receipts"),
    assignmentsAfter = await sourceSnapshot(db, "crm_workflow_assignments");
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    (receiptsBefore &&
      JSON.stringify(receiptsBefore) !== JSON.stringify(receiptsAfter)) ||
    (!receiptsBefore && receiptsAfter.count !== "0") ||
    (assignmentsBefore &&
      JSON.stringify(assignmentsBefore) !== JSON.stringify(assignmentsAfter)) ||
    (!assignmentsBefore && assignmentsAfter.count !== "0")
  )
    throw Error("Workflow schema migration retention mismatch");
  const indexes = (
    await db.query(`SELECT count(*)::int AS n FROM pg_index WHERE indisunique AND indisvalid AND
  ((indrelid='crm_workflow_assignments'::regclass AND indexrelid=to_regclass('crm_workflow_assignment_task_revision')) OR
   (indrelid='crm_workflow_result_receipts'::regclass AND indexrelid=to_regclass('crm_workflow_result_note')))`)
  ).rows[0].n;
  const columns = (
    await db.query(
      `SELECT attname,atttypid::regtype::text AS type FROM pg_attribute WHERE attrelid='crm_workflow_result_receipts'::regclass AND attnum>0 AND NOT attisdropped AND attname=ANY($1::text[])`,
      [
        [
          "note_id",
          "finalized_task_revision",
          "finalize_operation_id",
          "finalized_at",
        ],
      ],
    )
  ).rows;
  const types = new Map(columns.map((r) => [r.attname, r.type]));
  if (
    indexes !== 2 ||
    types.get("note_id") !== "uuid" ||
    types.get("finalize_operation_id") !== "uuid" ||
    types.get("finalized_task_revision") !== "integer" ||
    types.get("finalized_at") !== "timestamp with time zone"
  )
    throw Error("Workflow schema indexes or column types unavailable");
  return {
    migration: "crm-workflow-assignment-source-v1",
    crmContentAndMembershipsUnchanged: true,
    existingReceiptsRetained: true,
    snapshot: after,
    uniqueAssignmentAndNoteIndexes: 2,
    featureActivated: false,
    grantsChanged: false,
    servingRuntimeAcceptance: "not-established",
  };
}
