import { z } from "zod";
import { verifyDecision } from "./source-handoff/roles-proof.mjs";
import {
  workflowAssignment,
  workflowAssignmentOperation,
  workflowAssignmentAuthority,
  assignmentDigest,
} from "./workflow-assignment-transport.mjs";
import { verifyCrmResultLease } from "./crm-result-lease-contract.mjs";
const uuid = z.uuid(),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowAssignmentSourceBinding = z
  .strictObject({
    version: z.literal(1),
    connectionId: uuid,
    ownerId: uuid,
    datasetId: uuid,
    sourceWorkspace: uuid,
    principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
    credentialId: hex,
    runtimeLeaseId: uuid,
    runtimeBindingDigest: hex,
    tenant: z.string().min(1).max(128),
    workspace: z.string().min(1).max(128),
    approvedAt: z.int().positive(),
    expiresAt: z.int().positive(),
    completeTask: z.boolean().default(false),
    assignments: z.array(workflowAssignment).min(1).max(60),
  })
  .refine(
    (v) => v.expiresAt > v.approvedAt && v.expiresAt - v.approvedAt <= 900000,
    "Finite source approval required",
  )
  .refine(
    (v) => v.assignments.every((a) => a.principal === v.principal),
    "Worker identity mismatch",
  )
  .refine(
    (v) =>
      new Set(v.assignments.map((a) => a.assignmentId)).size ===
      v.assignments.length,
    "Duplicate assignment",
  );
const fail = () =>
  Object.assign(
    Error("Current exact CRM workflow source authority required."),
    { status: 403 },
  );
function packet(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,16384}$/.test(value))
    throw fail();
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(value, "base64url"),
      ),
    );
  } catch {
    throw fail();
  }
}
/** Verify the independent server approval, actual Roles decision and Workflows
 * lease before source storage is opened. This verifies no CRM membership by
 * itself; the source transaction must also recheck current owner/consent/records. */
export function guardWorkflowAssignmentSource(
  rawBinding,
  rawOperation,
  headers,
  { rolesKey, workflowKey, kind, now = Date.now() },
) {
  try {
    const binding = workflowAssignmentSourceBinding.parse(rawBinding),
      operation = workflowAssignmentOperation.parse(rawOperation);
    if (
      Object.hasOwn(headers, "cookie") ||
      Object.hasOwn(headers, "origin") ||
      binding.approvedAt > now ||
      binding.expiresAt <= now
    )
      throw fail();
    const assignment = binding.assignments.find(
      (a) => a.assignmentId === operation.assignmentId,
    );
    if (!assignment) throw fail();
    if (
      !["assignment", "task", "result", "finalize", "finalization"].includes(
        kind,
      ) ||
      (kind === "task" && operation.kind !== "task") ||
      (kind === "result" &&
        !["write", "receipt", "complete", "completion"].includes(
          operation.kind,
        )) ||
      (kind === "finalize" &&
        (!binding.completeTask || operation.kind !== "complete")) ||
      (kind === "finalization" &&
        (!binding.completeTask || operation.kind !== "completion"))
    )
      throw fail();
    const envelope = packet(headers["x-bittrees-roles-decision"]),
      r = envelope?.decision?.request;
    const decision = verifyDecision(envelope, r, rolesKey, now),
      expected = workflowAssignmentAuthority(
        assignment,
        binding.connectionId,
        operation,
      );
    if (
      !decision.allowed ||
      decision.expiresAt <= decision.checkedAt ||
      r.version !== 1 ||
      r.source !== "mcp.bittrees.org" ||
      r.audience !== "https://roles.bittrees.org/api/authority/mcp-decision" ||
      !uuid.safeParse(r.requestId).success ||
      !uuid.safeParse(r.operationId).success ||
      r.principal !== binding.principal ||
      r.credentialId !== binding.credentialId ||
      r.leaseId !== binding.runtimeLeaseId ||
      r.runtimeBindingDigest !== binding.runtimeBindingDigest ||
      r.delegationId !== null ||
      r.tenant !== binding.tenant ||
      r.workspace !== binding.workspace ||
      r.project !== "workflow" ||
      r.resource !== "workflow:" + assignment.workflowId ||
      r.action !== expected.action ||
      r.stage !== "execute" ||
      (expected.operationId !== null &&
        r.operationId !== expected.operationId) ||
      r.parametersDigest !== assignmentDigest(expected.parameters) ||
      !Number.isSafeInteger(r.issuedAt) ||
      r.issuedAt > now + 1000 ||
      r.issuedAt < now - 15000
    )
      throw fail();
    let lease;
    if (
      (kind === "result" && operation.kind === "write") ||
      kind === "finalize" ||
      kind === "finalization"
    ) {
      lease = verifyCrmResultLease(
        packet(headers["x-bittrees-workflow-lease"]),
        {
          state:
            kind === "finalize" || kind === "finalization"
              ? "completed"
              : "running",
          assignmentDigest: assignmentDigest(assignment),
          connectionId: binding.connectionId,
          runId: operation.runId,
          leaseId: operation.leaseId,
          crmOperationId: operation.crmOperationId,
          operation: operation.kind,
          authorityOperationId: r.operationId,
          resultDigest:
            operation.kind === "write"
              ? assignmentDigest(operation.result)
              : operation.resultDigest,
          principal: binding.principal,
          credentialId: binding.credentialId,
          runtimeLeaseId: binding.runtimeLeaseId,
          runtimeBindingDigest: binding.runtimeBindingDigest,
          tenant: binding.tenant,
          workspace: binding.workspace,
          authorityRequestId: r.requestId,
        },
        workflowKey,
        now,
      );
      if (lease.expiresAt > decision.expiresAt) throw fail();
    }
    return {
      binding,
      assignment,
      operation,
      decision,
      lease,
      deadline: Math.min(
        binding.expiresAt,
        decision.expiresAt,
        lease?.expiresAt ?? Infinity,
      ),
    };
  } catch {
    throw fail();
  }
}
