import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { hash, token } from "./auth";
import { membership } from "./service";
import { checkRecordAccess, accessIds } from "./access";
import { HttpError, recordSchema } from "./model";
const digest = (v: string) =>
  createHash("sha256").update(v).digest("base64url");

export async function destinations(user: string, workspace: string) {
  return transaction(async (db) => {
    await membership(workspace, user, true, false, db);
    const ids = await accessIds(db, user, workspace);
    return (
      await db.query(
        "SELECT id,kind,data->>'name' name FROM records WHERE workspace_id=$1 AND kind IN ('people','organizations','projects','opportunities') AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY lower(data->>'name')",
        [workspace, ids],
      )
    ).rows;
  });
}
export async function authorize(user: string, input: unknown) {
  const d = z
    .object({
      workspaceId: z.uuid(),
      targetId: z.uuid(),
      challenge: z.string().regex(/^[\w-]{43}$/),
      state: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(input);
  return transaction(async (db) => {
    await membership(d.workspaceId, user, true, false, db);
    await checkRecordAccess(db, user, d.workspaceId, d.targetId);
    const target = (
      await db.query(
        "SELECT kind FROM records WHERE id=$1 AND workspace_id=$2 AND kind IN ('people','organizations','projects','opportunities')",
        [d.targetId, d.workspaceId],
      )
    ).rows[0];
    if (!target) throw new HttpError(400, "Choose a supported destination.");
    const raw = token();
    await db.query(
      "INSERT INTO autonote_grants(id,user_id,workspace_id,target_id,code_hash,challenge,code_expires,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds',now()+interval '30 days')",
      [randomUUID(), user, d.workspaceId, d.targetId, hash(raw), d.challenge],
    );
    const callback = new URL(
      "/api/integrations/crm/callback",
      process.env.AUTONOTE_URL || "https://autonote.bittrees.org",
    );
    callback.searchParams.set("code", raw);
    callback.searchParams.set("state", d.state);
    return { url: callback.href };
  });
}
export async function exchange(input: unknown) {
  const d = z
    .object({ code: z.string().length(64), verifier: z.string().length(64) })
    .parse(input);
  return transaction(async (db) => {
    const g = (
      await db.query(
        "SELECT * FROM autonote_grants WHERE code_hash=$1 FOR UPDATE",
        [hash(d.code)],
      )
    ).rows[0];
    if (
      !g ||
      g.revoked_at ||
      new Date(g.code_expires).getTime() < Date.now() ||
      digest(d.verifier) !== g.challenge
    )
      throw new HttpError(401, "Invalid or expired connection code.");
    await membership(g.workspace_id, g.user_id, true, false, db);
    await checkRecordAccess(db, g.user_id, g.workspace_id, g.target_id);
    const raw = token();
    await db.query(
      "UPDATE autonote_grants SET code_hash=NULL,token_hash=$2 WHERE id=$1",
      [g.id, hash(raw)],
    );
    const t = (
      await db.query("SELECT data->>'name' name FROM records WHERE id=$1", [
        g.target_id,
      ])
    ).rows[0];
    const w = (
      await db.query("SELECT name FROM workspaces WHERE id=$1", [
        g.workspace_id,
      ])
    ).rows[0];
    return {
      token: raw,
      grantId: g.id,
      workspaceName: w.name,
      targetName: t.name,
      expiresAt: g.expires_at,
    };
  });
}
async function grant(db: any, bearer: string) {
  const g = (
    await db.query(
      "SELECT * FROM autonote_grants WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
      [hash(bearer)],
    )
  ).rows[0];
  if (!g) throw new HttpError(401, "CRM connection expired or was revoked.");
  await membership(g.workspace_id, g.user_id, true, false, db);
  const locked = (
    await db.query("SELECT * FROM autonote_grants WHERE id=$1 FOR UPDATE", [
      g.id,
    ])
  ).rows[0];
  if (
    !locked ||
    locked.revoked_at ||
    new Date(locked.expires_at).getTime() <= Date.now()
  )
    throw new HttpError(401, "Connection expired or revoked.");
  await checkRecordAccess(db, g.user_id, g.workspace_id, g.target_id);
  return locked;
}
export async function publish(bearer: string, input: unknown) {
  const d = z
    .object({
      meetingId: z.uuid(),
      title: z.string().min(1).max(200),
      summary: z.string().max(4000),
      actions: z
        .array(
          z.object({
            id: z.string().min(1).max(100),
            text: z.string().min(1).max(4000),
            dueDate: z.union([z.iso.date(), z.null()]),
          }),
        )
        .max(30),
    })
    .strict()
    .parse(input);
  if (!d.summary.trim() && !d.actions.length)
    throw new HttpError(400, "Choose content to publish.");
  if (new Set(d.actions.map((a) => a.id)).size !== d.actions.length)
    throw new HttpError(400, "Action identifiers must be unique.");
  return transaction(async (db) => {
    const g = await grant(db, bearer);
    const target = (
      await db.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2", [
        g.target_id,
        g.workspace_id,
      ])
    ).rows[0];
    if (!target) throw new HttpError(404, "Destination no longer exists.");
    const field = (
      {
        people: "personId",
        organizations: "organizationId",
        projects: "projectId",
        opportunities: "opportunityId",
      } as Record<string, string>
    )[target.kind];
    if (!field) throw new HttpError(400, "Unsupported destination.");
    const source = new URL(
      "/?meeting=" + d.meetingId,
      process.env.AUTONOTE_URL || "https://autonote.bittrees.org",
    ).href;
    const items = [
      ...(d.summary
        ? [
            {
              id: "summary",
              kind: "notes",
              text: d.summary,
              name: d.title,
              dueDate: null,
            },
          ]
        : []),
      ...d.actions.map((a) => ({
        ...a,
        id: "action:" + a.id,
        kind: "tasks",
        name: a.text.slice(0, 200),
      })),
    ];
    const output = [];
    for (const item of items) {
      const receipt = (
        await db.query(
          "SELECT record_id FROM autonote_receipts WHERE user_id=$1 AND workspace_id=$2 AND target_id=$3 AND meeting_id=$4 AND item_id=$5",
          [g.user_id, g.workspace_id, g.target_id, d.meetingId, item.id],
        )
      ).rows[0];
      if (receipt) {
        await checkRecordAccess(
          db,
          g.user_id,
          g.workspace_id,
          receipt.record_id,
        );
        output.push({
          itemId: item.id,
          recordId: receipt.record_id,
          existing: true,
        });
        continue;
      }
      const recordId = randomUUID(),
        data = recordSchema.parse({
          name: item.name,
          description:
            item.text.slice(0, 4000 - source.length - 10) +
            "\n\nSource: " +
            source,
          [field]: g.target_id,
          dueDate: item.dueDate || "",
          status: "Open",
        });
      await checkRecordAccess(db, g.user_id, g.workspace_id, undefined, data);
      await db.query(
        "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,$3,$4,$5)",
        [recordId, g.workspace_id, item.kind, data, target.visibility_ids],
      );
      await db.query(
        "INSERT INTO autonote_receipts VALUES($1,$2,$3,$4,$5,$6)",
        [
          g.user_id,
          g.workspace_id,
          g.target_id,
          d.meetingId,
          item.id,
          recordId,
        ],
      );
      await db.query(
        "INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) VALUES($1,$2,'AutoNote content published',$3,$4)",
        [g.workspace_id, g.user_id, recordId, { sourceMeetingId: d.meetingId }],
      );
      output.push({ itemId: item.id, recordId, existing: false });
    }
    return { items: output };
  });
}
export async function revokeBearer(bearer: string) {
  await pool().query(
    "UPDATE autonote_grants SET revoked_at=now() WHERE token_hash=$1",
    [hash(bearer)],
  );
  return { ok: true };
}
export async function listGrants(user: string) {
  return (
    await pool().query(
      "SELECT g.id,w.name workspace_name,r.data->>'name' target_name,g.expires_at,g.revoked_at FROM autonote_grants g JOIN workspaces w ON w.id=g.workspace_id JOIN records r ON r.id=g.target_id WHERE g.user_id=$1 AND g.token_hash IS NOT NULL ORDER BY g.created_at DESC",
      [user],
    )
  ).rows;
}
export async function revokeUser(user: string, id: string) {
  await pool().query(
    "UPDATE autonote_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2",
    [z.uuid().parse(id), user],
  );
  return { ok: true };
}
