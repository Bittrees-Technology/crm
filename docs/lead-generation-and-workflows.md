# Lead research and CRM workflows

## Investor research through a local MCP client

Enable `CRM_LEADS_ENABLED=true` after applying `scripts/migrate-workflows.ts`. This is separate from `AI_CONNECTOR_ENABLED`; no broader AI access is enabled by this workflow.

1. Create a research project. In Settings, invite the researcher by verified email or Ethereum wallet address as a **viewer**, limited to that project. Wait for them to accept. An existing editor can also research, but retains their existing editing rights; assigning research never changes membership or sharing.
2. Open **Lead research**. Select a workspace, project and researcher, then specify investor criteria, geography, exclusions, allowed source domains, maximum results (1–20 total people and organizations), and source freshness.
3. The researcher opens **Lead research** under their own account and selects **Connect / replace agent credential**. The credential is shown once, stored hashed, expires with the seven-day assignment, and can be revoked by either participant. Replacing it invalidates the old credential. Only the assigned researcher can obtain it; the owner does not share their personal credential.
4. Their MCP agent researches public sources and submits one immutable batch. The researcher can inspect their submitted draft; existing CRM matches, record IDs, private notes and other assignments are withheld.
5. The assigning owner reviews the people, firms, categories, evidence, uncertainty and possible matches, then explicitly publishes selected leads or rejects the batch. Other owners cannot approve this assignment. Selecting a person linked to a firm requires also selecting that firm.

New records start **visible to workspace owners only**, linked to the research project, with communication permission **Unknown**. Publishing means saving to CRM, not posting publicly or sending outreach. Use existing record-sharing controls afterward if the researcher should see published leads. The review displays the owner audience. Reused organizations retain their existing sharing and data.

Prefer the copyable remote configuration in CRM (see Guided connection below). For clients that only support local commands, configure the optional adapter to launch `node /absolute/path/to/crm/integrations/lead-mcp.mjs`. Supply `CRM_LEAD_TOKEN` through the client's protected process environment, never prompts or shared files. Default origin: `https://crm.bittrees.org`; isolated testing permits `http://127.0.0.1:3040`. Redirects and arbitrary origins are rejected. The adapter implements MCP 2025-11-25 stdio.

- `leads.brief`: approved research criteria, project identifier and expiry. No CRM records or member lists.
- `leads.preview`: submit sourced people and organizations with a stable operation UUID. Retries must keep the same operation UUID and candidates. No publication or messaging tool exists.

Candidates have `kind` (`organizations`, the backward-compatible default, or `people`), `category`, name, public HTTPS website/profile, optional professional `email` and `title`, summary, relevance, uncertainties, fit/evidence labels, and 1–3 source URLs with retrieval timestamps. People can set `organizationIndex` to the zero-based index of a firm in the same batch, or omit it for an independent investor. Categories support Angel, Venture capital, Family office, Corporate investor, Accelerator, Fund of funds, and custom labels. Labels persist on CRM records and are offered again in the record editor; normal search/saved views can find them.

Validation checks allowed source domains, freshness, exclusions, result limits, valid person-to-organization links and batch duplicates. Multiple people can share a firm's website. Person matches use name or professional email; firm matches use name/domain. The owner may reuse an active matching organization without overwriting it. Archived and do-not-contact matches are not eligible for reuse; duplicate people are blocked. Existing match versions and the owner audience are bound to the approval digest. Changed matches require another review.

Each request checks current owner authority, researcher membership, active project access, expiry and revocation. Removing access or archiving the project prevents further draft submission and publication. Import is atomic and idempotent, including simultaneous retries; linked records are created together. Content-free audit entries retain the review identifier. Research permission does not grant editing, exporting, outreach, identity management or broader MCP access. A viewer can still read records already authorized by their membership; choose project-limited membership when inviting them.

The agent uses its own model/search tools. CRM adds no paid service, fetches no submitted URLs and runs no background research. The brief and public research can reach the agent's configured providers. Source claims and timestamps are assertions, not independent verification. Use the review to assess suitability and evidence. Never infer private email addresses or permission to contact someone.

## CRM workflow improvements

- **Archive and restore:** Archive replaces the routine delete button. The Archived filter exposes restore. Links, sharing and private notes remain intact; archives leave active lists, totals and digests. Archived records cannot be edited or used as AI/AutoNote write destinations. Explicit permanent-deletion APIs remain available for existing administrative workflows. Archives are included in authorized exports and bounded workspace loading so relationships remain complete.
- **Saved views:** New saves sync to the signed-in user's account and workspace, including viewers. Up to 20 views are supported, with replace-by-name and deletion. Existing browser-only views remain local until explicitly saved to the account. View contents do not grant record access. Workspace merges preserve source views when a name does not already exist at the destination.
- **Linked records:** Record details include direct navigation to accessible linked records, with an unsaved-change confirmation.
- **Follow-ups:** Today and email share assignment, record-type, date-window and overdue selection logic. An IANA timezone controls calendar dates and weekday choices; delivery remains the existing approximately 08:00 UTC schedule. Today displays the current workspace; email can include selected accessible workspaces. Processing receipts allow a retried daily batch to skip sent/cancelled/empty accounts. Existing provider idempotency and permission rechecks remain in place. No new cron schedule is introduced.
- **CSV imports:** Users map source headers and review the proposed records and skipped matches. People with the same name and different emails are distinct. Organization websites and matching email addresses are strong matches; names alone match only if both records lack email and website. Imports never merge or overwrite existing data. Permission checks and deduplication run again on the server, including accessible archived records.

