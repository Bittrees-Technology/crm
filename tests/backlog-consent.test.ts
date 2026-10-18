import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign, createHash } from "node:crypto";
import { Pool } from "pg";
import { pool, schema } from "../lib/db";
import { backlogConsentSchema } from "../lib/backlog-consent-schema";
import { backlogConsent } from "../lib/backlog-consent";
import { datasetMcp } from "../lib/dataset-mcp";
import { datasetConnect } from "../lib/datasets";
import { configureProject } from "../lib/project-automation";
import { backlogSources } from "../lib/backlog-sources";
import { canonical } from "../lib/source-handoff/roles-proof.mjs";
import { openSourceHandoff } from "../lib/source-handoff/source-handoff.mjs";
const owner = randomUUID(),
  workspace = randomUUID(),
  leaseId = randomUUID();
const isolated = "consent_test_" + randomUUID().replaceAll("-", "");
let admin: Pool;
const roles = generateKeyPairSync("ed25519"),
  crm = generateKeyPairSync("ed25519"),
  operator = generateKeyPairSync("rsa", { modulusLength: 3072 });
const pub = (k: any) => k.export({ type: "spki", format: "pem" }).toString(),
  priv = (k: any) => k.export({ type: "pkcs8", format: "pem" }).toString();
const manifest = {
  feedRevision: "a".repeat(64),
  sourceWorkspace: workspace,
  mappings: Object.entries(backlogSources)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([sourceProjectId, s]) => ({
      sourceProjectId,
      crmProjectId: randomUUID(),
      siteUrl: s.url,
    })),
};
const mappingDigest = createHash("sha256")
  .update(canonical(manifest))
  .digest("hex");
