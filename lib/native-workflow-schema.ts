// Additive authority metadata only; no CRM content or membership grants.
export const nativeWorkflowSchema = `
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS authority_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE members ADD COLUMN IF NOT EXISTS authority_generation uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS native_workflow_requests (
 request_id uuid PRIMARY KEY,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS native_workflow_requests_expiry ON native_workflow_requests(expires_at);
CREATE OR REPLACE FUNCTION crm_native_member_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.authority_generation := gen_random_uuid();
 ELSIF (NEW.workspace_id,NEW.user_id,NEW.role,NEW.scope_ids) IS DISTINCT FROM (OLD.workspace_id,OLD.user_id,OLD.role,OLD.scope_ids) THEN
  NEW.authority_generation := gen_random_uuid();
 ELSE
  NEW.authority_generation := OLD.authority_generation;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION crm_native_workspace_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- Only ownership transitions rotate the workspace epoch. Other members'
 -- scopes survive unrelated non-owner membership or restriction changes.
 IF TG_OP='INSERT' THEN
  IF NEW.role='owner' THEN EXECUTE format('UPDATE %I.workspaces SET authority_generation=gen_random_uuid() WHERE id=$1',TG_TABLE_SCHEMA) USING NEW.workspace_id; END IF;
 ELSIF TG_OP='DELETE' THEN
  IF OLD.role='owner' THEN EXECUTE format('UPDATE %I.workspaces SET authority_generation=gen_random_uuid() WHERE id=$1',TG_TABLE_SCHEMA) USING OLD.workspace_id; END IF;
 ELSIF (NEW.workspace_id,NEW.user_id,NEW.role) IS DISTINCT FROM (OLD.workspace_id,OLD.user_id,OLD.role) THEN
  -- Deterministic workspace ordering also covers owner moves between workspaces.
  EXECUTE format('UPDATE %I.workspaces SET authority_generation=gen_random_uuid() WHERE id IN (SELECT id FROM %I.workspaces WHERE ($1 AND id=$2) OR ($3 AND id=$4) ORDER BY id FOR UPDATE)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) USING OLD.role='owner',OLD.workspace_id,NEW.role='owner',NEW.workspace_id;
 END IF;
 RETURN NULL;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='crm_native_member_generation' AND tgrelid='members'::regclass) THEN
  CREATE TRIGGER crm_native_member_generation BEFORE INSERT OR UPDATE ON members FOR EACH ROW EXECUTE FUNCTION crm_native_member_generation();
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='crm_native_workspace_generation' AND tgrelid='members'::regclass) THEN
  CREATE TRIGGER crm_native_workspace_generation AFTER INSERT OR UPDATE OR DELETE ON members FOR EACH ROW EXECUTE FUNCTION crm_native_workspace_generation();
 END IF;
END $$;
`;
