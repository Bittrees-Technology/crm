export const indexCorrectionsSchema = `
CREATE TABLE IF NOT EXISTS index_corrections (
 id uuid PRIMARY KEY, payload_hash text NOT NULL, payload jsonb NOT NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces(id), owner_id uuid NOT NULL REFERENCES users(id),
 task_id uuid REFERENCES records(id) ON DELETE SET NULL,
 workflow_run_id uuid, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS index_corrections_pending ON index_corrections(next_attempt_at) WHERE delivered_at IS NULL;
`;
