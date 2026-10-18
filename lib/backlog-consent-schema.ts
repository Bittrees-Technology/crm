export const backlogConsentSchema = `
CREATE TABLE IF NOT EXISTS crm_backlog_consents(
 owner_id uuid NOT NULL REFERENCES users(id), lease_id uuid NOT NULL,
 draft_id uuid NOT NULL REFERENCES lead_drafts(id), request_digest text NOT NULL,
 envelope jsonb NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,lease_id), UNIQUE(draft_id));
`;