## Deliberately deferred

Server-side search, lazy lists and aggregate reports were recommended only when observed workspace sizes justify them. A read-only production aggregate on 14 October 2026 found eight records across two nonempty workspaces, with seven in the largest. The existing complete, permission-checked paginated loader remains; partial client totals have not been introduced. Rich analytics, automated enrichment and recurring research remain deferred until the manually reviewed investor workflow demonstrates a need.

## Rollout

Apply the additive migration using an existing restricted database environment, then deploy the code. The migration adds workflow/private-list tables plus nullable researcher/project references to existing lead searches; it does not delete or rewrite customer records. Retain additive schema during rollback. A rollback to the older application will display archived records as ordinary active records because the older UI does not understand the new archive timestamp.

Validation and deployment results are recorded in the release report after completion.

## Wallet invitations

In Settings, choose **Invitation method → Ethereum wallet**, enter the recipient's `0x` address, select Viewer and the research project, then create and share the invitation link. The recipient signs in with that wallet (or links it to their existing account) and accepts. No email is required. Only an account with that verified wallet can accept; possession of the invitation link alone is insufficient. Mixed-case addresses must have a valid Ethereum checksum.

Wallet invitations retain the same seven-day expiry, revocation, single-use acceptance, and scope as email invitations. Recreating a link invalidates older pending links for the same address, regardless of casing. Accepting an invitation does not upgrade an existing member's permissions. Research assignment and publication approval remain separate: a viewer may submit assigned research, but only the assigning owner can publish it.

Before deployment, run `scripts/migrate-invites.ts` using the existing restricted production database environment. It adds a wallet recipient column and allows email to be empty only for wallet invitations; existing email invitations remain intact.

## Guided connection and private research lists

In **Lead research**, the assigned researcher selects **Connect / replace agent credential**. The setup card provides Cursor and VS Code configuration, server URL, copy controls, a credential visibility toggle, a CRM connection check, and starter research instructions. The credential belongs to the researcher and their assignment. Store it in personal client settings, not a prompt or shared repository. Existing client server entries should be preserved.

Compatible clients can use `https://crm.bittrees.org/api/integrations/leads/mcp` with Streamable HTTP and an `Authorization: Bearer …` header. The stateless endpoint supports initialize, ping, tools/list, and tools/call; notifications receive 202, GET receives 405, and cross-origin browser requests are rejected. Every request rechecks current assignment authority. The only tools remain `leads.brief` and `leads.preview`; there is no publication tool. The older stdio adapter remains available for clients without remote HTTP/header support. OAuth-only clients are not supported by this connection. The CRM connection check confirms the credential and server, not the configuration inside another application.

Anyone with a CRM account can also use **My private research lists → New private list**, with no assignment or AI required. Each account can save up to 100 lists of up to 20 entries. Add organizations, then add people and choose their related organization; standalone people are supported. Names are required; categories, professional email, public website/profile, title and research notes are optional. Save each entry explicitly. Lists are stored under the user's account and excluded from workspace browsing, other users' lists and MCP tools.

When ready, select an accessible workspace/project and an approving owner, then choose **Share list for approval**. This freezes the submitted version and creates a separate review copy. Only that owner can decide it. The review expires after seven days, and current project access is checked again at approval. New published records are visible to workspace owners only. Sharing is a CRM review action; it does not send an email or contact any lead. A researcher can withdraw an undecided submission, make an editable copy, or remove their personal list without deleting the owner's review copy.

Manual entries are marked as researcher submissions with unconfirmed evidence, rather than pretending to have agent-supplied sources. Agent submissions still require public websites and evidence URLs. The independent list editor is manual in this release; MCP research still uses an owner-created assignment and submits directly to its approval queue.

The additive workflow migration now also creates `lead_drafts`. No background polling, enrichment, paid service or new scheduled job is added. Validation includes private-list isolation, optimistic concurrency/retries, scoped sharing, manual person-to-firm publication, MCP discovery authentication, origin/protocol rejection, and prevention of manual-mode bypass by an agent. Browser coverage exercises both generated configurations, the connection check, private entry persistence, sharing and owner publication.

## AI marketplace coordinator pilot

Owners may now opt an assignment into proposed follow-up tasks with `allowTasks: true`; omitted/older briefs default to false. Tasks use the same sourced candidate format and may link to people through `contactIndex` and organizations through `organizationIndex`. Review must select linked records before importing the task. Tasks are assigned to the approving owner without invented deadlines. They do not send outreach.

`leads.status` and `POST /api/integrations/leads/status` reconcile `{operationId}` against the current assignment. They recheck assignment authority and return proposal state and review location without exposing CRM record IDs. AI uses this through MCP Connect to recover uncertain responses. A fresh weekly batch still needs a fresh seven-day assignment; the pilot does not grant permanent workspace access.
