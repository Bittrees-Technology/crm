# Native workflow role eligibility

`POST /api/roles/workflow-authority` accepts only the frozen Roles native workflow
protocol. CRM verifies the pinned Roles signature using
`ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY` and signs the exact-bound response using
`ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY`. No new keys are required. The shared
protocol files are copied verbatim from Roles; the native protocol SHA-256 is
`c03ad6112f346041d6104b7f5b4577f6659ed9db97d6d28a35f8ba64c7c68992`.

Every operation resolves the exact verified email or Ethereum identity to an
active, unmerged CRM account and reads its current native workspace memberships.
It does not use observed role feeds, central administrator roles, invitations,
linked wallet identities, or cached positive membership decisions. Email proves
only the email identity, even when its CRM account also has a wallet.

The subject receives at most 100 opaque scopes, never workspace names, account
IDs, record IDs, contacts, content, or member lists. `NULL`, empty and populated
record restrictions have distinct canonical digests. Resource and membership
identifiers use the existing source pseudonym secret and a separate domain.
Non-list requests return only an exact selected current scope. Excess scope
counts, missing configuration, database failures and expired requests fail closed.

Run `scripts/migrate-native-workflow.ts` with the existing direct migration
connection before deployment. It adds generation columns, two schema-bound
triggers and a replay table. An optional `NATIVE_WORKFLOW_RUNTIME_ROLE` must name
an already-existing runtime role and grants only replay SELECT/INSERT/DELETE.
The migration checks retention of users, identities, members, workspaces and
records in the same transaction. No private content or membership is changed.
It can be reapplied without rotating unchanged scopes.

Member generations change on insert and meaningful role/restriction/account/
workspace updates. A no-op update preserves the previous generation; supplied
generation values cannot override it. Workspace generations change on ownership
transitions, including owner moves and delete/recreate. Unrelated non-owner
changes preserve other members' scopes. Triggers cover invitations, account
recovery/upserts and workspace merge paths and bind their own installed schema
with `search_path=pg_catalog`.

Signed request IDs have an atomic, independently committed one-use claim. An
authority-read failure cannot make the accepted request reusable. Each accepted
request removes at most 100 replay claims expired for over one minute; freshness
validation already rejects their reuse. Authority reads follow CRM's user then
identity then workspace lock order (with an explicit exact-identity recheck
after the user lock), use bounded lock/statement timeouts and never lock member
rows while waiting for epoch updates. Responses expire no later than the signed
request and within five seconds.

This endpoint supplies role eligibility only. It grants no CRM operations,
source writes, schedules, transactions, memberships, policy changes or Safe
activation. Workflow permits only own manual tracking and its fixed public
Roles-health probe, subject to Roles' separately approved policy. Absence of the
optional native-project policy remains a denial in Roles.
