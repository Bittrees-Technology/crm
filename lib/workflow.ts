import { z } from "zod";
import { contactAvailabilityValues } from "./contact-availability";
import { transaction } from "./db";
import { membership } from "./service";
import { checkRecordAccess, accessIds, redactRecord } from "./access";
import { HttpError } from "./model";
export const viewSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  page: z.enum([
    "people",
    "organizations",
    "opportunities",
    "projects",
    "tasks",
    "notes",
    "today",
    "reports",
    "settings",
  ]),
  search: z.string().max(500),
  filter: z.enum([
    "all",
    "mine",
    "due",
    "archived",
    "promising",
    "verified",
    "research",
  ]),
  board: z.boolean(),
  contactAvailability: z.enum(contactAvailabilityValues).optional(),
  standingTier: z.enum(["all", "A", "B", "C", "P", "U", "none"]).optional(),
  standingSort: z
    .enum(["default", "standing", "confidence", "queue", "name"])
    .optional(),
});
export async function views(user: string, workspace: string, raw?: unknown) {
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + workspace,
    ]);
    await membership(workspace, user, false, false, db);
    if (raw !== undefined) {
      const v = viewSchema.parse(raw);
      const count = (
        await db.query(
          "SELECT count(*)::int AS n FROM saved_views WHERE user_id=$1 AND workspace_id=$2 AND name<>$3",
          [user, workspace, v.name],
        )
      ).rows[0].n;
      if (count >= 20)
        throw new HttpError(
          400,
          "You can save up to 20 views. Replace or delete an existing view.",
        );
      await db.query(
        "INSERT INTO saved_views(user_id,workspace_id,name,data) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,workspace_id,name) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",
        [user, workspace, v.name, v],
      );
    }
    return (
      await db.query(
        "SELECT data FROM saved_views WHERE user_id=$1 AND workspace_id=$2 ORDER BY updated_at,name",
        [user, workspace],
      )
    ).rows.map((r) => r.data);
  });
}
export async function deleteView(
  user: string,
  workspace: string,
  name: string,
) {
  return transaction(async (db) => {
    await membership(workspace, user, false, false, db);
    await db.query(
      "DELETE FROM saved_views WHERE user_id=$1 AND workspace_id=$2 AND name=$3",
      [user, workspace, z.string().max(80).parse(name)],
    );
    return { ok: true };
  });
}
export async function archive(user: string, workspace: string, raw: unknown) {
  const input = z
    .strictObject({
      id: z.uuid(),
      version: z.number().int().positive(),
      archived: z.boolean(),
    })
    .parse(raw);
  return transaction(async (db) => {
    const role = await membership(workspace, user, true, false, db);
    await checkRecordAccess(db, user, workspace, input.id);
    const old = (
      await db.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2", [
        input.id,
        workspace,
      ])
    ).rows[0];
    if (!old) throw new HttpError(404, "Record unavailable.");
    if (old.version !== input.version)
      throw new HttpError(
        409,
        "This record changed. Refresh before continuing.",
      );
    if (!!old.archived_at === input.archived)
      return redactRecord(old, await accessIds(db, user, workspace));
    const row = (
      await db.query(
        "UPDATE records SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *",
        [input.id, workspace, input.archived],
      )
    ).rows[0];
    const activity = (
      await db.query(
        "INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) VALUES($1,$2,$3,$4,$5) RETURNING id,action,record_id,detail,created_at,(SELECT name FROM users WHERE id=$2) AS actor",
        [
          workspace,
          user,
          input.archived ? "Record archived" : "Record restored",
          input.id,
          JSON.stringify({ kind: row.kind, name: row.data.name }),
        ],
      )
    ).rows[0];
    return {
      ...redactRecord(row, await accessIds(db, user, workspace)),
      ...(role === "owner" ? { activity } : {}),
    };
  });
}
