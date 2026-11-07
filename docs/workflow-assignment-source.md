# Native assignment source (default off)

`POST /api/integrations/workflow-assignments` composes the assignment issuer with
current CRM dataset credentials, explicit project task consent, workspace/record
access, exact task revision and AI assignment, signed Roles decisions, and
independent Workflows lease proofs. It is unavailable unless
`CRM_WORKFLOW_ASSIGNMENTS_ENABLED=1`. No request performs schema migration,
enrollment, key generation, permission grants, or configuration discovery.

The deployment owner must separately review `CRM_WORKFLOW_ASSIGNMENT_BINDINGS_JSON`:
one exact connection/owner/dataset/source workspace/native principal and credential,
runtime lease/digest, tenant/workspace, workflow/version and assignment tuple per
approved task. Bindings expire within fifteen minutes. `completeTask` defaults to
false and is separate approval for a task status transition. An ordinary dataset
connection or task assignment is not this approval. Supplier research/preparation
tasks are excluded; this path cannot replace CryptoDirectory retry authority.

Use the existing CRM ecosystem signing key. Pin the actual Roles decision signer
in `CRM_WORKFLOW_ROLES_DECISION_PUBLIC_KEY` and Workflows result-lease signer in
`CRM_WORKFLOW_LEASE_PUBLIC_KEY`. These are distinct custody domains. Never copy a
native or CRM credential into model inputs or obtain one by reading another store.

The JSON body is version 1, connectionId, kind and a strict typed operation.
Kinds assignment/task perform protected reads; result writes or reconciles the
original CRM result operation. A write requires a current running Workflows proof.
The result becomes one structured CRM note and is verified by source readback.
Owner task fields are preserved. Changed task/note revisions deny reconciliation.

`finalize` accepts only the original central completion PUT operation and requires
separately approved status scope plus a signed completed Workflows proof.
`finalization` accepts only its GET reconciliation operation and reads the existing
finalization without writing. Finalization changes only task status; it cannot
repeat generation, result-note creation or central completion. Lost replies retain
all original operation IDs. Neither a note nor Done status independently validates
the work's content.

Source permission is checked inside the transaction. Every SQL statement shares
the signed admission deadline, including lock waits. The source takes shared
advisory lock 73492017 before row locks; the reviewed migration takes its exclusive
counterpart before schema/core locks. An expired or busy transaction rolls back;
a possibly committed reply must be reconciled under the original operation.

## Explicit schema step

After review, run `scripts/migrate-workflow-assignments.ts` with the exact
`--apply-reviewed-schema` flag in the intended existing database environment.
Without it, the script exits before opening a database. The transactional migration
checks preservation of source content, memberships, existing assignments/receipts,
column types and unique indexes. It does not activate the feature or grant rights.
Do not apply this to production as part of local tests.

Local tests use a dedicated loopback PostgreSQL database and synthetic schemas.
They exercise current consent and revocation, exact assignment/revision scopes,
write/readback/replay, separately approved completion, lost-response reconciliation,
owner edits, migration retention, expiry and contention. This evidence does not
establish configured production authority, runtime cost coverage or live acceptance.
