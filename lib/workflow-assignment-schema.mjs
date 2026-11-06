export const workflowAssignmentSchema=`
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
`;
