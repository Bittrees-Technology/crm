# Bittrees Calendar integration

Calendar uses the canonical email/Ethereum shared sign-in and its own item permissions. Its server calls this app's `/api/calendar` read endpoint with a per-app `CALENDAR_BRIDGE_SECRET`, HMAC-SHA256 proof, timestamp and request UUID. Configure the secret in server-only hosting settings; no source database or execution credentials are distributed. Unknown/expired proofs fail closed.

Source reads recheck the current verified source identity and native resource permissions. Authenticated Calendar sessions do not grant source memberships or roles. Responses are bounded metadata; no private notes, transcripts, recordings or credentials are transferred. Source access changes are checked on each refresh. Calendar does not mutate source tasks or execute workflows.

CRM contributes currently permitted task/project/opportunity deadlines. Workflows contributes the current permitted catalogue and readable hub run metadata. AutoNote contributes readable meeting labels/times and the user's selected Google meetings. Roles contributes a current membership decision derived from existing approved Workflow grants or Roles directory/tier access; it does not activate a new policy or grant a role.

AutoNote's `/api/calendar-context` is source-session protected. It reads a permitted Calendar meeting and can link a currently readable AutoNote meeting to an item the user organizes. The UUID-only handoff opens the existing recorder on explicit user action; participant consent, source sharing and reviewed CRM publication remain enforced. Calendar receives only the access-controlled AutoNote URL. No recording starts automatically.

Calendar is registered as an exact-origin shared sign-in client at `https://calendar.bittrees.org/api/sso/callback`. The Roles broker release must accept its client ID before the new registry is deployed. Existing clients are retained. Login/SSO synchronization scripts include Calendar.
