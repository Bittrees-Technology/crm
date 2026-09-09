import { Pool, type PoolClient } from "pg";
const globalDb = globalThis as unknown as { crmPool?: Pool };
export function pool() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured");
  return (globalDb.crmPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  }));
}
export async function transaction<T>(fn: (db: PoolClient) => Promise<T>) {
  const db = await pool().connect();
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export const schema = `
CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS identities(kind text NOT NULL, value text NOT NULL, user_id uuid NOT NULL REFERENCES users(id), verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,value));
CREATE TABLE IF NOT EXISTS sessions(hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS challenges(id uuid PRIMARY KEY, kind text NOT NULL, value text NOT NULL, secret_hash text NOT NULL, browser_hash text NOT NULL, user_id uuid REFERENCES users(id), payload text, expires_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0, consumed boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS rate_limits(key text PRIMARY KEY, hits int NOT NULL, resets_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS members(workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS records(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), kind text NOT NULL, data jsonb NOT NULL, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE records ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS records_workspace ON records(workspace_id,kind);
CREATE TABLE IF NOT EXISTS audit(id bigserial PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, record_id uuid, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS invites(hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), email text NOT NULL, role text NOT NULL CHECK(role IN ('editor','viewer')), expires_at timestamptz NOT NULL, accepted_at timestamptz);
`;
