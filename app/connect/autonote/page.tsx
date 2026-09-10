"use client";
import { useEffect, useState, useRef } from "react";
export default function Connect() {
  const [me, setMe] = useState<any>(null),
    [workspace, setWorkspace] = useState(""),
    [records, setRecords] = useState<any[]>([]),
    [target, setTarget] = useState(""),
    [connections, setConnections] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [loading, setLoading] = useState(true),
    [loadingRecords, setLoadingRecords] = useState(false),
    [state, setState] = useState(""),
    [challenge, setChallenge] = useState("");
  const destinationRequest = useRef(0);
  async function api(
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) {
    const r = await fetch("/api/" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({
      error: "CRM is temporarily unavailable. Please retry.",
    }));
    if (!r.ok) throw new Error(d.error || "Sign in to CRM first.");
    return d;
  }
  async function load() {
    setError("");
    setLoading(true);
    try {
      const user = await api("me");
      setMe(user);
      setConnections(await api("integrations/autonote/connections"));
      setReady(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setState(q.get("state") || "");
    setChallenge(q.get("challenge") || "");
    load();
  }, []);
  async function selectWorkspace(id: string) {
    const request = ++destinationRequest.current;
    setWorkspace(id);
    setTarget("");
    setRecords([]);
    setError("");
    if (!id) {
      setLoadingRecords(false);
      return;
    }
    setLoadingRecords(true);
    try {
      const items = await api(
        "integrations/autonote/destinations?workspace=" +
          encodeURIComponent(id),
      );
      if (request === destinationRequest.current) setRecords(items);
    } catch (e) {
      if (request === destinationRequest.current)
        setError((e as Error).message);
    } finally {
      if (request === destinationRequest.current) setLoadingRecords(false);
    }
  }
  return (
    <main className="integration-page">
      <a href="/">Bittrees CRM</a>
      <h1>Connect AutoNote</h1>
      <p>
        Let AutoNote add reviewed meeting notes and tasks to one CRM
        destination.
      </p>
      {loading ? (
        <p role="status">Loading your CRM account…</p>
      ) : !ready ? (
        <>
          <p>Sign in to your CRM account, then return here.</p>
          <a href="/" target="_blank" rel="noreferrer">
            Open CRM sign-in
          </a>
          <button className="button" onClick={load}>
            I’m signed in · refresh
          </button>
        </>
      ) : (
        <>
          {state &&
            challenge &&
            /^[a-f0-9]{64}$/.test(state) &&
            /^[\w-]{43}$/.test(challenge) && (
              <section className="integration-card">
                <label>
                  Workspace
                  <select
                    disabled={busy}
                    value={workspace}
                    onChange={(e) => selectWorkspace(e.target.value)}
                  >
                    <option value="">Choose workspace</option>
                    {me.workspaces
                      .filter((w: any) => w.role !== "viewer")
                      .map((w: any) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Destination record
                  <select
                    disabled={
                      busy || loadingRecords || !workspace || !records.length
                    }
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">
                      {loadingRecords
                        ? "Loading destinations…"
                        : "Choose a destination"}
                    </option>
                    {records.map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.name} · {r.kind}
                      </option>
                    ))}
                  </select>
                </label>
                {workspace && !loadingRecords && !records.length && (
                  <p className="small">
                    No writable destination found here. Create a person,
                    organization, project, or opportunity in CRM, then select
                    this workspace again.
                  </p>
                )}
                {!me.workspaces.some((w: any) => w.role !== "viewer") && (
                  <p className="small">
                    You need an editor or owner role in a workspace to connect a
                    destination.
                  </p>
                )}
                <p>
                  This connection lasts 30 days. It can add notes and tasks only
                  under this record, using your current CRM permissions. It
                  cannot read private owner notes or modify unrelated records.
                  Every publication starts with a review in AutoNote. Copies
                  follow the destination’s current sharing settings and remain
                  in CRM after disconnecting.
                </p>
                <button
                  className="button primary"
                  disabled={!target || busy || loadingRecords}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const d = await api("integrations/autonote/authorize", {
                        workspaceId: workspace,
                        targetId: target,
                        state,
                        challenge,
                      });
                      location.assign(d.url);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Connecting…" : "Allow this connection"}
                </button>
              </section>
            )}
          {(!state ||
            !challenge ||
            !/^[a-f0-9]{64}$/.test(state) ||
            !/^[\w-]{43}$/.test(challenge)) && (
            <p className="small">
              To connect a new destination, start from AutoNote → Settings →
              Connect CRM destination.
            </p>
          )}
          <h2>AutoNote connections</h2>
          {connections.length ? (
            connections.map((c) => (
              <section
                key={c.id}
                style={{ padding: "15px 0", borderBottom: "1px solid #ddd" }}
              >
                <strong>
                  {c.workspace_name} → {c.target_name}
                </strong>
                <p>
                  {c.revoked_at
                    ? "Disconnected"
                    : Date.parse(c.expires_at) <= Date.now()
                      ? "Expired"
                      : "Expires " +
                        new Date(c.expires_at).toLocaleDateString()}
                </p>
                {!c.revoked_at && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await api(
                          "integrations/autonote/connections",
                          { id: c.id },
                          "DELETE",
                        );
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Disconnect
                  </button>
                )}
              </section>
            ))
          ) : (
            <p>No active connections.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" style={{ color: "#a2392d" }}>
          {error}
        </p>
      )}
    </main>
  );
}
