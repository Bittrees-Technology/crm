import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { spawnSync } from "node:child_process";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { pool, schema, transaction } from "../lib/db";
import { migrateWorkflowAssignments } from "../lib/workflow-assignment-migration";
import { workflowAssignmentSchema } from "../lib/workflow-assignment-schema.mjs";
import { changeTaskConsent, reviewTaskConsents } from "../lib/workflow-task-consent";
import { workflowAssignmentSource } from "../lib/workflow-assignment-source";
import {
  workflowAssignmentAuthority,
  assignmentDigest,
} from "../lib/workflow-assignment-transport.mjs";
import { decisionMessage } from "../lib/source-handoff/roles-proof.mjs";
import { crmResultLeaseMessage } from "../lib/crm-result-lease-contract.mjs";
import { hash } from "../lib/auth";
import { recordSchema } from "../lib/model";
const isolated = "workflow_source_" + randomUUID().replaceAll("-", "");
let admin: Pool;
const roles = generateKeyPairSync("ed25519"),
  workflow = generateKeyPairSync("ed25519"),
  crm = generateKeyPairSync("ed25519");
const pem = (key: any) =>
  key
    .export({ format: "pem", type: key.type === "private" ? "pkcs8" : "spki" })
    .toString();
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/crm_test");
  admin = new Pool({ connectionString: url.href });
  await admin.query("CREATE SCHEMA " + isolated);
  url.searchParams.set("options", "-csearch_path=" + isolated);
  url.searchParams.set("application_name", isolated);
  process.env.DATABASE_URL = url.href;
  process.env.CRM_LEADS_ENABLED = "true";
  await pool().query(schema);
  await pool().query(workflowAssignmentSchema);
});
after(async () => {
  await pool().end();
  await admin.query("DROP SCHEMA " + isolated + " CASCADE");
  await admin.end();
});
async function fixture(completeTask = false) {
  const now = Date.now(),
    owner = randomUUID(),
    workspace = randomUUID(),
    project = randomUUID(),
    task = randomUUID(),
    dataset = randomUUID(),
    bearer =
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  await pool().query("INSERT INTO users(id,name) VALUES($1,$2)", [
    owner,
    "Synthetic source owner",
  ]);
  await pool().query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    workspace,
    "Synthetic source workspace",
  ]);
  await pool().query("INSERT INTO members VALUES($1,$2,'owner',NULL)", [
    workspace,
    owner,
  ]);
  const taskData = recordSchema.parse({
    name: "Assigned local review",
    description: "Supplied synthetic instruction",
    projectId: project,
    ownerId: owner,
    category: "AI review",
    status: "Open",
    dueDate: "2026-12-01",
  });
  for (const [id, kind, data] of [
    [project, "projects", recordSchema.parse({ name: "Selected project" })],
    [task, "tasks", taskData],
  ])
    await pool().query(
      "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,$3,$4)",
      [id, workspace, kind, data],
    );
  await pool().query(
    "INSERT INTO lead_drafts(id,user_id,name) VALUES($1,$2,$3)",
    [dataset, owner, "Synthetic source dataset"],
  );
  await pool().query(
    "INSERT INTO dataset_connections(draft_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
    [dataset, owner, hash(bearer)],
  );
  await pool().query(
    "INSERT INTO dataset_project_permissions(draft_id,project_id,workspace_id,user_id,token_hash,tasks,expires_at) VALUES($1,$2,$3,$4,$5,true,now()+interval '1 day')",
    [dataset, project, workspace, owner, hash(bearer)],
  );
  const assignment = {
    assignmentId: randomUUID(),
    taskId: task,
    taskRevision: 1,
    projectId: project,
    workflowId: "local-review",
    workflowRevision: 1,
    principal: "agent:" + randomUUID(),
  };
  const binding = {
    version: 1,
    connectionId: randomUUID(),
    ownerId: owner,
    datasetId: dataset,
    sourceWorkspace: workspace,
    principal: assignment.principal,
    credentialId: "c".repeat(64),
    runtimeLeaseId: randomUUID(),
    runtimeBindingDigest: "d".repeat(64),
    tenant: "t",
    workspace: "w",
    approvedAt: now - 1,
    expiresAt: now + 600000,
    completeTask,
    assignments: [assignment],
  };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CRM_WORKFLOW_ASSIGNMENTS_ENABLED: "1",
    CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON: JSON.stringify([binding]),
    CRM_WORKFLOW_ROLES_DECISION_PUBLIC_KEY: pem(roles.publicKey),
    CRM_WORKFLOW_LEASE_PUBLIC_KEY: pem(workflow.publicKey),
    ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY: pem(crm.privateKey),
  };
  function headers(
    op: any,
    state = "running",
    mutate?: (decision: any, proof: any) => void,
    target = assignment,
  ) {
    const now = Date.now(),
      auth = workflowAssignmentAuthority(target, binding.connectionId, op);
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
      tenant: "t",
      workspace: "w",
      project: "workflow",
      resource: "workflow:" + target.workflowId,
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
      state,
      assignmentDigest: assignmentDigest(target),
      connectionId: binding.connectionId,
      runId: op.runId,
      leaseId: op.leaseId,
      crmOperationId: op.crmOperationId,
      operation: op.kind,
      authorityOperationId: request.operationId,
      resultDigest:
        op.kind === "write" ? assignmentDigest(op.result) : op.resultDigest,
      principal: binding.principal,
      credentialId: binding.credentialId,
      runtimeLeaseId: binding.runtimeLeaseId,
      runtimeBindingDigest: binding.runtimeBindingDigest,
      tenant: "t",
      workspace: "w",
      authorityRequestId: request.requestId,
      issuedAt: now,
      expiresAt: now + 4000,
    };
    mutate?.(decision, proof);
    const encode = (x: any) =>
      Buffer.from(JSON.stringify(x)).toString("base64url");
    return {
      "x-bittrees-roles-decision": encode({
        decision,
        signature: sign(
          null,
          Buffer.from(decisionMessage(decision)),
          roles.privateKey,
        ).toString("base64"),
      }),
      ...(["write", "complete", "completion"].includes(op.kind)
        ? {
            "x-bittrees-workflow-lease": encode({
              proof,
              signature: sign(
                null,
                Buffer.from(crmResultLeaseMessage(proof)),
                workflow.privateKey,
              ).toString("base64"),
            }),
          }
        : {}),
    };
  }
  const op = (kind: string, extra = {}) => ({
    kind,
    assignmentId: assignment.assignmentId,
    ...extra,
  });
  const call = (
    kind: string,
    operation: any,
    state = "running",
    customHeaders?: any,
  ) =>
    workflowAssignmentSource(
      bearer,
      { version: 1, connectionId: binding.connectionId, kind, operation },
      customHeaders ?? headers(operation, state),
      env,
    );
  return {
    assignment,
    binding,
    env,
    bearer,
    owner,
    workspace,
    project,
    task,
    dataset,
    taskData,
    op,
    headers,
    call,
  };
}
test("source intake is idempotent and expired/current owner grants cannot be substituted", async () => {
  const f = await fixture(),
    input = f.op("intake");
  await f.call("assignment", input);
  await f.call("assignment", input);
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int AS n FROM crm_workflow_assignments WHERE id=$1",
        [f.assignment.assignmentId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await f.call("task", f.op("task"))).instruction,
    f.taskData.description,
  );
  await pool().query(
    "UPDATE dataset_project_permissions SET tasks=false WHERE draft_id=$1",
    [f.dataset],
  );
  await assert.rejects(f.call("task", f.op("task")), { status: 403 });
  await pool().query(
    "UPDATE dataset_project_permissions SET tasks=true WHERE draft_id=$1",
    [f.dataset],
  );
  await pool().query(
    "UPDATE members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [f.workspace, f.owner],
  );
  await assert.rejects(f.call("task", f.op("task")), { status: 403 });
});
test("wrong source owner, dataset, workspace and revised/unassigned records hold without registration", async () => {
  for (const field of ["ownerId", "datasetId", "sourceWorkspace"]) {
    const f = await fixture();
    (f.binding as any)[field] = randomUUID();
    f.env.CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON = JSON.stringify([f.binding]);
    await assert.rejects(f.call("assignment", f.op("intake")));
    assert.equal(
      (
        await pool().query(
          "SELECT count(*)::int AS n FROM crm_workflow_assignments WHERE id=$1",
          [f.assignment.assignmentId],
        )
      ).rows[0].n,
      0,
    );
  }
  for (const change of [
    { version: 2 },
    { ownerId: randomUUID() },
    { projectId: randomUUID() },
    { category: "Ordinary task" },
    { supplierPreparation: { synthetic: true } },
  ]) {
    const f = await fixture();
    if ("version" in change)
      await pool().query("UPDATE records SET version=2 WHERE id=$1", [f.task]);
    else
      await pool().query(
        "UPDATE records SET data=data||$2::jsonb WHERE id=$1",
        [f.task, change],
      );
    await assert.rejects(f.call("assignment", f.op("intake")));
  }
});
test("committed result notes reconcile under the original operation without changing owner task fields", async () => {
  const f = await fixture();
  await f.call("assignment", f.op("intake"));
  const lease = {
      runId: randomUUID(),
      leaseId: randomUUID(),
      crmOperationId: randomUUID(),
    },
    write = f.op("write", {
      ...lease,
      result: { summary: "Independently reviewed result" },
    });
  const first = await f.call("result", write); // Simulated lost reply: discard transport response, retain operation.
  const recovered = await f.call("result", f.op("receipt", lease));
  assert.deepEqual(recovered.receipt, first.receipt);
  assert.equal(recovered.noteId, first.noteId);
  const replay = await f.call("result", write);
  assert.equal(replay.noteId, first.noteId);
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int AS n FROM records WHERE workspace_id=$1 AND kind='notes'",
        [f.workspace],
      )
    ).rows[0].n,
    1,
  );
  const original = (
    await pool().query("SELECT data,version FROM records WHERE id=$1", [f.task])
  ).rows[0];
  assert.deepEqual(original.data, f.taskData);
  assert.equal(original.version, 1);
  await assert.rejects(
    f.call("result", { ...write, result: { summary: "Replacement result" } }),
  );
  await pool().query(
    "UPDATE dataset_connections SET expires_at=now()-interval '1 second' WHERE draft_id=$1",
    [f.dataset],
  );
  await assert.rejects(f.call("result", f.op("receipt", lease)), {
    status: 401,
  });
});
test("owner edits and missing/expired/forged lease proofs prevent source effects", async () => {
  const f = await fixture();
  await f.call("assignment", f.op("intake"));
  const write = f.op("write", {
    runId: randomUUID(),
    leaseId: randomUUID(),
    crmOperationId: randomUUID(),
    result: { summary: "Candidate" },
  });
  const h = f.headers(write);
  delete (h as any)["x-bittrees-workflow-lease"];
  await assert.rejects(f.call("result", write, "running", h), { status: 403 });
  const expired = f.headers(
    write,
    "running",
    (_d, p) => (p.expiresAt = Date.now() - 1),
  );
  await assert.rejects(f.call("result", write, "running", expired), {
    status: 403,
  });
  await pool().query(
    "UPDATE records SET data=data||$2::jsonb,version=version+1 WHERE id=$1",
    [f.task, { description: "Owner edited instruction" }],
  );
  await assert.rejects(f.call("result", write));
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int AS n FROM crm_workflow_result_receipts WHERE assignment_id=$1",
        [f.assignment.assignmentId],
      )
    ).rows[0].n,
    0,
  );
});
for (const selected of [false, true]) {
  test(`completed-state finalization changes only status and reconciles once with ${selected ? "selected-task" : "project"} access`, async () => {
    const f = await fixture(true);
    if (selected) {
      await pool().query(
        "DELETE FROM dataset_project_permissions WHERE draft_id=$1",
        [f.dataset],
      );
      f.env.CRM_LEADS_ENABLED = "true";
      f.env.CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON = JSON.stringify([
        { ...f.binding, sourceConsent: "selected-tasks" },
      ]);
      const {
        requests: [request],
      } = await reviewTaskConsents(f.owner, f.dataset, f.env);
      await changeTaskConsent(
        f.owner,
        { action: "approve", datasetId: f.dataset, reviewId: request.reviewId },
        f.env,
      );
    }
    await f.call("assignment", f.op("intake"));
    const lease = {
        runId: randomUUID(),
        leaseId: randomUUID(),
        crmOperationId: randomUUID(),
      },
      result = { summary: "Validated source result" },
      digest = assignmentDigest(result);
    await f.call("result", f.op("write", { ...lease, result }));
    const complete = f.op("complete", {
      ...lease,
      operationId: randomUUID(),
      resultDigest: digest,
      expiresAt: Date.now() + 60000,
    });
    await assert.rejects(f.call("finalize", complete, "running"), {
      status: 403,
    });
    const first = await f.call("finalize", complete, "completed");
    assert.equal(first.task.status, "Done");
    assert.equal(first.task.taskVersion, 2);
    const current = (
      await pool().query("SELECT data,version FROM records WHERE id=$1", [
        f.task,
      ])
    ).rows[0];
    assert.deepEqual(current.data, { ...f.taskData, status: "Done" });
    assert.equal(current.version, 2);
    const recover = { ...complete, kind: "completion" };
    delete (recover as any).expiresAt;
    const again = await f.call("finalization", recover, "completed");
    assert.equal(again.task.replayed, true);
    assert.equal(again.task.taskVersion, 2);
    assert.equal(
      (await f.call("result", f.op("receipt", lease))).receipt.resultDigest,
      digest,
    );
  });
}
test("changed result notes and withdrawn status approval prevent completion without overwriting edits", async () => {
  const f = await fixture(true);
  await f.call("assignment", f.op("intake"));
  const lease = {
      runId: randomUUID(),
      leaseId: randomUUID(),
      crmOperationId: randomUUID(),
    },
    result = { summary: "Candidate reviewed before write" };
  const saved = await f.call("result", f.op("write", { ...lease, result }));
  await pool().query(
    "UPDATE records SET data=data||$2::jsonb,version=2 WHERE id=$1",
    [saved.noteId, { description: "Owner edited note" }],
  );
  const complete = f.op("complete", {
    ...lease,
    operationId: randomUUID(),
    resultDigest: assignmentDigest(result),
    expiresAt: Date.now() + 60000,
  });
  await assert.rejects(f.call("finalize", complete, "completed"), {
    status: 409,
  });
  assert.equal(
    (await pool().query("SELECT data FROM records WHERE id=$1", [saved.noteId]))
      .rows[0].data.description,
    "Owner edited note",
  );
  assert.equal(
    (await pool().query("SELECT data FROM records WHERE id=$1", [f.task]))
      .rows[0].data.status,
    "Open",
  );
});

