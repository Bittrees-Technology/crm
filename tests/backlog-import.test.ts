import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { pool, schema, transaction } from "../lib/db";
import { configureProject, projectAgent } from "../lib/project-automation";
import { backlogImportInput } from "../lib/backlog-import";
const owner = randomUUID(),
  workspace = randomUUID(),
  project = randomUUID(),
  dataset = randomUUID();
const isolated = "backlog_test_" + randomUUID().replaceAll("-", "");
let admin: Pool;
const call = (name: string, args: any) =>
  transaction((db) =>
    projectAgent(db, { id: dataset, user_id: owner }, name, args),
  );
const base = {
  projectId: project,
  source: "https://agent.bittrees.org",
  sourceId: "agent-readiness:agent:agent-test",
  title: "Acceptance task",
  description: "Test criteria",
  sourceUrl: "https://agent.bittrees.org/readiness#agent-test",
  sourceStatus: "blocked",
  sourcePriority: "P1",
  contentHash: "a".repeat(64),
};
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/crm_test"
  )
    throw Error("Backlog integration tests require local crm_test");
  admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${isolated}`);
  url.searchParams.set("options", `-c search_path=${isolated}`);
  process.env.DATABASE_URL = url.href;
  process.env.CRM_LEADS_ENABLED = "true";
  await pool().query(schema);
  await pool().query("INSERT INTO users(id,name) VALUES($1,$2)", [
    owner,
    "Synthetic backlog owner",
  ]);
  await pool().query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    workspace,
    "Synthetic backlog",
  ]);
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [workspace, owner],
  );
  await pool().query(
    "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'projects',$3)",
    [project, workspace, { name: "Agent" }],
  );
  await pool().query(
    "INSERT INTO lead_drafts(id,user_id,name) VALUES($1,$2,$3)",
    [dataset, owner, "Synthetic connection"],
  );
  await pool().query(
    "INSERT INTO dataset_connections(draft_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
    [dataset, owner, "test-hash"],
  );
});
after(async () => {
  await pool().end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${isolated} CASCADE`);
    await admin.end();
  }
});
test("backlog import requires a separate grant and exact reviewed site mapping", async () => {
  await configureProject(owner, {
    datasetId: dataset,
    projectId: project,
    autoLeads: false,
    tasks: true,
  });
  await assert.rejects(
    call("tasks.import_source", { ...base, operationId: randomUUID() }),
    { status: 403 },
  );
  await assert.rejects(
    configureProject(owner, {
      datasetId: dataset,
      projectId: project,
      autoLeads: false,
      tasks: false,
      backlogSourceProjectId: "wallet",
    }),
  );
  await configureProject(owner, {
    datasetId: dataset,
    projectId: project,
    autoLeads: false,
    tasks: false,
    backlogSourceProjectId: "agent",
  });
  await assert.rejects(
    call("tasks.import_source", {
      ...base,
      sourceId: "agent-readiness:tcp:task",
      sourceUrl: "https://agent.bittrees.org/readiness#task",
      operationId: randomUUID(),
    }),
    { status: 403 },
  );
  assert.throws(() =>
    backlogImportInput.parse({
      ...base,
      operationId: randomUUID(),
      ownerId: owner,
    }),
  );
  assert.throws(() =>
    backlogImportInput.parse({
      ...base,
      operationId: randomUUID(),
      sourceUrl: "https://evil.example/task",
    }),
  );
  const listed = await call("projects.list", {});
  assert.equal((listed as any).projects[0].backlogSourceProjectId, "agent");
});
test("concurrent exact retry produces one ordinary task and changed retry conflicts", async () => {
  const args = { ...base, operationId: randomUUID() };
  const results: any[] = await Promise.all([
    call("tasks.import_source", args),
    call("tasks.import_source", args),
  ]);
  assert.equal(results[0].taskId, results[1].taskId);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  const task = (
    await pool().query("SELECT * FROM records WHERE id=$1", [results[0].taskId])
  ).rows[0];
  assert.equal(task.data.category, "Production backlog");
  assert.equal(task.data.ownerId, owner);
  assert.equal(task.data.status, "Open");
  await assert.rejects(
    call("tasks.import_source", { ...args, title: "changed" }),
    { status: 409 },
  );
});
test("updates preserve CRM completion/schedule and conflict with source-field edits", async () => {
  const status: any = await call("tasks.import_source_status", {
    projectId: project,
    source: base.source,
    sourceId: base.sourceId,
  });
  await pool().query(
    "UPDATE records SET data=data||$2::jsonb,version=version+1 WHERE id=$1",
    [status.taskId, { status: "Done", dueDate: "2027-01-01" }],
  );
  await assert.rejects(
    call("tasks.import_source", {
      ...base,
      operationId: randomUUID(),
      contentHash: "b".repeat(64),
      expectedVersion: status.version,
    }),
    { status: 409 },
  );
  const current: any = await call("tasks.import_source_status", {
    projectId: project,
    source: base.source,
    sourceId: base.sourceId,
  });
  const saved: any = await call("tasks.import_source", {
    ...base,
    operationId: randomUUID(),
    contentHash: "b".repeat(64),
    title: "Updated source",
    expectedVersion: current.version,
  });
  const task = (
    await pool().query("SELECT * FROM records WHERE id=$1", [saved.taskId])
  ).rows[0];
  assert.equal(task.data.status, "Done");
  assert.equal(task.data.dueDate, "2027-01-01");
  await pool().query(
    "UPDATE records SET data=data||$2::jsonb,version=version+1 WHERE id=$1",
    [saved.taskId, { description: "Human edit" }],
  );
  const edited: any = await call("tasks.import_source_status", {
    projectId: project,
    source: base.source,
    sourceId: base.sourceId,
  });
  assert.equal(edited.conflict, true);
  await assert.rejects(
    call("tasks.import_source", {
      ...base,
      operationId: randomUUID(),
      contentHash: "c".repeat(64),
      expectedVersion: edited.version,
    }),
    { status: 409 },
  );
});
test("revocation blocks both reads and writes without changing tasks", async () => {
  await configureProject(owner, {
    datasetId: dataset,
    projectId: project,
    autoLeads: false,
    tasks: false,
  });
  await assert.rejects(
    call("tasks.import_source_status", {
      projectId: project,
      source: base.source,
      sourceId: base.sourceId,
    }),
    { status: 403 },
  );
  await assert.rejects(
    call("tasks.import_source", { ...base, operationId: randomUUID() }),
    { status: 403 },
  );
});
