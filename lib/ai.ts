import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction, pool } from "./db";
import { hash, token } from "./auth";
import { membership } from "./service";
import { accessIds, referenceFields } from "./access";
import { HttpError, recordSchema, kinds } from "./model";
export function requireAiEnabled() {
  if (process.env.AI_CONNECTOR_ENABLED !== "true")
    throw new HttpError(404, "Not found.");
}
const selection = z
  .array(z.uuid())
  .min(1)
  .max(100)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Choose distinct records.",
  );
type Grant = {
  id: string;
  user_id: string;
  workspace_id: string;
  record_ids: string[];
  actions: string[];
  challenge: string;
  code_expires: Date;
  expires_at: Date;
  revoked_at: Date | null;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export async function selected(
  db: PoolClient,
  user: string,
  workspace: string,
  ids: string[],
) {
  const allowed = await accessIds(db, user, workspace);
  if (allowed !== null && ids.some((id) => !allowed.includes(id)))
    throw new HttpError(404, "Selected records are unavailable.");
  const rows = (
    await db.query(
      "SELECT id,kind,data,version FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
      [workspace, ids],
    )
  ).rows;
  if (rows.length !== ids.length)
    throw new HttpError(404, "Selected records are unavailable.");
  return rows;
}
export async function authorize(user: string, raw: unknown) {
  requireAiEnabled();
  const input = z
    .strictObject({
      workspaceId: z.uuid(),
      recordIds: selection,
      actions: z.tuple([z.literal("read")]),
      challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      expiresInDays: z.number().int().min(1).max(30),
    })
    .parse(raw);
  return transaction(async (db) => {
    await membership(input.workspaceId, user, false, false, db);
    await selected(db, user, input.workspaceId, input.recordIds);
    const id = randomUUID(),
      code = token();
    const row = (
      await db.query(
        "INSERT INTO ai_grants(id,user_id,workspace_id,record_ids,actions,code_hash,challenge,code_expires,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '60 seconds',now()+($8*interval '1 day')) RETURNING expires_at,code_expires",
        [
          id,
          user,
          input.workspaceId,
          input.recordIds,
          input.actions,
          hash(code),
          input.challenge,
          input.expiresInDays,
        ],
      )
    ).rows[0];
    return {
      code,
      grantId: id,
      expiresAt: row.expires_at,
      codeExpiresAt: row.code_expires,
      actions: input.actions,
      recordIds: input.recordIds,
    };
  });
}
export async function locked(
  db: PoolClient,
  bearer: string,
  field: "code_hash" | "token_hash",
  write = false,
) {
  if (!/^[a-f0-9]{64}$/.test(bearer))
    throw new HttpError(401, "AI connection required.");
  const found = (
    await db.query("SELECT * FROM ai_grants WHERE " + field + "=$1", [
      hash(bearer),
    ])
  ).rows[0] as Grant | undefined;
  if (!found) throw new HttpError(401, "AI connection expired or revoked.");
  await membership(found.workspace_id, found.user_id, write, false, db);
  const current = (
    await db.query(
      "SELECT * FROM ai_grants WHERE id=$1 AND " + field + "=$2 FOR UPDATE",
      [found.id, hash(bearer)],
    )
  ).rows[0] as Grant | undefined;
  if (
    !current ||
    current.revoked_at ||
    new Date(current.expires_at).getTime() <= Date.now()
  )
    throw new HttpError(401, "AI connection expired or revoked.");
  return current;
}
export async function exchange(raw: unknown) {
  requireAiEnabled();
  const input = z
    .strictObject({
      code: z.string().regex(/^[a-f0-9]{64}$/),
      verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    })
    .parse(raw);
  return transaction(async (db) => {
    const grant = await locked(db, input.code, "code_hash");
    if (
      new Date(grant.code_expires).getTime() <= Date.now() ||
      digest(input.verifier) !== grant.challenge
    )
      throw new HttpError(401, "Invalid or expired connection code.");
    await selected(db, grant.user_id, grant.workspace_id, grant.record_ids);
    const bearer = token();
    await db.query(
      "UPDATE ai_grants SET code_hash=NULL,token_hash=$2 WHERE id=$1",
      [grant.id, hash(bearer)],
    );
    return {
      token: bearer,
      grantId: grant.id,
      subjectId: grant.user_id,
      workspaceId: grant.workspace_id,
      recordIds: grant.record_ids,
      actions: grant.actions,
      expiresAt: grant.expires_at,
      policyRevision: "crm-ai-read-v1",
    };
  });
}
export async function read(bearer: string, raw: unknown) {
  requireAiEnabled();
  const input = z.strictObject({ recordIds: selection }).parse(raw);
  return transaction(async (db) => {
    const grant = await locked(db, bearer, "token_hash");
    if (
      !grant.actions.includes("read") ||
      input.recordIds.some((id) => !grant.record_ids.includes(id))
    )
      throw new HttpError(403, "Record is outside this AI connection.");
    const rows = await selected(
      db,
      grant.user_id,
      grant.workspace_id,
      input.recordIds,
    );
    const records = rows.map((row) => {
      // Explicit projection: no private notes, audit, sharing policy or member directory.
      const data = recordSchema.parse(row.data);
      for (const field of referenceFields)
        if (data[field] && !input.recordIds.includes(data[field]))
          data[field] = "";
      data.ownerId = "";
      return {
        id: row.id,
        kind: z.enum(kinds).parse(row.kind),
        version: row.version,
        data,
      };
    });
    await db.query("UPDATE ai_grants SET last_used_at=now() WHERE id=$1", [
      grant.id,
    ]);
    return {
      contractVersion: "1.0.0",
      grantId: grant.id,
      subjectId: grant.user_id,
      workspaceId: grant.workspace_id,
      policyRevision: "crm-ai-read-v1",
      records,
    };
  });
}
export async function connections(user: string) {
  requireAiEnabled();
  return (
    await pool().query(
      "SELECT id,workspace_id,record_ids,actions,expires_at,revoked_at,last_used_at,created_at FROM ai_grants WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
      [user],
    )
  ).rows;
}
export async function revoke(user: string, id: string) {
  requireAiEnabled();
  z.uuid().parse(id);
  const result = await pool().query(
    "UPDATE ai_grants SET revoked_at=COALESCE(revoked_at,now()),code_hash=NULL,token_hash=NULL WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, user],
  );
  if (!result.rowCount) throw new HttpError(404, "Connection not found.");
  return { ok: true };
}

export async function choices(user: string, workspace: string) {
  requireAiEnabled();
  z.uuid().parse(workspace);
  return transaction(async (db) => {
    await membership(workspace, user, false, false, db);
    const allowed = await accessIds(db, user, workspace);
    const rows = (
      await db.query(
        "SELECT id,kind,data->>'name' AS name,version FROM records WHERE workspace_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY lower(data->>'name'),id LIMIT 1001",
        [workspace, allowed],
      )
    ).rows;
    return { items: rows.slice(0, 1000), truncated: rows.length > 1000 };
  });
}

/** Destructive scope reduction only; remains available after expiry, membership loss or feature shutdown. */
export async function revokeBearer(bearer: string, raw: unknown) {
  z.strictObject({}).parse(raw);
  if (!/^[a-f0-9]{64}$/.test(bearer))
    throw new HttpError(401, "AI connection required.");
  await pool().query(
    "UPDATE ai_grants SET revoked_at=COALESCE(revoked_at,now()),code_hash=NULL,token_hash=NULL WHERE token_hash=$1",
    [hash(bearer)],
  );
  // An unknown/already-cleared token cannot read either. Stable acknowledgement permits uncertain retries.
  return { ok: true };
}
