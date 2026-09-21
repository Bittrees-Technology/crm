"use client";
import { useState, useEffect, useRef } from "react";
type Choice = { id: string; name: string; kind: string };
type Grant = {
  id: string;
  workspace_id: string;
  record_ids: string[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
export default function Consent() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
      [],
    ),
    [workspace, setWorkspace] = useState(""),
    [records, setRecords] = useState<Choice[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [grants, setGrants] = useState<Grant[]>([]);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [challenge, setChallenge] = useState(""),
    [days, setDays] = useState(1),
    [review, setReview] = useState(false),
    [code, setCode] = useState(""),
    [truncated, setTruncated] = useState(false);
  const [codeExpiresAt, setCodeExpiresAt] = useState(0);
  const request = useRef(0);
  async function api(
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) {
    const response = await fetch("/api/" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response
      .json()
      .catch(() => ({ error: "CRM is temporarily unavailable." }));
    if (!response.ok) throw Error(data.error || "Sign in to CRM to continue.");
    return data;
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    await action(async () => {
      const me = await api("me");
      setWorkspaces(me.workspaces);
      setGrants(await api("integrations/ai/connections"));
      setReady(true);
    });
  }
  useEffect(() => {
    setChallenge(new URLSearchParams(location.search).get("challenge") || "");
    void load();
  }, []);
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(
      () => setCode(""),
      Math.max(0, codeExpiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [code, codeExpiresAt]);
  async function chooseWorkspace(id: string) {
    const current = ++request.current;
    setWorkspace(id);
    setRecords([]);
    setSelected([]);
    setReview(false);
    setCode("");
    if (!id) return;
    await action(async () => {
      const data = await api(
        "integrations/ai/choices?workspace=" + encodeURIComponent(id),
      );
      if (current === request.current) {
        setRecords(data.items);
        setTruncated(data.truncated);
      }
    });
  }
  return (
    <main className="integration-page">
      <a href="/">Bittrees CRM</a>
      <h1>Connect your local AI</h1>
      <p>
        Choose exactly which shared CRM records the companion may read. Private
        owner notes stay excluded.
      </p>
      {error && <p role="alert">{error}</p>}
      {!ready ? (
        <section>
          <p>Sign in to CRM, then return to this page.</p>
          <a href="/" target="_blank" rel="noreferrer">
            Open CRM sign-in
          </a>
          <button
            className="button"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh account
          </button>
        </section>
      ) : (
        <>
          {code ? (
            <section className="integration-card">
              <h2>Finish in your companion</h2>
              <p>
                Paste this one-time code into the local Bittrees AI window that
                started this connection. It expires in 60 seconds. Do not share
                it.
              </p>
              <label>
                Connection code
                <input
                  readOnly
                  value={code}
                  autoComplete="off"
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <button className="button" onClick={() => setCode("")}>
                Hide code
              </button>
            </section>
          ) : /^[A-Za-z0-9_-]{43}$/.test(challenge) ? (
            <section className="integration-card">
              <h2>Select records</h2>
              <label>
                Workspace
                <select
                  disabled={busy || review}
                  value={workspace}
                  onChange={(e) => void chooseWorkspace(e.target.value)}
                >
                  <option value="">Choose workspace</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              {truncated && (
                <p>
                  Only the first 1,000 visible records are shown. A narrower
                  search will be added before broad rollout.
                </p>
              )}
              {!review ? (
                <>
                  <fieldset disabled={busy}>
                    <legend>Records ({selected.length}/100)</legend>
                    {records.map((r) => (
                      <label key={r.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(r.id)}
                          disabled={
                            !selected.includes(r.id) && selected.length >= 100
                          }
                          onChange={(e) =>
                            setSelected((old) =>
                              e.target.checked
                                ? [...old, r.id]
                                : old.filter((id) => id !== r.id),
                            )
                          }
                        />
                        {r.name} · {r.kind}
                      </label>
                    ))}
                    {workspace && !busy && !records.length && (
                      <p>No visible records in this workspace.</p>
                    )}
                  </fieldset>
                  <label>
                    Connection expires after
                    <select
                      disabled={busy}
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                    >
                      {[1, 7, 30].map((n) => (
                        <option key={n} value={n}>
                          {n} {n === 1 ? "day" : "days"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !selected.length}
                    onClick={() => setReview(true)}
                  >
                    Review connection
                  </button>
                </>
              ) : (
                <>
                  <h3>
                    Allow read access to {selected.length} selected records
                  </h3>
                  <ul>
                    {records
                      .filter((r) => selected.includes(r.id))
                      .map((r) => (
                        <li key={r.id}>
                          {r.name} ({r.kind})
                        </li>
                      ))}
                  </ul>
                  <p>
                    The companion may read the current shared contents of these
                    records for {days} {days === 1 ? "day" : "days"}, while your
                    CRM access permits it. This includes their shared contact
                    and business fields. It does not include other records, new
                    children, private owner notes, workspace administration or
                    permission to create or change records.
                  </p>
                  <p>
                    You can revoke future access below. Copies already processed
                    on your Mac follow its deletion controls.
                  </p>
                  <div className="form-actions">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => setReview(false)}
                    >
                      Change selection
                    </button>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          const result = await api(
                            "integrations/ai/authorize",
                            {
                              workspaceId: workspace,
                              recordIds: selected,
                              actions: ["read"],
                              challenge,
                              expiresInDays: days,
                            },
                          );
                          setCodeExpiresAt(Date.parse(result.codeExpiresAt));
                          setCode(result.code);
                          setReview(false);
                          setGrants(await api("integrations/ai/connections"));
                        })
                      }
                    >
                      Allow selected read access
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : (
            <p>
              Start a CRM connection from your local Bittrees AI companion to
              select records.
            </p>
          )}
          <section className="integration-card">
            <h2>Your AI connections</h2>
            <p>
              These app connections are separate from human sharing permissions.
            </p>
            {!grants.length && <p>No AI connections.</p>}
            {grants.map((g) => (
              <article key={g.id}>
                <h3>
                  {workspaces.find((w) => w.id === g.workspace_id)?.name ??
                    "Workspace unavailable"}{" "}
                  · {g.record_ids.length} records
                </h3>
                <p>
                  {g.revoked_at
                    ? "Revoked"
                    : new Date(g.expires_at) <= new Date()
                      ? "Expired"
                      : "Read-only"}{" "}
                  · Expires {new Date(g.expires_at).toLocaleString()}
                </p>
                <p>
                  Last used:{" "}
                  {g.last_used_at
                    ? new Date(g.last_used_at).toLocaleString()
                    : "Not used"}
                </p>
                {!g.revoked_at && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(
                          "integrations/ai/connections",
                          { id: g.id },
                          "DELETE",
                        );
                        setCode("");
                        setGrants(await api("integrations/ai/connections"));
                      })
                    }
                  >
                    Revoke connection
                  </button>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
