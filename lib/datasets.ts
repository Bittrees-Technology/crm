import { autoAddLeads, projectAgent } from "./project-automation";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { hash, token } from "./auth";
import { HttpError, recordSchema } from "./model";
import {
  membership,
  lockActiveAccount,
  saveRecordInTransaction,
} from "./service";
import { accessIds } from "./access";
import {
  draftEntrySchema,
  saveDraftInTransaction,
  shareDraftInTransaction,
} from "./lead-drafts";
import { datasetVersion, trainingRows } from "./dataset-model";
const uuid = z.uuid();
function enabled() {
  if (process.env.CRM_LEADS_ENABLED !== "true")
    throw new HttpError(404, "Not found.");
}
async function owned(db: PoolClient, user: string, id: string) {
  enabled();
  uuid.parse(id);
  await lockActiveAccount(db, user);
  const d = (
    await db.query(
      "SELECT * FROM lead_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [id, user],
    )
  ).rows[0];
  if (!d) throw new HttpError(404, "Dataset not found.");
  return d;
}
async function credential(db: PoolClient, bearer: string) {
  enabled();
  if (!/^[a-f0-9]{64}$/.test(bearer))
    throw new HttpError(401, "Dataset connection required.");
  const c = (
    await db.query("SELECT * FROM dataset_connections WHERE token_hash=$1", [
      hash(bearer),
    ])
  ).rows[0];
  if (!c) throw new HttpError(401, "Dataset connection expired or revoked.");
  const d = await owned(db, c.user_id, c.draft_id);
  // Lock order matches connect/revoke. Recheck after obtaining the dataset lock.
  if (
    !(
      await db.query(
        "SELECT 1 FROM dataset_connections WHERE draft_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>now()",
        [d.id, d.user_id, hash(bearer)],
      )
    ).rowCount
  )
    throw new HttpError(401, "Dataset connection expired or revoked.");
  return d;
}
export async function datasetConnect(user: string, raw: unknown) {
  const a = z
    .strictObject({ id: uuid, revoke: z.boolean().default(false) })
    .parse(raw);
  return transaction(async (db) => {
    const d = await owned(db, user, a.id);
    if (a.revoke) {
      await db.query("DELETE FROM dataset_connections WHERE draft_id=$1", [
        d.id,
      ]);
      return { revoked: true };
    }
    if (d.shared_search_id)
      throw new HttpError(
        409,
        "Make an editable copy before connecting an agent.",
      );
    const secret = token();
    const c = (
      await db.query(
        "INSERT INTO dataset_connections(draft_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days') ON CONFLICT(draft_id) DO UPDATE SET user_id=EXCLUDED.user_id,token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at RETURNING expires_at",
        [d.id, user, hash(secret)],
      )
    ).rows[0];
    return { token: secret, expiresAt: c.expires_at };
  });
}
async function crmRows(db: PoolClient, user: string, links: any[]) {
  const result = [];
  for (const workspace of new Set<string>(links.map((l) => l.workspace_id))) {
    // A lost membership removes the source data; never fall back to stored credentials.
    const member = (
      await db.query(
        "SELECT 1 FROM members WHERE workspace_id=$1 AND user_id=$2",
        [workspace, user],
      )
    ).rowCount;
    if (!member) continue;
    await membership(workspace, user, false, false, db);
    const allowed = await accessIds(db, user, workspace);
    const ids = links
      .filter((l) => l.workspace_id === workspace)
      .map((l) => l.record_id)
      .filter((id) => allowed === null || allowed.includes(id));
    if (!ids.length) continue;
    const rows = (
      await db.query(
        `SELECT id,kind,version,updated_at,archived_at,
      jsonb_build_object('name',data->>'name','category',data->>'category','source',data->>'source','title',data->>'title','website',data->>'website','email',data->>'email','description',data->>'description','organizationId',data->>'organizationId') AS data
      FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind IN ('people','organizations','projects')`,
        [workspace, ids],
      )
    ).rows;
    for (const r of rows) {
      if (
        allowed !== null &&
        r.data.organizationId &&
        !allowed.includes(r.data.organizationId)
      )
        r.data.organizationId = "";
      result.push({ ...r, workspaceId: workspace });
    }
  }
  return result;
}
async function read(db: PoolClient, d: any, known?: string) {
  const links = (
    await db.query(
      "SELECT entry_id,record_id,workspace_id FROM dataset_record_links WHERE draft_id=$1",
      [d.id],
    )
  ).rows;
  const current = await crmRows(db, d.user_id, links);
  const available = new Set(current.map((r) => r.id));
  const receipts = (
    await db.query(
      `SELECT x.operation_id,x.review_id,s.workspace_id,p.decision,p.record_ids,d.entries FROM dataset_submissions x
    JOIN lead_drafts d ON d.id=x.snapshot_id JOIN lead_previews p ON p.id=x.review_id JOIN lead_searches s ON s.id=p.search_id
    WHERE x.draft_id=$1 ORDER BY p.created_at DESC LIMIT 50`,
      [d.id],
    )
  ).rows;
  // Return mappings only for destination records still readable by this user.
  const mapped = [];
  for (const r of receipts) {
    const records = await crmRows(
      db,
      d.user_id,
      (r.record_ids || []).map((id: string) => ({
        record_id: id,
        workspace_id: r.workspace_id,
      })),
    );
    const visible = new Set(records.map((x) => x.id));
    mapped.push({
      operationId: r.operation_id,
      reviewId: r.review_id,
      status: r.decision ? "reviewed" : "awaiting_review",
      accepted: r.decision?.accept.length || 0,
      mappings: (r.decision?.accept || []).flatMap(
        (index: number, i: number) =>
          visible.has(r.record_ids[i])
            ? [
                {
                  entryId: r.entries[index].id,
                  recordId: r.record_ids[i],
                  workspaceId: r.workspace_id,
                },
              ]
            : [],
      ),
    });
  }
  const content = {
    schemaVersion: datasetVersion,
    id: d.id,
    name: d.name,
    version: d.version,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    entries: d.entries,
    crm: current,
    links: links.map((l) => ({
      entryId: l.entry_id,
      recordId: l.record_id,
      workspaceId: l.workspace_id,
      status: available.has(l.record_id) ? "available" : "unavailable",
    })),
    submissions: mapped,
  };
  const revision = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  return known === revision
    ? { unchanged: true, revision }
    : { ...content, revision };
}
export async function datasetRead(user: string, id: string, training = false) {
  return transaction(async (db) => {
    const d = await owned(db, user, id);
    return training ? trainingRows(d) : read(db, d);
  });
}
export async function datasetChoices(user: string, workspace: string) {
  uuid.parse(workspace);
  return transaction(async (db) => {
    await membership(workspace, user, false, false, db);
    const ids = await accessIds(db, user, workspace);
    return (
      await db.query(
        "SELECT id,kind,data->>'name' AS name FROM records WHERE workspace_id=$1 AND kind IN ('people','organizations','projects') AND archived_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY data->>'name',id LIMIT 100",
        [workspace, ids],
      )
    ).rows;
  });
}
export async function datasetImport(user: string, raw: unknown) {
  const a = z
    .strictObject({
      id: uuid,
      version: z.number().int().positive(),
      workspaceId: uuid,
      recordIds: z.array(uuid).min(1).max(20),
    })
    .parse(raw);
  return transaction(async (db) => {
    const d = await owned(db, user, a.id);
    const rows = await crmRows(
      db,
      user,
      a.recordIds.map((id) => ({ record_id: id, workspace_id: a.workspaceId })),
    );
    if (
      rows.length !== new Set(a.recordIds).size ||
      rows.some((r) => r.archived_at)
    )
      throw new HttpError(403, "Select active records you can access.");
    const prior = (
      await db.query("SELECT * FROM dataset_record_links WHERE draft_id=$1", [
        d.id,
      ])
    ).rows;
    const mapping = new Map<string, string>(
      prior.map((r) => [r.record_id, r.entry_id]),
    );
    for (const r of rows)
      if (!mapping.has(r.id)) mapping.set(r.id, randomUUID());
    const entries = [...d.entries];
    for (const r of rows) {
      if (prior.some((l) => l.record_id === r.id)) continue; // Never overwrite research with an older snapshot.
      const entry = draftEntrySchema.parse({
        id: mapping.get(r.id),
        kind: r.kind,
        name: r.data.name,
        category: r.data.category || "",
        source: r.data.source || "",
        title: r.data.title || "",
        website: r.data.website || "",
        email: r.data.email || "",
        description: (r.data.description || "").slice(0, 500),
        organizationId:
          r.kind === "people" ? mapping.get(r.data.organizationId) || "" : "",
        research: {
          verification: "unverified",
          training: "pending",
          sources: [],
        },
      });
      if (r.kind === "people" && r.data.organizationId && !entry.organizationId)
        throw new HttpError(
          400,
          "Select the linked organization too, to preserve the relationship.",
        );
      entries.push(entry);
    }
    const saved = await saveDraftInTransaction(db, user, {
      id: d.id,
      version: a.version,
      name: d.name,
      entries,
    });
    for (const r of rows)
      await db.query(
        "INSERT INTO dataset_record_links(draft_id,entry_id,record_id,workspace_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [d.id, mapping.get(r.id), r.id, a.workspaceId],
      );
    return saved;
  });
}
async function submit(db: PoolClient, d: any, raw: unknown) {
  const a = z
    .strictObject({
      operationId: uuid,
      version: z.number().int().positive(),
      entryIds: z.array(uuid).min(1).max(20),
      workspaceId: uuid,
      projectId: uuid,
      ownerId: uuid,
    })
    .parse(raw);
  const digest = createHash("sha256").update(JSON.stringify(a)).digest("hex");
  const prior = (
    await db.query(
      "SELECT * FROM dataset_submissions WHERE draft_id=$1 AND operation_id=$2",
      [d.id, a.operationId],
    )
  ).rows[0];
  if (prior) {
    if (prior.payload_hash !== digest)
      throw new HttpError(
        409,
        "Operation ID already used with different content.",
      );
    return { reviewId: prior.review_id };
  }
  if (d.version !== a.version)
    throw new HttpError(409, "Dataset changed. Read it again before sharing.");
  if (new Set(a.entryIds).size !== a.entryIds.length)
    throw new HttpError(400, "Select distinct entries.");
  const entries = d.entries.filter((e: any) => a.entryIds.includes(e.id));
  if (entries.length !== a.entryIds.length)
    throw new HttpError(400, "Selected entries are unavailable.");
  const snapshot = randomUUID();
  await saveDraftInTransaction(db, d.user_id, {
    id: snapshot,
    name: d.name,
    version: 0,
    entries,
  });
  const result = await shareDraftInTransaction(db, d.user_id, {
    id: snapshot,
    version: 1,
    workspaceId: a.workspaceId,
    projectId: a.projectId,
    ownerId: a.ownerId,
  });
  await db.query(
    "INSERT INTO dataset_submissions(draft_id,operation_id,payload_hash,snapshot_id,review_id) VALUES($1,$2,$3,$4,$5)",
    [d.id, a.operationId, digest, snapshot, result.reviewId],
  );
  return result;
}
export async function datasetShare(user: string, raw: any) {
  const { id, ...input } = z.object({ id: uuid }).passthrough().parse(raw);
  return transaction(async (db) =>
    submit(db, await owned(db, user, id), input),
  );
}
export async function datasetAgent(bearer: string, name: string, raw: unknown) {
  return transaction(async (db) => {
    const d = await credential(db, bearer);
    if (
      name.startsWith("projects.") ||
      name.startsWith("project.") ||
      name.startsWith("tasks.")
    )
      return projectAgent(db, d, name, raw);
    if (name === "dataset.read") {
      const a = z
        .strictObject({
          revision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(raw);
      return read(db, d, a.revision);
    }
    if (name === "dataset.append") {
      const a = z
        .strictObject({
          version: z.number().int().positive(),
          entries: z.array(draftEntrySchema).min(1).max(20),
        })
        .parse(raw);
      if (new Set(a.entries.map((e) => e.id)).size !== a.entries.length)
        throw new HttpError(400, "Distinct entry IDs required.");
      const existing = new Map(
        d.entries.map((e: any) => [e.id, draftEntrySchema.parse(e)]),
      );
      const added = a.entries.filter((e) => !existing.has(e.id));
      for (const e of a.entries) {
        if (
          existing.has(e.id) &&
          JSON.stringify(existing.get(e.id)) !== JSON.stringify(e)
        )
          throw new HttpError(
            409,
            "Entry already exists with different content; review conflict.",
          );
        if (e.research?.training === "eligible" && !existing.has(e.id))
          throw new HttpError(
            400,
            "Training eligibility requires human review.",
          );
      }
      // Exact retries are harmless, including after other additions. Never replace existing research.
      if (!added.length) return { id: d.id, version: d.version, added: 0 };
      if (a.version !== d.version)
        throw new HttpError(
          409,
          "Dataset changed; read the current version and reconcile.",
        );
      const names = new Set(
        d.entries.map(
          (e: any) =>
            e.kind + ":" + e.name.normalize("NFKC").trim().toLowerCase(),
        ),
      );
      for (const e of added) {
        const key =
          e.kind + ":" + e.name.normalize("NFKC").trim().toLowerCase();
        if (names.has(key))
          throw new HttpError(
            409,
            "Possible duplicate name; review before adding.",
          );
        names.add(key);
      }
      const result = await saveDraftInTransaction(db, d.user_id, {
        id: d.id,
        version: d.version,
        name: d.name,
        entries: [...d.entries, ...added],
      });
      const crm = await autoAddLeads(db, d, added);
      return { ...result, added: added.length, crm };
    }
    if (name === "dataset.save") {
      const a = z
        .strictObject({
          version: z.number().int().positive(),
          name: z.string().trim().min(1).max(200),
          entries: z.array(draftEntrySchema).max(600),
        })
        .parse(raw);
      for (const e of a.entries) {
        const prior = d.entries.find((p: any) => p.id === e.id);
        // Training permission is a human decision, not a label an agent may grant itself.
        if (
          e.research?.training === "eligible" &&
          (prior?.research?.training !== "eligible" ||
            JSON.stringify(draftEntrySchema.parse(prior)) !== JSON.stringify(e))
        )
          throw new HttpError(
            400,
            "Changed research needs human training eligibility review. Set training to pending.",
          );
      }
      return saveDraftInTransaction(db, d.user_id, { ...a, id: d.id });
    }
    if (name === "dataset.schema") {
      z.strictObject({}).parse(raw);
      return {
        schemaVersion: datasetVersion,
        entry: z.toJSONSchema(draftEntrySchema),
        maxEntries: 600,
        maxAppendEntries: 20,
        instructions:
          "Read before saving. Preserve stable entry IDs; organizationId references another entry. Save with the current version. Automatic CRM additions require explicit project permission; otherwise human approval is required to share or publish. CRM records are read-only source snapshots; do not silently overwrite conflicts. Training eligibility requires human review.",
      };
    }
    throw new HttpError(400, "Unknown dataset tool.");
  });
}

const syncFields = [
  "name",
  "category",
  "title",
  "website",
  "email",
  "description",
] as const;
async function updateProposals(db: PoolClient, d: any) {
  const links = (
    await db.query("SELECT * FROM dataset_record_links WHERE draft_id=$1", [
      d.id,
    ])
  ).rows;
  const proposals = [];
  for (const link of links) {
    const entry = d.entries.find((e: any) => e.id === link.entry_id);
    if (!entry) continue;
    const role = (
      await db.query(
        "SELECT role FROM members WHERE user_id=$1 AND workspace_id=$2",
        [d.user_id, link.workspace_id],
      )
    ).rows[0]?.role;
    if (role !== "owner") continue;
    await membership(link.workspace_id, d.user_id, true, true, db);
    const record = (
      await db.query(
        "SELECT id,kind,data,version FROM records WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL AND kind IN ('people','organizations','projects')",
        [link.record_id, link.workspace_id],
      )
    ).rows[0];
    if (!record || entry.kind !== record.kind) continue;
    const proposed = Object.fromEntries(
      (record.kind === "projects"
        ? ["name", "category", "source", "description"]
        : syncFields
      ).map((f) => [f, entry[f] || ""]),
    );
    if (record.kind === "people") {
      const org = links.find(
        (l) =>
          l.entry_id === entry.organizationId &&
          l.workspace_id === link.workspace_id,
      );
      if (entry.organizationId && !org) continue;
      proposed.organizationId = org?.record_id || "";
    }
    const changes = Object.keys(proposed)
      .filter((f) => (record.data[f] || "") !== proposed[f])
      .map((field) => ({
        field,
        before: record.data[field] || "",
        after: proposed[field],
      }));
    if (!changes.length) continue;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          dataset: d.id,
          version: d.version,
          entryId: entry.id,
          record,
          proposed,
        }),
      )
      .digest("hex");
    proposals.push({
      entryId: entry.id,
      name: entry.name,
      workspaceId: link.workspace_id,
      recordId: record.id,
      version: record.version,
      kind: record.kind,
      changes,
      digest,
      data: { ...record.data, ...proposed },
    });
  }
  return proposals;
}
export async function datasetUpdates(user: string, id: string) {
  return transaction(async (db) =>
    (await updateProposals(db, await owned(db, user, id))).map(
      ({ data: _data, ...p }) => p,
    ),
  );
}
export async function datasetApply(user: string, raw: unknown) {
  const a = z
    .strictObject({
      id: uuid,
      entryId: uuid,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(raw);
  return transaction(async (db) => {
    const d = await owned(db, user, a.id);
    const p = (await updateProposals(db, d)).find(
      (p) => p.entryId === a.entryId,
    );
    if (!p || p.digest !== a.digest)
      throw new HttpError(
        409,
        "Research, CRM data or access changed. Reload the proposed updates and review again.",
      );
    const saved = await saveRecordInTransaction(db, user, p.workspaceId, {
      id: p.recordId,
      kind: p.kind,
      version: p.version,
      data: p.data,
    });
    return { recordId: saved.id, version: saved.version };
  });
}

const projectSelection = z.strictObject({
  id: uuid,
  workspaceId: uuid,
  entryIds: z
    .array(uuid)
    .min(1)
    .max(20)
    .refine((a) => new Set(a).size === a.length),
});
async function projectPreview(
  db: PoolClient,
  user: string,
  a: z.infer<typeof projectSelection>,
) {
  const d = await owned(db, user, a.id);
  if (d.shared_search_id) throw new HttpError(409, "Use an editable dataset.");
  await membership(a.workspaceId, user, true, true, db);
  // Same lock as record creation: duplicate detection and approval are atomic.
  await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
    a.workspaceId,
  ]);
  const entries = d.entries.filter((e: any) => a.entryIds.includes(e.id));
  if (
    entries.length !== a.entryIds.length ||
    entries.some((e: any) => e.kind !== "projects")
  )
    throw new HttpError(400, "Select project entries only.");
  const links = (
    await db.query("SELECT * FROM dataset_record_links WHERE draft_id=$1", [
      d.id,
    ])
  ).rows;
  const rows = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim().toLowerCase();
    const existing = (
      await db.query(
        "SELECT id FROM records WHERE workspace_id=$1 AND kind='projects' AND lower(trim(data->>'name'))=$2",
        [a.workspaceId, name],
      )
    ).rows;
    const linked = links.some((l) => l.entry_id === entry.id);
    const blocked = linked
      ? "Already linked: use Review proposed CRM updates."
      : existing.length
        ? "A project with this name already exists, including archived records. Link the existing record instead."
        : names.has(name)
          ? "Duplicate project name in this selection."
          : "";
    names.add(name);
    rows.push({
      entryId: entry.id,
      name: entry.name,
      blocked,
      data: recordSchema.parse({
        name: entry.name,
        category: entry.category,
        source: entry.source,
        description: entry.description,
        ownerId: user,
      }),
    });
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ user, ...a, version: d.version, rows }))
    .digest("hex");
  return { digest, version: d.version, workspaceId: a.workspaceId, rows };
}
export async function datasetProjectPreview(user: string, raw: unknown) {
  const a = projectSelection.parse(raw);
  return transaction((db) => projectPreview(db, user, a));
}
export async function datasetProjectApprove(user: string, raw: unknown) {
  const { digest, ...a } = projectSelection
    .extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(raw);
  return transaction(async (db) => {
    const preview = await projectPreview(db, user, a);
    if (preview.digest !== digest || preview.rows.some((r) => r.blocked))
      throw new HttpError(
        409,
        "Dataset, access or matching projects changed. Review a fresh preview before approving.",
      );
    const records = [];
    for (const row of preview.rows) {
      const saved = await saveRecordInTransaction(db, user, a.workspaceId, {
        kind: "projects",
        data: row.data,
        visibilityIds: [],
      });
      await db.query(
        "INSERT INTO dataset_record_links(draft_id,entry_id,record_id,workspace_id) VALUES($1,$2,$3,$4)",
        [a.id, row.entryId, saved.id, a.workspaceId],
      );
      records.push({ entryId: row.entryId, recordId: saved.id });
    }
    return { records };
  });
}
