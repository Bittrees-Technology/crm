"use client";
import { useState } from "react";
import {
  standingLabels,
  standingUploadSchema,
  type OrganizationStanding,
} from "@/lib/organization-standing-model";
function Assessment({ value }: { value: OrganizationStanding | null }) {
  if (!value) return <p>Not assessed</p>;
  return (
    <>
      <p>
        {value.tier} · {standingLabels[value.tier]} · {value.confidence}{" "}
        confidence
      </p>
      <p>{value.rationale}</p>
      <p>
        <strong>Theme fit:</strong> {value.themeFit}. {value.fitBasis}
      </p>
      <p>
        <strong>Review queue:</strong> {value.reviewQueue}
      </p>
      <p className="muted small">
        {value.status} · Reviewed{" "}
        {new Date(value.reviewedAt).toLocaleDateString()} · {value.fitStatus}
      </p>
      <ul>
        {value.flags.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      {value.sources.map((source, i) => (
        <p key={i}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.url}
          </a>
          <br />
          {source.basis} · Retrieved{" "}
          {source.retrievedAt
            ? new Date(source.retrievedAt).toLocaleDateString()
            : "date unavailable"}
          {source.claim && (
            <>
              <br />
              {source.claim}
            </>
          )}
        </p>
      ))}
    </>
  );
}
type Preview = {
  digest: string;
  matched: number;
  changed: number;
  rows: {
    id: string;
    name: string;
    before: OrganizationStanding | null;
    after: OrganizationStanding;
  }[];
};
export function StandingImport({
  workspace,
  api,
  onSaved,
  onClose,
}: {
  workspace: string;
  api: (path: string, method: string, body: unknown) => Promise<any>;
  onSaved: (message: string) => Promise<void>;
  onClose: () => void;
}) {
  const [upload, setUpload] = useState<unknown>(),
    [preview, setPreview] = useState<Preview>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function act(apply: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `workspaces/${workspace}/organization-standing`,
        "POST",
        { upload, ...(apply ? { digest: preview!.digest } : {}) },
      );
      if (apply)
        await onSaved(
          `Organization standing saved: ${result.updated} updated; ${result.unchanged} already matched. ${result.matched} organizations matched.`,
        );
      else setPreview(result);
    } catch (e) {
      setError((e as Error).message);
      if (apply) setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel panel-pad standing-import"
      aria-label="Review organization standing import"
    >
      <h2>Review organization standing</h2>
      <p>
        Update existing organizations from a standing review file. Exact names
        and website hosts must match uniquely. Current descriptions, contact
        details, ownership, sharing and verification stay intact. No records are
        created.
      </p>
      <label>
        Standing review file
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={async (e) => {
            setUpload(undefined);
            setPreview(undefined);
            setError("");
            try {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 900000)
                throw Error(
                  "Split files larger than 900 KB into smaller batches.",
                );
              const parsed = standingUploadSchema.parse(
                JSON.parse(await file.text()),
              );
              setUpload(parsed);
            } catch {
              setError(
                "Choose a valid standing review JSON file smaller than 900 KB.",
              );
            }
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <p role="status">
            {preview.matched} organizations matched · {preview.changed} changes.
            Review the before and after values below.
          </p>
          <div className="standing-preview">
            {preview.rows.map((row) => (
              <details key={row.id}>
                <summary>
                  {row.name} · {row.before?.tier || "Not assessed"} →{" "}
                  {row.after.tier} · {row.after.confidence} confidence
                </summary>
                <h3>Current assessment</h3>
                <Assessment value={row.before} />
                <h3>Proposed assessment: {standingLabels[row.after.tier]}</h3>
                <Assessment value={row.after} />
              </details>
            ))}
          </div>
        </>
      )}
      <div className="toolbar">
        <button
          className="button"
          disabled={busy || !upload}
          onClick={() => void act(false)}
        >
          Preview standing updates
        </button>
        {preview && (
          <button
            className="button primary"
            disabled={busy || !preview.changed}
            onClick={() => void act(true)}
          >
            Apply {preview.changed} reviewed standing updates
          </button>
        )}
        <button className="button subtle" disabled={busy} onClick={onClose}>
          Close standing review
        </button>
      </div>
      <p className="muted small">
        Standing is provisional research, separate from investor verification
        and outreach approval. People display their linked organization’s
        standing.
      </p>
    </section>
  );
}
