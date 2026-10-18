# Agent backlog source import

Agent publishes 66 public tasks across 11 approved sites at
https://agent.bittrees.org/tasks.json. MCP owns orchestration; CRM owns task
mutation and authorization. No tasks are imported by deploying this code.

## Owner setup

In `/connect/ai/projects`, an owner chooses an existing connection and CRM project,
then selects the matching site in **Sync Agent backlog for this site**. This is a
separate grant, default Off. Existing AI-task grants do not authorize imports.
Backlog grants require an absolute UTC `expiresAt`, in the future and at most
one hour away. Finalize consent after native activation using the exact expiry
from its verified Roles receipt; repeated saves retain that timestamp. CRM caps
the grant at the connection expiry as well. MCP separately enforces the signed
lease expiry. This input does not itself verify a Roles receipt or activate a
lease. No source token should be copied into chat or the native runner.

The same expiry, connection token, account, workspace ownership, project access
and revocation checks apply on every import and status lookup. Shared sign-in
and public feed visibility do not grant this permission.

`projects.list` returns `backlogSourceProjectId` and `backlogSourceSiteUrl` for
explicitly mapped destinations. MCP must use these approved mappings; it must
not guess from project names. Excluded products are not selectable.

## Tool contract

`tasks.import_source` accepts exactly:

- `projectId`, `operationId` (UUIDs)
- `source`: `https://agent.bittrees.org`
- `sourceId`: `agent-readiness:<mapped-site-id>:<task-id>`
- `contentHash`: 64 lowercase hex characters from the source feed
- `title`: 1–200 characters; `description`: up to 3500 characters
- `sourceUrl`: `https://agent.bittrees.org/readiness#<task-id>`
- `sourceStatus`: `todo`, `in-progress`, `blocked`, or `done`
- `sourcePriority`: `P0`, `P1`, or `P2`
- `expectedVersion`: positive integer for updates; omitted on first creation

Returns `{taskId,version,contentHash,created,unchanged,replayed?}`. Ordinary tasks
use category `Production backlog`; they are never eligible for the AI draft/review
worker. Source status and priority remain visible in provenance. CRM completion,
assignment, due date, private notes, comments, sharing and links survive updates.
The initial CRM completion reflects whether the source task was already done.

`tasks.import_source_status` accepts `{projectId,source,sourceId}` and returns
`{found:false}` or `{found:true,taskId,version,contentHash,sourceStatus,
sourcePriority,crmStatus,conflict}`. No private notes are exposed.

Each source identity maps uniquely per owner and destination project. Imports and
receipts commit in one transaction. The workspace lock serializes concurrent
first imports. Exact operation retries replay the receipt after current permission
and task access checks. Reusing an operation ID with changed input fails 409.
Source-field edits, changed versions, reassignment, movement or deleted tasks fail
closed for review; records are never silently recreated. Missing feed entries
never delete or complete CRM tasks. Retain the original payload for uncertain
retries; do not invent a new operation ID to conceal a conflict.

## Release

Run the versioned `scripts/project-automation-migration.ts` on an isolated database
branch first, then the approved production migration before deploying the app.
It adds one default-off grant column, source identity mappings, and operation
receipts, and grants the existing runtime role access to those new tables.
No existing grant is enabled by migration. Preserve the old columns/tables on
rollback; no destructive down migration is needed.

Validation includes isolated local PostgreSQL tests for separate permission,
excluded mapping, concurrent retry, changed retry, version conflicts, preservation
of completion/scheduling, source edit conflicts and revocation. Production
activation additionally needs the enrolled MCP actor, a bound CRM source
connection and owner-approved per-site mappings. Never pass CRM credentials or
routes as model-controlled tool arguments.

Migration verified on isolated production-copy branch `br-fragrant-smoke-bakr00i5`
on October 17, 2026: repeatable migration, existing CRM records unchanged,
runtime table permissions present, and zero backlog grants enabled. The branch
expires October 20. Application environment files were not changed.

## Dedicated sealed MCP consent (disabled until configured)

`POST /api/datasets/backlog/consent` uses the existing authenticated owner session,
origin/CSRF check and request limits. The UI is under `/connect/ai/projects` →
Agent backlog through MCP. Review uses `{leaseReceipt:{receipt,signature},confirmed:false}`;
explicit approval repeats the same receipt with `confirmed:true`. Review never
creates a connection. Server configuration pins the owner, verified wallet,
Roles tenant, exact native identity/lease/policy and approved manifest. The Roles
receipt signature is checked against a pinned public key before normalization.

This is owner-authorized source provisioning, not a live Roles authorization
decision. MCP must check current Roles authority before every protected effect.
Source membership, connection expiry and revocation are independently checked
here. The source token and all eleven grants end at the signed receipt expiry.
Setup consumes the remaining activation interval. No source grant permits AI
work, leads, qualification, deletion or renewal.

Required server configuration (no defaults enabling access):
- `CRM_BACKLOG_HANDOFF_ENABLED=true`
- `CRM_BACKLOG_HANDOFF_CONFIG`: strict JSON with `ownerId`, lowercase verified
  `ownerWallet`, `tenant`, `principal`, `credentialId`, `runtimeBindingDigest`,
  `leaseId`, `policyDigest`, `manifest`, `mappingDigest`.
- `CRM_BACKLOG_ROLES_PUBLIC_KEY`: independently pinned Roles Ed25519 public key.
- `CRM_MCP_HANDOFF_RECIPIENT_PUBLIC_KEY`: dedicated operator RSA public key (3072+
  bits); never its private key.
- `CRM_MCP_HANDOFF_SIGNING_PRIVATE_KEY`: dedicated CRM Ed25519 signing key; its
  public key must be independently pinned by the operator.

Manifest is `{feedRevision,sourceWorkspace,mappings}`; mappings are sorted by
ASCII sourceProjectId and contain `{sourceProjectId,crmProjectId,siteUrl}`.
The digest is SHA256 of canonical sorted-key JSON. Configuration is prepared
only after real native enrollment; browser input cannot change the approved
manifest, keys, owner, identity or policy.

The additive `crm_backlog_consents` table persists only signed ciphertext and
public metadata. Consent atomically creates a fresh dedicated draft, token hash,
exact mappings and receipt. Identical retries return the original envelope;
changed or revoked consent cannot recreate/renew access. Existing connections
are untouched. Generic connection rotation and permission extension are blocked
for these dedicated connections; revocation remains available.

The operator opens the downloaded encrypted envelope with MCP's
`scripts/open-source-handoff.mjs`, using independently verified consent metadata,
the signed Roles receipt, approved manifest, private recipient key and pinned
CRM signing public key. Never derive all expected metadata from the envelope.
Generated connection/handoff IDs may come from the authenticated consent record.
No plaintext source credential appears in browser, chat or logs.

Apply the additive project-automation migration before deploying this code.
No production migration, signing/encryption key provisioning, connection or grant
is implied by a successful local test. Production steps require a verified
zero-additional-cost path and final owner/native approvals.
