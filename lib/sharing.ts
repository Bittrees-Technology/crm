import { z } from "zod";
import { transaction } from "./db";
import { membership } from "./service";
import { HttpError } from "./model";
import { resolveAccess } from "./access-graph";

export async function privateNote(
  userId: string,
  workspace: string,
  recordId: string,
) {
  z.uuid().parse(recordId);
  return transaction(async (db) => {
    await membership(workspace, userId, false, true, db);
    const record = await db.query(
      "SELECT id FROM records WHERE id=$1 AND workspace_id=$2",
      [recordId, workspace],
    );
    if (!record.rowCount) throw new HttpError(404, "Record not found.");
    return (
      (
        await db.query(
          "SELECT content,version FROM record_private_notes WHERE record_id=$1 AND author_id=$2",
          [recordId, userId],
        )
      ).rows[0] || { content: "", version: 0 }
    );
  });
}
export async function inspectAccess(userId: string, workspace: string) {
  return transaction(async (db) => {
    await membership(workspace, userId, false, true, db);
    const records = (
      await db.query(
        "SELECT id,kind,data,visibility_ids FROM records WHERE workspace_id=$1 ORDER BY lower(data->>'name'),id",
        [workspace],
      )
    ).rows;
    const members = (
      await db.query(
        "SELECT m.user_id,u.name,m.role,m.scope_ids FROM members m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY u.name,m.user_id",
        [workspace],
      )
    ).rows;
    return {
      records: records.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.data.name,
      })),
      members: members.map((m) => ({
        id: m.user_id,
        name: m.name,
        role: m.role,
        records: Array.from(resolveAccess(records, m), ([id, reasons]) => ({
          id,
          reasons,
        })),
      })),
    };
  });
}
