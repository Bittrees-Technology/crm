import { createHash } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { lockActiveAccount } from "./service";
import { HttpError } from "./model";
const operation = z.object({
  action: z.enum(["delete", "merge"]),
  targetId: z.uuid().optional(),
  review: z.string().optional(),
  confirmName: z.string().optional(),
});
export async function workspaceOperation(
  user: string,
  sourceId: string,
  input: unknown,
  execute = false,
) {
  const body = operation.parse(input);
  if (body.action === "merge" && (!body.targetId || body.targetId === sourceId))
    throw new HttpError(400, "Choose a different destination workspace.");
  return transaction(async (db) => {
    await db.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [
      user,
    ]);
    await lockActiveAccount(db, user);
    const ids = [
      sourceId,
      ...(body.action === "merge" ? [body.targetId!] : []),
    ].sort();
    const rows = (
      await db.query(
        "SELECT w.*,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id AND m.user_id=$1 WHERE w.id=ANY($2::uuid[]) ORDER BY w.id FOR UPDATE OF w",
        [user, ids],
      )
    ).rows;
    if (rows.length !== ids.length || rows.some((w) => w.role !== "owner"))
      throw new HttpError(403, "You must own each workspace involved.");
    const details = [];
    for (const id of ids) {
      const w = rows.find((w) => w.id === id)!;
      const records = (
        await db.query(
          "SELECT id,version FROM records WHERE workspace_id=$1 ORDER BY id",
          [id],
        )
      ).rows;
      const members = (
        await db.query(
          "SELECT m.user_id,u.name,m.role,m.scope_ids FROM members m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY user_id",
          [id],
        )
      ).rows;
      const invites = (
        await db.query(
          "SELECT id,accepted_at,revoked_at,scope_ids FROM invites WHERE workspace_id=$1 ORDER BY id",
          [id],
        )
      ).rows;
      details.push({ id, name: w.name, records, members, invites });
    }
    const review = createHash("sha256")
      .update(JSON.stringify({ action: body.action, sourceId, details }))
      .digest("hex");
    const source = details.find((w) => w.id === sourceId)!;
    const target = details.find((w) => w.id === body.targetId);
    const summary = (w: typeof source) => ({
      id: w.id,
      name: w.name,
      records: w.records.length,
      members: w.members.map((m) => ({
        name: m.name,
        role: m.role,
        limited: m.scope_ids !== null,
      })),
      invitations: w.invites.filter((i) => !i.accepted_at && !i.revoked_at)
        .length,
    });
    if (!execute)
      return {
        review,
        source: summary(source),
        target: target ? summary(target) : null,
      };
    if (body.review !== review || body.confirmName !== source.name)
      throw new HttpError(
        409,
        "The workspace changed or its name did not match. Review it again before confirming.",
      );
    if (body.action === "delete") {
      const others = (
        await db.query(
          "SELECT workspace_id FROM members WHERE user_id=$1 AND workspace_id<>$2",
          [user, sourceId],
        )
      ).rowCount;
      if (!others)
        throw new HttpError(
          400,
          "Create another workspace before deleting your last workspace.",
        );
      await db.query("DELETE FROM audit WHERE workspace_id=$1", [sourceId]);
      await db.query("DELETE FROM records WHERE workspace_id=$1", [sourceId]);
    } else {
      await db.query(
        `INSERT INTO members(workspace_id,user_id,role,scope_ids) SELECT $1,user_id,role,scope_ids FROM members WHERE workspace_id=$2
        ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=CASE WHEN members.role='owner' OR EXCLUDED.role='owner' THEN 'owner' WHEN members.role='editor' OR EXCLUDED.role='editor' THEN 'editor' ELSE 'viewer' END,
        scope_ids=CASE WHEN members.scope_ids IS NULL OR EXCLUDED.scope_ids IS NULL THEN NULL ELSE ARRAY(SELECT DISTINCT unnest(members.scope_ids || EXCLUDED.scope_ids)) END`,
        [body.targetId, sourceId],
      );
      await db.query(
        "UPDATE records SET workspace_id=$1,version=version+1,updated_at=now() WHERE workspace_id=$2",
        [body.targetId, sourceId],
      );
      await db.query("UPDATE audit SET workspace_id=$1 WHERE workspace_id=$2", [
        body.targetId,
        sourceId,
      ]);
      await db.query(
        "INSERT INTO audit(workspace_id,actor_id,action,detail) VALUES($1,$2,'Workspaces merged',$3)",
        [
          body.targetId,
          user,
          JSON.stringify({ name: source.name, records: source.records.length }),
        ],
      );
    }
    // Old invitation links never grant access to a merged destination.
    await db.query("DELETE FROM invites WHERE workspace_id=$1", [sourceId]);
    await db.query("DELETE FROM members WHERE workspace_id=$1", [sourceId]);
    await db.query("DELETE FROM workspaces WHERE id=$1", [sourceId]);
    // A queued email might still contain deleted or re-scoped records. Cancel it rather than reusing stale text.
    await db.query(
      "UPDATE digest_receipts SET status='cancelled' WHERE status IN ('pending','failed') AND record_ids && $1::uuid[]",
      [source.records.map((r) => r.id)],
    );
    return { ok: true, workspaceId: body.targetId || null };
  });
}
