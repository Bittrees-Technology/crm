"use client";
import { SupplierPreparation } from "./supplier-preparation";
import { useEffect, useState } from "react";
import { api } from "../leads/lead-api";
export default function ProjectConnections() {
  const [datasets, setDatasets] = useState<any[]>([]),
    [dataset, setDataset] = useState(""),
    [options, setOptions] = useState<any>({ projects: [], permissions: [] }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [secret, setSecret] = useState("");
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
  async function load(id = dataset) {
    setDatasets(
      (await api("leads/drafts")).filter((d: any) => !d.shared_search_id),
    );
    if (id)
      setOptions(
        await api("datasets/projects/permissions?id=" + encodeURIComponent(id)),
      );
  }
  useEffect(() => {
    void act(() => load());
  }, []);
  return (
    <main className="integration-page">
      <header>
        <a href="/">← CRM</a>
        <h1>Local AI</h1>
        <p>
          Connect only the projects you want your local AI to work on. Automatic
          additions appear in People, Organizations and Tasks; they do not need
          a separate review queue.
        </p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="integration-card">
        <h2>Connection</h2>
        <fieldset disabled={busy}>
          <label>
            Research connection
            <select
              value={dataset}
              onChange={(e) => {
                const id = e.target.value;
                setDataset(id);
                setSecret("");
                void act(() => load(id));
              }}
            >
              <option value="">Choose a connection</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              void act(async () => {
                const id = crypto.randomUUID();
                await api("leads/draft", {
                  id,
                  version: 0,
                  name: "Local AI projects",
                  entries: [],
                });
                setDataset(id);
                await load(id);
              })
            }
          >
            New connection
          </button>
          {dataset && (
            <details>
              <summary>Connect or reconnect the local app</summary>
              <p>
                Reconnecting replaces the previous key and invalidates its
                project permissions. Enable the project permissions again after
                connecting. Existing app connections can skip this step.
              </p>
              <button
                onClick={() =>
                  void act(async () => {
                    if (
                      !confirm(
                        "Replace this dataset connection key? The previous key will stop working.",
                      )
                    )
                      return;
                    const c = await api("datasets/connect", { id: dataset });
                    setSecret(c.token);
                  })
                }
              >
                Generate connection key
              </button>
              {secret && (
                <>
                  <label>
                    Connection key
                    <input type="password" readOnly value={secret} />
                  </label>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await navigator.clipboard.writeText(secret);
                        setMessage(
                          "Copied. Paste into Bittrees AI → Connections → CRM dataset.",
                        );
                      })
                    }
                  >
                    Copy key
                  </button>
                  <button onClick={() => setSecret("")}>Hide key</button>
                </>
              )}
            </details>
          )}
        </fieldset>
      </section>
      {dataset && (
        <section className="integration-card">
          <h2>Connected projects</h2>
          <p>
            Permissions apply only to your account and expire within 30 days.
            Project sharing rules determine who sees created records. A dataset
            has one automatic lead destination; task access can cover several
            projects. Existing research is not imported retroactively.
          </p>
          <p>
            Task access lets the local AI read accessible project records,
            create tasks assigned to you, and work on open tasks categorized{" "}
            <strong>AI draft</strong> or <strong>AI review</strong>. Results are
            saved as project notes. It cannot send messages, delete data, change
            access or approve training.
          </p>
          {options.projects.map((p: any) => (
            <ProjectPermission
              key={dataset + p.id + JSON.stringify(options.permissions)}
              dataset={dataset}
              project={p}
              permission={options.permissions.find(
                (g: any) => g.project_id === p.id,
              )}
              busy={busy}
              save={(body: any) =>
                void act(async () => {
                  await api("datasets/projects/permissions", body);
                  await load();
                  setMessage(
                    "Project permissions saved. Refresh connected projects in the local app.",
                  );
                })
              }
            />
          ))}
          {!options.projects.length && (
            <p>
              Create a project in a workspace you own to enable local AI
              automation.
            </p>
          )}
        </section>
      )}
      <details className="integration-card">
        <summary>Advanced research and collaborator review</summary>
        <p>
          Private datasets, training exports and approval-required researcher
          submissions remain available separately.
        </p>
        <a href="/connect/ai/leads">Open advanced research</a>
      </details>
    </main>
  );
}
function ProjectPermission({ dataset, project, permission, busy, save }: any) {
  const [leads, setLeads] = useState(permission?.auto_leads || false),
    [tasks, setTasks] = useState(permission?.tasks || false),
    [qualification, setQualification] = useState(
      permission?.qualification || false,
    );
  return (
    <fieldset disabled={busy}>
      <legend>
        {project.workspace} · {project.name}
      </legend>
      <label>
        <input
          type="checkbox"
          checked={leads}
          onChange={(e) => setLeads(e.target.checked)}
        />
        Automatically add new researched people and organizations here
      </label>
      <label>
        <input
          type="checkbox"
          checked={tasks}
          onChange={(e) => setTasks(e.target.checked)}
        />
        Allow local AI task creation, project reading and draft/review work
      </label>
      <label>
        <input
          type="checkbox"
          checked={qualification}
          onChange={(e) => setQualification(e.target.checked)}
        />
        Allow sourced qualification research and label-only updates for linked
        people and organizations
      </label>
      <p>
        Qualification updates preserve descriptions, contact details,
        organization links and sharing. They do not establish investor
        eligibility or interest.
      </p>
      {permission && (
        <p>Expires {new Date(permission.expires_at).toLocaleString()}</p>
      )}
      <SupplierPreparation project={project} />
      <button
        onClick={() => {
          if (
            (leads || tasks || qualification) &&
            !confirm(
              `Allow this connection to ${leads ? "add new people and organizations automatically; " : ""}${tasks ? "read project records and create/complete AI draft or review tasks; " : ""}${qualification ? "research qualifications and update only qualification labels on mapped project records; " : ""}in ${project.name} for up to 30 days?`,
            )
          )
            return;
          save({
            datasetId: dataset,
            projectId: project.id,
            autoLeads: leads,
            tasks,
            qualification,
            expiresInDays: 30,
          });
        }}
      >
        Save project permissions
      </button>
    </fieldset>
  );
}
