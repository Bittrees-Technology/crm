"use client";
import { useState } from "react";
import { api } from "./lead-api";

type Review = {
  reviewId: string;
  project: string;
  device: string;
  credential: string;
  workflow: string;
  workflowRevision: number;
  expiresAt: number;
  completeTask: boolean;
  tasks: { id: string; name: string; version: number }[];
};
type Approval = { reviewId: string; expiresAt: number; request: Review | null };
type Access = { requests: Review[]; active: Approval[]; unavailable: boolean };

export default function WorkflowTaskAccess({
  datasetId,
}: {
  datasetId: string;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load(action?: "approve" | "revoke", reviewId?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action) {
        await api("datasets/workflow-task-consents", {
          datasetId,
          action,
          reviewId,
        });
        setNotice(
          action === "approve"
            ? "Selected task access approved."
            : "Selected task access revoked.",
        );
      }
      setAccess(
        await api(
          "datasets/workflow-task-consents?id=" + encodeURIComponent(datasetId),
        ),
      );
    } catch (e) {
      setAccess(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={busy}>
      <legend>Workflow task access</legend>
      <button type="button" onClick={() => void load()}>
        {access ? "Refresh task requests" : "Review task requests"}
      </button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {access?.unavailable && (
        <p role="status">Task requests are currently unavailable.</p>
      )}
      {access &&
        !access.unavailable &&
        !access.requests.length &&
        !access.active.length && (
          <p>No pending requests or active task approvals.</p>
        )}
      {access &&
        [
          ...access.requests.map((request) => ({
            ...request,
            request,
            approved: false,
          })),
          ...access.active.map((approval) => ({ ...approval, approved: true })),
        ].map(({ reviewId, expiresAt, request: r, approved }) => (
          <section key={reviewId}>
            <h4>
              {r ? r.project + " · " : ""}
              {approved ? "Approved task access" : "Requested task access"}
            </h4>
            {r ? (
              <>
                <p>
                  Workflow {r.workflow}, revision {r.workflowRevision}. Access
                  expires {new Date(r.expiresAt).toLocaleString()}.
                </p>
                <p>
                  Allow the device to read the listed task revisions and attach
                  one result per task.
                  {r.completeTask
                    ? " It can also mark these tasks complete."
                    : ""}
                </p>
                <details>
                  <summary>Device and credential</summary>
                  <p>{r.device}</p>
                  <p>{r.credential}</p>
                </details>
                <ul>
                  {r.tasks.map((t) => (
                    <li key={t.id}>
                      {t.name} · revision {t.version} <small>({t.id})</small>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                The reviewed scope is no longer available. This approval expires{" "}
                {new Date(expiresAt).toLocaleString()}.
              </p>
            )}
            <button
              type="button"
              onClick={() =>
                void load(approved ? "revoke" : "approve", reviewId)
              }
            >
              {approved ? "Revoke task access" : "Approve listed tasks"}
            </button>
          </section>
        ))}
    </fieldset>
  );
}
