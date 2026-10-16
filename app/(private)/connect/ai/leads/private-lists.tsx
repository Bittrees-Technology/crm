"use client";
import { useEffect, useState } from "react";
import type { DraftEntry } from "@/lib/lead-drafts";
import DatasetPanel from "./dataset-panel";
import { api } from "./lead-api";
type Draft = {
  id: string;
  name: string;
  version: number;
  entries: DraftEntry[];
  shared_search_id: string | null;
};
export default function PrivateLists({ onShared }: { onShared: () => void }) {
  const [lists, setLists] = useState<any[]>([]),
    [draft, setDraft] = useState<Draft | null>(null),
    [entry, setEntry] = useState<DraftEntry | null>(null),
    [targets, setTargets] = useState<any[]>([]);
  const [workspace, setWorkspace] = useState(""),
    [project, setProject] = useState(""),
    [owner, setOwner] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const target = targets.find((t) => t.id === workspace);
  async function load() {
    setLists(await api("leads/drafts"));
  }
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
  useEffect(() => {
    void act(load);
  }, []);
  async function open(id: string) {
    setEntry(null);
    setWorkspace("");
    setProject("");
    setOwner("");
    const [d, t] = await Promise.all([
      api("leads/draft?id=" + id),
      api("leads/share-targets"),
    ]);
    setDraft(d);
    setTargets(t);
  }
  async function save(d: Draft) {
    const result = await api("leads/draft", {
      id: d.id,
      name: d.name,
      entries: d.entries,
      version: d.version,
    });
    const updated = { ...d, version: result.version };
    setDraft(updated);
    await load();
    return updated;
  }
  function add(kind: "people" | "organizations" | "projects") {
    setEntry({
      id: crypto.randomUUID(),
      kind,
      name: "",
      category: kind === "projects" ? "" : "Investor",
      source: "",
      email: "",
      title: "",
      website: "",
      description: "",
      organizationId: "",
    });
  }
  return (
    <section className="integration-card">
      <h2>My private research lists</h2>
      <p>
        Add people, organizations and projects yourself, without an AI
        connection or assignment. Lists are private to your account until you
        share a fixed copy with an owner for approval. Nothing is published
        automatically.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button
        className="button primary"
        disabled={busy || !!entry}
        onClick={() =>
          void act(async () => {
            if (
              draft &&
              !confirm("Open a new list? Save any list-name changes first.")
            )
              return;
            const d = {
              id: crypto.randomUUID(),
              name: "Untitled investor list",
              entries: [],
              version: 0,
              shared_search_id: null,
            };
            await save(d);
            await open(d.id);
          })
        }
      >
        New private list
      </button>
      <button
        className="button"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            if (
              draft &&
              (entry ||
                draft.name !== lists.find((l) => l.id === draft.id)?.name) &&
              !confirm("Reload saved data and discard unsaved changes?")
            )
              return;
            if (draft) await open(draft.id);
            await load();
            setMessage("Private lists refreshed.");
          })
        }
      >
        Refresh private lists
      </button>
      {!draft &&
        lists.map((l) => (
          <article key={l.id}>
            <button
              className="button"
              disabled={busy}
              onClick={() => void act(() => open(l.id))}
            >
              {l.name}
            </button>
            <p>
              {l.count} entries ·{" "}
              {{
                private: "Private draft",
                awaiting_review: "Awaiting owner review",
                reviewed: "Reviewed",
                withdrawn: "Submission closed",
                expired: "Review expired",
                unavailable: "Destination removed",
              }[l.status as string] || "Private draft"}
            </p>
          </article>
        ))}
      {draft && (
        <div>
          <DatasetPanel
            key={draft.id}
            draft={draft}
            targets={targets}
            reload={async () => {
              await open(draft.id);
              await load();
              onShared();
            }}
          />
          <h3>
            {draft.shared_search_id ? "Submitted list" : "Edit private list"}
          </h3>
          <fieldset disabled={busy || !!draft.shared_search_id}>
            <legend>List details</legend>
            <label>
              List name
              <input
                maxLength={200}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <button
              className="button"
              disabled={!draft.name.trim()}
              onClick={() =>
                void act(async () => {
                  await save(draft);
                  setMessage("Private list saved.");
                })
              }
            >
              Save list name
            </button>{" "}
            <button
              className="button"
              disabled={draft.entries.length >= 600 || !!entry}
              onClick={() => add("people")}
            >
              Add person to list
            </button>{" "}
            <button
              className="button"
              disabled={draft.entries.length >= 600 || !!entry}
              onClick={() => add("organizations")}
            >
              Add organization to list
            </button>
            <button
              className="button"
              disabled={draft.entries.length >= 600 || !!entry}
              onClick={() => add("projects")}
            >
              Add project to list
            </button>
            <p>
              {draft.entries.length}/600 entries. Save each entry before
              sharing.
            </p>
          </fieldset>
          {entry && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await save({
                    ...draft,
                    entries: [
                      ...draft.entries.filter((x) => x.id !== entry.id),
                      entry,
                    ],
                  });
                  setEntry(null);
                  setMessage("Entry saved privately.");
                });
              }}
            >
              <fieldset disabled={busy}>
                <legend>
                  {entry.kind === "people"
                    ? "Person"
                    : entry.kind === "projects"
                      ? "Project"
                      : "Organization"}
                </legend>
                <label>
                  Name
                  <input
                    required
                    maxLength={200}
                    value={entry.name}
                    onChange={(e) =>
                      setEntry({ ...entry, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Category
                  <input
                    list="research-categories"
                    maxLength={200}
                    value={entry.category}
                    onChange={(e) =>
                      setEntry({ ...entry, category: e.target.value })
                    }
                  />
                </label>
                <label>
                  Source / reference
                  <input
                    maxLength={200}
                    value={entry.source || ""}
                    onChange={(e) =>
                      setEntry({ ...entry, source: e.target.value })
                    }
                  />
                </label>
                <datalist id="research-categories">
                  {[
                    "Angel",
                    "Venture capital",
                    "Family office",
                    "Corporate investor",
                    "Accelerator",
                    "Investor",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </datalist>
                <label>
                  Website or public profile (optional)
                  <input
                    type="url"
                    placeholder="https://"
                    value={entry.website}
                    onChange={(e) =>
                      setEntry({ ...entry, website: e.target.value })
                    }
                  />
                </label>
                {entry.kind === "people" && (
                  <>
                    <label>
                      Professional email (optional)
                      <input
                        type="email"
                        value={entry.email}
                        onChange={(e) =>
                          setEntry({ ...entry, email: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Role or title
                      <input
                        maxLength={200}
                        value={entry.title}
                        onChange={(e) =>
                          setEntry({ ...entry, title: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Related organization
                      <select
                        aria-label="Related organization"
                        value={entry.organizationId}
                        onChange={(e) =>
                          setEntry({ ...entry, organizationId: e.target.value })
                        }
                      >
                        <option value="">Independent / none</option>
                        {draft.entries
                          .filter((x) => x.kind === "organizations")
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </>
                )}
                <label>
                  Research notes
                  <textarea
                    maxLength={500}
                    value={entry.description}
                    onChange={(e) =>
                      setEntry({ ...entry, description: e.target.value })
                    }
                  />
                </label>
                <button className="button primary" type="submit">
                  Save entry privately
                </button>{" "}
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    if (confirm("Discard these entry changes?")) setEntry(null);
                  }}
                >
                  Cancel entry
                </button>
              </fieldset>
            </form>
          )}
          {draft.entries.map((e) => (
            <article className="integration-card" key={e.id}>
              <h4>{e.name}</h4>
              <p>
                {e.kind === "people"
                  ? "Person"
                  : e.kind === "projects"
                    ? "Project"
                    : "Organization"}{" "}
                · {e.category}
                {e.organizationId
                  ? " · " +
                    draft.entries.find((o) => o.id === e.organizationId)?.name
                  : ""}
              </p>
              {e.description && <p>{e.description}</p>}
              {!draft.shared_search_id && (
                <>
                  <button
                    className="button"
                    disabled={busy || !!entry}
                    onClick={() => setEntry({ ...e })}
                  >
                    Edit {e.name}
                  </button>{" "}
                  <button
                    className="button"
                    disabled={busy || !!entry}
                    onClick={() =>
                      void act(async () => {
                        if (
                          !confirm(
                            "Remove this entry? People linked to it will become independent.",
                          )
                        )
                          return;
                        await save({
                          ...draft,
                          entries: draft.entries
                            .filter((x) => x.id !== e.id)
                            .map((x) =>
                              x.organizationId === e.id
                                ? { ...x, organizationId: "" }
                                : x,
                            ),
                        });
                      })
                    }
                  >
                    Remove {e.name}
                  </button>
                </>
              )}
            </article>
          ))}
          {!draft.shared_search_id && (
            <fieldset
              disabled={
                busy ||
                !!entry ||
                !draft.entries.length ||
                draft.entries.length > 20
              }
            >
              <legend>Share when ready</legend>
              {draft.entries.length > 20 && (
                <p>
                  Use “Submit selected people and organizations” above to review
                  up to 20 entries at a time.
                </p>
              )}
              <p>
                Choose where this list belongs and who should approve it.
                Sharing freezes this list; the owner receives a review copy and
                has seven days to decide what to publish. New published records
                start visible to workspace owners only.
              </p>
              <label>
                Share with workspace
                <select
                  aria-label="Share with workspace"
                  value={workspace}
                  onChange={(e) => {
                    setWorkspace(e.target.value);
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
                Destination project
                <select
                  aria-label="Destination project"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">Choose accessible project</option>
                  {target?.projects.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Approving owner
                <select
                  aria-label="Approving owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="">Choose owner</option>
                  {target?.owners.map((o: any) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              {!targets.length && (
                <p>
                  No accessible project yet. Ask the owner to share a project
                  with you. You can keep working privately meanwhile.
                </p>
              )}
              <button
                className="button primary"
                disabled={!workspace || !project || !owner}
                onClick={() =>
                  void act(async () => {
                    if (
                      !confirm(
                        `Share ${draft.entries.length} entries with ${target.owners.find((o: any) => o.id === owner)?.name} for approval? This freezes the list but does not publish records.`,
                      )
                    )
                      return;
                    const saved = await save(draft);
                    await api("leads/share-list", {
                      id: saved.id,
                      version: saved.version,
                      workspaceId: workspace,
                      projectId: project,
                      ownerId: owner,
                    });
                    await open(saved.id);
                    await load();
                    setMessage(
                      "List submitted. The selected owner can review it in Lead research.",
                    );
                    onShared();
                  })
                }
              >
                Share list for approval
              </button>
            </fieldset>
          )}
          {draft.shared_search_id && (
            <p>
              This fixed copy has been submitted. The owner reviews it in Lead
              research. Check Your searches for the current outcome. If the
              review expired or was closed, make an editable copy to submit
              again.
            </p>
          )}
          <button
            className="button"
            disabled={busy || !!entry}
            onClick={() =>
              void act(async () => {
                const copy = {
                  ...draft,
                  id: crypto.randomUUID(),
                  name: (draft.name + " copy").slice(0, 200),
                  version: 0,
                  shared_search_id: null,
                };
                await save(copy);
                await open(copy.id);
              })
            }
          >
            Make editable copy
          </button>{" "}
          <button
            className="button"
            disabled={busy || !!entry}
            onClick={() => {
              if (
                draft.name !== lists.find((l) => l.id === draft.id)?.name &&
                !confirm("Leave without saving the list name?")
              )
                return;
              setDraft(null);
            }}
          >
            Back to private lists
          </button>{" "}
          {
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (
                    !confirm(
                      draft.shared_search_id
                        ? "Remove this list from your account? The submitted review copy remains with the owner."
                        : "Delete this private list and its entries?",
                    )
                  )
                    return;
                  await api(
                    "leads/draft",
                    { id: draft.id, version: draft.version },
                    "DELETE",
                  );
                  setDraft(null);
                  setEntry(null);
                  await load();
                })
              }
            >
              {draft.shared_search_id
                ? "Remove from my lists"
                : "Delete private list"}
            </button>
          }
        </div>
      )}
    </section>
  );
}
