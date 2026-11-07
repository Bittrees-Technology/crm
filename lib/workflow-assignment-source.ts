import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { workflowAssignmentDatasetAuthority } from "./datasets";
import { checkRecordAccess } from "./access";
import { saveRecordInTransaction } from "./service";
import { recordSchema, HttpError } from "./model";
import { rateLimit, hash } from "./auth";
import { createWorkflowAssignmentIssuer } from "./workflow-assignment-issuer.mjs";
import {
  workflowAssignmentOperation,
  assignmentDigest,
} from "./workflow-assignment-transport.mjs";
import {
  guardWorkflowAssignmentSource,
  workflowAssignmentSourceBinding,
} from "./workflow-assignment-source-guard.mjs";
const callSchema = z.strictObject({
  version: z.literal(1),
  connectionId: z.uuid(),
  kind: z.enum(["assignment", "task", "result", "finalize", "finalization"]),
  operation: workflowAssignmentOperation,
});
type Context = ReturnType<typeof guardWorkflowAssignmentSource>;
export const workflowAssignmentSourceEnabled = (env = process.env) =>
  env.CRM_WORKFLOW_ASSIGNMENTS_ENABLED === "1";
const denied = () =>
  new HttpError(403, "Current exact workflow source permission required.");
function deadline(time: number) {
  if (!Number.isSafeInteger(time) || time <= Date.now()) throw denied();
}
/** Bound every queued SQL statement to the same signed admission deadline.
 * The facade owns no connection and cannot commit independently. */