test("explicit migration retains owner data and receipts without activating features or changing grants", async () => {
  const f = await fixture();
  await f.call("assignment", f.op("intake"));
  const first = await transaction(migrateWorkflowAssignments),
    second = await transaction(migrateWorkflowAssignments);
  assert.equal(first.crmContentAndMembershipsUnchanged, true);
  assert.equal(first.featureActivated, false);
  assert.equal(first.grantsChanged, false);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.equal(
    (await f.call("task", f.op("task"))).instruction,
    f.taskData.description,
  );
});

async function waitForSourceLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (
      await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
        [isolated],
      )
    ).rows[0];
    if (row.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Source request never reached the controlled workspace lock");
}
test("expiry while waiting for a workspace lock rolls back before saving a result", async () => {
  const f = await fixture();
  await f.call("assignment", f.op("intake"));
  const blocker = await admin.connect();
  let pending: Promise<any> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM " + isolated + ".workspaces WHERE id=$1 FOR UPDATE",
      [f.workspace],
    );
    const write = f.op("write", {
      runId: randomUUID(),
      leaseId: randomUUID(),
      crmOperationId: randomUUID(),
      result: { summary: "Must not commit after deadline" },
    });
    const expiresAt = Date.now() + 1500;
    const headers = f.headers(write, "running", (d, p) => {
      d.expiresAt = expiresAt;
      p.expiresAt = expiresAt;
    });
    pending = f.call("result", write, "running", headers);
    void pending.catch(() => {});
    await waitForSourceLock();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 40)),
    );
    await blocker.query("COMMIT");
    await assert.rejects(pending, (e: any) => [403, 409].includes(e.status));
    assert.equal(
      (
        await pool().query(
          "SELECT count(*)::int AS n FROM crm_workflow_result_receipts WHERE assignment_id=$1",
          [f.assignment.assignmentId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await pending.catch(() => {});
  }
});
test("owner membership revoked during a lock wait denies the pending write", async () => {
  const f = await fixture();
  await f.call("assignment", f.op("intake"));
  const blocker = await admin.connect();
  let pending: Promise<any> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SET LOCAL search_path TO " + isolated);
    await blocker.query(
      "SELECT id FROM " + isolated + ".workspaces WHERE id=$1 FOR UPDATE",
      [f.workspace],
    );
    const write = f.op("write", {
      runId: randomUUID(),
      leaseId: randomUUID(),
      crmOperationId: randomUUID(),
      result: { summary: "Must not commit after revocation" },
    });
    pending = f.call("result", write);
    void pending.catch(() => {});
    await waitForSourceLock();
    await blocker.query(
      "UPDATE " +
        isolated +
        ".members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
      [f.workspace, f.owner],
    );
    await blocker.query("COMMIT");
    await assert.rejects(pending, { status: 403 });
    assert.equal(
      (
        await pool().query(
          "SELECT count(*)::int AS n FROM crm_workflow_result_receipts WHERE assignment_id=$1",
          [f.assignment.assignmentId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await pending.catch(() => {});
  }
});

test("source proof expiry never outlives current dataset/project consent", async () => {
  const f = await fixture();
  const row = (
    await pool().query(
      "UPDATE dataset_project_permissions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE draft_id=$1 RETURNING expires_at",
      [f.dataset],
    )
  ).rows[0];
  const result = await f.call("assignment", f.op("intake"));
  assert.ok(
    result.envelope.proof.expiresAt <= new Date(row.expires_at).getTime(),
  );
  await pool().query(
    "UPDATE crm_workflow_assignments SET revoked_at=now() WHERE id=$1",
    [f.assignment.assignmentId],
  );
  await assert.rejects(f.call("task", f.op("task")), { status: 403 });
});

test("migration command refuses implicit application before opening a database", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./node_modules/tsx/dist/loader.mjs",
      "scripts/migrate-workflow-assignments.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/not-approved",
      },
    },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /No database was opened/);
});

