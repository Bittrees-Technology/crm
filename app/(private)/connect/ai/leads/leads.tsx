"use client";
import { useEffect, useState } from "react";
import type { Candidate } from "@/lib/lead-model";
async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "Request failed. Try again.");
  return value;
}
type Review = {
  id: string;
  workspace: string;
  audience: string;
  digest: string;
  candidates: Candidate[];
  matches: { id: string; name: string; doNotContact: boolean }[][];
  decision: unknown;
  expiresAt: string;
};
export default function Leads() {
  const [workspaces, setWorkspaces] = useState<
      { id: string; name: string; role: string }[]
    >([]),
    [workspace, setWorkspace] = useState("");
  const [target, setTarget] = useState(""),
    [geography, setGeography] = useState(""),
    [domains, setDomains] = useState(""),
    [exclusions, setExclusions] = useState(""),
    [limit, setLimit] = useState(20),
    [freshness, setFreshness] = useState(30);
  const [searches, setSearches] = useState<any[]>([]),
    [review, setReview] = useState<Review | null>(null),
    [accept, setAccept] = useState<number[]>([]),
    [reason, setReason] = useState("other");
  const [credential, setCredential] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    const [me, items] = await Promise.all([api("me"), api("leads/searches")]);
    setWorkspaces(me.workspaces.filter((w: any) => w.role === "owner"));
    setSearches(items);
  }
  async function open(id: string) {
    setReview(null);
    setAccept([]);
    setReview(await api("leads/review?id=" + encodeURIComponent(id)));
  }
  useEffect(() => {
    void act(async () => {
      await load();
      const id = new URLSearchParams(location.search).get("review");
      if (id) await open(id);
    });
  }, []);
  return (
    <main className="integration-page">
      <header>
        <a href="/">← CRM</a>
        <h1>Find organizations</h1>
        <p>
          Define a focused search, research with your connected agent, then
          review candidates here.
        </p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!review && (
        <section className="integration-card">
          <h2>Search brief</h2>
          <p>
            Owner access is required. The connection shares this brief only. It
            can submit one candidate batch within 24 hours; it cannot read CRM
            records, approve imports or send messages. Your agent’s search and
            model providers receive the brief and public research.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const s = await api("leads/searches", {
                  workspaceId: workspace,
                  brief: {
                    target,
                    geography,
                    sourceDomains: domains
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    exclusions: exclusions
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    maxResults: limit,
                    freshnessDays: freshness,
                  },
                });
                setCredential(s.token);
                await load();
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>Target organizations</legend>
              <label>
                Workspace
                <select
                  aria-label="Workspace"
                  required
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                >
                  <option value="">Choose workspace</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                What makes an organization relevant?
                <textarea
                  required
                  maxLength={500}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
              <label>
                Geography (optional)
                <input
                  maxLength={200}
                  value={geography}
                  onChange={(e) => setGeography(e.target.value)}
                />
              </label>
              <label>
                Permitted source domains, separated by commas
                <input
                  required
                  placeholder="company.org, industry.org"
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                />
              </label>
              <label>
                Exclude names or topics, separated by commas
                <input
                  value={exclusions}
                  onChange={(e) => setExclusions(e.target.value)}
                />
              </label>
              <label>
                Maximum organizations
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </label>
              <label>
                Sources retrieved within this many days
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={freshness}
                  onChange={(e) => setFreshness(Number(e.target.value))}
                />
              </label>
              <button className="button primary" type="submit">
                Create search connection
              </button>
            </fieldset>
          </form>
          {credential && (
            <section>
              <h3>Connection credential</h3>
              <p>
                Shown once. Store as CRM_LEAD_TOKEN in your local MCP server
                environment, outside prompts and shared files.
              </p>
              <input
                aria-label="Lead connection credential"
                type="password"
                readOnly
                value={credential}
                autoComplete="off"
                onFocus={(e) => e.target.select()}
              />
              <button className="button" onClick={() => setCredential("")}>
                Hide credential
              </button>
            </section>
          )}
        </section>
      )}
      {review && (
        <section className="integration-card">
          <h2>Review organizations</h2>
          <p>
            Destination: {review.workspace}. Visibility: {review.audience}.
            Communication permission: Unknown. Research claims are supplied by
            your agent and have not been independently verified.
          </p>
          <p>
            Expires {new Date(review.expiresAt).toLocaleString()}. Matching
            candidates are blocked from import; review the existing records
            first.
          </p>
          <fieldset disabled={busy || !!review.decision}>
            <legend>Select organizations to import</legend>
            {review.candidates.map((c, i) => (
              <article key={i} className="integration-card">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={review.matches[i].length > 0}
                    checked={accept.includes(i)}
                    onChange={(e) =>
                      setAccept((a) =>
                        e.target.checked ? [...a, i] : a.filter((n) => n !== i),
                      )
                    }
                  />
                  {c.name}
                </label>
                <p>
                  <a href={c.website} target="_blank" rel="noopener noreferrer">
                    {c.website}
                  </a>
                </p>
                <p>{c.summary}</p>
                <p>{c.relevance}</p>
                <p>
                  Fit: {c.fit} · Evidence: {c.evidence}
                </p>
                <p>
                  Unresolved:{" "}
                  {c.uncertainties || "None reported; verify before use."}
                </p>
                <ul>
                  {c.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.url}
                      </a>{" "}
                      · retrieved {new Date(s.retrievedAt).toLocaleString()}
                    </li>
                  ))}
                </ul>
                {review.matches[i].map((m) => (
                  <p key={m.id}>
                    Possible duplicate: {m.name}
                    {m.doNotContact ? " · Do not contact" : ""}
                  </p>
                ))}
              </article>
            ))}
            <label>
              Reason for leaving candidates out
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                <option value="other">Other</option>
                <option value="not_relevant">Not relevant</option>
                <option value="insufficient_evidence">
                  Insufficient evidence
                </option>
                <option value="duplicate">Duplicate</option>
              </select>
            </label>
            <button
              className="button primary"
              onClick={() =>
                void act(async () => {
                  const result = await api("leads/approve", {
                    reviewId: review.id,
                    digest: review.digest,
                    accept,
                    reason,
                  });
                  setReview(null);
                  await load();
                  setMessage(
                    `${result.accepted} organizations imported. Unselected candidates were rejected.`,
                  );
                })
              }
            >
              {accept.length
                ? `Import ${accept.length} selected organizations`
                : "Reject all candidates"}
            </button>
          </fieldset>
          {!!review.decision && <p>This preview has already been decided.</p>}
          <button
            className="button"
            disabled={busy}
            onClick={() => void act(() => open(review.id))}
          >
            Reload review
          </button>
        </section>
      )}
      <section className="integration-card">
        <h2>Your searches</h2>
        <button
          className="button"
          disabled={busy}
          onClick={() => void act(load)}
        >
          Refresh
        </button>
        {searches.map((s) => (
          <article key={s.id}>
            <h3>{s.brief.target}</h3>
            <p>
              {s.revoked_at
                ? "Revoked"
                : new Date(s.expires_at) < new Date()
                  ? "Expired"
                  : s.decision
                    ? `${s.record_ids?.length || 0} accepted · ${s.decision.rejected} rejected`
                    : s.preview_id
                      ? "Ready for review"
                      : "Waiting for agent research"}
            </p>
            {s.preview_id &&
              !s.revoked_at &&
              new Date(s.expires_at) > new Date() && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void act(() => open(s.preview_id))}
                >
                  Review candidates
                </button>
              )}
            {!s.revoked_at && (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("leads/searches", { id: s.id }, "DELETE");
                    setReview(null);
                    setCredential("");
                    await load();
                  })
                }
              >
                Revoke connection
              </button>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
