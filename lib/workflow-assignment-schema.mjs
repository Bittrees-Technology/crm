export const workflowAssignmentSchema = `
CREATE TABLE IF NOT EXISTS crm_workflow_assignments(
 id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES records(id),workspace_id uuid NOT NULL REFERENCES workspaces(id),
 task_revision integer NOT NULL CHECK(task_revision>0),connection_id uuid NOT NULL,
 assignment jsonb NOT NULL CHECK(assignment->>'assignmentId'=id::text AND assignment->>'taskId'=task_id::text AND assignment->>'taskRevision'=task_revision::text),
 expires_at timestamptz NOT NULL,revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS crm_workflow_result_receipts(
 operation_id uuid PRIMARY KEY,assignment_id uuid NOT NULL REFERENCES crm_workflow_assignments(id),
 assignment_digest text NOT NULL,run_id uuid NOT NULL,lease_id uuid NOT NULL,
 result jsonb NOT NULL,result_digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(assignment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_workflow_assignment_task_revision
 ON crm_workflow_assignments(task_id,task_revision,connection_id,(assignment->>'workflowId'),(assignment->>'workflowRevision'));
ALTER TABLE crm_workflow_result_receipts ADD COLUMN IF NOT EXISTS note_id uuid REFERENCES records(id);
ALTER TABLE crm_workflow_result_receipts ADD COLUMN IF NOT EXISTS finalized_task_revision integer CHECK(finalized_task_revision>0);
ALTER TABLE crm_workflow_result_receipts ADD COLUMN IF NOT EXISTS finalize_operation_id uuid;
ALTER TABLE crm_workflow_result_receipts ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
`;

export const workflowAssignmentCompletionConstraints = `
CREATE UNIQUE INDEX IF NOT EXISTS crm_workflow_result_note ON crm_workflow_result_receipts(note_id) WHERE note_id IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='crm_workflow_result_receipts'::regclass AND conname='crm_workflow_result_finalization_consistent') THEN
  ALTER TABLE crm_workflow_result_receipts ADD CONSTRAINT crm_workflow_result_finalization_consistent CHECK(
   (finalized_task_revision IS NULL AND finalize_operation_id IS NULL AND finalized_at IS NULL) OR
   (finalized_task_revision IS NOT NULL AND finalize_operation_id IS NOT NULL AND finalized_at IS NOT NULL AND note_id IS NOT NULL));
 END IF;
END $$;
`;
