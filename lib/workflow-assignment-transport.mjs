// Exact native/gateway/source operation contract. No operation grants authority.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "./source-handoff/roles-proof.mjs";
const uuid = z.uuid(),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowAssignment = z.strictObject({
  assignmentId: uuid,
  taskId: uuid,
  taskRevision: z.int().positive(),
  projectId: uuid,
  workflowId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  workflowRevision: z.int().positive(),
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
});
const lease = {
  assignmentId: uuid,
  runId: uuid,
  leaseId: uuid,
  crmOperationId: uuid,
};
export const workflowAssignmentOperation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("intake"), assignmentId: uuid }),
  z.strictObject({
    kind: z.literal("claim"),
    assignmentId: uuid,
    operationId: uuid,
  }),
  z.strictObject({ kind: z.literal("task"), assignmentId: uuid }),
  z.strictObject({
    kind: z.literal("write"),
    ...lease,
    result: z.strictObject({ summary: z.string().trim().min(1).max(4000) }),
  }),
  z.strictObject({ kind: z.literal("receipt"), ...lease }),
  z.strictObject({
    kind: z.literal("complete"),
    ...lease,
    operationId: uuid,
    resultDigest: hex,
    expiresAt: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal("completion"),
    ...lease,
    operationId: uuid,
    resultDigest: hex,
  }),
]);
export const assignmentDigest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function workflowAssignmentAuthority(
  rawAssignment,
  rawConnectionId,
  rawOperation,
) {
  const a = workflowAssignment.parse(rawAssignment),
    connectionId = uuid.parse(rawConnectionId),
    o = workflowAssignmentOperation.parse(rawOperation);
  if (a.assignmentId !== o.assignmentId)
    throw Error("Assignment authority mismatch");
  const assignmentDigestValue = assignmentDigest(a),
    base = {
      connectionId,
      workflowId: a.workflowId,
      assignmentDigest: assignmentDigestValue,
    };
  if (o.kind === "intake" || o.kind === "task")
    return {
      action: "workflow:claim",
      operationId: null,
      parameters: {
        tool: o.kind === "intake" ? "workflow_crm_intake" : "workflow_crm_task",
        arguments: base,
      },
    };
  if (o.kind === "claim")
    return {
      action: "workflow:claim",
      operationId: o.operationId,
      parameters: {
        tool: "workflow_claim",
        arguments: {
          connectionId,
          workflowId: a.workflowId,
          operationId: o.operationId,
          assignmentDigest: assignmentDigestValue,
        },
      },
    };
  const result = {
    connectionId,
    assignmentDigest: assignmentDigestValue,
    runId: o.runId,
    leaseId: o.leaseId,
    crmOperationId: o.crmOperationId,
  };
  if (o.kind === "write" || o.kind === "receipt")
    return {
      action: "workflow:complete",
      operationId: o.crmOperationId,
      parameters: {
        tool:
          o.kind === "write"
            ? "workflow_crm_result_write"
            : "workflow_crm_result_read",
        arguments: {
          ...result,
          ...(o.kind === "write"
            ? { resultDigest: assignmentDigest(o.result) }
            : {}),
        },
      },
    };
  return {
    action: "workflow:complete",
    operationId: o.operationId,
    parameters: {
      tool: "workflow_crm_completion",
      arguments: {
        runId: o.runId,
        operationId: o.operationId,
        method: o.kind === "complete" ? "PUT" : "GET",
        connectionId,
        assignmentDigest: assignmentDigestValue,
        leaseId: o.leaseId,
        crmOperationId: o.crmOperationId,
        resultDigest: o.resultDigest,
      },
    },
  };
}
