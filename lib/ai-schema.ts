export const aiSchema = [
  "CREATE TABLE IF NOT EXISTS ai_grants(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,record_ids uuid[] NOT NULL CHECK(cardinality(record_ids) BETWEEN 1 AND 100),actions text[] NOT NULL CHECK(actions=ARRAY['read']::text[]),code_hash text UNIQUE,challenge text NOT NULL,code_expires timestamptz NOT NULL,token_hash text UNIQUE,expires_at timestamptz NOT NULL,revoked_at timestamptz,last_used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());",
  "CREATE INDEX IF NOT EXISTS ai_grants_owner ON ai_grants(user_id,created_at);",
].join("\n");
