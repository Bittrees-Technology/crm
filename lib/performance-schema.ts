// Additive only: existing clients keep working during a rolling deployment.
export const performanceSchema = `
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS read_revision bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS records_workspace_id ON records(workspace_id,id);
CREATE TABLE IF NOT EXISTS record_save_receipts(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 payload_hash text NOT NULL,
 record_id uuid NOT NULL,
 record_version int NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,workspace_id,operation_id)
);
CREATE OR REPLACE FUNCTION crm_bump_read_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  UPDATE workspaces SET read_revision=read_revision+1 WHERE id=OLD.workspace_id;
 END IF;
 IF TG_OP = 'INSERT' THEN
  UPDATE workspaces SET read_revision=read_revision+1 WHERE id=NEW.workspace_id;
 ELSIF TG_OP = 'UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  UPDATE workspaces SET read_revision=read_revision+1 WHERE id=NEW.workspace_id;
 END IF;
 RETURN NULL;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='crm_records_revision') THEN
  CREATE TRIGGER crm_records_revision AFTER INSERT OR UPDATE OR DELETE ON records FOR EACH ROW EXECUTE FUNCTION crm_bump_read_revision();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='crm_members_revision') THEN
  CREATE TRIGGER crm_members_revision AFTER INSERT OR UPDATE OR DELETE ON members FOR EACH ROW EXECUTE FUNCTION crm_bump_read_revision();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='crm_audit_revision') THEN
  CREATE TRIGGER crm_audit_revision AFTER INSERT OR UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION crm_bump_read_revision();
 END IF;
END $$;
`;
