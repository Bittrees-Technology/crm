"use client";
import { useState } from "react";
import { api } from "../leads/lead-api";
export function BacklogConsent() {
  const [receipt, setReceipt] = useState(""),
    [review, setReview] = useState<any>(null),
    [envelope, setEnvelope] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false);
  async function submit(confirmed: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await api("datasets/backlog/consent", {
        leaseReceipt: JSON.parse(receipt),
        confirmed,
      });
      setReview(result.review);
      setEnvelope(result.envelope || null);
    } catch {
      setReview(null);
      setEnvelope(null);
      setAck(false);
      setError(
        "The prepared connection is unavailable or the receipt is invalid, expired or no longer matches. Refresh the native activation details before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="integration-card">
      <summary>Agent backlog through MCP</summary>
      <p>
        Use this only after your local Bittrees AI has completed native
        activation. Setup uses the same one-hour window; it does not restart it.
        Existing connections stay separate.
      </p>
      <label>
        Signed activation receipt
        <textarea
          aria-label="Signed activation receipt"
          value={receipt}
          onChange={(e) => {
            setReceipt(e.target.value);
            setReview(null);
            setEnvelope(null);
            setAck(false);
          }}
        />
      </label>
      <button disabled={busy || !receipt} onClick={() => void submit(false)}>
        Review backlog connection
      </button>
      {error && <p role="alert">{error}</p>}
      {review && (
        <section>
          <h3>Allow local Bittrees AI to sync this backlog</h3>
          <p>
            Operator: {review.operator}. Enrolled identity: {review.principal}.
          </p>
          <p>
            Access ends {review.expiresAt}. Only the listed Agent backlog tasks
            may be imported. Existing completion, assignments, notes and due
            dates are preserved. No deletion or unrelated AI-task access is
            granted.
          </p>
          <ul>
            {review.projects.map((p: any) => (
              <li key={p.crmProjectId}>
                {p.sourceProjectId} → {p.name}
              </li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I approve these destinations and this exact expiry.
          </label>
          <button
            disabled={busy || !ack || Boolean(envelope)}
            onClick={() => void submit(true)}
          >
            Approve dedicated backlog connection
          </button>
        </section>
      )}
      {envelope && (
        <section>
          <p>
            Connection approved. Download the encrypted handoff for the MCP
            operator. It contains no readable connection key. Saving or
            downloading again does not extend access. Revoke this dedicated
            connection here.
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              if (!confirm("Revoke this dedicated backlog connection now?"))
                return;
              setBusy(true);
              try {
                await api("datasets/connect", {
                  id: envelope.metadata.connectionId,
                  revoke: true,
                });
                setEnvelope(null);
                setReview(null);
                setAck(false);
                setError(
                  "Connection revoked. This activation cannot recreate it.",
                );
              } catch {
                setError("Revocation was not confirmed. Try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Revoke backlog connection
          </button>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(envelope)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "crm-mcp-handoff.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download encrypted handoff
          </button>
        </section>
      )}
    </details>
  );
}
