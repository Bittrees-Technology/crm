"use client";
import { useState } from "react";
import type { CrmRecord } from "@/lib/model";
async function request(path: string, body: unknown, method = "POST") {
  const r = await fetch("/api/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401)
      window.dispatchEvent(new Event("crm-session-expired"));
    throw new Error(data.error || "Please try again.");
  }
  return data;
}
export function ScopePicker({
  value,
  onChange,
  records,
  disabled = false,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  records: CrmRecord[];
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const roots = records.filter((r) =>
    ["projects", "organizations", "opportunities"].includes(r.kind),
  );
  return (
    <fieldset disabled={disabled} className="scope-picker">
      <legend>Collaboration access</legend>
      <label>
        Access area
        <select
          value={value === null ? "all" : "selected"}
          onChange={(e) => onChange(e.target.value === "all" ? null : [])}
        >
          <option value="all">Whole workspace</option>
          <option value="selected">
            Selected projects, organizations, or opportunities
          </option>
        </select>
      </label>
      {value !== null && (
        <>
          <p className="small">
            Includes selected records and records linked beneath them, subject
            to each record’s sharing settings. Owners can also share individual
            records.
          </p>
          {roots.length > 8 && (
            <label>
              Find collaboration areas
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          )}
          <div className="scope-options">
            {roots
              .filter((r) =>
                `${r.data.name} ${r.kind}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((r) => (
                <label className="checkbox-label" key={r.id}>
                  <input
                    type="checkbox"
                    checked={value.includes(r.id)}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...value, r.id]
                          : value.filter((id) => id !== r.id),
                      )
                    }
                  />
                  {r.data.name} · {r.kind}
                </label>
              ))}
            {!roots.length && (
              <p>Create a project, organization, or opportunity first.</p>
            )}
          </div>
          {value.length === 0 && (
            <p className="small">Select at least one record.</p>
          )}
        </>
      )}
    </fieldset>
  );
}
export function MemberAccess({
  workspace,
  member,
  records,
  onChanged,
}: {
  workspace: string;
  member: {
    id: string;
    name: string;
    role: string;
    scope_ids?: string[] | null;
  };
  records: CrmRecord[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [value, setValue] = useState<string[] | null>(member.scope_ids ?? null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="member-access">
      <button
        className="text-button"
        type="button"
        onClick={() => {
          setOpen(!open);
          setValue(member.scope_ids ?? null);
          setError("");
        }}
      >
        {member.scope_ids === null || member.scope_ids === undefined
          ? "Whole workspace"
          : "Limited access"}{" "}
        · Edit access for {member.name}
      </button>
      {open && (
        <div>
          <ScopePicker
            records={records}
            value={value}
            onChange={setValue}
            disabled={busy}
          />
          <button data-insights="save-collaboration-access"
            className="button"
            disabled={busy || value?.length === 0}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await request(
                  `workspaces/${workspace}/members`,
                  { userId: member.id, role: member.role, scopeIds: value },
                  "PATCH",
                );
                await onChanged();
                setOpen(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save collaboration access
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
type Review = {
  review: string;
  source: {
    name: string;
    records: number;
    invitations: number;
    members: { name: string; role: string; limited: boolean }[];
  };
  target: {
    name: string;
    records: number;
    members: { name: string; role: string; limited: boolean }[];
  } | null;
};
export function WorkspaceActions({
  workspace,
  workspaces,
  onChanged,
}: {
  workspace: string;
  workspaces: { id: string; name: string; role: string }[];
  onChanged: (id: string | null) => Promise<void>;
}) {
  const [action, setAction] = useState<"delete" | "merge" | null>(null),
    [targetId, setTarget] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const destinations = workspaces.filter(
    (w) => w.id !== workspace && w.role === "owner",
  );
  return (
    <div className="panel-pad workspace-actions">
      <div className="button-stack">
        <button data-insights="merge-workspace"
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setAction("merge");
            setReview(null);
            setError("");
          }}
        >
          Merge workspace
        </button>
        <button data-insights="delete-workspace"
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() => {
            setAction("delete");
            setReview(null);
            setError("");
          }}
        >
          Delete workspace
        </button>
      </div>
      {action && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              if (!review) {
                const r = await request(`workspaces/${workspace}/review`, {
                  action,
                  targetId: action === "merge" ? targetId : undefined,
                });
                setReview(r);
                setName("");
              } else {
                const r = await request(`workspaces/${workspace}/manage`, {
                  action,
                  targetId: action === "merge" ? targetId : undefined,
                  review: review.review,
                  confirmName: name,
                });
                await onChanged(r.workspaceId);
                setAction(null);
                setReview(null);
              }
            } catch (e) {
              setError((e as Error).message);
              setReview(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>
            {action === "merge"
              ? "Merge into another workspace"
              : "Delete this workspace"}
          </h3>
          {action === "merge" && (
            <label>
              Destination workspace
              <select
                required
                value={targetId}
                disabled={busy}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setReview(null);
                }}
              >
                <option value="">Choose a workspace…</option>
                {destinations.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action === "merge" && !destinations.length && (
            <p className="small">
              Create another workspace you own to use as the destination.
            </p>
          )}
          {review && (
            <div className="operation-review">
              <p>
                <strong>{review.source.name}</strong>: {review.source.records}{" "}
                records, {review.source.members.length} team members,{" "}
                {review.source.invitations} pending invitations.
              </p>
              {action === "delete" ? (
                <p>
                  This permanently deletes the workspace, its records, activity,
                  and invitation links for everyone. Export a backup first.
                  Personal accounts are kept.
                </p>
              ) : (
                <>
                  <p>
                    All records and activity move into{" "}
                    <strong>{review.target?.name}</strong> (
                    {review.target?.records} existing records). Records with
                    matching names stay separate; their links are preserved. The
                    source workspace and its invitation links are removed.
                  </p>
                  <p>
                    Whole-workspace members from either workspace will gain
                    access to the combined workspace. Limited members keep their
                    selected records; when someone belongs to both, access is
                    combined and the stronger role applies. Record sharing
                    restrictions remain in place, and personal owner notes stay
                    author-only.
                  </p>
                  <ul>
                    {[
                      ...review.source.members,
                      ...(review.target?.members || []),
                    ].map((m, i) => (
                      <li key={i}>
                        {m.name} · {m.role} ·{" "}
                        {m.limited ? "Limited access" : "Whole workspace"}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <label>
                Type the source workspace name to confirm
                <input
                  required
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
          )}
          <div className="button-stack">
            <button
              className={
                action === "delete" ? "button danger" : "button primary"
              }
              disabled={
                busy ||
                (action === "merge" && !targetId) ||
                (!!review && name !== review.source.name)
              }
            >
              {busy
                ? "Working…"
                : review
                  ? action === "merge"
                    ? "Confirm merge"
                    : "Permanently delete workspace"
                  : "Review changes"}
            </button>
            <button data-insights="cancel"
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setAction(null);
                setReview(null);
              }}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
