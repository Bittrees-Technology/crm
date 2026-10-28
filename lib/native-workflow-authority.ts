import { createHash, createHmac, createPrivateKey, sign } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { canonical } from "../shared/signed-action.mjs";
import { PERSONAL_WORKFLOW_ENDPOINT } from "../shared/personal-workflow-authority.mjs";
import {
  nativeWorkflowDecisionMessage,
  nativeWorkflowScopeId,
  verifyNativeWorkflowRequest,
} from "../shared/native-workflow-authority.mjs";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
type Env = Record<string, string | undefined>;
// No cached/feed roles or linked identities are used here. The signed Roles
// request carries the original authenticated Workflow identity, not its account.
export async function currentNativeWorkflowScopes(db: Pick<PoolClient, "query">, identity: { kind: string; value: string }, env: Env, expiresAt: number) {
  const secret = env.ROLES_FEED_SUBJECT_SECRET;
  if (!secret || secret.length < 32) throw Error("Authority unavailable");
  const opaque = (kind: string, value: unknown) => createHmac("sha256", secret).update(canonical(["crm-native-workflow-v1", kind, value])).digest("hex");
  const user = (await db.query(
    "SELECT u.id,i.verified_at FROM identities i JOIN users u ON u.id=i.user_id WHERE i.kind=$1 AND i.value=$2 AND i.verified_at IS NOT NULL AND u.merged_into IS NULL FOR SHARE OF u",
    [identity.kind === "wallet" ? "ethereum" : "email", identity.value],
  )).rows[0];
  if (!user) return [];
  // Match CRM's user -> workspace lock order. Do not lock member rows after
  // workspace rows: direct member updates may be waiting in the epoch trigger.
  const workspaces = (await db.query(
    "SELECT w.id,w.authority_generation FROM workspaces w WHERE EXISTS (SELECT 1 FROM members m WHERE m.workspace_id=w.id AND m.user_id=$1) ORDER BY w.id LIMIT 101 FOR SHARE OF w",
    [user.id],
  )).rows;
  if (workspaces.length > 100) throw Error("Authority exceeds bound");
  const rows = (await db.query(
    "SELECT m.workspace_id,m.role,m.scope_ids,m.authority_generation FROM members m WHERE m.user_id=$1 AND m.workspace_id=ANY($2::uuid[]) ORDER BY m.workspace_id LIMIT 101",
    [user.id, workspaces.map(w => w.id)],
  )).rows;
  if (rows.length > 100) throw Error("Authority exceeds bound");
  return rows.map(row => {
    if (!["owner", "editor", "viewer"].includes(row.role)) throw Error("Unknown membership");
    const workspace = workspaces.find(w => w.id === row.workspace_id)!;
    // Preserve NULL (unrestricted) versus [] (no records), and bind every
    // current record restriction without disclosing a single record identifier.
    const restrictionsDigest = createHash("sha256").update(canonical({ scope_ids: row.scope_ids === null ? null : [...row.scope_ids].sort() })).digest("hex");
    const scope = {
      resourceId: opaque("workspace", row.workspace_id),
      membershipId: opaque("membership", [identity, user.id, String(user.verified_at), row.authority_generation, workspace.authority_generation]),
      roleId: "workspace." + row.role,
      restrictionsDigest,
      expiresAt,
    };
    return { id: nativeWorkflowScopeId("crm", identity, scope), ...scope };
  });
}

export async function nativeWorkflowAuthority(request: Request, env: Env = process.env) {
  let packet, authority;
  try {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/roles/workflow-authority") throw Error();
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw Error();
    // Bound streamed bodies too; Content-Length alone is untrusted.
    const reader = request.body?.getReader();
    if (!reader) throw Error();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); throw Error(); }
      chunks.push(value);
    }
    packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    authority = verifyNativeWorkflowRequest(packet, "crm", env.ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY);
  } catch { return Response.json({ error: "Signed Roles request required" }, { status: 401, headers }); }
  try {
    const key = createPrivateKey(env.ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY || "");
    if (key.asymmetricKeyType !== "ed25519") throw Error();
    // Commit the one-use claim independently: an outage/lock timeout in the
    // subsequent authority read must not make an accepted envelope reusable.
    const claimed = await pool().query("INSERT INTO native_workflow_requests(request_id,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING request_id", [authority.requestId, new Date(authority.expiresAt)]);
    if (!claimed.rowCount) return Response.json({ error: "Roles request already used" }, { status: 409, headers });
    const result = await transaction(async db => {
      await db.query("SET LOCAL statement_timeout='2000ms'");
      await db.query("SET LOCAL lock_timeout='1000ms'");
      // Small bounded cleanup; expired requests already fail signature freshness.
      await db.query("DELETE FROM native_workflow_requests WHERE request_id IN (SELECT request_id FROM native_workflow_requests WHERE expires_at<now()-interval '1 minute' ORDER BY expires_at LIMIT 100)");
      const expiresAt = Math.min(authority.expiresAt, Date.now() + 5000);
      let scopes = await currentNativeWorkflowScopes(db, authority.workflowRequest.identity, env, expiresAt);
      if (authority.workflowRequest.action !== "list") scopes = scopes.filter(s => s.id === authority.workflowRequest.scopeId);
      const checkedAt = Date.now();
      if (expiresAt <= checkedAt || checkedAt < authority.issuedAt - 1000) throw Error();
      return { version: 1, issuer: "https://crm.bittrees.org", audience: PERSONAL_WORKFLOW_ENDPOINT, project: "crm", identity: authority.workflowRequest.identity, request: authority, status: "current", checkedAt, expiresAt, scopes, readOnly: true, grantsSourceAuthority: false };
    });
    if (result.expiresAt <= Date.now()) throw Error();
    return Response.json({ decision: result, signature: sign(null, Buffer.from(nativeWorkflowDecisionMessage(result)), key).toString("base64") }, { headers });
  } catch { return Response.json({ error: "Native role authority unavailable" }, { status: 503, headers }); }
}