function admittedClient(raw: PoolClient, expires: () => number): PoolClient {
  let tail: Promise<unknown> = Promise.resolve();
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property !== "query") return Reflect.get(target, property, receiver);
      return (...args: any[]) => {
        const result = tail.then(async () => {
          const until = expires();
          deadline(until);
          const remaining = Math.max(1, until - Date.now());
          await raw.query(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
            [remaining + "ms", Math.min(remaining, 3000) + "ms"],
          );
          deadline(expires());
          const value = await (raw.query as any)(...args);
          deadline(expires());
          return value;
        });
        tail = result;
        return result;
      };
    },
  });
}
async function taskContext(db: PoolClient, context: Context) {
  const { binding: b, assignment: a } = context;
  await checkRecordAccess(db, b.ownerId, b.sourceWorkspace, a.taskId);
  const task = (
    await db.query(
      "SELECT id,workspace_id,kind,data,version,visibility_ids FROM records WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL FOR SHARE",
      [a.taskId, b.sourceWorkspace],
    )
  ).rows[0];
  const receipt = (
    await db.query(
      "SELECT * FROM crm_workflow_result_receipts WHERE assignment_id=$1",
      [a.assignmentId],
    )
  ).rows[0];
  const expectedVersion = receipt?.finalized_task_revision ?? a.taskRevision;
  if (
    !task ||
    task.kind !== "tasks" ||
    task.version !== expectedVersion ||
    task.data.ownerId !== b.ownerId ||
    task.data.projectId !== a.projectId ||
    !["AI draft", "AI review"].includes(task.data.category) ||
    task.data.status !== (receipt?.finalized_task_revision ? "Done" : "Open")
  )
    throw denied();
  // Supplier evidence belongs to its exact-pair research bridge and durable
  // budgets. An ordinary CRM assignment must never become a retry workaround.
  if (task.data.supplierResearch || task.data.supplierPreparation)
    throw new HttpError(
      403,
      "Prepared supplier evidence requires its dedicated workflow.",
    );
  return { task, receipt };
}
async function materialize(db: PoolClient, context: Context) {
  const { binding: b, assignment: a, operation: o } = context;
  if (o.kind !== "intake") return;
  await db.query(
    `INSERT INTO crm_workflow_assignments(id,task_id,workspace_id,task_revision,connection_id,assignment,expires_at)
     SELECT $1,$2,$3,$4,$5,$6::jsonb,to_timestamp($7/1000.0) WHERE to_timestamp($7/1000.0)>clock_timestamp()
     ON CONFLICT DO NOTHING`,
    [
      a.assignmentId,
      a.taskId,
      b.sourceWorkspace,
      a.taskRevision,
      b.connectionId,
      JSON.stringify(a),
      b.expiresAt,
    ],
  );
}
async function resultNote(db: PoolClient, context: Context, task: any) {
  const { assignment: a, binding: b, operation: o } = context;
  if (o.kind !== "write") throw denied();
  const saved = await saveRecordInTransaction(
    db,
    b.ownerId,
    b.sourceWorkspace,
    {
      operationId: o.crmOperationId,
      kind: "notes",
      data: recordSchema.parse({
        name: ("AI result — " + task.data.name).slice(0, 200),
        description: o.result.summary,
        projectId: a.projectId,
        ownerId: b.ownerId,
        source: "workflow:" + o.crmOperationId,
        nextAction: "Validated result for task " + a.taskId,
      }),
      visibilityIds: task.visibility_ids,
    },
  );
  const updated = await db.query(
    "UPDATE crm_workflow_result_receipts SET note_id=$1 WHERE operation_id=$2 AND assignment_id=$3 AND (note_id IS NULL OR note_id=$1)",
    [saved.id, o.crmOperationId, a.assignmentId],
  );
  if (updated.rowCount !== 1)
    throw new HttpError(409, "Workflow result note binding changed.");
  return saved.id;
}
async function verifyResultNote(db: PoolClient, context: Context) {
  const { binding: b, assignment: a, operation: o } = context;
  if (!("crmOperationId" in o)) throw denied();
  const row = (
    await db.query(
      `SELECT r.*,n.data AS note_data,n.version AS note_version,n.archived_at AS note_archived
     FROM crm_workflow_result_receipts r JOIN records n ON n.id=r.note_id AND n.workspace_id=$2 AND n.kind='notes'
     WHERE r.operation_id=$1 AND r.assignment_id=$3 FOR SHARE OF r,n`,
      [o.crmOperationId, b.sourceWorkspace, a.assignmentId],
    )
  ).rows[0];
  if (
    !row ||
    row.note_archived ||
    row.note_version !== 1 ||
    row.note_data.ownerId !== b.ownerId ||
    row.note_data.projectId !== a.projectId ||
    row.note_data.source !== "workflow:" + o.crmOperationId ||
    assignmentDigest({ summary: row.note_data.description }) !==
      row.result_digest ||
    row.result_digest !==
      (o.kind === "write"
        ? assignmentDigest(o.result)
        : "resultDigest" in o
          ? o.resultDigest
          : row.result_digest)
  )
    throw new HttpError(
      409,
      "The workflow result note changed; reconcile the original operation.",
    );
  return row;
}
async function finalizeTask(db: PoolClient, context: Context, task: any) {
  const { binding: b, assignment: a, operation: o, lease } = context;
  if (
    !b.completeTask ||
    !lease ||
    lease.state !== "completed" ||
    (o.kind !== "complete" && o.kind !== "completion")
  )
    throw denied();
  const result = await verifyResultNote(db, context);
  if (result.finalized_task_revision) {
    if (
      result.finalize_operation_id !== o.operationId ||
      task.version !== result.finalized_task_revision ||
      task.data.status !== "Done"
    )
      throw denied();
    return {
      taskId: a.taskId,
      taskVersion: task.version,
      status: "Done",
      operationId: o.operationId,
      replayed: true,
    };
  }
  const saved = await saveRecordInTransaction(
    db,
    b.ownerId,
    b.sourceWorkspace,
    {
      operationId: o.operationId,
      id: a.taskId,
      kind: "tasks",
      version: a.taskRevision,
      data: recordSchema.parse({ ...task.data, status: "Done" }),
    },
  );
  await db.query(
    "UPDATE crm_workflow_result_receipts SET finalized_task_revision=$1,finalize_operation_id=$2,finalized_at=clock_timestamp() WHERE operation_id=$3 AND assignment_id=$4 AND finalized_task_revision IS NULL",
    [saved.version, o.operationId, o.crmOperationId, a.assignmentId],
  );
  return {
    taskId: a.taskId,
    taskVersion: saved.version,
    status: "Done",
    operationId: o.operationId,
    replayed: false,
  };
}
async function readFinalization(db: PoolClient, context: Context, task: any) {
  const o = context.operation;
  if (
    o.kind !== "completion" ||
    !context.lease ||
    context.lease.state !== "completed"
  )
    throw denied();
  const result = await verifyResultNote(db, context);
  if (
    !result.finalized_task_revision ||
    result.finalize_operation_id !== o.operationId ||
    task.version !== result.finalized_task_revision ||
    task.data.status !== "Done"
  )
    throw new HttpError(
      409,
      "Source task completion is not confirmed; retain the original operation.",
    );
  return {
    taskId: context.assignment.taskId,
    taskVersion: task.version,
    status: "Done",
    operationId: o.operationId,
    replayed: true,
  };
}
/** Actual production composition. Environment bindings are independently reviewed
 * server configuration; neither request data nor the model can create approval.
 * Every operation still checks live source consent, owner, records and Roles. */
