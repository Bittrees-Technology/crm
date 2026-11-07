import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { NextRequest } from "next/server";
import {
  canonical,
  decisionMessage,
} from "../lib/source-handoff/roles-proof.mjs";
import { crmResultLeaseMessage } from "../lib/crm-result-lease-contract.mjs";
import {
  workflowAssignmentAuthority,
  assignmentDigest,
} from "../lib/workflow-assignment-transport.mjs";
import { guardWorkflowAssignmentSource } from "../lib/workflow-assignment-source-guard.mjs";
import { workflowAssignmentSource } from "../lib/workflow-assignment-source";
import { POST } from "../app/api/[...path]/route";
const pem = (key: any) =>
  key.export({
    format: "pem",
    type: key.type === "private" ? "pkcs8" : "spki",
  });
function setup(kind = "write") {
  const now = Date.now(),
    roles = generateKeyPairSync("ed25519"),
    workflow = generateKeyPairSync("ed25519");
  const assignment = {
    assignmentId: randomUUID(),
    taskId: randomUUID(),
    taskRevision: 1,
    projectId: randomUUID(),
    workflowId: "review",
    workflowRevision: 1,
    principal: "agent:" + randomUUID(),
  };
  const binding = {
    version: 1,
    connectionId: randomUUID(),
    ownerId: randomUUID(),
    datasetId: randomUUID(),
    sourceWorkspace: randomUUID(),
    principal: assignment.principal,
    credentialId: "c".repeat(64),
    runtimeLeaseId: randomUUID(),
    runtimeBindingDigest: "d".repeat(64),
    tenant: "tenant",
    workspace: "workspace",
    approvedAt: now - 1,
    expiresAt: now + 60000,
    completeTask: false,
    assignments: [assignment],
  };
  const op: any = {
    kind,
    assignmentId: assignment.assignmentId,
    runId: randomUUID(),
    leaseId: randomUUID(),
    crmOperationId: randomUUID(),
    ...(kind === "write"
      ? { result: { summary: "Reviewed candidate" } }
      : {
          operationId: randomUUID(),
          resultDigest: "a".repeat(64),
          ...(kind === "complete" ? { expiresAt: now + 60000 } : {}),
        }),
  };
  const auth = workflowAssignmentAuthority(
    assignment,
    binding.connectionId,
    op,
  );
  const request = {
    version: 1,
    source: "mcp.bittrees.org",
    audience: "https://roles.bittrees.org/api/authority/mcp-decision",
    requestId: randomUUID(),
    operationId: auth.operationId ?? randomUUID(),
    principal: binding.principal,
    credentialId: binding.credentialId,
    leaseId: binding.runtimeLeaseId,
    runtimeBindingDigest: binding.runtimeBindingDigest,
    delegationId: null,
    tenant: binding.tenant,
    workspace: binding.workspace,
    project: "workflow",
    resource: "workflow:review",
    action: auth.action,
    stage: "execute",
    parametersDigest: assignmentDigest(auth.parameters),
    issuedAt: now,
  };
  const decision = {
    version: 1,
    issuer: "https://roles.bittrees.org",
    audience: "https://mcp.bittrees.org",
    request,
    allowed: true,
    requiresSourceAuthorization: true,
    checkedAt: now,
    expiresAt: now + 5000,
  };
  const proof = {
    version: 1,
    issuer: "https://workflow.bittrees.org",
    audience: "https://crm.bittrees.org",
    kind: "crm-result-lease",
    state: kind === "write" ? "running" : "completed",
    assignmentDigest: assignmentDigest(assignment),
    connectionId: binding.connectionId,
    runId: op.runId,
    leaseId: op.leaseId,
    crmOperationId: op.crmOperationId,
    operation: kind,
    authorityOperationId: request.operationId,
    resultDigest:
      kind === "write" ? assignmentDigest(op.result) : op.resultDigest,
    principal: binding.principal,
    credentialId: binding.credentialId,
    runtimeLeaseId: binding.runtimeLeaseId,
    runtimeBindingDigest: binding.runtimeBindingDigest,
    tenant: binding.tenant,
    workspace: binding.workspace,
    authorityRequestId: request.requestId,
    issuedAt: now,
    expiresAt: now + 4000,
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const headers = () => ({
    "x-bittrees-roles-decision": encode({
      decision,
      signature: sign(
        null,
        Buffer.from(decisionMessage(decision)),
        roles.privateKey,
      ).toString("base64"),
    }),
    "x-bittrees-workflow-lease": encode({
      proof,
      signature: sign(
        null,
        Buffer.from(crmResultLeaseMessage(proof)),
        workflow.privateKey,
      ).toString("base64"),
    }),
  });
  const options = {
    rolesKey: pem(roles.publicKey),
    workflowKey: pem(workflow.publicKey),
    kind: kind === "write" ? "result" : "finalize",
    now,
  };
  return {
    binding,
    op,
    decision,
    proof,
    headers,
    options,
    guard: () => guardWorkflowAssignmentSource(binding, op, headers(), options),
  };
}
test("exact source write requires current independent Roles and Workflows proofs", () => {
  const s = setup();
  assert.equal(s.guard().lease!.state, "running");
  assert.equal(s.guard().assignment.taskId, s.binding.assignments[0].taskId);
  assert.throws(() =>
    guardWorkflowAssignmentSource(s.binding, s.op, {}, s.options),
  );
  assert.throws(() =>
    guardWorkflowAssignmentSource(
      s.binding,
      { ...s.op, completeTask: true },
      s.headers(),
      s.options,
    ),
  );
  assert.throws(() =>
    guardWorkflowAssignmentSource(
      s.binding,
      { ...s.op, result: { summary: "tampered" } },
      s.headers(),
      s.options,
    ),
  );
});
test("source binding and each worker/connection/operation axis are independently pinned", () => {
  for (const key of [
    "principal",
    "credentialId",
    "runtimeLeaseId",
    "runtimeBindingDigest",
    "tenant",
    "workspace",
    "connectionId",
  ]) {
    const s = setup();
    (s.binding as any)[key] =
      key.includes("Digest") || key === "credentialId"
        ? "e".repeat(64)
        : key === "principal"
          ? "agent:" + randomUUID()
          : key === "tenant" || key === "workspace"
            ? "different"
            : randomUUID();
    assert.throws(s.guard, key);
  }
  const s = setup();
  s.proof.crmOperationId = randomUUID();
  assert.throws(s.guard);
});
test("revoked/expired Roles decisions, replaced results and stale signed leases deny", () => {
  for (const mutate of [
    (s: any) => (s.decision.allowed = false),
    (s: any) => (s.decision.expiresAt = s.options.now),
    (s: any) => (s.proof.expiresAt = s.options.now),
    (s: any) => (s.proof.state = "completed"),
    (s: any) => (s.proof.authorityRequestId = randomUUID()),
    (s: any) => (s.proof.resultDigest = "f".repeat(64)),
    (s: any) => (s.binding.expiresAt = s.options.now),
  ]) {
    const s = setup();
    mutate(s);
    assert.throws(s.guard);
  }
  const s = setup(),
    h = s.headers();
  h["x-bittrees-workflow-lease"] = Buffer.from(
    JSON.stringify({ proof: s.proof, signature: "forged" }),
  ).toString("base64url");
  assert.throws(() =>
    guardWorkflowAssignmentSource(s.binding, s.op, h, s.options),
  );
});
test("task status completion needs separate source approval and confirmed central completion", () => {
  const s = setup("complete");
  assert.throws(s.guard);
  s.binding.completeTask = true;
  assert.equal(s.guard().lease!.state, "completed");
  s.proof.state = "running";
  assert.throws(s.guard);
});
test("browser context and unknown assignment are never accepted as native authority", () => {
  const s = setup();
  assert.throws(() =>
    guardWorkflowAssignmentSource(
      s.binding,
      s.op,
      { ...s.headers(), cookie: "" },
      s.options,
    ),
  );
  assert.throws(() =>
    guardWorkflowAssignmentSource(
      s.binding,
      s.op,
      { ...s.headers(), origin: "" },
      s.options,
    ),
  );
  assert.throws(() =>
    guardWorkflowAssignmentSource(
      s.binding,
      { ...s.op, assignmentId: randomUUID() },
      s.headers(),
      s.options,
    ),
  );
});
test("unconfigured production source stays closed before database creation", async () => {
  const before = (globalThis as any).crmPool,
    old = process.env.CRM_WORKFLOW_ASSIGNMENTS_ENABLED;
  delete process.env.CRM_WORKFLOW_ASSIGNMENTS_ENABLED;
  try {
    await assert.rejects(
      workflowAssignmentSource(
        "not-a-credential",
        {},
        {},
        { NODE_ENV: "test" },
      ),
      { status: 404 },
    );
    const r = await POST(
      new NextRequest(
        "http://127.0.0.1:3040/api/integrations/workflow-assignments",
        {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        },
      ),
    );
    assert.equal(r.status, 404);
    assert.equal((globalThis as any).crmPool, before);
  } finally {
    if (old !== undefined) process.env.CRM_WORKFLOW_ASSIGNMENTS_ENABLED = old;
  }
});