const config = {
  ownerId: owner,
  ownerWallet: "0x" + "1".repeat(40),
  tenant: "roles:" + randomUUID(),
  principal: "agent:" + randomUUID(),
  credentialId: "b".repeat(64),
  runtimeBindingDigest: "c".repeat(64),
  leaseId,
  policyDigest: "d".repeat(64),
  manifest,
  mappingDigest,
};
const now = Date.now() - 1000;
const receipt = {
  version: 1,
  issuer: "https://roles.bittrees.org",
  audience: "https://mcp.bittrees.org",
  leaseId,
  policyDigest: config.policyDigest,
  principal: config.principal,
  credentialId: config.credentialId,
  runtimeBindingDigest: config.runtimeBindingDigest,
  tenant: config.tenant,
  workspace: "crm:" + workspace,
  sourceWorkspace: workspace,
  activatedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 3600000).toISOString(),
  renewable: false,
};
const leaseReceipt = {
  receipt,
  signature: sign(
    null,
    Buffer.from(
      "Bittrees MCP lease activation receipt v1\n" + canonical(receipt),
    ),
    roles.privateKey,
  ).toString("base64"),
};
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname != "/crm_test"
  )
    throw Error("Local crm_test required");
  admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${isolated}`);
  url.searchParams.set("options", `-c search_path=${isolated}`);
  process.env.DATABASE_URL = url.href;
  process.env.CRM_LEADS_ENABLED = "true";
  process.env.CRM_BACKLOG_HANDOFF_ENABLED = "true";
  process.env.CRM_BACKLOG_HANDOFF_CONFIG = JSON.stringify(config);
  process.env.CRM_BACKLOG_ROLES_PUBLIC_KEY = pub(roles.publicKey);
  process.env.CRM_MCP_HANDOFF_RECIPIENT_PUBLIC_KEY = pub(operator.publicKey);
  process.env.CRM_MCP_HANDOFF_SIGNING_PRIVATE_KEY = priv(crm.privateKey);
  await pool().query(schema);
  await pool().query(backlogConsentSchema);
  await pool().query(
    "INSERT INTO users(id,name) VALUES($1,'Synthetic owner')",
    [owner],
  );
  await pool().query(
    "INSERT INTO identities(kind,value,user_id) VALUES('ethereum',$1,$2)",
    [config.ownerWallet, owner],
  );
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')",
    [workspace],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [workspace, owner],
  );
  for (const m of manifest.mappings)
    await pool().query(
      "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'projects',$3)",
      [m.crmProjectId, workspace, { name: m.sourceProjectId }],
    );
});
after(async () => {
  await pool().end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${isolated} CASCADE`);
    await admin.end();
  }
});
test("review is read only; invalid signatures and wrong owners cannot consent", async () => {
  const result = await backlogConsent(owner, { leaseReceipt });
  assert.equal(result.review.projects.length, 11);
  assert.equal(
    (await pool().query("SELECT count(*) FROM dataset_connections")).rows[0]
      .count,
    "0",
  );
  await assert.rejects(
    backlogConsent(randomUUID(), { leaseReceipt, confirmed: true }),
    { status: 403 },
  );
  await assert.rejects(
    backlogConsent(owner, {
      leaseReceipt: {
        ...leaseReceipt,
        receipt: { ...receipt, credentialId: "e".repeat(64) },
      },
      confirmed: true,
    }),
    { status: 403 },
  );
});
test("concurrent consent creates one sealed dedicated connection; exact retry does not renew", async () => {
  const [a, b] = await Promise.all([
    backlogConsent(owner, { leaseReceipt, confirmed: true }),
    backlogConsent(owner, { leaseReceipt, confirmed: true }),
  ]);
  assert.deepEqual(a.envelope, b.envelope);
  assert.equal(
    (await pool().query("SELECT count(*) FROM dataset_connections")).rows[0]
      .count,
    "1",
  );
  const envelope: any = a.envelope;
  const opener = process.env.MCP_HANDOFF_MODULE
    ? (await import(process.env.MCP_HANDOFF_MODULE)).openSourceHandoff
    : openSourceHandoff;
  const opened = opener({
    envelope,
    expectedMetadata: {
      version: 1,
      issuer: "https://crm.bittrees.org",
      audience: "https://mcp.bittrees.org",
      handoffId: envelope.metadata.handoffId,
      connectionId: envelope.metadata.connectionId,
      leaseId,
      policyDigest: config.policyDigest,
      tenant: config.tenant,
      workspace: "crm:" + workspace,
      principal: config.principal,
      credentialId: config.credentialId,
      runtimeBindingDigest: config.runtimeBindingDigest,
      sourceWorkspace: workspace,
      mappingDigest,
      activatedAt: receipt.activatedAt,
      expiresAt: receipt.expiresAt,
      recipientKeyId: createHash("sha256")
        .update(operator.publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
    },
    recipientPrivateKey: priv(operator.privateKey),
    signingPublicKey: pub(crm.publicKey),
  });
  assert.equal(opened.expiresAt, Date.parse(receipt.expiresAt));
  assert.equal(JSON.stringify(a).includes(opened.token), false);
  const row = (await pool().query("SELECT * FROM dataset_connections")).rows[0];
  assert.equal(
    row.token_hash,
    createHash("sha256").update(opened.token).digest("hex"),
  );
  assert.equal(new Date(row.expires_at).toISOString(), receipt.expiresAt);
  const grants = (
    await pool().query("SELECT * FROM dataset_project_permissions")
  ).rows;
  assert.equal(grants.length, 11);
  assert.ok(
    grants.every(
      (g) =>
        !g.tasks &&
        !g.auto_leads &&
        !g.qualification &&
        new Date(g.expires_at).toISOString() === receipt.expiresAt,
    ),
  );
  const call = async (name: string, args: any) =>
    datasetMcp(
      opened.token,
      {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      },
      "2025-06-18",
    );
  const listed: any = await call("projects.list", {});
  assert.equal(JSON.parse(listed.result.content[0].text).projects.length, 11);
  for (const m of manifest.mappings)
    for (let i = 0; i < 6; i++) {
      const id = "synthetic-" + i;
      const args = {
        projectId: m.crmProjectId,
        source: "https://agent.bittrees.org",
        sourceId: `agent-readiness:${m.sourceProjectId}:${id}`,
        sourceUrl: `https://agent.bittrees.org/readiness#${id}`,
        operationId: randomUUID(),
        title: "Synthetic backlog task",
        description: "Synthetic consent integration",
        sourceStatus: "todo",
        sourcePriority: "P2",
        contentHash: "f".repeat(64),
      };
      const first: any = await call("tasks.import_source", args),
        again: any = await call("tasks.import_source", args);
      assert.ok(!first.result.isError, first.result.content[0].text);
      assert.ok(!again.result.isError);
      assert.equal(
        JSON.parse(first.result.content[0].text).taskId,
        JSON.parse(again.result.content[0].text).taskId,
      );
    }
  assert.equal(
    (await pool().query("SELECT count(*) FROM crm_source_tasks")).rows[0].count,
    "66",
  );
  await pool().query(
    "UPDATE dataset_connections SET expires_at=now()-interval '1 second' WHERE draft_id=$1",
    [row.draft_id],
  );
  await assert.rejects(call("projects.list", {}), { status: 401 });
  await pool().query(
    "UPDATE dataset_connections SET expires_at=$2 WHERE draft_id=$1",
    [row.draft_id, receipt.expiresAt],
  );
  await assert.rejects(datasetConnect(owner, { id: row.draft_id }), {
    status: 409,
  });
  await assert.rejects(
    configureProject(owner, {
      datasetId: row.draft_id,
      projectId: manifest.mappings[0].crmProjectId,
      autoLeads: false,
      tasks: true,
    }),
    { status: 409 },
  );
  await pool().query(
    "UPDATE members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, owner],
  );
  await assert.rejects(
    backlogConsent(owner, { leaseReceipt, confirmed: true }),
    { status: 403 },
  );
  await pool().query(
    "UPDATE members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, owner],
  );
  await pool().query(
    "UPDATE dataset_project_permissions SET backlog_source_project=NULL WHERE draft_id=$1 AND project_id=$2",
    [row.draft_id, manifest.mappings[0].crmProjectId],
  );
  await assert.rejects(
    backlogConsent(owner, { leaseReceipt, confirmed: true }),
    { status: 403 },
  );
  await datasetConnect(owner, { id: row.draft_id, revoke: true });
  await assert.rejects(
    backlogConsent(owner, { leaseReceipt, confirmed: true }),
    { status: 403 },
  );
  assert.equal(
    (await pool().query("SELECT count(*) FROM crm_backlog_consents")).rows[0]
      .count,
    "1",
  );
});
