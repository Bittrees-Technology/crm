import { z } from "zod";
import { transaction } from "./db";
import { membership, saveRecordInTransaction } from "./service";
import { checkRecordAccess } from "./access";
import { HttpError, recordSchema } from "./model";
import { supplierSelection, supplierSignature } from "./supplier-research";
export async function supplierInventory(user: string, workspace: string) {
  return transaction(async (db) => {
    await membership(workspace, user, false, true, db);
    const rows = (
      await db.query(
        "SELECT id,kind,data,version FROM records WHERE workspace_id=$1 AND archived_at IS NULL AND (kind='organizations' OR (kind='tasks' AND data->>'ownerId'=$2 AND data->>'status'='Open' AND NOT data ? 'supplierPreparation')) ORDER BY updated_at DESC LIMIT 501",
        [workspace, user],
      )
    ).rows;
    const personIds = rows
      .filter(
        (r) => r.kind === "tasks" && !r.data.organizationId && r.data.personId,
      )
      .map((r) => r.data.personId);
    const people = personIds.length
      ? (
          await db.query(
            "SELECT id,data FROM records WHERE workspace_id=$1 AND kind='people' AND archived_at IS NULL AND id=ANY($2::uuid[])",
            [workspace, personIds],
          )
        ).rows
      : [];
    return {
      records: rows.slice(0, 500).map((r) => ({
        ...r,
        supplierOrganizationId:
          r.data.organizationId ||
          people.find((p) => p.id === r.data.personId)?.data.organizationId ||
          "",
      })),
      truncated: rows.length > 500,
    };
  });
}
export async function prepareSupplier(
  user: string,
  workspace: string,
  raw: unknown,
) {
  const a = z
    .strictObject({
      selection: supplierSelection,
      reviewToken: z.string().optional(),
      confirmed: z.literal(true).optional(),
    })
    .parse(raw);
  return transaction(async (db) => {
    await membership(workspace, user, true, true, db);
    const s = {
      ...a.selection,
      parents: [...a.selection.parents].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    };
    const ids = [s.projectId, s.organizationId, ...s.parents.map((p) => p.id)];
    for (const id of ids) await checkRecordAccess(db, user, workspace, id);
    const rows = (
      await db.query(
        "SELECT * FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
        [workspace, ids],
      )
    ).rows;
    const project = rows.find((r) => r.id === s.projectId),
      org = rows.find((r) => r.id === s.organizationId);
    if (
      !project ||
      project.kind !== "projects" ||
      project.archived_at ||
      !org ||
      org.kind !== "organizations" ||
      org.archived_at ||
      org.version !== s.organizationVersion
    )
      throw new HttpError(
        409,
        "Project or supplier changed. Refresh the preview.",
      );
    let supplierHost = "";
    try {
      supplierHost = new URL(org.data.website).hostname.replace(/^www\./, "");
    } catch {}
    if (
      !supplierHost ||
      new URL(s.urls[0]).hostname.replace(/^www\./, "") !== supplierHost
    )
      throw new HttpError(
        400,
        "Approved URLs must match the supplier website. Update and verify its organization website first.",
      );
    const personIds = rows
      .filter(
        (r) => r.kind === "tasks" && !r.data.organizationId && r.data.personId,
      )
      .map((r) => r.data.personId);
    for (const id of personIds)
      await checkRecordAccess(db, user, workspace, id);
    const people = personIds.length
      ? (
          await db.query(
            "SELECT id,data,version FROM records WHERE workspace_id=$1 AND kind='people' AND archived_at IS NULL AND id=ANY($2::uuid[]) FOR UPDATE",
            [workspace, personIds],
          )
        ).rows
      : [];
    const contacts = people
      .map((p) => ({
        id: p.id,
        version: p.version,
        organizationId: p.data.organizationId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const parents = s.parents.map((p) => {
      const r = rows.find((r) => r.id === p.id);
      if (
        !r ||
        r.kind !== "tasks" ||
        r.archived_at ||
        r.version !== p.version ||
        r.data.ownerId !== user ||
        (r.data.organizationId ||
          people.find((p) => p.id === r.data.personId)?.data.organizationId) !==
          org.id ||
        r.data.status !== "Open" ||
        r.data.supplierPreparation
      )
        throw new HttpError(
          409,
          "Select current open supplier confirmations assigned to you.",
        );
      return r;
    });
    const payload = {
      version: 1,
      workspaceId: workspace,
      ownerId: user,
      contacts,
      ...s,
    };
    const signature = supplierSignature(payload);
    const description = (
      "Research public supplier evidence only. Do not contact anyone or confirm stock, dealer terms, shipping or export eligibility. Original confirmations stay open. Record exact source quotes, retrieval dates and remaining questions.\n\n" +
      parents
        .map((r) => `${r.data.name}\n${r.data.description || ""}`)
        .join("\n\n")
    ).slice(0, 4000);
    const preview = {
      supplier: org.data.name,
      project: project.data.name,
      parents: parents.map((r) => ({
        id: r.id,
        name: r.data.name,
        version: r.version,
      })),
      urls: s.urls,
      description,
      reviewToken: signature,
    };
    if (!a.confirmed) return { preview };
    if (a.reviewToken !== signature)
      throw new HttpError(
        409,
        "Preview changed. Review the exact scope before creating a task.",
      );
    // Stable identity prevents retries or repeated previews from creating another child.
    const key = supplierSignature({
      user,
      workspace,
      projectId: s.projectId,
      organizationId: s.organizationId,
      parents: s.parents.map((p) => p.id),
    });
    const existing = (
      await db.query(
        "SELECT id,data,version FROM records WHERE workspace_id=$1 AND data->'supplierPreparation'->>'key'=$2 AND archived_at IS NULL",
        [workspace, key],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.data.supplierPreparation?.signature !==
        supplierSignature({ ...payload, key })
      )
        throw new HttpError(
          409,
          "An existing supplier review has different approved inputs. Review it before preparing another.",
        );
      return { id: existing.id, version: existing.version, existing: true };
    }
    const child = await saveRecordInTransaction(db, user, workspace, {
      kind: "tasks",
      data: recordSchema.parse({
        name: `Research supplier evidence — ${org.data.name}`,
        category: "AI review",
        description,
        projectId: s.projectId,
        organizationId: s.organizationId,
        ownerId: user,
        status: "Open",
      }),
      visibilityIds: [user],
    });
    const preparation = { ...payload, key };
    await db.query(
      "UPDATE records SET data=data||$1::jsonb WHERE id=$2 AND workspace_id=$3",
      [
        {
          supplierResearch: { version: 1, urls: s.urls },
          supplierPreparation: {
            ...preparation,
            signature: supplierSignature(preparation),
          },
          sourceTaskIds: s.parents.map((p) => p.id),
        },
        child.id,
        workspace,
      ],
    );
    return { id: child.id, version: child.version, existing: false };
  });
}
