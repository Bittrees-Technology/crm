"use client";
import { useState } from "react";
import { api } from "./lead-api";
export default function ProjectImportPanel({
  draft,
  targets,
  reload,
}: {
  draft: any;
  targets: any[];
  reload: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const projects = draft.entries.filter((e: any) => e.kind === "projects");
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  if (!projects.length) return null;
  const selection = {
    id: draft.id,
    workspaceId: workspace,
    entryIds: selected,
  };
  return (
    <fieldset disabled={busy || !!draft.shared_search_id}>
      <legend>Preview and approve project imports</legend>
      <p>
        Create projects in a workspace you own. New records are visible only to
        workspace owners until you change sharing. Existing names are blocked to
        prevent duplicates; add the existing CRM record to the dataset to
        propose updates instead.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <label>
        Project destination
        <select
          value={workspace}
          onChange={(e) => {
            setWorkspace(e.target.value);
            setPreview(null);
          }}
        >
          <option value="">Choose owned workspace</option>
          {targets
            .filter((t) => t.role === "owner")
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      {projects.map((e: any) => (
        <label key={e.id}>
          <input
            type="checkbox"
            checked={selected.includes(e.id)}
            onChange={() => {
              setSelected((a) =>
                a.includes(e.id) ? a.filter((x) => x !== e.id) : [...a, e.id],
              );
              setPreview(null);
            }}
          />
          {e.name}
        </label>
      ))}
      <button
        className="button"
        disabled={!workspace || !selected.length}
        onClick={() =>
          void act(async () =>
            setPreview(await api("datasets/projects/preview", selection)),
          )
        }
      >
        Preview project import
      </button>
      {preview && (
        <section>
          <h4>Proposed new projects</h4>
          {preview.rows.map((r: any) => (
            <article key={r.entryId}>
              <h5>{r.name}</h5>
              {r.blocked ? (
                <p role="alert">{r.blocked}</p>
              ) : (
                <dl>
                  <dt>Type</dt>
                  <dd>{r.data.category || "Empty"}</dd>
                  <dt>Source</dt>
                  <dd>{r.data.source || "Empty"}</dd>
                  <dt>Description</dt>
                  <dd>{r.data.description || "Empty"}</dd>
                  <dt>Access</dt>
                  <dd>Workspace owners only</dd>
                </dl>
              )}
            </article>
          ))}
          <button
            className="button primary"
            disabled={preview.rows.some((r: any) => r.blocked)}
            onClick={() =>
              void act(async () => {
                await api("datasets/projects/approve", {
                  ...selection,
                  digest: preview.digest,
                });
                setPreview(null);
                setSelected([]);
                await reload();
                setMessage(
                  "Approved projects created and linked. The dataset agent can read their current CRM versions.",
                );
              })
            }
          >
            Approve and create {preview.rows.length} projects
          </button>
        </section>
      )}
    </fieldset>
  );
}
