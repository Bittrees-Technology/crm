import { projectAutomationSchema } from "./project-automation-schema";
export const datasetSchema =
  `
CREATE TABLE IF NOT EXISTS dataset_connections(
 draft_id uuid PRIMARY KEY REFERENCES lead_drafts(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS dataset_record_links(
 draft_id uuid NOT NULL REFERENCES lead_drafts(id) ON DELETE CASCADE,
 entry_id uuid NOT NULL, record_id uuid NOT NULL, workspace_id uuid NOT NULL,
 PRIMARY KEY(draft_id,entry_id));
CREATE TABLE IF NOT EXISTS dataset_submissions(
 draft_id uuid NOT NULL REFERENCES lead_drafts(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL, payload_hash text NOT NULL,
 snapshot_id uuid NOT NULL, review_id uuid NOT NULL,
 PRIMARY KEY(draft_id,operation_id));
` + projectAutomationSchema;