test("schema migration lock denies an expired source request before any registration", async () => {
  const f = await fixture();
  const blocker = await admin.connect();
  let pending: Promise<any> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(73492017)");
    const intake = f.op("intake");
    const headers = f.headers(intake, "running", (decision) => {
      decision.expiresAt = Date.now() + 450;
    });
    pending = f.call("assignment", intake, "running", headers);
    void pending.catch(() => {});
    await waitForSourceLock();
    // The request must settle while the migration still owns its lock.
    await assert.rejects(pending, (e: any) => [403, 409].includes(e.status));
    assert.equal(
      (
        await pool().query(
          "SELECT count(*)::int AS n FROM crm_workflow_assignments WHERE id=$1",
          [f.assignment.assignmentId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await pending.catch(() => {});
  }
});

test("actual REST route uses protected source authority and rejects browser, oversized and malformed bodies", async () => {
  const f = await fixture();
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/[...path]/route");
  const old = Object.fromEntries(
    Object.keys(f.env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, f.env);
  const operation = f.op("intake");
  const body = JSON.stringify({
    version: 1,
    connectionId: f.binding.connectionId,
    kind: "assignment",
    operation,
  });
  const send = (
    content: any = body,
    headers: Record<string, string> = {},
    suffix = "",
    method = "POST",
  ) =>
    POST(
      new NextRequest(
        "http://127.0.0.1:3040/api/integrations/workflow-assignments" + suffix,
        {
          method,
          ...(method === "POST" ? { body: content } : {}),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + f.bearer,
            ...f.headers(operation),
            ...headers,
          },
        },
      ),
    );
  try {
    const response = await send();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).assignment, f.assignment);
    assert.equal(
      (await send(body, { origin: "https://crm.bittrees.org" })).status,
      403,
    );
    assert.equal((await send(body, { cookie: "" })).status, 403);
    assert.equal((await send(body, {}, "?other=1")).status, 403);
    assert.equal((await send(body, {}, "", "GET")).status, 405);
    assert.equal((await send("x".repeat(24001))).status, 413);
    assert.equal((await send(new Uint8Array([255, 254]))).status, 400);
    assert.equal(
      (await send(body, { "content-encoding": "gzip" })).status,
      415,
    );
    await pool().query(
      "UPDATE dataset_project_permissions SET tasks=false WHERE draft_id=$1",
      [f.dataset],
    );
    assert.equal((await send()).status, 403);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("owner approval permits only the selected task revisions and revocation stops the next protected operation", async () => {
  const f = await fixture(true);
  const extra = async (name: string) => {
    const taskId = randomUUID();
    await pool().query(
      "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'tasks',$3)",
      [taskId, f.workspace, { ...f.taskData, name }],
    );
    return { ...f.assignment, taskId, assignmentId: randomUUID() };
  };
  const second = await extra("Second intake"),
    third = await extra("Outside review");
  const scope = {
    ...f.binding,
    sourceConsent: "selected-tasks",
    assignments: [f.assignment, second],
  };
  const env = {
    ...f.env,
    CRM_LEADS_ENABLED: "true",
    CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON: JSON.stringify([scope]),
  };
  const call = (
    target: typeof f.assignment,
    kind: "assignment" | "task",
    opKind: "intake" | "task",
    current = env,
  ) => {
    const operation = { kind: opKind, assignmentId: target.assignmentId };
    return workflowAssignmentSource(
      f.bearer,
      { version: 1, connectionId: f.binding.connectionId, kind, operation },
      f.headers(operation, "running", undefined, target),
      current,
    );
  };
  await pool().query(
    "DELETE FROM dataset_project_permissions WHERE draft_id=$1",
    [f.dataset],
  );
  await assert.rejects(call(f.assignment, "assignment", "intake"), {
    status: 403,
  });
  const {
    requests: [request],
  } = await reviewTaskConsents(f.owner, f.dataset, env);
  assert.deepEqual(
    request.tasks.map((t) => t.id).sort(),
    [f.task, second.taskId].sort(),
  );
  const decision = {
    datasetId: f.dataset,
    action: "approve",
    reviewId: request.reviewId,
  };
  await assert.rejects(changeTaskConsent(randomUUID(), decision, env));
  await changeTaskConsent(f.owner, decision, env);
  for (const a of scope.assignments) {
    await call(a, "assignment", "intake");
    assert.equal(
      (await call(a, "task", "task")).instruction,
      f.taskData.description,
    );
  }
  await assert.rejects(call(third, "assignment", "intake"), { status: 403 });
  const changed = {
    ...env,
    CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON: JSON.stringify([
      { ...scope, assignments: [...scope.assignments, third] },
    ]),
  };
  await assert.rejects(call(third, "assignment", "intake", changed), {
    status: 403,
  });
  await assert.rejects(changeTaskConsent(f.owner, decision, changed), {
    status: 403,
  });
  await pool().query("UPDATE records SET version=version+1 WHERE id=$1", [
    second.taskId,
  ]);
  await assert.rejects(call(second, "task", "task"), { status: 403 });
  await changeTaskConsent(f.owner, { ...decision, action: "revoke" }, env);
  await assert.rejects(call(f.assignment, "task", "task"), { status: 403 });
  assert.equal(
    (await reviewTaskConsents(f.owner, f.dataset, env)).active.length,
    0,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int AS n FROM dataset_project_permissions WHERE draft_id=$1",
        [f.dataset],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int AS n FROM crm_workflow_assignments WHERE id=$1",
        [third.assignmentId],
      )
    ).rows[0].n,
    0,
  );
});

test("credential rotation and a dedicated backlog connection cannot inherit task approval", async () => {
  const f = await fixture();
  const scope = { ...f.binding, sourceConsent: "selected-tasks" };
  const env = {
    ...f.env,
    CRM_LEADS_ENABLED: "true",
    CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON: JSON.stringify([scope]),
  };
  const review = () => reviewTaskConsents(f.owner, f.dataset, env);
  const first = (await review()).requests[0];
  const decision = {
    datasetId: f.dataset,
    reviewId: first.reviewId,
    action: "approve",
  };
  await changeTaskConsent(f.owner, decision, env);
  await transaction(migrateWorkflowAssignments);
  assert.equal((await review()).active[0].request?.reviewId, first.reviewId);
  const op = f.op("intake");
  const call = (bearer: string) =>
    workflowAssignmentSource(
      bearer,
      {
        version: 1,
        connectionId: f.binding.connectionId,
        kind: "assignment",
        operation: op,
      },
      f.headers(op),
      env,
    );
  await pool().query(
    "UPDATE dataset_connections SET token_hash=$2 WHERE draft_id=$1",
    [f.dataset, hash("a".repeat(64))],
  );
  await assert.rejects(call(f.bearer), { status: 403 });
  await assert.rejects(call("a".repeat(64)), { status: 403 });
  const changed = await review();
  assert.notEqual(changed.requests[0].reviewId, first.reviewId);
  assert.equal(changed.active[0].request, null);
  await pool().query(
    "INSERT INTO crm_backlog_consents(owner_id,lease_id,draft_id,request_digest,envelope,expires_at) VALUES ($1,$2,$3,'fixture','{}',now()+interval '1 day')",
    [f.owner, randomUUID(), f.dataset],
  );
  assert.equal((await review()).requests.length, 0);
  await assert.rejects(
    changeTaskConsent(
      f.owner,
      { ...decision, reviewId: changed.requests[0].reviewId },
      env,
    ),
    { status: 403 },
  );
  const unavailable = {
    ...env,
    CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON: "invalid",
  };
  assert.equal(
    (await reviewTaskConsents(f.owner, f.dataset, unavailable)).active[0]
      .request,
    null,
  );
  await changeTaskConsent(
    f.owner,
    { ...decision, action: "revoke" },
    unavailable,
  );
  assert.equal((await review()).active.length, 0);
});