export async function workflowAssignmentSource(
  bearer: string,
  raw: unknown,
  headers: Record<string, string>,
  env = process.env,
) {
  if (!workflowAssignmentSourceEnabled(env))
    throw new HttpError(404, "Not found.");
  const call = callSchema.parse(raw),
    bytes = env.CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON ?? "[]";
  if (bytes.length > 128000) throw denied();
  let rows: z.infer<typeof workflowAssignmentSourceBinding>[];
  try {
    rows = z
      .array(workflowAssignmentSourceBinding)
      .max(20)
      .parse(JSON.parse(bytes));
  } catch {
    throw new HttpError(
      503,
      "Native workflow source configuration unavailable.",
    );
  }
  const matches = rows.filter((b) => b.connectionId === call.connectionId);
  if (matches.length !== 1) throw denied();
  const binding = matches[0];
  const guarded = () => {
    try {
      return guardWorkflowAssignmentSource(binding, call.operation, headers, {
        rolesKey: env.CRM_WORKFLOW_ROLES_DECISION_PUBLIC_KEY,
        workflowKey: env.CRM_WORKFLOW_LEASE_PUBLIC_KEY,
        kind: call.kind,
      });
    } catch {
      throw denied();
    }
  };
  const context = guarded();
  const check = () => {
    if (env.CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON !== bytes) throw denied();
    guarded();
    deadline(context.deadline);
  };
  check();
  await rateLimit("workflow-source:" + hash(bearer), 240);
  check();
  let finalReceipt: unknown, noteId: string | undefined;
  let sourceDeadline = context.deadline;
  const issuer = createWorkflowAssignmentIssuer({
    privateKey: env.ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY,
    transaction: async (work: (db: PoolClient) => Promise<unknown>) =>
      transaction(async (raw) => {
        const db = admittedClient(raw, () => sourceDeadline);
        check();
        // Match the explicit migration lock order before locking source rows.
        await db.query("SELECT pg_advisory_xact_lock_shared(73492017)");
        const source = await workflowAssignmentDatasetAuthority(
          db,
          bearer,
          binding,
          context.assignment.projectId,
        );
        sourceDeadline = Math.min(source.deadline, context.deadline);
        deadline(sourceDeadline);
        const state = await taskContext(db, context);
        check();
        await materialize(db, context);
        const value = await work(db);
        if (call.kind === "result") {
          if (context.operation.kind === "write")
            noteId = await resultNote(db, context, state.task);
          const note = await verifyResultNote(db, context);
          noteId = note.note_id;
        }
        if (call.kind === "finalize")
          finalReceipt = await finalizeTask(db, context, state.task);
        if (call.kind === "finalization")
          finalReceipt = await readFinalization(db, context, state.task);
        check();
        deadline(Math.min(source.deadline, context.deadline));
        return value;
      }),
    authorize: async (_db: PoolClient, current: any) => {
      check();
      if (
        assignmentDigest(current.assignment) !==
          assignmentDigest(context.assignment) ||
        current.connectionId !== binding.connectionId
      )
        throw denied();
      if (current.runId !== undefined) {
        const o = context.operation;
        if (
          !("runId" in o) ||
          current.runId !== o.runId ||
          current.leaseId !== o.leaseId ||
          current.crmOperationId !== o.crmOperationId
        )
          throw denied();
      }
      return sourceDeadline;
    },
  });
  let result: any;
  try {
    if (call.kind === "assignment")
      result = await issuer.assignment(
        context.assignment.assignmentId,
        binding.connectionId,
      );
    else if (call.kind === "task")
      result = await issuer.task(
        context.assignment.assignmentId,
        binding.connectionId,
      );
    else {
      const o = context.operation;
      if (!("runId" in o)) throw denied();
      result = await issuer.result(
        {
          assignmentId: o.assignmentId,
          connectionId: binding.connectionId,
          runId: o.runId,
          leaseId: o.leaseId,
          crmOperationId: o.crmOperationId,
          ...(call.kind === "result" && o.kind === "write"
            ? { result: o.result }
            : {}),
        },
        { write: call.kind === "result" && o.kind === "write" },
      );
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (["57014", "55P03"].includes((error as { code?: string })?.code ?? ""))
      throw new HttpError(
        409,
        "Source admission expired or remained busy; reconcile the original operation.",
      );
    const status = (error as { status?: number })?.status;
    if (status === 403) throw denied();
    if (status === 409)
      throw new HttpError(
        409,
        "Workflow source state changed; reconcile the original operation.",
      );
    throw error;
  }
  check();
  return {
    ...result,
    ...(noteId ? { noteId } : {}),
    ...(finalReceipt ? { task: finalReceipt } : {}),
  };
}
