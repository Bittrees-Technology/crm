"use client";
import { defaultDigestOptions, type DigestOptions } from "@/lib/digest-options";
import { useEffect, useState } from "react";
import { Check, Clock3, Mail, Plus, ShieldCheck } from "lucide-react";
import { stages, type CrmRecord, type RecordData } from "@/lib/model";
async function request(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Please try again.");
  return d;
}
function DueDate({
  record,
  disabled,
  onChange,
}: {
  record: CrmRecord;
  disabled: boolean;
  onChange: (changes: Partial<RecordData>) => Promise<void>;
}) {
  const [value, setValue] = useState(record.data.dueDate);
  useEffect(
    () => setValue(record.data.dueDate),
    [record.data.dueDate, record.version],
  );
  return (
    <input
      type="date"
      className="quick-date"
      aria-label={`Due date for ${record.data.name}`}
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={async () => {
        if (value !== record.data.dueDate) {
          try {
            await onChange({ dueDate: value });
          } catch {
            setValue(record.data.dueDate);
          }
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}
export function QuickActions({
  record,
  disabled,
  onChange,
}: {
  record: CrmRecord;
  disabled: boolean;
  onChange: (changes: Partial<RecordData>) => Promise<void>;
}) {
  return (
    <div className="quick-actions" onClick={(e) => e.stopPropagation()}>
      {record.kind === "tasks" ? (
        <button
          type="button"
          className="button subtle"
          disabled={disabled}
          onClick={() =>
            void onChange({
              status: record.data.status === "Done" ? "Open" : "Done",
            }).catch(() => {})
          }
        >
          <Check size={14} />
          {record.data.status === "Done" ? "Reopen" : "Complete"}
        </button>
      ) : (
        <select
          aria-label={`Stage for ${record.data.name}`}
          value={record.data.stage}
          disabled={disabled}
          onChange={(e) =>
            void onChange({
              stage: e.target.value as RecordData["stage"],
            }).catch(() => {})
          }
        >
          {stages.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      )}
      <DueDate record={record} disabled={disabled} onChange={onChange} />
    </div>
  );
}
export function BackupIdentity({
  identities,
  onLink,
}: {
  identities: { kind: string }[];
  onLink: () => void;
}) {
  const email = identities.some((i) => i.kind === "email"),
    wallet = identities.some((i) => i.kind === "ethereum");
  return (
    <div className={"backup-identity " + (email && wallet ? "complete" : "")}>
      <ShieldCheck size={20} />
      <div>
        <strong>
          {email && wallet
            ? "Two verified ways to sign in"
            : email
              ? "Add a wallet as a backup sign-in"
              : "Add email as a backup sign-in"}
        </strong>
        <p>
          {email && wallet
            ? "Your email and Ethereum wallet access the same account."
            : email
              ? "Keep access to this account with your wallet as well as email."
              : "Verify your email so you can access this account even without your wallet."}
        </p>
      </div>
      {!(email && wallet) && (
        <button type="button" className="button" onClick={onLink}>
          {email ? "Link wallet" : "Link email"}
        </button>
      )}
    </div>
  );
}
type TimelineEvent = {
  id: string;
  action: string;
  actor: string;
  created_at: string;
  record_id: string;
  note?: string;
  detail: {
    name?: string;
    changes?: Record<string, { from: string; to: string }>;
  };
};
export function RelationshipTimeline({
  workspace,
  record,
  records,
  demo,
}: {
  workspace: string;
  record: CrmRecord;
  records: CrmRecord[];
  demo: boolean;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    if (demo) {
      const ids = new Set([record.id]);
      for (let i = 0; i < records.length; i++) {
        for (const r of records)
          if (
            [
              r.data.personId,
              r.data.organizationId,
              r.data.projectId,
              r.data.opportunityId,
            ].some((id) => ids.has(id))
          )
            ids.add(r.id);
      }
      setEvents(
        records
          .filter((r) => ids.has(r.id))
          .map((r) => ({
            id: r.id,
            record_id: r.id,
            action:
              r.kind === "tasks" && r.data.status === "Done"
                ? "Task completed"
                : "Record created",
            actor: "Demo team",
            created_at: r.updated_at,
            note: r.kind === "notes" ? r.data.description : undefined,
            detail: { name: r.data.name },
          }))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
      setLoading(false);
    } else
      request(`workspaces/${workspace}/records/${record.id}/timeline`)
        .then((d) => {
          if (!cancelled) setEvents(d.events);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    return () => {
      cancelled = true;
    };
  }, [workspace, record.id, record.version, demo, retry]);
  return (
    <section className="relationship-timeline">
      <h3>Relationship history</h3>
      <p className="small">
        Notes, task completions, and updates · most recent first
      </p>
      {loading ? (
        <p className="small">Loading history…</p>
      ) : error ? (
        <div className="error">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry
          </button>
        </div>
      ) : events.length ? (
        events.map((e) => (
          <article key={e.id} className="timeline-event">
            <span className="timeline-dot" />
            <div>
              <strong>
                {e.detail.changes?.status?.to === "Done"
                  ? "Task completed"
                  : e.action}
              </strong>
              <span> · {e.detail.name || "Record"}</span>
              <small>
                {e.actor} · {new Date(e.created_at).toLocaleString()}
              </small>
              {e.detail.changes &&
                Object.entries(e.detail.changes)
                  .filter(([k]) => k !== "ownerId")
                  .map(([k, v]) => (
                    <p className="small" key={k}>
                      {(
                        {
                          stage: "Stage",
                          status: "Status",
                          dueDate: "Due date",
                          nextAction: "Next step",
                        } as Record<string, string>
                      )[k] || k}
                      : {v.from || "Not set"} → {v.to || "Not set"}
                    </p>
                  ))}
              {e.note && <p className="timeline-note">{e.note}</p>}
            </div>
          </article>
        ))
      ) : (
        <p className="quiet-empty">New notes and updates will appear here.</p>
      )}
    </section>
  );
}
export function DigestSettings({
  workspaces,
  identities,
  demo,
  onLink,
}: {
  workspaces: { id: string; name: string }[];
  identities: { kind: string; value: string }[];
  demo: boolean;
  onLink: () => void;
}) {
  const emails = identities.filter((i) => i.kind === "email");
  const [options, setOptions] = useState<DigestOptions>(defaultDigestOptions);
  const [preview, setPreview] = useState("");
  const [enabled, setEnabled] = useState(false),
    [email, setEmail] = useState(""),
    [last, setLast] = useState<{ status: string; day: string } | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    if (demo) {
      setBusy(false);
      return;
    }
    request("me/digest")
      .then((d) => {
        if (live) {
          setEnabled(d.enabled);
          setEmail(d.email || emails[0]?.value || "");
          setLast(d.last);
          setOptions(d.options || defaultDigestOptions);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [demo, emails.map((i) => i.value).join(",")]);
  return (
    <section className="panel full-span">
      <div className="section-heading">
        <h2>
          <Mail size={18} /> Daily follow-up email
        </h2>
        <span className="small">Optional · once a day</span>
      </div>
      <form
        className="settings-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await request("me/digest", "PATCH", { enabled, email, options });
            setNotice(
              enabled ? "Daily digest enabled." : "Daily digest turned off.",
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="small">
          Around 08:00 UTC, receive overdue, today, and upcoming sections with
          next steps, context, and links to each record. Nothing is sent when no
          work matches your settings.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || demo || !emails.length}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Email me a daily digest
        </label>
        {emails.length ? (
          <label>
            Verified delivery address
            <select
              value={email}
              disabled={busy || demo}
              onChange={(e) => setEmail(e.target.value)}
            >
              {emails.map((e) => (
                <option key={e.value}>{e.value}</option>
              ))}
            </select>
          </label>
        ) : (
          <button
            type="button"
            className="text-button"
            disabled={demo}
            onClick={onLink}
          >
            Link a verified email to enable reminders
          </button>
        )}
        <fieldset disabled={busy || demo} className="digest-controls">
          <label>
            Follow-up ownership
            <select
              value={options.assignment}
              onChange={(e) =>
                setOptions({
                  ...options,
                  assignment: e.target.value as "mine" | "all",
                })
              }
            >
              <option value="mine">Assigned to me</option>
              <option value="all">All work I can access</option>
            </select>
          </label>
          <label>
            Look-ahead window
            <select
              value={options.daysAhead}
              onChange={(e) =>
                setOptions({ ...options, daysAhead: Number(e.target.value) })
              }
            >
              {[0, 1, 3, 7, 14, 30].map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? "Today only" : `Next ${days} days`}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={options.includeOverdue}
              onChange={(e) =>
                setOptions({ ...options, includeOverdue: e.target.checked })
              }
            />
            Include overdue follow-ups
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={options.weekdaysOnly}
              onChange={(e) =>
                setOptions({ ...options, weekdaysOnly: e.target.checked })
              }
            />
            Weekdays only (UTC)
          </label>
          <label>
            Follow-up records
            <select
              value={options.kinds.length === 2 ? "both" : options.kinds[0]}
              onChange={(e) =>
                setOptions({
                  ...options,
                  kinds:
                    e.target.value === "both"
                      ? ["tasks", "opportunities"]
                      : [e.target.value as "tasks" | "opportunities"],
                })
              }
            >
              <option value="both">Tasks and opportunities</option>
              <option value="tasks">Tasks only</option>
              <option value="opportunities">Opportunities only</option>
            </select>
          </label>
          <label>
            Email workspaces
            <select
              value={options.workspaceIds === null ? "all" : "selected"}
              onChange={(e) =>
                setOptions({
                  ...options,
                  workspaceIds: e.target.value === "all" ? null : [],
                })
              }
            >
              <option value="all">All my workspaces</option>
              <option value="selected">Selected workspaces</option>
            </select>
          </label>
          {options.workspaceIds !== null &&
            workspaces.map((w) => (
              <label key={w.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={options.workspaceIds!.includes(w.id)}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      workspaceIds: e.target.checked
                        ? [...options.workspaceIds!, w.id]
                        : options.workspaceIds!.filter((id) => id !== w.id),
                    })
                  }
                />
                {w.name}
              </label>
            ))}
          {options.workspaceIds?.length === 0 && (
            <p className="small">
              No workspaces selected: no emails will be sent.
            </p>
          )}
        </fieldset>
        <div className="button-stack">
          <button className="button" disabled={busy || demo || !emails.length}>
            Save email preference
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || demo}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r = await request("me/digest/preview", "POST", options);
                setPreview(r.text);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Preview follow-up email
          </button>
        </div>
        {preview && (
          <div
            className="digest-preview"
            role="region"
            aria-label="Follow-up email preview"
          >
            <h3>Email preview</h3>
            <p className="small">
              Preview uses the settings above. Save them to update scheduled
              emails.
            </p>
            <pre>{preview}</pre>
          </div>
        )}
        {last && (
          <p className="small">
            Last digest:{" "}
            {last.status === "sent"
              ? "sent"
              : last.status === "failed"
                ? "delivery failed — we will try again on the next scheduled day"
                : last.status}{" "}
            · {new Date(last.day).toLocaleDateString()}
          </p>
        )}
        {notice && (
          <p role="status" className="verified">
            {notice}
          </p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </form>
    </section>
  );
}
export function InviteManager({
  workspace,
  demo,
  revision,
  onInvite,
  onChanged,
}: {
  workspace: string;
  demo: boolean;
  revision: number;
  onInvite: (
    email: string,
    role: string,
    scopeIds?: string[] | null,
  ) => Promise<void>;
  onChanged: (revoked: boolean) => void;
}) {
  const [invites, setInvites] = useState<
      {
        id: string;
        email: string;
        role: string;
        status: string;
        expires_at: string;
        scope_ids: string[] | null;
      }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    if (demo) return;
    request(`workspaces/${workspace}/invites`)
      .then((d) => {
        if (live) setInvites(d.invites);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [workspace, demo, revision, tick]);
  async function act(fn: () => Promise<unknown>, revoked = false) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setTick((v) => v + 1);
      onChanged(revoked);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="invitation-manager">
      <h3>Invitations</h3>
      <p className="small">
        Recreating a link immediately revokes older links for the same email.
        Share the new link directly with the recipient.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!invites.length ? (
        <p className="quiet-empty">No invitations yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>
                    {i.role} ·{" "}
                    {i.scope_ids === null
                      ? "Whole workspace"
                      : `${i.scope_ids.length} selected records`}
                  </td>
                  <td>
                    <span className="badge">{i.status}</span>
                  </td>
                  <td>{new Date(i.expires_at).toLocaleDateString()}</td>
                  <td className="invite-actions">
                    {i.status === "Pending" && (
                      <button
                        type="button"
                        className="text-button danger"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              request(
                                `workspaces/${workspace}/invites`,
                                "DELETE",
                                { id: i.id },
                              ),
                            true,
                          )
                        }
                      >
                        Revoke
                      </button>
                    )}
                    {i.status !== "Accepted" && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void act(() => onInvite(i.email, i.role, i.scope_ids))
                        }
                      >
                        Recreate link
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
