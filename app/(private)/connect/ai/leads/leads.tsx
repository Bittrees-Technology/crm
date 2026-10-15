"use client";
import { useEffect, useState } from "react";
import type { Candidate } from "@/lib/lead-model";
import { api } from "./lead-api";
import McpSetup from "./mcp-setup";
import PrivateLists from "./private-lists";
type Review = {
  id: string;
  canApprove: boolean;
  workspace: string;
  audience: string;
  digest: string;
  candidates: Candidate[];
  matches: {
    id: string;
    name: string;
    doNotContact: boolean;
    archived: boolean;
  }[][];
  decision: unknown;
  expiresAt: string | null;
};
export default function Leads() {
  const [workspaces, setWorkspaces] = useState<
      { id: string; name: string; role: string }[]
    >([]),
    [workspace, setWorkspace] = useState("");
  const [project, setProject] = useState(""),
    [researcher, setResearcher] = useState("");
  const [options, setOptions] = useState<{
    projects: { id: string; name: string }[];
    members: { id: string; name: string; role: string }[];
  }>({ projects: [], members: [] });
  const [allowTasks, setAllowTasks] = useState(false);
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
  const [reuse, setReuse] = useState<Record<string, string>>({});
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
    setCredential("");
    setReview(null);
    setAccept([]);
    setReuse({});
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
        <h1>Lead research</h1>
        <p>
          Assign business research, connect an agent, then review candidates
          here.
        </p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!review && <PrivateLists onShared={() => void act(load)} />}
      {!review && (
        <section className="integration-card">
          <h2>Search brief</h2>
          <p>
            Owners create assignments. Invite a collaborator as a viewer with
            access to the research project in Settings, then assign them below.
            The connection shares this brief only. It can submit one candidate
            batch within 7 days; it cannot read CRM records, approve imports or
            send messages. Your agent’s search and model providers receive the
            brief and public research.
          </p>
          {workspaces.length > 0 ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const s = await api("leads/searches", {
                    workspaceId: workspace,
                    projectId: project || undefined,
                    researcherId: researcher || undefined,
                    brief: {
                      target,
                      allowTasks,
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
                  setMessage(
                    s.token
                      ? "Search created. Connect your agent below."
                      : "Research assigned. The researcher can open Lead research and connect their own agent.",
                  );
                });
              }}
            >
              <fieldset disabled={busy}>
                <legend>Research assignment</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={allowTasks}
                    onChange={(e) => setAllowTasks(e.target.checked)}
                  />{" "}
                  Allow proposed follow-up tasks (review required; no outreach)
                </label>
                <label>
                  Workspace
                  <select
                    aria-label="Workspace"
                    required
                    value={workspace}
                    onChange={(e) => {
                      const value = e.target.value;
                      setWorkspace(value);
                      setProject("");
                      setResearcher("");
                      setOptions({ projects: [], members: [] });
                      if (value)
                        void act(async () =>
                          setOptions(
                            await api(
                              "leads/options?workspaceId=" +
                                encodeURIComponent(value),
                            ),
                          ),
                        );
                    }}
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
                  Research project
                  <select
                    aria-label="Research project"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    required={!!researcher}
                  >
                    <option value="">
                      Choose project (required for delegation)
                    </option>
                    {options.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Assigned researcher
                  <select
                    aria-label="Assigned researcher"
                    value={researcher}
                    onChange={(e) => setResearcher(e.target.value)}
                  >
                    <option value="">Me</option>
                    {options.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.role}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  What makes a candidate relevant?
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
                  Maximum people and organizations
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
          ) : (
            <p>
              Your owner-created research assignments appear below. You can
              connect your agent and submit drafts; the assigning owner approves
              publication.
            </p>
          )}
          {credential && (
            <McpSetup
              credential={credential}
              onHide={() => setCredential("")}
            />
          )}
        </section>
      )}
      {review && (
        <section className="integration-card">
          <h2>
            {review.canApprove
              ? "Review investor leads"
              : "Submitted investor leads"}
          </h2>
          <p>
            Destination: {review.workspace}. Visibility: {review.audience}.
            Communication permission: Unknown. Research claims are supplied by
            the researcher or agent and have not been independently verified.
          </p>
          <p>
            {review.expiresAt
              ? `Expires ${new Date(review.expiresAt).toLocaleString()}.`
              : "Active until revoked."}{" "}
            Existing organizations can be reused without changing their data or
            sharing. Duplicate people, archived records, and do-not-contact
            matches cannot be published here.
          </p>
          <fieldset disabled={busy || !!review.decision || !review.canApprove}>
            <legend>Select people and organizations to publish</legend>
            {review.candidates.map((c, i) => (
              <article key={i} className="integration-card">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={review.matches[i].length > 0 && !reuse[String(i)]}
                    checked={accept.includes(i)}
                    onChange={(e) =>
                      setAccept((a) =>
                        e.target.checked ? [...a, i] : a.filter((n) => n !== i),
                      )
                    }
                  />
                  {c.name}
                </label>
                {c.website && (
                  <p>
                    <a
                      href={c.website}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {c.website}
                    </a>
                  </p>
                )}
                <p>
                  {c.kind === "tasks"
                    ? "Follow-up task"
                    : c.kind === "people"
                      ? "Person"
                      : "Organization"}{" "}
                  · {c.category}
                </p>
                {c.title && <p>{c.title}</p>}
                {c.email && <p>{c.email}</p>}
                {c.contactIndex !== undefined && (
                  <p>
                    Linked contact: {review.candidates[c.contactIndex]?.name}
                  </p>
                )}
                {c.organizationIndex !== undefined && (
                  <p>
                    Organization: {review.candidates[c.organizationIndex]?.name}
                    . Select this organization too.
                  </p>
                )}
                <p>
                  {c.researchMethod === "manual"
                    ? "Manually added · owner review required"
                    : "Agent research"}
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
                {review.canApprove &&
                  c.kind === "organizations" &&
                  review.matches[i].length > 0 && (
                    <label>
                      Use an existing organization (leave its data and sharing
                      unchanged)
                      <select
                        value={reuse[String(i)] || ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          setReuse((r) => {
                            const next = { ...r };
                            if (value) next[String(i)] = value;
                            else delete next[String(i)];
                            return next;
                          });
                          setAccept((a) => a.filter((n) => n !== i));
                        }}
                      >
                        <option value="">Do not publish this candidate</option>
                        {review.matches[i]
                          .filter((m) => !m.doNotContact && !m.archived)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                {review.matches[i].map((m) => (
                  <p key={m.id}>
                    Possible duplicate: {m.name}
                    {m.doNotContact ? " · Do not contact" : ""}
                    {m.archived ? " · Archived" : ""}
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
                    reuse: Object.fromEntries(
                      Object.entries(reuse).filter(([index]) =>
                        accept.includes(Number(index)),
                      ),
                    ),
                    reason,
                  });
                  setReview(null);
                  await load();
                  setMessage(
                    `${result.accepted} leads accepted. New records are visible to workspace owners only; reused organizations retain their existing sharing. Unselected candidates were rejected.`,
                  );
                })
              }
            >
              {accept.length
                ? `Publish ${accept.length} selected leads`
                : "Reject all candidates"}
            </button>
          </fieldset>
          {!review.canApprove && (
            <p>
              Awaiting the assigning owner’s decision. You cannot publish or see
              existing CRM match details here.
            </p>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Back to assignments
          </button>
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
          <article key={`${s.id}:${s.preview_id || "assignment"}`}>
            <h3>{s.brief.target}</h3>
            <p>
              {s.canApprove
                ? "You approve publication"
                : s.brief.method === "manual"
                  ? "Your submitted list · owner approval required"
                  : "Assigned to you · owner approval required"}
            </p>
            <p>
              {s.blocked
                ? "Paused: researcher no longer has access to the active project"
                : s.revoked_at
                  ? "Revoked"
                  : s.expires_at && new Date(s.expires_at) < new Date()
                    ? "Expired"
                    : s.decision
                      ? `${s.record_ids?.length || s.decision.accepted || 0} accepted · ${s.decision.rejected} rejected`
                      : s.preview_id
                        ? "Ready for review"
                        : "Waiting for agent research"}
            </p>
            {s.canConnect &&
              !s.revoked_at &&
              !s.preview_id &&
              (!s.expires_at || new Date(s.expires_at) > new Date()) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setReview(null);
                      setCredential(
                        (await api("leads/connect", { id: s.id })).token,
                      );
                      setMessage(
                        "Connection credential shown above. Any previous credential is now revoked.",
                      );
                    })
                  }
                >
                  Connect / replace agent credential
                </button>
              )}
            {s.preview_id &&
              !s.blocked &&
              !s.revoked_at &&
              (!s.expires_at || new Date(s.expires_at) > new Date()) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void act(() => open(s.preview_id))}
                >
                  {s.canApprove ? "Review candidates" : "View submitted drafts"}
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
                {s.brief.method === "manual"
                  ? s.decision
                    ? "Close review"
                    : "Withdraw submitted list"
                  : "Revoke connection"}
              </button>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
