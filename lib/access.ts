import { z } from "zod";
import type { PoolClient } from "pg";
import { HttpError, type RecordData } from "./model";
import {
  referenceFields,
  resolveAccess,
  type AccessRecord,
} from "./access-graph";
export { referenceFields } from "./access-graph";
// Access resolution needs links and names, never descriptions or contact details.
export const accessProjection = `id,kind,visibility_ids,jsonb_build_object(
 'name',data->>'name','organizationId',data->>'organizationId',
 'personId',data->>'personId','projectId',data->>'projectId',
 'opportunityId',data->>'opportunityId') AS data`;
export type Db = Pick<PoolClient, "query">;
export const scopeSchema = z.array(z.uuid()).max(100).nullable();
export async function accessIds(
  db: Db,
  user: string,
  workspace: string,
): Promise<string[] | null> {
  const member = (
    await db.query(
      "SELECT user_id,role,scope_ids FROM members WHERE user_id=$1 AND workspace_id=$2",
      [user, workspace],
    )
  ).rows[0];
  if (!member) throw new HttpError(404, "Workspace not found.");
  if (member.role === "owner") return null;
  if (member.scope_ids === null) {
    // Whole-workspace members need only record IDs, with per-record sharing enforced in SQL.
    return (
      await db.query(
        "SELECT id FROM records WHERE workspace_id=$1 AND (visibility_ids IS NULL OR $2::uuid=ANY(visibility_ids))",
        [workspace, user],
      )
    ).rows.map((r) => r.id);
  }
  const records = (
    await db.query(
      `SELECT ${accessProjection} FROM records WHERE workspace_id=$1`,
      [workspace],
    )
  ).rows;
  return [...resolveAccess(records, member).keys()];
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
export async function validateVisibility(
  db: Db,
  workspace: string,
  ids: string[] | null,
) {
  if (ids === null) return;
  const unique = [...new Set(ids)];
  const count = (
    await db.query(
      "SELECT user_id FROM members WHERE workspace_id=$1 AND user_id=ANY($2::uuid[])",
      [workspace, unique],
    )
  ).rowCount;
  if (count !== unique.length)
    throw new HttpError(
      400,
      "Only current workspace members can be selected for record sharing.",
    );
}
export async function checkRecordAccess(
  db: Db,
  user: string,
  workspace: string,
  id?: string,
  data?: RecordData,
) {
  const member = (
    await db.query(
      "SELECT user_id,role,scope_ids FROM members WHERE user_id=$1 AND workspace_id=$2",
      [user, workspace],
    )
  ).rows[0];
  if (!member) throw new HttpError(404, "Workspace not found.");
  if (member.role === "owner") return;
  const records: AccessRecord[] = (
    await db.query(
      `SELECT ${accessProjection} FROM records WHERE workspace_id=$1`,
      [workspace],
    )
  ).rows;
  const visible = resolveAccess(records, member);
  if (id && !visible.has(id)) throw new HttpError(404, "Record not found.");
  if (!data) return;
  const existing = records.find((r) => r.id === id);
  for (const field of referenceFields) {
    if (
      existing?.data[field] &&
      !visible.has(existing.data[field]) &&
      !data[field]
    )
      data[field] = existing.data[field];
    if (
      data[field] &&
      !visible.has(data[field]) &&
      data[field] !== existing?.data[field]
    )
      throw new HttpError(
        403,
        "A linked record is outside your collaboration access.",
      );
  }
  const proposed: AccessRecord = {
    id: id || "new",
    kind: existing?.kind || "tasks",
    data,
    visibility_ids: existing?.visibility_ids ?? null,
  };
  if (
    !resolveAccess(
      [...records.filter((r) => r.id !== id), proposed],
      member,
    ).has(proposed.id)
  )
    throw new HttpError(
      403,
      "Keep this record linked to work you can access, or ask an owner to share this record with you.",
    );
}
export function redactRecord<
  T extends { data: RecordData; visibility_ids?: string[] | null },
>(record: T, ids: string[] | null): T {
  if (ids === null) return record;
  const { visibility_ids: _policy, ...publicRecord } = record;
  return {
    ...publicRecord,
    data: {
      ...record.data,
      ...Object.fromEntries(
        referenceFields
          .filter((k) => record.data[k] && !ids.includes(record.data[k]))
          .map((k) => [k, ""]),
      ),
    },
  } as T;
}
