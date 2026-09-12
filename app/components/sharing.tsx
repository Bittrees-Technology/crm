"use client";
import { useEffect, useState } from "react";
import type { CrmRecord, RecordData } from "@/lib/model";
import { resolveAccess } from "@/lib/access-graph";
type Member = {
  id: string;
  name: string;
  role: string;
  scope_ids?: string[] | null;
};

export function RecordSharing({
  records,
  members,
  record,
  data,
  value,
  onChange,
  disabled,
}: {
  records: CrmRecord[];
  members: Member[];
  record?: CrmRecord;
  data: RecordData;
  value: string[] | null;
  onChange: (ids: string[] | null) => void;
  disabled: boolean;
}) {
  const id = record?.id || "new";
  const proposed = [
    ...records.filter((r) => r.id !== id),
    { id, kind: record?.kind || "record", data, visibility_ids: value },
  ];
  const [search, setSearch] = useState("");
  return (
    <details className="sharing-panel">
      <summary>
        Sharing &amp; access ·{" "}
        {value === null
          ? "Workspace rules"
          : value.length
            ? "Selected people"
            : "Workspace owners"}
      </summary>
      <p className="muted small">
        All workspace owners can access shared content. Your private note stays
        visible only to you. Changes take effect when you save.
      </p>
      <label>
        Record access
        <select data-insights="record-access"
          aria-label="Record access"
          disabled={disabled}
          value={value === null ? "workspace" : "selected"}
          onChange={(e) => onChange(e.target.value === "workspace" ? null : [])}
        >
          <option value="workspace">Follow workspace access</option>
          <option value="selected">Selected people</option>
        </select>
      </label>
      <p className="muted small">
        Leave everyone unchecked for workspace owners only. Selecting a person
        grants access to this record only. Linked records keep their own sharing
        rules. Restricting a record may also remove access inherited through it.
      </p>
      <label>
        Find a team member
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="access-list">
        {members
          .filter((m) => m.name.toLowerCase().includes(search.toLowerCase()))
          .map((m) => {
            const member = {
              user_id: m.id,
              role: m.role,
              scope_ids: m.scope_ids ?? null,
            };
            const access = resolveAccess(proposed, member),
              before = resolveAccess(records, member);
            const reasons = access.get(id);
            const lost = [...before.keys()].filter(
              (k) => !access.has(k),
            ).length;
            const gained = [...access.keys()].filter(
              (k) => !before.has(k),
            ).length;
            return (
              <div className="access-row" key={m.id}>
                <div>
                  {value !== null && m.role !== "owner" ? (
                    <label className="access-choice">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={value.includes(m.id)}
                        onChange={(e) =>
                          onChange(
                            e.target.checked
                              ? [...value, m.id]
                              : value.filter((v) => v !== m.id),
                          )
                        }
                      />
                      {m.name}
                    </label>
                  ) : (
                    <strong>{m.name}</strong>
                  )}
                  <span className="small muted">
                    {reasons
                      ? `${m.role === "viewer" ? "Can view" : "Can edit"} · ${reasons.join("; ")}`
                      : "No access to this record"}
                  </span>
                  {!!(lost || gained) && (
                    <span className="small">
                      After saving: {gained} record(s) gained · {lost} record(s)
                      lost
                    </span>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </details>
  );
}
type Report = {
  records: { id: string; name: string; kind: string }[];
  members: {
    id: string;
    name: string;
    role: string;
    records: { id: string; reasons: string[] }[];
  }[];
};
export function AccessInspector({
  workspace,
  revision,
}: {
  workspace: string;
  revision: string;
}) {
  const [open, setOpen] = useState(false),
    [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [member, setMember] = useState(""),
    [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReport(null);
    setError("");
    fetch(`/api/workspaces/${workspace}/access`, {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || "Unable to load access.");
        return body;
      })
      .then((r) => {
        if (!controller.signal.aborted) setReport(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e.message || "Unable to load access.");
      });
    return () => controller.abort();
  }, [open, workspace, revision, retry]);
  const selected =
    report?.members.find((m) => m.id === member) || report?.members[0];
  const accessible = new Map(selected?.records.map((r) => [r.id, r.reasons]));
  const rows =
    report?.records.filter(
      (r) =>
        accessible.has(r.id) &&
        `${r.name} ${r.kind}`.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  return (
    <details
      className="sharing-panel"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Review who can access each record</summary>
      <p className="muted small">
        Select a team member to see their effective access and why. Private
        owner notes are excluded.
      </p>
      {error ? (
        <div role="alert" className="error">
          {error}{" "}
          <button data-insights="retry-access-review"
            type="button"
            className="button"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry access review
          </button>
        </div>
      ) : !report ? (
        <p role="status">Loading access…</p>
      ) : (
        <>
          <label>
            Review access for
            <select data-insights="review-access-for"
              aria-label="Review access for"
              value={selected?.id || ""}
              onChange={(e) => setMember(e.target.value)}
            >
              {report.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.role}
                </option>
              ))}
            </select>
          </label>
          <label>
            Find accessible records
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <p className="small">
            {selected?.records.length || 0} of {report.records.length} records
            accessible ·{" "}
            {selected?.role === "viewer" ? "View only" : "Can edit"}
          </p>
          <div className="access-list">
            {rows.map((r) => (
              <div className="access-row" key={r.id}>
                <strong>{r.name}</strong>
                <span className="muted small">
                  {r.kind} · {accessible.get(r.id)?.join("; ")}
                </span>
              </div>
            ))}
            {!rows.length && <p>No accessible records match.</p>}
          </div>
        </>
      )}
    </details>
  );
}
