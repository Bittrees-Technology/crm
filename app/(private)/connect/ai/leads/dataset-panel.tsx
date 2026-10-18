"use client";
import ProjectImportPanel from "./project-import-panel";
import { useState } from "react";
import type { DraftEntry } from "@/lib/lead-drafts";
import { api } from "./lead-api";
type Props = {
  draft: {
    id: string;
    version: number;
    name: string;
    entries: DraftEntry[];
    shared_search_id: string | null;
  };
  targets: any[];
  reload: () => Promise<void>;
};
export default function DatasetPanel({ draft, targets, reload }: Props) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [secret, setSecret] = useState("");
  const [workspace, setWorkspace] = useState(""),
    [records, setRecords] = useState<any[]>([]),
    [chosen, setChosen] = useState<string[]>([]);
  const [destination, setDestination] = useState(""),
    [project, setProject] = useState(""),
    [owner, setOwner] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const [updates, setUpdates] = useState<any[]>([]);
  const target = targets.find((t) => t.id === destination);
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
  function toggle(ids: string[], id: string) {
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }
  return (
    <details className="integration-card">
      <summary>Dataset, agent connection & sharing</summary>
      <p>
        Keep working in this private dataset. Connect one local agent, or export
        the data for your own tools. Submit selected people and organizations
        together for owner approval.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <p>
        <a href={`/api/datasets/export?id=${draft.id}`}>
          Download research JSON
        </a>
        {" · "}
        <a href={`/api/datasets/export?id=${draft.id}&training=true`}>
          Download eligible training JSONL
        </a>
      </p>
      <p>
        Exports use saved data. Training exports include only entries you mark
        eligible, omit the email field, and remove links to excluded entries.
        Review free-text notes and source permissions before marking
        eligibility.
      </p>
      <fieldset disabled={busy}>
        <legend>Training review</legend>
        {draft.entries.map((e) => (
          <label key={e.id}>
            {e.name}
            <select
              aria-label={`Training eligibility for ${e.name}`}
              value={e.research?.training || "pending"}
              disabled={!!draft.shared_search_id}
              onChange={(ev) =>
                void act(async () => {
                  const entries = draft.entries.map((x) =>
                    x.id === e.id
                      ? {
                          ...x,
                          research: {
                            sources: [],
                            relevance: "",
                            uncertainties: "",
                            verification: "unverified" as const,
                            ...x.research,
                            training: ev.target.value as
                              "pending" | "eligible" | "excluded",
                          },
                        }
                      : x,
                  );
                  await api("leads/draft", {
                    id: draft.id,
                    version: draft.version,
                    name: draft.name,
                    entries,
                  });
                  await reload();
                  setMessage("Training decision saved.");
                })
              }
            >
              <option value="pending">Pending review</option>
              <option value="eligible">Eligible for training</option>
              <option value="excluded">Exclude from training</option>
            </select>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={busy || !!draft.shared_search_id}>
        <legend>Connect a local agent</legend>
        <p>
          The connection lasts 30 days and can read and edit only this dataset,
          plus the CRM source records you explicitly add below while you retain
          access. It cannot share or publish. Your agent and its model provider
          may receive this data.
        </p>
        <button
          className="button"
          onClick={() =>
            void act(async () => {
              if (
                !confirm(
                  "Allow an agent to read and edit this dataset for 30 days? This replaces any previous dataset connection.",
                )
              )
                return;
              const c = await api("datasets/connect", { id: draft.id });
              setSecret(c.token);
              setMessage(
                "Connection created. Copy the configuration into your agent’s MCP settings.",
              );
            })
          }
        >
          Create / replace dataset connection
        </button>{" "}
        <button
          className="button"
          onClick={() =>
            void act(async () => {
              await api("datasets/connect", { id: draft.id, revoke: true });
              setSecret("");
              setMessage("Dataset connection revoked.");
            })
          }
        >
          Revoke dataset connection
        </button>
        {secret && (
          <button
            className="button"
            onClick={() =>
              void act(async () => {
                await navigator.clipboard.writeText(
                  JSON.stringify(
                    {
                      mcpServers: {
                        "bittrees-dataset": {
                          url:
                            window.location.origin +
                            "/api/integrations/datasets/mcp",
                          headers: { Authorization: "Bearer " + secret },
                        },
                      },
                    },
                    null,
                    2,
                  ),
                );
                setMessage(
                  "Configuration copied. Keep it private; it contains your connection credential.",
                );
              })
            }
          >
            Copy MCP configuration
          </button>
        )}
        <p>
          Ask your agent: “Call dataset.schema, then dataset.read. Research
          investor leads for BBRF-PT with sources, link people to organizations,
          and use dataset.save with the current version. Keep training
          eligibility pending. Do not contact anyone.”
        </p>
      </fieldset>
      <fieldset disabled={busy || !!draft.shared_search_id}>
        <legend>Add published CRM records to this dataset</legend>
        <label>
          Source workspace
          <select
            value={workspace}
            onChange={(ev) => {
              const id = ev.target.value;
              setWorkspace(id);
              setChosen([]);
              setRecords([]);
              if (id)
                void act(async () =>
                  setRecords(await api("datasets/choices?workspace=" + id)),
                );
            }}
          >
            <option value="">Choose workspace</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {records.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={chosen.includes(r.id)}
              onChange={() => setChosen(toggle(chosen, r.id))}
            />
            {r.name} ({r.kind})
          </label>
        ))}
        <p>
          Select related organizations along with their people. Only these
          records become readable by the dataset agent. Private notes are never
          included. Subsequent source changes appear separately so research is
          not overwritten.
        </p>
        <button
          className="button"
          disabled={!chosen.length}
          onClick={() =>
            void act(async () => {
              await api("datasets/import", {
                id: draft.id,
                version: draft.version,
                workspaceId: workspace,
                recordIds: chosen,
              });
              await reload();
              setChosen([]);
              setMessage(
                "Selected records added. The agent can now read their current CRM versions.",
              );
            })
          }
        >
          Add selected CRM records
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Review updates to your linked CRM records</legend>
        <p>
          Agent edits stay in the dataset until you approve them here. Only
          records in workspaces you own can be updated this way. Sharing
          settings and private notes are preserved.
        </p>
        <button
          className="button"
          onClick={() =>
            void act(async () => {
              const rows = await api("datasets/updates?id=" + draft.id);
              setUpdates(rows);
              if (!rows.length)
                setMessage("No changes to linked CRM records you own.");
            })
          }
        >
          Review proposed CRM updates
        </button>
        {updates.map((u) => (
          <article key={u.entryId}>
            <h4>{u.name}</h4>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Current CRM value</th>
                  <th>Proposed value</th>
                </tr>
              </thead>
              <tbody>
                {u.changes.map((c: any) => (
                  <tr key={c.field}>
                    <td>{c.field}</td>
                    <td>{c.before || "Empty"}</td>
                    <td>{c.after || "Empty"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              className="button"
              onClick={() =>
                void act(async () => {
                  await api("datasets/apply", {
                    id: draft.id,
                    entryId: u.entryId,
                    digest: u.digest,
                  });
                  setUpdates(await api("datasets/updates?id=" + draft.id));
                  setMessage("Approved changes saved to CRM.");
                })
              }
            >
              Approve changes to {u.name}
            </button>
          </article>
        ))}
      </fieldset>
      <ProjectImportPanel draft={draft} targets={targets} reload={reload} />
      <fieldset disabled={busy}>
        <legend>Submit selected people and organizations for approval</legend>
        <p>
          This submits a fixed copy and leaves your dataset editable. Choose
          your own workspace to publish there after your review, or a shared
          project for its owner’s approval. A project invitation is needed
          before another workspace appears here.
        </p>
        <button
          type="button"
          onClick={() =>
            setSelected(
              draft.entries
                .filter((e) => e.kind !== "projects")
                .map((e) => e.id),
            )
          }
        >
          Select all people and organizations
        </button>{" "}
        <button type="button" onClick={() => setSelected([])}>
          Clear selection
        </button>
        <p>{selected.length.toLocaleString()} selected</p>
        {draft.entries
          .filter((e) => e.kind !== "projects")
          .map((e) => (
            <label key={e.id}>
              <input
                type="checkbox"
                checked={selected.includes(e.id)}
                onChange={() => setSelected(toggle(selected, e.id))}
              />
              {e.name} ({e.kind})
            </label>
          ))}
        <label>
          Destination workspace
          <select
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setProject("");
              setOwner("");
            }}
          >
            <option value="">Choose workspace</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Submission project
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Choose project</option>
            {target?.projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Submission owner
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Choose owner</option>
            {target?.owners.map((o: any) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={!selected.length || !project || !owner}
          onClick={() =>
            void act(async () => {
              // Keep the exact operation on an uncertain response; readback also exposes receipts.
              const key = `dataset-share:${draft.id}`;
              const payload = {
                id: draft.id,
                version: draft.version,
                entryIds: selected,
                workspaceId: destination,
                projectId: project,
                ownerId: owner,
              };
              const previous = JSON.parse(
                sessionStorage.getItem(key) || "null",
              );
              const submission =
                previous &&
                JSON.stringify(previous.payload) === JSON.stringify(payload)
                  ? previous
                  : { payload, operationId: crypto.randomUUID() };
              sessionStorage.setItem(key, JSON.stringify(submission));
              const r = await api("datasets/share", {
                ...payload,
                operationId: submission.operationId,
              });
              setMessage(
                "Submitted for owner approval. Your dataset remains editable.",
              );
              await reload();
              setSelected([]);
              window.location.hash = "review-" + r.reviewId;
            })
          }
        >
          Submit selected entries for approval
        </button>
      </fieldset>
    </details>
  );
}
