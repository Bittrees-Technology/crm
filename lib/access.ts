import { z } from "zod";
import type { PoolClient } from "pg";
import { HttpError, type RecordData } from "./model";
export type Db = Pick<PoolClient, "query">;
export const scopeSchema = z.array(z.uuid()).max(100).nullable();
export const referenceFields = [
  "organizationId",
  "personId",
  "projectId",
  "opportunityId",
] as const;
export async function accessIds(
  db: Db,
  user: string,
  workspace: string,
): Promise<string[] | null> {
  const member = (
    await db.query(
      "SELECT role,scope_ids FROM members WHERE user_id=$1 AND workspace_id=$2",
      [user, workspace],
    )
  ).rows[0];
  if (!member) throw new HttpError(404, "Workspace not found.");
  if (member.role === "owner" || member.scope_ids === null) return null;
  return (
    await db.query(
      `WITH RECURSIVE visible AS (
    SELECT id FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[])
    UNION SELECT r.id FROM records r JOIN visible v ON v.id::text IN(r.data->>'organizationId',r.data->>'personId',r.data->>'projectId',r.data->>'opportunityId') WHERE r.workspace_id=$1
  ) SELECT id FROM visible`,
      [workspace, member.scope_ids],
    )
  ).rows.map((r) => r.id);
}
export async function validateScope(
  db: Db,
  workspace: string,
  ids: string[] | null,
) {
  if (ids === null) return;
  const unique = [...new Set(ids)];
  const count = (
    await db.query(
      "SELECT id FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind IN ('projects','organizations','opportunities')",
      [workspace, unique],
    )
  ).rowCount;
  if (!unique.length || count !== unique.length)
    throw new HttpError(
      400,
      "Select at least one project, organization, or opportunity in this workspace.",
    );
}
export async function checkRecordAccess(
  db: Db,
  user: string,
  workspace: string,
  id?: string,
  data?: RecordData,
) {
  const ids = await accessIds(db, user, workspace);
  if (ids === null) return;
  if (id && !ids.includes(id)) throw new HttpError(404, "Record not found.");
  if (data) {
    const existing = id
      ? (
          await db.query(
            "SELECT data FROM records WHERE id=$1 AND workspace_id=$2",
            [id, workspace],
          )
        ).rows[0]?.data
      : undefined;
    for (const field of referenceFields) {
      if (existing?.[field] && !ids.includes(existing[field]) && !data[field])
        data[field] = existing[field];
      if (
        data[field] &&
        !ids.includes(data[field]) &&
        data[field] !== existing?.[field]
      )
        throw new HttpError(
          403,
          "A linked record is outside your collaboration access.",
        );
    }
    const roots: string[] = (
      await db.query(
        "SELECT scope_ids FROM members WHERE user_id=$1 AND workspace_id=$2",
        [user, workspace],
      )
    ).rows[0].scope_ids;
    // Test the proposed graph, excluding the record itself and its descendants: cycles must not preserve revoked access.
    const reachable = (
      await db.query(
        `WITH RECURSIVE visible AS (
      SELECT id FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND id::text<>$3
      UNION SELECT r.id FROM records r JOIN visible v ON v.id::text IN(r.data->>'organizationId',r.data->>'personId',r.data->>'projectId',r.data->>'opportunityId') WHERE r.workspace_id=$1 AND r.id::text<>$3
    ) SELECT id FROM visible`,
        [workspace, roots, id || ""],
      )
    ).rows.map((r) => r.id);
    if (
      !(id && roots.includes(id)) &&
      !referenceFields.some((field) => reachable.includes(data[field]))
    )
      throw new HttpError(
        403,
        "Keep this record linked to a project, organization, or opportunity you can access.",
      );
  }
}
export function redactRecord<T extends { data: RecordData }>(
  record: T,
  ids: string[] | null,
): T {
  if (ids === null) return record;
  return {
    ...record,
    data: {
      ...record.data,
      ...Object.fromEntries(
        referenceFields
          .filter((k) => record.data[k] && !ids.includes(record.data[k]))
          .map((k) => [k, ""]),
      ),
    },
  };
}
