"use client";
import { useState } from "react";
import {
  contactUploadSchema,
  type PublicContact,
} from "@/lib/contact-research-model";
export function PublicContacts({ contacts }: { contacts: PublicContact[] }) {
  if (!contacts.length) return null;
  return (
    <section
      className="record-section"
      aria-label="Public professional contacts"
    >
      <h3>Public professional contacts</h3>
      <p className="muted small">
        Published business contact routes. Delivery and identity are unverified;
        this does not authorize outreach.
      </p>
      <dl className="record-profile">
        {contacts.map((c) => (
          <div key={c.kind + c.value}>
            <dt>{c.kind}</dt>
            <dd>
              <a
                href={c.kind === "email" ? "mailto:" + c.value : c.value}
                target={c.kind === "email" ? undefined : "_blank"}
                rel="noopener noreferrer"
              >
                {c.value}
              </a>
              <p className="muted small">{c.evidence}</p>
              <a href={c.sourceURL} target="_blank" rel="noopener noreferrer">
                Source
              </a>
              <span className="muted small">
                {" "}
                · Retrieved {new Date(c.retrievedAt).toLocaleDateString()}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
type Preview = {
  digest: string;
  matched: number;
  changed: number;
  rows: {
    id: string;
    name: string;
    before: { email: string; website: string; publicContacts: PublicContact[] };
    after: { email: string; website: string; publicContacts: PublicContact[] };
  }[];
};
export function ContactResearchImport({
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
      const r = await api(
        `workspaces/${workspace}/people-contact-research`,
        "POST",
        { upload, ...(apply ? { digest: preview!.digest } : {}) },
      );
      if (apply)
        await onSaved(
          `Public contacts saved: ${r.updated} people updated; ${r.unchanged} already matched.`,
        );
      else setPreview(r);
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
      aria-label="Review people contact research"
    >
      <h2>Review people contact research</h2>
      <p>
        Add sourced business email and personal social links to existing people.
        Names, organizations and current contact context must match. Existing
        emails, relationships, notes, sharing and investor qualifications are
        preserved. No records are created and no messages are sent.
      </p>
      <label>
        Contact research file
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
              if (file.size > 900000) throw Error();
              setUpload(
                contactUploadSchema.parse(JSON.parse(await file.text())),
              );
            } catch {
              setError(
                "Choose a valid contact review JSON file smaller than 900 KB.",
              );
            }
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <p role="status">
            {preview.matched} people matched · {preview.changed} changes. Review
            the before and after values below.
          </p>
          <div className="standing-preview">
            {preview.rows.map((row) => (
              <details key={row.id}>
                <summary>
                  {row.name} · {row.before.publicContacts.length} →{" "}
                  {row.after.publicContacts.length} public contact routes
                </summary>
                <h3>Current contact fields</h3>
                <p>Email: {row.before.email || "Not supplied"}</p>
                <p>Public profile: {row.before.website || "Not supplied"}</p>
                <h3>Proposed contact fields</h3>
                <p>Email: {row.after.email || "Not supplied"}</p>
                <p>Public profile: {row.after.website || "Not supplied"}</p>
                <PublicContacts contacts={row.after.publicContacts} />
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
          Preview contact updates
        </button>
        {preview && (
          <button
            className="button primary"
            disabled={busy || !preview.changed}
            onClick={() => void act(true)}
          >
            Apply {preview.changed} reviewed contact updates
          </button>
        )}
        <button className="button subtle" disabled={busy} onClick={onClose}>
          Close contact review
        </button>
      </div>
    </section>
  );
}
