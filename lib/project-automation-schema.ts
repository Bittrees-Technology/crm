export const projectAutomationSchema = `
CREATE TABLE IF NOT EXISTS dataset_project_permissions(
 draft_id uuid NOT NULL REFERENCES lead_drafts(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES users(id),
 token_hash text NOT NULL, auto_leads boolean NOT NULL DEFAULT false,
 tasks boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
 PRIMARY KEY(draft_id,project_id));
ALTER TABLE dataset_project_permissions ADD COLUMN IF NOT EXISTS qualification boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS dataset_one_lead_destination ON dataset_project_permissions(draft_id) WHERE auto_leads;
CREATE TABLE IF NOT EXISTS project_ai_runs(
 id uuid PRIMARY KEY, draft_id uuid NOT NULL REFERENCES lead_drafts(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE, task_version int NOT NULL,
 expires_at timestamptz NOT NULL, result_hash text, result jsonb);
CREATE INDEX IF NOT EXISTS project_ai_runs_task ON project_ai_runs(task_id,expires_at);
`;
