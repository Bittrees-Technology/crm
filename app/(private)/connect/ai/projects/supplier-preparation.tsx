"use client";
import { useState } from "react";
import { api } from "../leads/lead-api";
export function SupplierPreparation({ project }: { project: any }) {
  const [rows, setRows] = useState<any[] | null>(null),
    [org, setOrg] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [urls, setUrls] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const route = `workspaces/${project.workspace_id}/supplier-research`;
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const supplier = rows?.find((r) => r.id === org);
  const tasks =
    rows?.filter(
      (r) => r.kind === "tasks" && r.supplierOrganizationId === org,
    ) || [];
  function proposeSources() {
    const proposed = new Set<string>();
    let host = "";
    try {
      host = new URL(supplier.data.website).hostname.replace(/^www\./, "");
    } catch {}
    const texts = [
      supplier?.data.website || "",
      ...tasks
        .filter((t) => selected.includes(t.id))
        .map((t) => t.data.description || ""),
    ];
    for (const text of texts)
      for (const raw of text.match(/https:\/\/[^\s<>"\x27]+/g) || []) {
        try {
          const u = new URL(raw.replace(/[),.;]+$/, ""));
          if (
            u.hostname.replace(/^www\./, "") === host &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            !u.port &&
            u.href.length <= 300
          )
            proposed.add(u.href);
        } catch {}
      }
    setUrls([...proposed].slice(0, 16).join("\n"));
    setPreview(null);
    setMessage(
      proposed.size
        ? "Suggested sources only. Review the exact URLs before approval."
        : "No matching supplier URLs found. Add the public supplier pages to review.",
    );
  }
  function selection() {
    return {
      projectId: project.id,
      organizationId: org,
      organizationVersion: supplier.version,
      parents: tasks
        .filter((r) => selected.includes(r.id))
        .map((r) => ({ id: r.id, version: r.version })),
      urls: urls
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
  }
  return (
    <details>
      <summary>Prepare supplier research</summary>
      <p>
        Create a separate evidence review in {project.name}. Original supplier
        confirmations stay open. This does not enable project access or contact
        suppliers.
      </p>
      <fieldset disabled={busy}>
        {!rows && (
          <button
            onClick={() =>
              void act(async () => {
                const r = await api(route);
                setRows(r.records);
                if (r.truncated)
                  setMessage(
                    "Only the latest 500 records are shown. Missing suppliers must be reviewed separately.",
                  );
              })
            }
          >
            Load my open supplier confirmations
          </button>
        )}
        {rows && (
          <>
            {rows.some(
              (r) => r.kind === "tasks" && !r.supplierOrganizationId,
            ) && (
              <p>
                Some open tasks have no current supplier link. Link their
                organization or linked person's organization before preparing
                research.
              </p>
            )}
            <label>
              Supplier
              <select
                value={org}
                onChange={(e) => {
                  setOrg(e.target.value);
                  setSelected([]);
                  setUrls("");
                  setPreview(null);
                }}
              >
                <option value="">Choose supplier</option>
                {rows
                  .filter(
                    (r) =>
                      r.kind === "organizations" &&
                      rows.some(
                        (t) =>
                          t.kind === "tasks" &&
                          t.supplierOrganizationId === r.id,
                      ),
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.data.name}
                    </option>
                  ))}
              </select>
            </label>
            {!!tasks.length && (
              <button
                type="button"
                onClick={() => {
                  setSelected(tasks.slice(0, 32).map((t) => t.id));
                  setPreview(null);
                }}
              >
                Select all supplier confirmations
              </button>
            )}
            {tasks.length > 32 && (
              <p>Select up to 32 confirmations per review.</p>
            )}
            {tasks.map((t) => (
              <label key={t.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(t.id)}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked
                        ? [...selected, t.id]
                        : selected.filter((id) => id !== t.id),
                    );
                    setPreview(null);
                  }}
                />
                {t.data.name}
              </label>
            ))}
            <button
              type="button"
              disabled={!supplier || !selected.length}
              onClick={proposeSources}
            >
              Use listed supplier sources
            </button>
            <label>
              Approved public supplier URLs, one per line
              <textarea
                value={urls}
                onChange={(e) => {
                  setUrls(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <p>
              Use 1–16 HTTPS pages on the supplier website. The local app may
              fetch these pages only after you separately enable task access for
              this project.
            </p>
            <button
              disabled={!supplier || !selected.length || !urls.trim()}
              onClick={() =>
                void act(async () => {
                  setPreview(null);
                  const r = await api(route, { selection: selection() });
                  setPreview(r.preview);
                })
              }
            >
              Preview research task
            </button>
          </>
        )}
        {preview && (
          <section>
            <h3>{preview.supplier} — evidence review</h3>
            <p>
              Destination: {preview.project}. Assigned to you and private to
              your account’s record sharing. Other workspace owners retain their
              normal access.
            </p>
            <ul>
              {preview.parents.map((t: any) => (
                <li key={t.id}>{t.name} — stays open</li>
              ))}
            </ul>
            <ul>
              {preview.urls.map((url: string) => (
                <li key={url}>{url}</li>
              ))}
            </ul>
            <p>{preview.description}</p>
            <button
              onClick={() =>
                void act(async () => {
                  const result = await api(route, {
                    selection: selection(),
                    reviewToken: preview.reviewToken,
                    confirmed: true,
                  });
                  setMessage(
                    result.existing
                      ? "This research task already exists."
                      : "Research task prepared. Enable only the intended project task permission above when ready. Original confirmations remain open.",
                  );
                  setPreview(null);
                })
              }
            >
              Approve sources and prepare research task
            </button>
          </section>
        )}
      </fieldset>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
