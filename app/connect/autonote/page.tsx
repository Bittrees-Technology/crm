"use client";
import { useEffect, useState } from "react";
export default function Connect() {
  const [me, setMe] = useState<any>(null),
    [workspace, setWorkspace] = useState(""),
    [records, setRecords] = useState<any[]>([]),
    [target, setTarget] = useState(""),
    [connections, setConnections] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [state, setState] = useState(""),
    [challenge, setChallenge] = useState("");
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
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Sign in to CRM first.");
    return d;
  }
  async function load() {
    setError("");
    try {
      const user = await api("me");
      setMe(user);
      setConnections(await api("integrations/autonote/connections"));
      setReady(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setState(q.get("state") || "");
    setChallenge(q.get("challenge") || "");
    load();
  }, []);
  async function selectWorkspace(id: string) {
    setWorkspace(id);
    setTarget("");
    setRecords([]);
    try {
      setRecords(
        await api("integrations/autonote/destinations?workspace=" + id),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main style={{ maxWidth: 700, margin: "45px auto", padding: 25 }}>
      <a href="/">Bittrees CRM</a>
      <h1>Connect AutoNote</h1>
      <p>
        Let AutoNote add reviewed meeting notes and tasks to one CRM
        destination.
      </p>
      {!ready ? (
        <>
          <p>Sign in to your CRM account, then return here.</p>
          <a href="/" target="_blank" rel="noreferrer">
            Open CRM sign-in
          </a>
          <button onClick={load}>Load my workspaces</button>
        </>
      ) : (
        <>
          {state && challenge && (
            <section
              style={{
                display: "grid",
                gap: 18,
                padding: 24,
                border: "1px solid #d0ddd7",
                borderRadius: 12,
              }}
            >
              <label>
                Workspace
                <select
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
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">
                    Choose person, organization, project, or opportunity
                  </option>
                  {records.map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.name} · {r.kind}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                This connection lasts 30 days. It can add notes and tasks only
                under this record, using your current CRM permissions. It cannot
                read private owner notes or modify unrelated records. Every
                publication starts with a review in AutoNote. Copies follow the
                destination’s current sharing settings and remain in CRM after
                disconnecting.
              </p>
              <button
                disabled={!target || busy}
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
                Allow this connection
              </button>
            </section>
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
                    : "Expires " + new Date(c.expires_at).toLocaleDateString()}
                </p>
                {!c.revoked_at && (
                  <button
                    onClick={async () => {
                      try {
                        await api(
                          "integrations/autonote/connections",
                          { id: c.id },
                          "DELETE",
                        );
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
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
