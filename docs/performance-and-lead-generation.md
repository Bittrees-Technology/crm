# CRM performance release and focused lead generation

Review date: 1 October 2026. Scope: faster loading and reliable saves, followed by recommendations for AI through Bittrees MCP. No prospect collection, outreach, new AI grant or autonomous CRM write is enabled by this release.

## Implemented

- Workspace records load in 100-record pages (server maximum 200). Cursor context includes the workspace, user and revision. Every page rechecks authorization; changed records, membership or sharing invalidate the sequence. The client retries a changed sequence once, cancels obsolete requests and commits only a complete consistent result. It never displays partial totals as complete reports.
- Permission queries omit descriptions and contact fields. Whole-workspace collaborators retrieve only allowed record IDs; limited collaborators use compact relationship information. The existing access resolver and permission tests remain authoritative.
- Routine creates and updates apply the returned authorized record directly. They do not reload all workspace records. Owners also receive their new activity entry. Changes to record relationships or sharing still refresh the full authorized view because they can affect other records.
- Each editor submission has a stable operation ID. Durable receipts bind the operation to the user, workspace and HMAC of the validated request. Concurrent or lost-response retries do not create a second record, increment a version twice, or duplicate a private note. Reuse with changed fields is rejected. Current permissions are checked on replay; removed records are never recreated. Receipts store identifiers and a keyed fingerprint, not descriptions/private notes or response snapshots.
- A confirmed save stays confirmed if a necessary subsequent refresh fails. The UI closes the saved editor, explains that refresh is needed and clears the stale record list. Drafts remain available after unconfirmed saves. Workspace switching is disabled during pending operations.
- Normal deletion updates the list and activity without refetching the workspace. Permanent deletion behavior itself is unchanged; archive/restore is a separate recommendation.

## Measured evidence

A rolled-back fixture of 1,000 synthetic contacts, each with a 4,000-character description, produced these JSON sizes:

| Payload | Bytes |
| --- | ---: |
| Full record list | 4,601,001 |
| One record | 4,600 |
| Previous permission input | 4,409,001 |
| Limited-collaborator relationship input | 185,001 |
| Whole-workspace permission IDs | 46,001 |

In this fixture, permission payloads shrink by about 96% for limited collaborators and 99% for whole-workspace collaborators. Routine saves eliminate the subsequent full-list request; the actual returned mutation also contains bounded activity metadata for owners. These are synthetic payload comparisons, not production billing forecasts or measured end-to-end latency.

48 automated tests pass, including concurrency, private notes, stale edits, permission changes between pages and retry after deletion. Browser checks exercise all six record forms, wallet/email linking, scoped collaboration, imports, reports, session recovery, mobile/accessibility checks and a deliberately dropped response after a successful commit. That new browser scenario verifies the retry uses the same operation ID, creates exactly one record and performs zero workspace reloads. Production webpack build and TypeScript checks pass.

## Deployment and limitations

Apply only the additive performance migration before deploying the new application:

`npx tsx --env-file=<restricted-environment-file> scripts/migrate-performance.ts`

It adds a workspace revision column, revision triggers, a workspace/record index and a content-free save-receipt table. The migration runs in a transaction with a lock timeout. Existing application versions and explicit full exports continue working. Rolling back code should retain receipts and additive schema; do not drop them or rewind the database.

Initial loading still retrieves the complete authorized workspace in bounded pages, preserving current full-text client search, relationship selectors and complete reports. It is not yet lazy loading by screen. For very large lead lists, add server-side search, list pagination and aggregate reports together, with complete permission checks; don't introduce partial dashboards. A workspace changing continuously can exhaust the bounded reload attempt and require Refresh. Receipts consume a small amount of metadata per confirmed operation; any future retention policy must preserve deduplication guarantees. There is no new background polling, paid service or cache containing private notes.

## Next: focused lead generation through MCP

The current MCP catalog offers public project context; catalog selection does not grant private CRM authority. CRM already has selected-record read grants and separately reviewed note/task publishing behind its AI feature flag. That is useful groundwork, but it is not yet an approved prospect-creation connector, and the existing note/task permission must not silently become permission to create people or organizations.

Recommended sequence:

1. **Campaign brief:** select workspace, desired organization/person type, geography, relevant topics, exclusions, maximum results, permitted public sources and freshness requirements. Offer a few optional criteria, not a new campaign-management product.
2. **Explicit CRM connector:** bind the MCP connection to the signed-in user and selected workspace/records. Recheck membership and sharing on every call. Keep credentials out of model prompts and logs, omit private owner notes, provide expiry/revoke and log content-free action metadata.
3. **Research-only preview:** return a bounded list of prospects with source URLs, retrieval time, relevance reasons, known facts and unresolved claims. Rank fit and evidence separately. Use permitted public professional sources; do not invent contacts or infer contact permission. A local model does not make a remote data source local—show which source/provider receives each request.
4. **Duplicate and exclusion review:** check only records the user can access. Respect existing do-not-contact choices within that scope and avoid exposing hidden matches. Present match suggestions for human review; do not automatically merge people by name. Broader suppression rules require a separately designed privileged check that does not disclose restricted records.
5. **Explicit accept:** preview the exact people/organizations/opportunities/tasks to create, their destination and audience. Introduce a separate bounded prospect-write permission and source-owned approval. Use immutable proposal hashes and idempotent operation receipts for publication; an approval cannot expand sharing or authorize outreach.
6. **Measure usefulness:** show accepted/rejected/duplicate counts, source age and simple rejection reasons. Apply saved user preferences to later runs only with clear scope. Keep AI-generated research separate from verified user-entered facts.

Suggested initial MCP tool boundaries (proposals, not existing endpoints): `crm.read_selected`, `leads.preview`, `crm.check_visible_duplicates`, `crm.prepare_prospect_import`, `crm.publish_approved_import`. Separate research from CRM mutations; an agent's ability to research is not permission to save or contact someone.

Start with one manually launched search producing at most 20 candidate organizations. Add person-level enrichment, recurring research and other providers only after the organization workflow is useful. Sending email, bulk scraping, automated identity linking, hidden-record discovery and unrestricted autonomous writes are outside this initial scope.

## Other useful follow-ups

1. Archive/restore to make cleanup reversible.
2. One Today view and digest definition with user timezone and resumable email batches.
3. User-synced saved views and better linked-record detail pages.
4. Reviewable duplicate handling and import column mapping.
5. Server-side search/aggregates once real workspace sizes justify the extra complexity.

## Release status

Local checks complete; upstream CI and production rollout pending.
