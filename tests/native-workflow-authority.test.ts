import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { pool, schema } from "../lib/db";
import { nativeWorkflowSchema } from "../lib/native-workflow-schema";
import { currentNativeWorkflowScopes, nativeWorkflowAuthority } from "../lib/native-workflow-authority";
import { canonical } from "../shared/signed-action.mjs";
import { PERSONAL_WORKFLOW_ENDPOINT } from "../shared/personal-workflow-authority.mjs";
import { nativeWorkflowEndpoint, nativeWorkflowRequestMessage, verifyNativeWorkflowDecision } from "../shared/native-workflow-authority.mjs";

const roles = generateKeyPairSync("ed25519"), crm = generateKeyPairSync("ed25519");
const pem = (k: typeof roles.publicKey) => k.export({ type: "spki", format: "pem" }).toString();
const env = { ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY: pem(roles.publicKey), ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY: crm.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ROLES_FEED_SUBJECT_SECRET: "synthetic-native-workflow-subject-secret-only" };
let isolated: string, originalUrl: string;
before(async () => {
  assert(process.env.DATABASE_URL?.endsWith("/crm_test")); originalUrl = process.env.DATABASE_URL!;
  isolated = "native_workflow_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: originalUrl }); await admin.connect();
  try { await admin.query('CREATE SCHEMA "' + isolated + '"'); } finally { await admin.end(); }
  const url = new URL(originalUrl); url.searchParams.set("options", "-csearch_path=" + isolated); process.env.DATABASE_URL = url.toString();
  await pool().query(schema); await pool().query(nativeWorkflowSchema);
});
after(async () => { await pool().end(); const admin = new pg.Client({ connectionString: originalUrl }); await admin.connect(); try { await admin.query('DROP SCHEMA "' + isolated + '" CASCADE'); } finally { await admin.end(); } });
const wallet = () => ({ kind: "wallet", value: "0x" + randomUUID().replaceAll("-", "") + "12345678" });
async function fixture(role = "viewer", restrictions: string[] | null = null) {
  const user = randomUUID(), workspace = randomUUID(), identity = wallet();
  await pool().query("INSERT INTO users(id,name) VALUES($1,'Private subject name')", [user]);
  await pool().query("INSERT INTO identities(kind,value,user_id) VALUES('ethereum',$1,$2)", [identity.value, user]);
  await pool().query("INSERT INTO workspaces(id,name) VALUES($1,'Private workspace name')", [workspace]);
  await pool().query("INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,$3,$4)", [workspace, user, role, restrictions]);
  return { user, workspace, identity };
}
function packet(identity = wallet(), action = "list", scopeId: string | null = null) {
  const now = Date.now();
  const workflowRequest = { version: 1, source: "workflow.bittrees.org", audience: PERSONAL_WORKFLOW_ENDPOINT, identity, project: "crm", action, scopeId, workflowId: ["list", "create"].includes(action) ? null : "workflow-test", operationId: randomUUID(), parametersDigest: "a".repeat(64), issuedAt: now, requestId: randomUUID() };
  const request = { version: 1, issuer: "https://roles.bittrees.org", audience: nativeWorkflowEndpoint("crm"), project: "crm", workflowRequest, policyDigest: "b".repeat(64), requestId: randomUUID(), issuedAt: now, expiresAt: now + 5000 };
  return signed(request);
}
function signed(request: any) { return { request, signature: sign(null, Buffer.from(nativeWorkflowRequestMessage(request)), roles.privateKey).toString("base64") }; }
async function call(p: ReturnType<typeof packet>, config = env) {
  return nativeWorkflowAuthority(new Request(nativeWorkflowEndpoint("crm"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }), config);
}
async function scopes(identity: ReturnType<typeof wallet>, action = "list", selected: string | null = null) {
  const p = packet(identity, action, selected), response = await call(p); assert.equal(response.status, 200);
  const result = await response.json(); return verifyNativeWorkflowDecision(result, p.request, pem(crm.publicKey)).scopes;
}
test("signed subject-only proof; nonmember gets signed current empty scopes; anonymous denied", async () => {
  const f = await fixture("owner"), found = await scopes(f.identity); assert.equal(found.length, 1); assert.equal(found[0].roleId, "workspace.owner");
  const text = JSON.stringify(found); for (const secret of [f.user, f.workspace, f.identity.value, "Private"]) assert(!text.includes(secret));
  assert.equal((await scopes(wallet())).length, 0);
  assert.equal((await nativeWorkflowAuthority(new Request(nativeWorkflowEndpoint("crm"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env)).status, 401);
});
test("signature, audience, domain, freshness and nested action/input/operation mismatches reject", async () => {
  for (const mutate of [
    (p: any) => p.request.audience = "https://autonote.bittrees.org/api/roles/workflow-authority",
    (p: any) => p.request.issuer = "https://untrusted.invalid",
    (p: any) => p.request.workflowRequest.parametersDigest = "c".repeat(64),
    (p: any) => p.request.workflowRequest.operationId = randomUUID(),
    (p: any) => p.request.workflowRequest.identity = wallet(),
    (p: any) => p.request.workflowRequest.action = "execute",
  ]) { const p = packet(); mutate(p); assert.equal((await call(p)).status, 401); }
  const p = packet(); p.request.expiresAt = Date.now() - 1; assert.equal((await call(signed(p.request))).status, 401);
  const future = packet(); future.request.issuedAt += 2000; future.request.expiresAt += 2000; assert.equal((await call(signed(future.request))).status, 401);
  const domain = packet(); domain.signature = sign(null, Buffer.from(canonical(domain.request)), roles.privateKey).toString("base64"); assert.equal((await call(domain)).status, 401);
});
test("atomic durable replay claim allows only one concurrent result and rejects later retry", async () => {
  const p = packet(), responses = await Promise.all([call(p), call(p)]); assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await call(p)).status, 409);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); try { assert.equal((await db.query("SELECT count(*)::int AS n FROM native_workflow_requests WHERE request_id=$1", [p.request.requestId])).rows[0].n, 1); } finally { await db.end(); }
});
test("exact selected scope only; revoked/recreated memberships and restored roles never revive old scopes", async () => {
  const f = await fixture(), original = (await scopes(f.identity))[0].id;
  assert.equal((await scopes(f.identity, "create", original)).length, 1);
  await pool().query("DELETE FROM members WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.user]); assert.equal((await scopes(f.identity, "execute", original)).length, 0);
  await pool().query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [f.workspace, f.user]);
  const recreated = (await scopes(f.identity))[0].id; assert.notEqual(recreated, original); assert.equal((await scopes(f.identity, "manage", original)).length, 0);
  await pool().query("UPDATE members SET role='owner' WHERE user_id=$1", [f.user]); await pool().query("UPDATE members SET role='viewer' WHERE user_id=$1", [f.user]); assert.notEqual((await scopes(f.identity))[0].id, recreated);
});
test("NULL, empty and full record restrictions are bound without disclosure", async () => {
  const f = await fixture(), unrestricted = (await scopes(f.identity))[0];
  await pool().query("UPDATE members SET scope_ids='{}' WHERE user_id=$1", [f.user]); const empty = (await scopes(f.identity))[0]; assert.notEqual(empty.restrictionsDigest, unrestricted.restrictionsDigest);
  const record = randomUUID(); await pool().query("UPDATE members SET scope_ids=$1 WHERE user_id=$2", [[record], f.user]); const restricted = (await scopes(f.identity))[0];
  assert.equal(restricted.restrictionsDigest, createHash("sha256").update(canonical({ scope_ids: [record] })).digest("hex")); assert(!JSON.stringify(restricted).includes(record));
});
test("ownership transfer invalidates other members' scopes and supplied generations are ignored", async () => {
  const f = await fixture("viewer"), owner = randomUUID(); await pool().query("INSERT INTO users(id,name) VALUES($1,'Other owner')", [owner]); await pool().query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [f.workspace, owner]);
  const prior = (await scopes(f.identity))[0].id;
  await pool().query("UPDATE members SET role='editor' WHERE user_id=$1", [owner]); assert.notEqual((await scopes(f.identity))[0].id, prior);
  const generation = (await pool().query("SELECT authority_generation FROM members WHERE user_id=$1", [f.user])).rows[0].authority_generation;
  await pool().query("UPDATE members SET authority_generation=$1 WHERE user_id=$2", [randomUUID(), f.user]); assert.equal((await pool().query("SELECT authority_generation FROM members WHERE user_id=$1", [f.user])).rows[0].authority_generation, generation);
});
test("linked email stays email-scoped; removing exact identity and merging accounts denies", async () => {
  const f = await fixture("owner"), email = { kind: "email", value: randomUUID() + "@example.invalid" };
  await pool().query("INSERT INTO identities(kind,value,user_id) VALUES('email',$1,$2)", [email.value, f.user]);
  const emailScopes = await scopes(email), walletScopes = await scopes(f.identity); assert.equal(emailScopes[0].roleId, "workspace.owner"); assert.notEqual(emailScopes[0].id, walletScopes[0].id);
  await pool().query("DELETE FROM identities WHERE value=$1", [email.value]); assert.equal((await scopes(email)).length, 0); assert.equal((await scopes(f.identity)).length, 1);
  const target = randomUUID(); await pool().query("INSERT INTO users(id,name) VALUES($1,'Merged target')", [target]); await pool().query("UPDATE users SET merged_into=$1 WHERE id=$2", [target, f.user]); assert.equal((await scopes(f.identity)).length, 0);
});
test("migration idempotence and schema-specific trigger installation; source configuration outage fails closed", async () => {
  const f = await fixture(), prior = (await scopes(f.identity))[0].id; await pool().query(nativeWorkflowSchema); assert.equal((await scopes(f.identity))[0].id, prior);
  assert.equal((await pool().query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='members'::regclass AND tgname IN ('crm_native_member_generation','crm_native_workspace_generation')")).rows[0].n, 2);
  assert.equal((await call(packet(), { ...env, ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY: "" })).status, 503);
  assert.equal((await call(packet(), { ...env, ROLES_FEED_SUBJECT_SECRET: "" })).status, 503);
});
test("more than 100 memberships fails closed rather than returning a truncated grant", async () => {
  const f = await fixture(); await pool().query("INSERT INTO workspaces(id,name) SELECT gen_random_uuid(),'Private' FROM generate_series(1,100)");
  await pool().query("INSERT INTO members(workspace_id,user_id,role) SELECT id,$1,'viewer' FROM workspaces WHERE name='Private'", [f.user]); assert.equal((await call(packet(f.identity))).status, 503);
});
test("upserts/recovery and workspace moves generate new scopes; absent database capability fails closed", async () => {
  const f = await fixture(), old = (await scopes(f.identity))[0].id;
  await pool().query("INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,'viewer',NULL) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role,scope_ids=EXCLUDED.scope_ids", [f.workspace, f.user]);
  assert.equal((await scopes(f.identity))[0].id, old, "unchanged upsert preserves membership generation");
  const moved = randomUUID(); await pool().query("INSERT INTO workspaces(id,name) VALUES($1,'Moved private workspace')", [moved]);
  await pool().query("UPDATE members SET workspace_id=$1 WHERE user_id=$2", [moved, f.user]); assert.equal((await scopes(f.identity, "create", old)).length, 0);
  await pool().query("ALTER TABLE members RENAME TO temporarily_unavailable_members");
  const p = packet(f.identity);
  try { assert.equal((await call(p)).status, 503); } finally { await pool().query("ALTER TABLE temporarily_unavailable_members RENAME TO members"); }
  assert.equal((await call(p)).status, 409, "failed authority read must not revive the one-use request");
});
test("in-flight membership changes time out closed; committed revocation denies old scope", async () => {
  const f = await fixture(), old = (await scopes(f.identity))[0].id;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); await db.query("BEGIN");
  try {
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [f.workspace]);
    await db.query("DELETE FROM members WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.user]);
    assert.equal((await call(packet(f.identity, "execute", old))).status, 503);
    await db.query("COMMIT");
  } finally { await db.query("ROLLBACK"); await db.end(); }
  assert.equal((await scopes(f.identity, "execute", old)).length, 0);
});
test("unrelated nonowner adds, restriction edits and removals preserve another member scope; owner away/back does not", async () => {
  const f = await fixture("owner"), other = randomUUID(), old = (await scopes(f.identity))[0].id;
  await pool().query("INSERT INTO users(id,name) VALUES($1,'Other private member')", [other]);
  await pool().query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [f.workspace, other]); assert.equal((await scopes(f.identity))[0].id, old);
  await pool().query("UPDATE members SET role='editor',scope_ids='{}' WHERE user_id=$1", [other]); assert.equal((await scopes(f.identity))[0].id, old);
  await pool().query("DELETE FROM members WHERE user_id=$1", [other]); assert.equal((await scopes(f.identity))[0].id, old);
  await pool().query("UPDATE members SET role='editor' WHERE user_id=$1", [f.user]); await pool().query("UPDATE members SET role='owner' WHERE user_id=$1", [f.user]); assert.notEqual((await scopes(f.identity))[0].id, old);
});
test("trigger uses its installed schema even when a temporary workspaces table shadows search_path", async () => {
  const f = await fixture("owner"), db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    const before = (await db.query('SELECT authority_generation FROM "' + isolated + '".workspaces WHERE id=$1', [f.workspace])).rows[0].authority_generation;
    await db.query("CREATE TEMP TABLE workspaces(id uuid,authority_generation uuid,read_revision bigint)");
    await db.query("UPDATE members SET role='editor' WHERE user_id=$1", [f.user]);
    const after = (await db.query('SELECT authority_generation FROM "' + isolated + '".workspaces WHERE id=$1', [f.workspace])).rows[0].authority_generation;
    assert.notEqual(after, before);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM workspaces")).rows[0].n, 0);
  } finally { await db.end(); }
});
test("direct identity deletion/rebinding between user lookup and identity recheck cannot produce old account scopes", async () => {
  for (const mutation of ["delete", "rebind"]) {
    const f = await fixture("owner"), target = await fixture("viewer"), old = (await scopes(f.identity))[0].id;
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); await db.query("BEGIN");
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => release = r), entered = new Promise<void>(r => started = r);
    const pending = currentNativeWorkflowScopes({ query: async (sql: any, values: any) => {
      const result = await db.query(sql, values);
      if (String(sql).startsWith("SELECT u.id")) { started(); await gate; }
      return result;
    } } as any, f.identity, env, Date.now() + 5000);
    try {
      await entered;
      if (mutation === "delete") await pool().query("DELETE FROM identities WHERE value=$1", [f.identity.value]);
      else await pool().query("UPDATE identities SET user_id=$1 WHERE value=$2", [target.user, f.identity.value]);
      release(); assert.deepEqual(await pending, []); await db.query("COMMIT");
      assert.equal((await scopes(f.identity, "execute", old)).length, 0);
    } finally { release(); await pending.catch(() => {}); await db.query("ROLLBACK"); await db.end(); }
  }
});
test("locked identity prevents concurrent direct revocation/rebind through the authority snapshot", async () => {
  for (const mutation of ["DELETE FROM identities WHERE value=$1", "UPDATE identities SET user_id=$2 WHERE value=$1"]) {
    const f = await fixture(), target = await fixture(), db = new pg.Client({ connectionString: process.env.DATABASE_URL }), admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect(); await admin.connect(); await db.query("BEGIN");
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => release = r), entered = new Promise<void>(r => started = r);
    const pending = currentNativeWorkflowScopes({ query: async (sql: any, values: any) => {
      const result = await db.query(sql, values);
      if (String(sql).startsWith("SELECT verified_at,extract")) { started(); await gate; }
      return result;
    } } as any, f.identity, env, Date.now() + 5000);
    try {
      await entered; await admin.query("SET lock_timeout='200ms'");
      await assert.rejects(admin.query(mutation, mutation.includes("$2") ? [f.identity.value, target.user] : [f.identity.value]), (error: any) => error.code === "55P03");
      release(); assert.equal((await pending).length, 1); await db.query("COMMIT");
      await admin.query("DELETE FROM identities WHERE value=$1", [f.identity.value]); assert.deepEqual(await scopes(f.identity), []);
    } finally { release(); await pending.catch(() => {}); await db.query("ROLLBACK"); await db.end(); await admin.end(); }
  }
});
test("identity verification generation preserves PostgreSQL microsecond precision", async () => {
  const f = await fixture(), old = (await scopes(f.identity))[0].id;
  await pool().query("UPDATE identities SET verified_at=verified_at+interval '1 microsecond' WHERE value=$1", [f.identity.value]);
  assert.notEqual((await scopes(f.identity))[0].id, old);
});
