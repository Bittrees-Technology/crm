export const leadsSchema = `
CREATE TABLE IF NOT EXISTS lead_searches(
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 brief jsonb NOT NULL, token_hash text UNIQUE, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS lead_previews(
 id uuid PRIMARY KEY, search_id uuid NOT NULL REFERENCES lead_searches(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL, payload_hash text NOT NULL, candidates jsonb NOT NULL,
 decision jsonb, record_ids uuid[], created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(search_id,operation_id));
ALTER TABLE lead_searches ADD COLUMN IF NOT EXISTS researcher_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE lead_searches ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES records(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS lead_searches_researcher ON lead_searches(researcher_id,created_at);
CREATE TABLE IF NOT EXISTS lead_drafts(
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL, entries jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
 shared_search_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS lead_drafts_user ON lead_drafts(user_id,updated_at);
CREATE INDEX IF NOT EXISTS lead_searches_user ON lead_searches(user_id,created_at);
`;
