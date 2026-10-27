# Organization standing reviews

Standing is provisional organization research. It is separate from personal ratings, investor verification, investment interest, legal eligibility and outreach permission. Profiles show the evidence confidence, original review date, rationale, limitations, theme-fit hypothesis and source URLs. People display their available linked organization's review; no personal score is stored.

Workspace owners can open Organizations → Review standing file. Upload a `bittrees-organization-standing.v1` JSON object containing `rows`, each with `name`, `website` and an `assessment` matching `organizationStandingSchema`. Files must fit the existing request-size limit. Split large files into separate batches. No portfolio count limit is imposed.

The preview requires a unique normalized organization name and matching website hostname. Archived records are excluded. A server HMAC binds the authenticated owner, workspace, all matched IDs/versions, current assessments and proposed assessments. Apply checks owner membership again and performs the batch atomically under the existing workspace lock. Concurrent record changes require a new preview. Repeating an identical applied file changes nothing. Existing contacts, descriptions, relationships, private notes, visibility and verification remain unchanged. Each changed organization gets an audit entry with its previous and new assessment.

Standing imports neither create records nor expand dataset/MCP credentials or CRM source links. Generic record and CSV saves cannot inject or replace standing; ordinary edits preserve existing reviews, including when an older client omits the field. Existing source adapters also preserve it through normal record saves.

Lists filter by standing tier and sort by standing, confidence, review queue or name. A/B/C sort first; platform (P), unrated (U), then unassessed entries remain distinguishable. Names break ties without inventing an exact quality rank. Saved views retain the filter and order. Exports include the assessment and flat tier/confidence/review-queue columns, including clearly inherited organization research on people.

No migration, new service, source connection or paid enrichment provider is required. Review files and private operational receipts belong outside the public repository.
