import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { hash, token } from "./auth";
import { HttpError } from "./model";
import { lockActiveAccount, membership } from "./service";
import { backlogSources } from "./backlog-sources";
import { canonical, verifyEd25519 } from "./source-handoff/roles-proof.mjs";
import {
  recipientKeyId,
  sealSourceHandoff,
} from "./source-handoff/source-handoff.mjs";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const principal = z
  .string()
  .regex(/^agent:[a-f0-9-]{36}$/)
  .refine((v) => z.uuid().safeParse(v.slice(6)).success);
export const receiptSchema = z.strictObject({
  version: z.literal(1),
  issuer: z.literal("https://roles.bittrees.org"),
  audience: z.literal("https://mcp.bittrees.org"),
  leaseId: z.uuid(),
  policyDigest: digest,
  principal,
  credentialId: digest,
  runtimeBindingDigest: digest,
  tenant: z.string().max(128),
  workspace: z.string().max(128),
  sourceWorkspace: z.uuid(),
  activatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  renewable: z.literal(false),
});
const manifestSchema = z.strictObject({
  feedRevision: digest,
  sourceWorkspace: z.uuid(),
  mappings: z
    .array(
      z.strictObject({
        sourceProjectId: z.string(),
        crmProjectId: z.uuid(),
        siteUrl: z.string().url().nullable(),
      }),
    )
    .length(11),
});
const configSchema = z.strictObject({
  ownerId: z.uuid(),
  ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
  tenant: z.string().regex(/^roles:[a-f0-9-]{36}$/),
  principal,
  credentialId: digest,
  runtimeBindingDigest: digest,
  leaseId: z.uuid(),
  policyDigest: digest,
  manifest: manifestSchema,
  mappingDigest: digest,
});
const inputSchema = z.strictObject({
  leaseReceipt: z.strictObject({
    receipt: receiptSchema,
    signature: z.string().max(128),
  }),
  confirmed: z.boolean().default(false),
});
const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function prepared(raw: unknown) {
  if (process.env.CRM_BACKLOG_HANDOFF_ENABLED !== "true")
    throw new HttpError(404, "Not found.");
  const config = configSchema.parse(
    JSON.parse(process.env.CRM_BACKLOG_HANDOFF_CONFIG || "null"),
  );
  const input = inputSchema.parse(raw),
    receipt = input.leaseReceipt.receipt;
  const now = Date.now(),
    start = Date.parse(receipt.activatedAt),
    end = Date.parse(receipt.expiresAt);
  if (
    !verifyEd25519(
      "Bittrees MCP lease activation receipt v1\n" + canonical(receipt),
      input.leaseReceipt.signature,
      process.env.CRM_BACKLOG_ROLES_PUBLIC_KEY || "",
    ) ||
    start > now ||
    end <= now ||
    end - start !== 3600000
  )
    throw new HttpError(403, "A valid active one-hour receipt is required.");
  for (const field of [
    "tenant",
    "principal",
    "credentialId",
    "runtimeBindingDigest",
    "leaseId",
    "policyDigest",
  ] as const)
    if (config[field] !== receipt[field])
      throw new HttpError(
        403,
        "Activation does not match the prepared connection.",
      );
  if (
    receipt.sourceWorkspace !== config.manifest.sourceWorkspace ||
    receipt.workspace !== "crm:" + receipt.sourceWorkspace
  )
    throw new HttpError(403, "Workspace mismatch.");
  const mappings = config.manifest.mappings;
  if (
    sha(config.manifest) !== config.mappingDigest ||
    new Set(mappings.map((m) => m.sourceProjectId)).size !== 11 ||
    new Set(mappings.map((m) => m.crmProjectId)).size !== 11 ||
    mappings.some(
      (m, i) =>
        !(m.sourceProjectId in backlogSources) ||
        (backlogSources as any)[m.sourceProjectId].url !== m.siteUrl ||
        (i > 0 && mappings[i - 1].sourceProjectId >= m.sourceProjectId),
    )
  )
    throw new HttpError(403, "Prepared mappings are invalid.");
  const recipient = process.env.CRM_MCP_HANDOFF_RECIPIENT_PUBLIC_KEY || "";
  const recipientId = recipientKeyId(recipient);
  return {
    config,
    input,
    receipt,
    recipient,
    recipientId,
    requestDigest: sha({
      leaseReceipt: input.leaseReceipt,
      mappingDigest: config.mappingDigest,
      recipientKeyId: recipientId,
    }),
  };
}
export async function backlogConsent(user: string, raw: unknown) {
  const p = prepared(raw),
    { config, input, receipt } = p;
  if (user !== config.ownerId)
    throw new HttpError(403, "Prepared connection owner required.");
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + ":" + receipt.leaseId,
    ]);
    await lockActiveAccount(db, user);
    if (
      !(
        await db.query(
          "SELECT 1 FROM identities WHERE user_id=$1 AND kind='ethereum' AND lower(value)=$2 AND verified_at IS NOT NULL",
          [user, config.ownerWallet],
        )
      ).rowCount
    )
      throw new HttpError(403, "Verified owner wallet required.");
    await membership(receipt.sourceWorkspace, user, true, true, db);
    const projects = [];
    for (const m of config.manifest.mappings) {
      const r = (
        await db.query(
          "SELECT id,data->>'name' AS name FROM records WHERE id=$1 AND workspace_id=$2 AND kind='projects' AND archived_at IS NULL",
          [m.crmProjectId, receipt.sourceWorkspace],
        )
      ).rows[0];
      if (!r)
        throw new HttpError(403, "An approved destination is unavailable.");
      projects.push({ ...m, name: r.name });
    }
    const review = {
      operator: "Local Bittrees AI",
      principal: receipt.principal,
      leaseId: receipt.leaseId,
      sourceWorkspace: receipt.sourceWorkspace,
      activatedAt: receipt.activatedAt,
      expiresAt: receipt.expiresAt,
      mappingDigest: config.mappingDigest,
      projects,
      recipientKeyId: p.recipientId,
    };
    if (!input.confirmed) return { review };
    const existing = (
      await db.query(
        "SELECT * FROM crm_backlog_consents WHERE owner_id=$1 AND lease_id=$2 FOR UPDATE",
        [user, receipt.leaseId],
      )
    ).rows[0];
    if (existing) {
      if (existing.request_digest !== p.requestDigest)
        throw new HttpError(409, "Consent details changed; review required.");
      const connection = (
        await db.query(
          "SELECT token_hash FROM dataset_connections WHERE draft_id=$1 AND user_id=$2 AND expires_at=$3 AND expires_at>now()",
          [existing.draft_id, user, receipt.expiresAt],
        )
      ).rows[0];
      if (!connection)
        throw new HttpError(403, "Connection expired or revoked.");
      const grants = (
        await db.query(
          "SELECT project_id,backlog_source_project FROM dataset_project_permissions WHERE draft_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at=$4 AND expires_at>now() AND NOT tasks AND NOT auto_leads AND NOT qualification",
          [existing.draft_id, user, connection.token_hash, receipt.expiresAt],
        )
      ).rows;
      if (
        grants.length !== 11 ||
        config.manifest.mappings.some(
          (m) =>
            !grants.some(
              (g) =>
                g.project_id === m.crmProjectId &&
                g.backlog_source_project === m.sourceProjectId,
            ),
        )
      )
        throw new HttpError(403, "Project consent changed or was revoked.");
      return { review, envelope: existing.envelope, replayed: true };
    }
    if (Date.parse(receipt.expiresAt) <= Date.now())
      throw new HttpError(403, "Activation expired.");
    const id = randomUUID(),
      secret = token(),
      tokenHash = hash(secret);
    const metadata = {
      version: 1,
      issuer: "https://crm.bittrees.org",
      audience: "https://mcp.bittrees.org",
      handoffId: randomUUID(),
      connectionId: id,
      leaseId: receipt.leaseId,
      policyDigest: receipt.policyDigest,
      tenant: receipt.tenant,
      workspace: receipt.workspace,
      principal: receipt.principal,
      credentialId: receipt.credentialId,
      runtimeBindingDigest: receipt.runtimeBindingDigest,
      sourceWorkspace: receipt.sourceWorkspace,
      mappingDigest: config.mappingDigest,
      activatedAt: new Date(receipt.activatedAt).toISOString(),
      expiresAt: new Date(receipt.expiresAt).toISOString(),
      recipientKeyId: p.recipientId,
    };
    const envelope = sealSourceHandoff({
      metadata,
      token: secret,
      recipientPublicKey: p.recipient,
      signingPrivateKey: process.env.CRM_MCP_HANDOFF_SIGNING_PRIVATE_KEY || "",
    });
    await db.query(
      "INSERT INTO lead_drafts(id,user_id,name) VALUES($1,$2,'Agent backlog via MCP')",
      [id, user],
    );
    await db.query(
      "INSERT INTO dataset_connections(draft_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
      [id, user, tokenHash, receipt.expiresAt],
    );
    for (const m of config.manifest.mappings)
      await db.query(
        "INSERT INTO dataset_project_permissions(draft_id,project_id,workspace_id,user_id,token_hash,auto_leads,tasks,qualification,backlog_source_project,expires_at) VALUES($1,$2,$3,$4,$5,false,false,false,$6,$7)",
        [
          id,
          m.crmProjectId,
          receipt.sourceWorkspace,
          user,
          tokenHash,
          m.sourceProjectId,
          receipt.expiresAt,
        ],
      );
    await db.query(
      "INSERT INTO crm_backlog_consents(owner_id,lease_id,draft_id,request_digest,envelope,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        user,
        receipt.leaseId,
        id,
        p.requestDigest,
        JSON.stringify(envelope),
        receipt.expiresAt,
      ],
    );
    await db.query(
      "INSERT INTO audit(workspace_id,actor_id,action,detail) VALUES($1,$2,'Agent backlog MCP consent',$3)",
      [
        receipt.sourceWorkspace,
        user,
        JSON.stringify({
          leaseId: receipt.leaseId,
          connectionId: id,
          mappingDigest: config.mappingDigest,
          expiresAt: receipt.expiresAt,
        }),
      ],
    );
    return { review, envelope, replayed: false };
  });
}
