import type { ReactNode } from "react";
import type { CrmRecord, Kind, RecordData } from "@/lib/model";
import { formatAmount } from "@/lib/currencies";

type Field = [keyof RecordData, string];
const contactFields: Partial<Record<Kind, Field[]>> = {
  people: [
    ["title", "Role / title"],
    ["email", "Email address"],
    ["website", "Public profile"],
    ["category", "Investor / contact category"],
  ],
  organizations: [
    ["category", "Organization type"],
    ["email", "Email address"],
    ["website", "Website"],
  ],
  projects: [["category", "Project type"]],
  opportunities: [
    ["category", "Opportunity type"],
    ["stage", "Stage"],
    ["value", "Estimated value"],
    ["nextAction", "Next action"],
    ["dueDate", "Next action due"],
  ],
  tasks: [
    ["status", "Status"],
    ["dueDate", "Due date"],
  ],
};
const relationshipFields: Partial<Record<Kind, Field[]>> = {
  people: [
    ["organizationId", "Organization"],
    ["projectId", "Project"],
  ],
  organizations: [["projectId", "Project"]],
  opportunities: [
    ["organizationId", "Organization"],
    ["personId", "Contact"],
    ["projectId", "Project"],
  ],
  tasks: [
    ["personId", "Contact"],
    ["organizationId", "Organization"],
    ["opportunityId", "Opportunity"],
    ["projectId", "Project"],
  ],
  notes: [
    ["personId", "Person"],
    ["organizationId", "Organization"],
    ["opportunityId", "Opportunity"],
    ["projectId", "Project"],
  ],
};
const detailTitles: Record<Kind, string> = {
  people: "Contact details",
  organizations: "Organization details",
  projects: "Project details",
  opportunities: "Opportunity details",
  tasks: "Task details",
  notes: "Note details",
};
export const recordKindLabels: Record<Kind, string> = {
  people: "People",
  organizations: "Organizations",
  projects: "Projects",
  opportunities: "Opportunities",
  tasks: "Tasks",
  notes: "Notes",
};

/** Preserve the stored prose. Only explicit HTTP(S) URLs become links. */
export function RecordDescription({ text }: { text: string }) {
  return (
    <div className="record-prose">
      {text.split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>
          {paragraph.split(/(https?:\/\/[^\s<>]+)/gi).map((part, j) => {
            if (!/^https?:\/\//i.test(part)) return part;
            const href = part
              .replace(/[.,;!?]+$/, "")
              .replace(/\)$/, (match) =>
                part.split(")").length > part.split("(").length ? "" : match,
              );
            try {
              const url = new URL(href);
              if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password
              )
                return part;
            } catch {
              return part;
            }
            return (
              <span key={j}>
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {href}
                </a>
                {part.slice(href.length)}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

export function RecordProfile({
  record,
  records,
  members,
  onOpen,
}: {
  record: CrmRecord;
  records: CrmRecord[];
  members: { id: string; name: string }[];
  onOpen?: (record: CrmRecord) => void;
}) {
  const { data, kind } = record;
  const ownership: Field[] = [["ownerId", "Owner"]];
  if (kind === "people" || kind === "organizations")
    ownership.push(
      ["communication", "Communication preference"],
      ["wallet", "Wallet reference (unverified)"],
    );
  const groups: [string, Field[]][] = [
    [detailTitles[kind], contactFields[kind] || []],
    ["Relationships", relationshipFields[kind] || []],
    ["Ownership & preferences", ownership],
    ["Source", [["source", "Source / reference"]]],
  ];
  function valueFor(key: keyof RecordData): ReactNode {
    const value = data[key];
    if (key === "ownerId")
      return members.find((m) => m.id === value)?.name || "Unavailable member";
    if (key.endsWith("Id")) {
      const linked = records.find((r) => r.id === value);
      return linked ? (
        <button
          type="button"
          className="text-button"
          onClick={() => onOpen?.(linked)}
        >
          {linked.data.name}
        </button>
      ) : (
        "Linked record unavailable"
      );
    }
    if (key === "website" && /^https?:\/\//i.test(String(value)))
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer">
          {String(value)}
        </a>
      );
    if (key === "email") return <a href={`mailto:${value}`}>{String(value)}</a>;
    if (key === "value") return formatAmount(data.value, data.currency);
    if (key === "status" || key === "stage")
      return (
        <span
          className={
            "badge " + (value === "Done" || value === "Won" ? "success" : "")
          }
        >
          {String(value)}
        </span>
      );
    if (key === "dueDate" && value)
      return (
        <time dateTime={String(value)}>
          {new Date(String(value) + "T12:00:00").toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </time>
      );
    return String(value);
  }
  return (
    <section aria-label="Record profile" className="record-profile-sections">
      {groups.map(([title, fields]) => {
        const present = fields.filter(
          ([key]) => data[key] !== "" && data[key] != null,
        );
        if (!present.length) return null;
        return (
          <section className="record-section" key={title}>
            <h3>{title}</h3>
            <dl className="record-profile">
              {present.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{valueFor(key)}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      <section className="record-section">
        <h3>{kind === "notes" ? "Note" : "Description / context"}</h3>
        <RecordDescription text={data.description || "No description added."} />
      </section>
    </section>
  );
}

export function RelatedRecords({
  record,
  records,
  busy,
  onOpen,
}: {
  record: CrmRecord;
  records: CrmRecord[];
  busy: boolean;
  onOpen: (record: CrmRecord) => void;
}) {
  const refs = (r: CrmRecord) => [
    r.data.organizationId,
    r.data.personId,
    r.data.projectId,
    r.data.opportunityId,
  ];
  const related = records.filter(
    (r) =>
      r.id !== record.id &&
      (refs(r).includes(record.id) || refs(record).includes(r.id)),
  );
  return (
    <section className="record-section related-record-groups">
      <h3>
        Related records{" "}
        <span className="related-count">{related.length.toLocaleString()}</span>
      </h3>
      {!related.length ? (
        <p className="muted small">
          No linked records yet. Add relationships when you edit this record.
        </p>
      ) : (
        (Object.keys(recordKindLabels) as Kind[]).map((kind) => {
          const items = related.filter((r) => r.kind === kind);
          if (!items.length) return null;
          return (
            <details key={kind} open={items.length <= 5}>
              <summary>
                {recordKindLabels[kind]}{" "}
                <span className="related-count">
                  {items.length.toLocaleString()}
                </span>
              </summary>
              <ul>
                {items.map((r) => (
                  <li key={r.id}>
                    <button
                      className="related-record-link"
                      type="button"
                      disabled={busy}
                      onClick={() => onOpen(r)}
                    >
                      <strong>{r.data.name}</strong>
                      <span>
                        {[
                          r.data.title || r.data.category,
                          r.archived_at
                            ? "Archived"
                            : r.kind === "tasks"
                              ? r.data.status
                              : "",
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Open record"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          );
        })
      )}
    </section>
  );
}
