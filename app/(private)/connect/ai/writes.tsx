"use client";
import { useEffect, useState } from "react";
type Api = (path: string, body?: unknown, method?: string) => Promise<any>;
export function WriteConsent({ grantId, api }: { grantId: string; api: Api }) {
  const [options, setOptions] = useState<any>(null),
    [target, setTarget] = useState(""),
    [kinds, setKinds] = useState<string[]>([]),
    [days, setDays] = useState(1),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete request.");
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    const data = await api("integrations/ai/writes/options?grantId=" + grantId);
    setOptions(data);
    setTarget(data.permission?.target_id ?? data.targets[0]?.id ?? "");
  };
  return (
    <section>
      <h4>Optional reviewed writes</h4>
      {error && <p role="alert">{error}</p>}
      {!options ? (
        <button
          className="button"
          disabled={busy}
          onClick={() => void act(load)}
        >
          Manage reviewed writes
        </button>
      ) : (
        <>
          {options.permission &&
          !options.permission.revoked_at &&
          new Date(options.permission.expires_at) > new Date() ? (
            <>
              <p>
                Allowed: {options.permission.kinds.join(", ")} under{" "}
                {options.targets.find(
                  (t: any) => t.id === options.permission.target_id,
                )?.name ?? "Unavailable destination"}
                . Expires{" "}
                {new Date(options.permission.expires_at).toLocaleString()}.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("integrations/ai/writes/revoke", { grantId });
                    setReview(false);
                    await load();
                  })
                }
              >
                Revoke write permission
              </button>
            </>
          ) : (
            <p>No active write permission. Read access is separate.</p>
          )}
          {!review ? (
            <>
              <label htmlFor={"write-target-" + grantId}>
                Write destination
              </label>
              <select
                id={"write-target-" + grantId}
                disabled={busy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose a selected destination</option>
                {options.targets.map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.kind}
                  </option>
                ))}
              </select>
              <fieldset disabled={busy}>
                <legend>Allowed new records</legend>
                {["notes", "tasks"].map((kind) => (
                  <label className="checkbox-label" key={kind}>
                    <input
                      type="checkbox"
                      checked={kinds.includes(kind)}
                      onChange={(e) =>
                        setKinds((v) =>
                          e.target.checked
                            ? [...v, kind]
                            : v.filter((k) => k !== kind),
                        )
                      }
                    />
                    {kind === "notes" ? "Create notes" : "Create tasks"}
                  </label>
                ))}
              </fieldset>
              <label htmlFor={"write-days-" + grantId}>
                Write permission expires after
              </label>
              <select
                id={"write-days-" + grantId}
                disabled={busy}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[1, 7, 30].map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
              </select>
              <button
                className="button"
                disabled={busy || !target || !kinds.length}
                onClick={() => setReview(true)}
              >
                Review write permission
              </button>
            </>
          ) : (
            <>
              <p>
                Allow this companion to submit {kinds.join(" and ")} proposals
                under {options.targets.find((t: any) => t.id === target)?.name},
                for at most {days} days and never beyond the read grant. Each
                exact proposal still requires your approval here before
                publication. Published records inherit the destination's
                sharing.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                Change write permission
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("integrations/ai/writes/authorize", {
                      grantId,
                      targetId: target,
                      kinds,
                      expiresInDays: days,
                    });
                    setReview(false);
                    setKinds([]);
                    await load();
                  })
                }
              >
                Allow reviewed writes
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
export function ExactReview({ id, api }: { id: string; api: Api }) {
  const [deleted, setDeleted] = useState(false);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api("integrations/ai/writes/review?id=" + encodeURIComponent(id))
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <section className="integration-card">
      <h2>Review exact CRM publication</h2>
      {error && <p role="alert">{error}</p>}
      {!deleted && (
        <button
          className="button"
          disabled={busy}
          onClick={async () => {
            if (
              !confirm(
                "Delete this proposal copy and cancel any unpublished approval? Published CRM records remain separate.",
              )
            )
              return;
            setBusy(true);
            try {
              await api(
                "integrations/ai/writes/review",
                { reviewId: id },
                "DELETE",
              );
              setData(null);
              setDeleted(true);
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Deletion failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Delete proposal copy
        </button>
      )}
      {deleted && (
        <p role="status">
          Proposal copy deleted. Any published CRM record remains in CRM and can
          be deleted there.
        </p>
      )}
      {deleted ? null : !data ? (
        <p>
          Open this review while signed in as the CRM user who connected the
          companion.
        </p>
      ) : (
        <>
          <p>
            New {data.payload.kind} under <strong>{data.targetName}</strong>.
          </p>
          <p>
            {data.audience.description}; currently {data.audience.memberCount}{" "}
            people. Changed sharing or source records require fresh review.
          </p>
          <h3>{data.payload.name}</h3>
          <pre className="review-text">{data.payload.description}</pre>
          <p>
            Due date: {data.payload.dueDate || "None"}. Assigned owner: none.
          </p>
          <details>
            <summary>Source record versions</summary>
            <ul>
              {data.payload.sources.map((s: any) => (
                <li key={s.id}>
                  {s.id} · version {s.version}
                </li>
              ))}
            </ul>
          </details>
          <p>Review expires {new Date(data.expiresAt).toLocaleString()}.</p>
          {data.approved ? (
            <p role="status">
              Approved. Return to the companion to publish this exact proposal.
            </p>
          ) : (
            <button
              className="button primary"
              disabled={
                busy || !!error || Date.parse(data.expiresAt) <= Date.now()
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("integrations/ai/writes/approve", {
                    reviewId: data.reviewId,
                    digest: data.digest,
                  });
                  setData({ ...data, approved: true });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Approval failed.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Approve exact proposal
            </button>
          )}
          <p>
            Approval does not edit the proposal or publish it immediately. No
            existing CRM records will be changed.
          </p>
        </>
      )}
    </section>
  );
}
