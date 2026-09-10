# Bittrees CRM

**Live:** [crm.bittrees.org](https://crm.bittrees.org) · [Try the fictional demo](https://crm.bittrees.org/?demo=1)

An independent relationship workspace for people, organizations, partnerships, and the next step.

**MIT licensed.** Next.js, React, PostgreSQL, Sign-In with Ethereum, and passwordless email verification.

## MVP

- People, organizations, opportunities, projects, tasks, and notes.
- Search, ownership filters, browser-saved views, pipeline board/table views, follow-ups, stage aging, and reports with separate currency totals.
- Validated CSV imports with duplicate preview; CSV view exports and a JSON export of accessible shared records.
- Ethereum EOA sign-in and email codes through Resend.
- Explicit verification to link an email and wallet to one account. Never merges separate accounts automatically. If both methods already have accounts, a recovery review requires fresh verification of both accounts and explicit confirmation.
- Multiple independent workspaces, owner/editor/viewer permissions, email-bound invite links, member access changes.
- Inline task completion, opportunity stage changes, and due-date changes.
- Contact and organization timelines with linked notes, task completions, and opportunity updates.
- Optional daily follow-up email to a verified address, disabled by default.
- Pending invitation status, revocation, replacement links, and guided email matching.
- Backup sign-in prompts, verified-method visibility, cancellable wallet requests, and bounded waits.
- Optimistic edit versions, atomic writes, relationship integrity, and a workspace activity history.
- Responsive interface and an isolated fictional demo (`/?demo=1`). Demo edits are intentionally session-only.

No other Bittrees product, control plane, token, or contract deployment is required.

## Run locally

Requires Node.js 24+, npm, and PostgreSQL 17 (or Docker).

```sh
npm ci
cp .env.example .env.local
# Set AUTH_SECRET to a randomly generated string of at least 32 characters.
# For example: openssl rand -hex 32
# If using Docker:
docker compose up -d
npm run db:migrate
npm run dev
```

Open `http://127.0.0.1:3040`. `APP_URL` must match the browser origin exactly, including protocol and port.

For local email verification, `DEV_EMAIL_CONSOLE=true` prints codes only to the local server console. This option is **always disabled in production**, regardless of its value. Sign in with a wallet extension or use an email code. In Settings, verify the other method to link it.

New accounts receive an empty private workspace. Demo records are never written to the database. Browser storage, where used, contains view preferences only.

## Production configuration

| Variable         | Purpose                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`   | Dedicated PostgreSQL connection string, TLS enabled for remote databases  |
| `APP_URL`        | Canonical HTTPS app origin                                                |
| `AUTH_SECRET`    | At least 32 cryptographically random characters for email-code hashing    |
| `RESEND_API_KEY` | Dedicated email-delivery API key                                          |
| `CRON_SECRET`   | Random secret securing the scheduled digest endpoint |
| `EMAIL_FROM`     | Sender on a verified domain, e.g. `Bittrees CRM <signin@crm.example.org>` |

Email sign-in is unavailable until its delivery credentials are configured. Ethereum login remains independent. Resend needs verified DNS records for the sender domain. Do not use development sender addresses for general users.

Set production variables in Vercel, apply the schema to the production database, then deploy the tested commit. Runtime code does not run migrations automatically. For the initial schema:

```sh
# Use a private, ignored environment file; never commit live credentials.
npx tsx --env-file=.env.production.local scripts/migrate.ts
vercel --prod
```

Use an independent database for previews, or leave preview auth unavailable. Never point unreviewed preview code at production data. The app allows its explicit canonical origin and the exact Vercel deployment URL for origin checks; SIWE messages remain bound to the requesting origin.

## Team coordination

1. Rename the workspace and your display name in Settings.
2. Create an invite for the teammate's email and selected role.
3. Share the generated link directly. The app does not send invitation emails.
4. The teammate signs in with that verified email, or links it to their wallet account, then accepts the invite.

Owners manage membership, invitations, and record sharing. Editors create and update accessible records; CSV import requires whole-workspace access. Viewers can read and export accessible shared records. Each owner can keep a personal private note alongside a shared description; other owners cannot read that note.

The owner role cannot be removed or transferred through this MVP. Reassign a member's records before removing them. Invitations expire after seven days and are single-use; redemption checks the exact verified email. Owners can revoke or recreate links in Settings. Recreating invalidates all earlier pending links for that email. Identity deletion and standalone ownership transfer are deferred. Link both email and wallet early if you need two independent sign-in methods.

## Identity and security model

- EIP-4361 messages generated by the server with domain, URI, nonce, issued-at, and ten-minute expiry.
- Verified Ethereum EOA signatures; smart contract wallets/EIP-1271 and WalletConnect are not included in this release.
- Challenges are browser-bound, single-use, and transactionally consumed, with five proof attempts maximum.
- Email codes are eight digits, expire after ten minutes, and are HMAC-hashed at rest.
- Seven-day opaque sessions: only hashes stored in PostgreSQL. Production cookies use `__Host-`, Secure, HttpOnly, SameSite=Lax.
- Exact origin checks for mutations; authenticated and unauthenticated rate limits stored centrally in PostgreSQL.
- Every record operation checks workspace membership and role on the server. Linked records must belong to the same workspace.
- Updates require the current record version; stale changes return a conflict instead of overwriting another user's work.
- Contact wallet references are unverified business metadata. They never create identities or grant access.
- Linking requires an active session plus fresh verification of the added identity. Existing identities can only move through the explicit two-account recovery flow.
- The app never asks for private keys, sends transactions, grants governance roles, or moves assets.

## Verify

Create a separate `crm_test` PostgreSQL database and `.env.test` from the example. Its URL must end in `/crm_test`: tests deliberately refuse to truncate any other database.

```sh
npm test
npm run typecheck
npm run build
# With the local development environment, port 3040 free, and Chromium installed:
npx playwright install chromium
npm run test:browser
```

Browser checks use isolated test wallets and local verification codes in a disposable `crm_browser_test` database (the local PostgreSQL role needs database-creation permission). They exercise both identity-linking orders, duplicate-account recovery, all six record forms, imports/exports, reports, invitations/roles, session renewal, failure recovery, and desktop/mobile accessibility. This dedicated browser-test database is reset each run; user workspaces are not used. No real wallet extension or personal inbox is controlled.

Tests exercise real PostgreSQL transactions, SIWE signatures, email verification, replay/expiry/attempt limits, identity collisions, invitation redemption, cross-workspace access, reference integrity, duplicate imports, role revocation, and stale edits. CI uses an isolated PostgreSQL service.

## Recover separately created email and wallet accounts

If you signed in separately with email and a wallet, each method may already have an account. In Settings, choose **Link email or wallet** and verify the other method. The app shows both accounts and their workspace access. Verify a method from your current account, then explicitly confirm combining them.

Workspaces remain separate, records remain intact, and assignments from the other account move to your current account. Shared workspaces retain the stronger existing role. Historical activity keeps its original attribution. All verified sign-in methods move to the current account; old sessions for both accounts are revoked. Daily digests turn off and can be re-enabled in Settings. The historical user row is retained for audit attribution but cannot sign in.

Recovery requests are single-use, expire after ten minutes, and are bound to the current session. Changed identity or workspace access requires a fresh review. Nothing is combined merely by viewing the review, and combining cannot be undone through the UI.

## Daily digest

Enable the daily digest in Settings and choose a verified email. The scheduled Vercel job runs once daily around 08:00 UTC. It includes only your assigned open tasks and active opportunities due within seven days, including overdue items, across workspaces you can access. Empty digests are skipped. Turn it off in Settings at any time.

Set `CRON_SECRET` in Vercel production. `GET /api/cron/digest` requires its bearer token; Vercel supplies this automatically. Per-user/day receipts and provider idempotency prevent duplicate sends on retries. Failed delivery is recorded; the next scheduled day generates a fresh digest. No historical digest is automatically resent. The current bounded job is designed for small teams; monitor failures and remaining work before growing beyond a few hundred daily recipients.

## Workspace management and collaboration

Owners can rename a workspace in Settings, merge it into another workspace they own, or permanently delete it. Merge/delete require a fresh review and typing the source name. Merge preserves record IDs, links, and activity; matching names remain separate records. Source invitation links are invalidated. Whole-workspace members gain access to ordinary records in the combined workspace, subject to record sharing restrictions; limited memberships retain their selected roots. Existing memberships combine access and use the stronger role, as shown in the merge warning. Export before deletion. Your last workspace cannot be deleted until another exists.

Invitations and existing members can be limited to selected projects, organizations, or opportunities and records linked beneath those selections. Scope checks apply on the server to reads, writes, exports, timelines, and emails. Hidden reference fields are omitted from responses and preserved during edits. Scoped activity omits historical field details; workspace audit history is owner-only, while collaborators use filtered record timelines. CSV import requires whole-workspace access. A shared record may be visible through any selected parent. A workspace owner can change access in Settings. Account identity recovery combines scopes; mixed non-owner roles use viewer to avoid extending editing rights without an owner's decision.

## Daily follow-up settings

The optional daily email defaults to assigned work. Users can choose all accessible work, a 0–30 day look-ahead, overdue inclusion, tasks/opportunities, selected workspaces, and weekdays only. Delivery remains around 08:00 UTC. The preview sends no email. Emails group overdue/today/upcoming items, include project/organization context and next steps, and link directly to records. Up to 50 items appear, with the remaining count shown. No matching work means no email. Permission and preference changes are rechecked before delivery; queued messages with outdated content are cancelled. Existing opt-in settings remain unchanged by this release.

Deployments must run the additive database migration before publishing this release (`members.scope_ids`, `invites.scope_ids`, and `users.digest_options`).

## Opportunity types

Built-in types include Partnership, Customer, Research, Contributor, Grant, Investment, Sponsorship, Integration, Consulting, Licensing, Community, and Event. Choose **Create custom type** in an opportunity to enter a label. Saving the opportunity also saves the label to your account for reuse across workspaces, devices, and sign-in methods. Personal options remain available after records are deleted; teammates can see a shared record's label without receiving your personal option list. Duplicate labels ignore capitalization and extra whitespace. Account recovery preserves both accounts' saved labels. Demo labels last only for the demo session.

## Opportunity currencies

The currency picker groups 18 fiat currencies, BTC/ETH/SOL and USDC/USDT/DAI, plus Bittrees BIT and BTREE. Reports show separate totals for currencies used in the workspace; amounts are never converted or combined across currencies.

New opportunity amounts are stored and exported as decimal strings, with up to 18 decimal places and a maximum of 1 trillion per record. Existing numeric amounts remain compatible. Totals use exact decimal arithmetic. BIT and BTREE are CRM denominations: no token contract, network, price feed, balance lookup, or payment flow is implied. Changing a currency changes the denomination, not the entered amount.

## Operations and data lifecycle

`GET /api/health` verifies database/schema availability; `GET /api/config` reports email capability without exposing credentials. Application APIs require authentication, except sign-in endpoints and health/config.

Use database-native scheduled backups and test restoration into a separate database before relying on the app for critical records. JSON exports are portable snapshots, not a substitute for database backups, and do not include authentication secrets. This MVP imports people/organizations from CSV; full JSON restoration uses a database migration or operator tooling, not the UI.

For a local database backup and restore drill:

```sh
# Run against your local Compose service; keep exports private.
docker compose exec -T postgres pg_dump -U crm -d crm -Fc > crm-backup.dump
docker compose exec postgres createdb -U crm crm_restore
docker compose exec -T postgres pg_restore -U crm -d crm_restore < crm-backup.dump
```

Monitor auth failures, database availability, and Resend delivery failures. Runtime errors return generic client messages. Audit records record actor/action/name/version rather than storing historical note content. Treat audit logs as private workspace data.

Periodic maintenance can delete expired sessions, expired challenges, expired or accepted invitations, and rate-limit rows whose reset time is older than one day. Retain audit records according to the operator's retention policy. Account deletion and organization-specific retention controls require operator support in this MVP; no automated deletion promise is made.

## Boundaries and next steps

Research and contributor work can use categorized opportunities and project associations. The first pipeline uses shared stages; specialized research/contributor stage editors are future work. Accounting, treasury, governance, and contributor authority remain separate products. External integrations, mailbox/calendar synchronization, AI assistance, billing, private fields, and automated outreach are intentionally absent.

This is an initial deployable MVP, not a claim of an independent security audit or unlimited production scale. Before a large rollout, load-test your database and email plan, add monitoring and backup automation, and define your support and retention policies.

## License

[MIT](LICENSE). Dependencies retain their own licenses. Bittrees names and marks are not separately licensed by this code license.

## Hosted verification

The v0.4.0 suite covers 36 automated tests plus Chromium checks for both identity-linking orders, wallet cancellation/timeouts, quick edits, timelines, invitation management/joining, and digest preferences. These checks also run in GitHub CI.

The initial September 9, 2026 deployment passed 17 PostgreSQL-backed tests, the production build, GitHub CI, a local backup/restore drill, and live HTTP smoke checks.

The live checks covered Ethereum sign-in, linked record creation and deletion, conflict detection, exports, logout, passwordless email sign-in, explicit wallet linking, and re-login to the same account. Email delivery was exercised using Resend's synthetic test address, not a personal inbox. Temporary test accounts were removed.

To repeat against a deployment you operate, with its database and Resend credentials in a private environment file:

```sh
SMOKE_URL=https://crm.bittrees.org npx tsx --env-file=.env.production.local scripts/smoke.ts
SMOKE_URL=https://crm.bittrees.org npx tsx --env-file=.env.production.local scripts/email-smoke.ts
SMOKE_URL=https://crm.bittrees.org npx tsx --env-file=.env.production.local scripts/recovery-smoke.ts
```

These scripts create and clean up their own temporary accounts. Never point the database configuration at a different deployment. Vercel does not export the values of sensitive variables; set `SMOKE_URL` explicitly. The email test requires a provider API key with permission to read its own sent test email.

The hosted MVP uses a dedicated Neon database in Frankfurt and Resend sending from `signin@crm.bittrees.org`, initially on free plans. Check provider limits before onboarding a large team. Public GitHub changes on `main` are connected to Vercel deployment.

## Record sharing and personal owner notes (0.5.0)

Open any record and expand **Sharing & access**. Follow workspace access by default, or choose **Selected people**. No selections means owners only. A selected collaborator receives access to that one record, using their existing editor/viewer role. A direct grant does not automatically share its children. Scope inheritance stops at a restricted record; another permitted parent may still provide access. Whole-workspace members evaluate each record independently. All workspace owners can access shared record content.

The editor lists effective access and proposed record-count changes before saving. **Settings → Team members → Review who can access each record** lists each person's accessible records and the reason. Removing a member clears their individual record grants; reinviting does not restore old grants. Assignment is separate from permission.

**Your private note** is a separate author-only field, available while its author is a workspace owner. Each owner has their own note. It is excluded from shared descriptions, search, exports, timelines, access reports, and daily emails. Shared and private changes save atomically, with conflict detection. Account recovery preserves both accounts' notes (combining text if both wrote on the same record); workspace merges preserve authorship. Record or workspace deletion deletes associated private notes. Database operators and private database backups remain trusted infrastructure.

Apply the additive migration (`records.visibility_ids`, `record_private_notes`) before deploying 0.5.0. Existing records retain workspace sharing. Older deployments must remain deployment-protected because their code does not enforce these new restrictions.

### AutoNote connection

`/connect/autonote` approves or revokes AutoNote grants for one destination. AutoNote presents a review before publishing a summary and accepted actions. CRM rechecks current access, preserves destination sharing, and skips already-published items. Grants expire after 30 days. Private owner notes are not exposed. Published copies remain after disconnect or source deletion. Set `AUTONOTE_URL` to the matching environment's origin; its production default is `https://autonote.bittrees.org`. Run the additive database migration before deploying this integration.
