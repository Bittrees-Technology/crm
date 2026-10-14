# Lead research and CRM workflows

## Organization research through a local MCP client

Enable `CRM_LEADS_ENABLED=true` after applying `scripts/migrate-workflows.ts`. This flag is separate from the existing `AI_CONNECTOR_ENABLED` selected-record connector. Enabling lead research does not enable the older connector or expand its note/task permissions.

A workspace owner opens **Find organizations**, selects a workspace and supplies a target, optional geography/exclusions, permitted source domains, result limit (1–20) and retrieval freshness window. The resulting credential is shown once, stored hashed by CRM, expires after 24 hours and can be revoked. One connection accepts one immutable research batch.

Configure an MCP-capable local agent to launch `node /absolute/path/to/crm/integrations/lead-mcp.mjs`. Supply `CRM_LEAD_TOKEN` through that client's protected process environment. Do not put credentials in prompts, source control or shared files. The default server origin is `https://crm.bittrees.org`; the adapter permits `http://127.0.0.1:3040` for isolated local testing only. It rejects redirects and arbitrary origins. The adapter implements the MCP 2025-11-25 initialization and stdio tools interface.

Available tools:

- `leads.brief`: returns only the approved research brief and expiry. It does not read CRM contacts, private notes or member lists.
- `leads.preview`: accepts a stable operation UUID and sourced organization candidates, then returns a review path. It does not import records or authorize outreach. Retries must reuse the same operation UUID and exact payload.

The local agent uses its own search tools and model to gather public information. CRM does not purchase a search service, fetch submitted URLs, run scheduled research or silently send CRM content to a provider. The brief and researched pages may be sent to the agent's configured search/model providers; local inference does not make a remote search provider local. Returned source claims and retrieval times are agent assertions, not proof that a page was fetched or independently verified.

Each candidate contains name, website, summary, relevance, uncertainties, separate fit/evidence labels, and up to three HTTPS source URLs with retrieval timestamps. Validation checks the source-domain allowlist, freshness, exclusions, one candidate per website and the configured result limit. It cannot mechanically verify semantic geography or relevance; the human review remains essential.

Only the initiating owner can review or import. The CRM checks potential organization matches by name/domain and shows do-not-contact flags; no record or duplicate details go back to the agent. Candidates with possible matches cannot be imported through this workflow. The import review is bound to the immutable batch, current matches and current owner audience. Ownership, expiry and revocation are checked again during import. Selected records are created atomically with owner-only visibility and Unknown communication permission. Audit entries contain action/record/review identifiers rather than research text. Repeating a confirmed decision returns the receipt instead of creating another organization. Different decisions after completion are rejected.

The initial version intentionally supports organization research by workspace owners. It has no agent-controlled approval/publish tool, outreach, person enrichment, automatic merging, recurring search or autonomous preference learning. Existing selected-record AI access remains a separate opt-in path.

## CRM workflow improvements

- **Archive and restore:** Archive replaces the routine delete button. The Archived filter exposes restore. Links, sharing and private notes remain intact; archives leave active lists, totals and digests. Archived records cannot be edited or used as AI/AutoNote write destinations. Explicit permanent-deletion APIs remain available for existing administrative workflows. Archives are included in authorized exports and bounded workspace loading so relationships remain complete.
- **Saved views:** New saves sync to the signed-in user's account and workspace, including viewers. Up to 20 views are supported, with replace-by-name and deletion. Existing browser-only views remain local until explicitly saved to the account. View contents do not grant record access. Workspace merges preserve source views when a name does not already exist at the destination.
- **Linked records:** Record details include direct navigation to accessible linked records, with an unsaved-change confirmation.
- **Follow-ups:** Today and email share assignment, record-type, date-window and overdue selection logic. An IANA timezone controls calendar dates and weekday choices; delivery remains the existing approximately 08:00 UTC schedule. Today displays the current workspace; email can include selected accessible workspaces. Processing receipts allow a retried daily batch to skip sent/cancelled/empty accounts. Existing provider idempotency and permission rechecks remain in place. No new cron schedule is introduced.
- **CSV imports:** Users map source headers and review the proposed records and skipped matches. People with the same name and different emails are distinct. Organization websites and matching email addresses are strong matches; names alone match only if both records lack email and website. Imports never merge or overwrite existing data. Permission checks and deduplication run again on the server, including accessible archived records.

## Deliberately deferred

Server-side search, lazy lists and aggregate reports were recommended only when observed workspace sizes justify them. A read-only production aggregate on 14 October 2026 found eight records across two nonempty workspaces, with seven in the largest. The existing complete, permission-checked paginated loader remains; partial client totals have not been introduced. Rich per-candidate rejection analytics, person enrichment and recurring research should follow evidence from the initial manually launched organization workflow.

## Rollout

Apply the additive migration using an existing restricted database environment, then deploy the code. The migration adds an archive timestamp and separate tables for user views, lead briefs and immutable previews; it does not delete or rewrite customer records. Retain additive schema during rollback. A rollback to the older application will display archived records as ordinary active records because the older UI does not understand the new archive timestamp.

Validation and deployment results are recorded in the release report after completion.
