# Research datasets and bidirectional MCP

## Start independently

1. Sign in to CRM with email or an Ethereum wallet. Use your own workspace.
2. Open **Lead research → New private list**. Name it **BBRF-PT investor pilot**.
3. Open **Dataset, agent connection & sharing**. Create a dataset connection and copy its MCP configuration into your local agent's MCP server settings. This is an HTTP MCP server; clients must support URL + Authorization header connections.
4. Ask the agent to call `dataset.schema`, then `dataset.read`, and research 5–10 people linked to their organizations. Save through `dataset.save`. Private lists and publication selections have no fixed entry-count cap; choose a review size appropriate to the evidence.
5. Review evidence and mark training eligibility. Download research JSON for a lossless saved dataset and approved CRM mappings, or eligible JSONL for training. The email field is excluded from training JSONL; review free text for personal information and source restrictions yourself.

Do not use the assignment-based lead MCP credential for this workflow. Dataset connections have their own endpoint and permissions.

## Data contract

`dataset.schema` returns the machine-readable entry schema. An entry has a stable UUID, kind (`people`/`organizations`), name, category, title, website, optional professional email, description, and an `organizationId` referencing an organization entry in the same dataset.

Optional `research` contains up to three sources (`url`, `retrievedAt`, `claim`, `usage`), relevance, uncertainties, verification, and training eligibility (`pending`, `eligible`, `excluded`). A research export includes schema version, dataset ID/version, timestamps, entries, current selected CRM sources, and submission receipts. Stable dataset IDs are separate from CRM IDs.

Example agent prompt:

> Build a BBRF-PT investor dataset with 5–10 people and their organizations. First read dataset.schema and dataset.read. Confirm the investment criteria from the project's public materials. Distinguish capital allocators from advisers and introducers. Preserve entry IDs, cite sources for factual claims, and record unknowns. Keep training eligibility pending. Save using the current dataset version. Do not contact anyone or publish records.

Public availability is not training permission. The researcher decides permitted training use, keeps versioned exports and separate evaluation data, and manages model training. CRM does not train a model or install one.

## Read and write through MCP

Endpoint: `/api/integrations/datasets/mcp` (Streamable HTTP JSON-RPC POST).

- `dataset.schema {}`: entry schema and workflow constraints.
- `dataset.read {revision?, pageSize?, offset?, pageRevision?}`: dataset, explicitly linked live CRM sources and submission status. Returns `unchanged: true` for the same revision. Source changes stay separate from research entries to prevent silent overwrites.
- `dataset.patch {version, name, changes, removeIds, entryOrder?}`: atomic entry changes and removals; unchanged entries remain intact.
- `dataset.save {version, name, entries}`: replace this private dataset's entries using optimistic concurrency. Preserve IDs and relationships. Retry the same payload/version after an uncertain response. A changed payload with a stale version is rejected.

In **Add published CRM records**, select records, including linked organizations. This explicitly enables live reads of those records while the dataset owner retains access. It does not expose the rest of the workspace. Removing the entry removes its live source link. Previously copied research remains in the dataset; revoking access cannot recall data already downloaded.

For changes flowing back to linked CRM records, use **Review proposed CRM updates**. A workspace owner sees current/proposed field values and approves them. A digest binds approval to the exact dataset and CRM versions; changed data or permissions requires a new review. Sharing, unrelated record fields and private notes are preserved. Agents cannot approve these updates.

No background polling or automatic outreach is enabled. The agent initiates reads and saves. Credentials expire after 30 days and can be revoked or replaced. Account recovery invalidates the old user's credential authority.

## Share with Jonathan / BBRF-PT

Once registered, accept a project-scoped invitation to the destination workspace. In **Submit selected entries for approval**, select people and their related organizations, the destination workspace/project, and the approving owner. This submits an immutable copy and leaves the working dataset editable.

The owner reviews duplicates and publishes selected candidates through the existing Lead research review. Nothing is written to their CRM until approval. Submitted existing records are treated as candidates; matching destination records require duplicate resolution rather than silent replacement. For updates to a destination record, its owner can add it to their own dataset and use the reviewed update flow.

The researcher can also select their own project and themselves as owner to publish into their own workspace. Create a project first if none exists. Receipt mappings return only destination record IDs the researcher can currently access; owner-only published records remain private.

## Operations

Apply `scripts/migrate-datasets.ts` before deploying this feature. It creates three additive tables for expiring dataset connections, selected source links, and idempotent submission receipts. Existing lead credentials gain no new capabilities. The normal full schema migration includes the same tables.

Tests cover credential isolation/revocation/expiry, stale writes and retries, linked records, training eligibility, selective submission and owner approval, read visibility, exact reviewed CRM updates, private-note exclusion, mobile accessibility and HTTP MCP discovery.

## Projects and the Mac companion (schema 1.1)

Datasets now accept `projects` alongside people and organizations. Project entries use stable entry IDs, name, category, source and description. The same dataset MCP credential remains limited to its approved dataset and separately granted project operations. Use the Mac app's Connections → CRM dataset panel to paste the copied MCP configuration, read selected source snapshots and preview private dataset saves.

Project import is a separate owner-only CRM review. Select project entries and an owned workspace, preview all fields, and approve the current digest. New projects are restricted to workspace owners and receive dataset record links. Same-name projects, including archived records, block creation; import existing records into the dataset to propose updates instead. A concurrent dataset or destination change invalidates approval. Repeated approval cannot create a second copy.

Linked projects participate in existing readback and reviewed-update flows. Private notes and unrelated fields are excluded or preserved. Project entries cannot enter investor lead publication; submit only people and organizations through that review path. No background sync, automatic sharing or agent approval is added.

## Bounded investor research

`dataset.append {version, entries}` adds entries without a fixed count quota. It never overwrites an existing entry: identical IDs/content are safe retries, differing content and duplicate names are conflicts. Training approval remains human-only. Full `dataset.save` remains an explicit replacement with the existing 2 MB request protection. `dataset.patch {version, name, changes, removeIds, entryOrder?}` updates a large list atomically without retransmitting unchanged entries. An optional entryOrder must list every resulting entry exactly once. Publication selections have no fixed count quota, and MCP exposes no submission or approval method. No schema migration is needed.

## Large portfolios

Private-list count, entry count, append count, research targets and owner-review selection count have no fixed business quotas. Assignment-specific requested targets, source permissions, human approval, duplicate/link checks, token expiration, request rates and transport byte limits remain enforced.

Use `dataset.read {pageSize:100}` for the first page. Continue using the returned `pagination.nextOffset` as `offset`, together with the first page's `revision` as `pageRevision`. Page size is an upper bound; replies may contain fewer entries to fit the transport. Assemble only pages with the same dataset ID, version and revision; discard a partial read if any page reports a conflict. Each revision includes current permission-filtered CRM source snapshots. `revision` alone still supports unchanged checks. Legacy full reads remain available for smaller replies; large replies direct the caller to paging. The native private-list editor uses version-checked pages and server-side copies.

The MCP tool schema advertises `dataset.patch`. Changed training-approved content still needs human reapproval, and patching never grants publication rights. Add large initial portfolios through request-sized append batches. No database migration or permission expansion is required.
