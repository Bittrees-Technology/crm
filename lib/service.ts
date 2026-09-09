import {
  accessIds,
  checkRecordAccess,
  redactRecord,
  scopeSchema,
  validateScope,
  validateVisibility,
} from "./access";
import { normalizeType, typeKey, defaultType } from "./opportunity-types";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { hash, token } from "./auth";
import {
  HttpError,
  kinds,
  recordSchema,
  type Kind,
  type RecordData,
} from "./model";
export async function lockActiveAccount(
  db: Pick<PoolClient, "query">,
  userId: string,
) {
  const account = (
    await db.query("SELECT merged_into FROM users WHERE id=$1 FOR SHARE", [
      userId,
    ])
  ).rows[0];
  if (!account || account.merged_into)
    throw new HttpError(
      401,
      "Your account changed. Sign in again to continue.",
    );
}
export async function membership(
  workspaceId: string,
  userId: string,
  write = false,
  owner = false,
  db: Pick<PoolClient, "query"> = pool(),
) {
  z.uuid().parse(workspaceId);
  await lockActiveAccount(db, userId);
  await db.query(
    `SELECT id FROM workspaces WHERE id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
    [workspaceId],
  );
  const member = (
    await db.query(
      "SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2",
      [workspaceId, userId],
    )
  ).rows[0];
  if (!member) throw new HttpError(404, "Workspace not found.");
  if ((write && member.role === "viewer") || (owner && member.role !== "owner"))
    throw new HttpError(403, "Your workspace role does not allow this action.");
  return member.role as string;
}
async function audit(
  db: PoolClient,
  w: string,
  u: string,
  action: string,
  id: string | null,
  detail: unknown,
) {
  await db.query(
    "INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) VALUES($1,$2,$3,$4,$5)",
    [w, u, action, id, JSON.stringify(detail)],
  );
}
async function validateReferences(db: PoolClient, w: string, data: RecordData) {
  for (const [field, kind] of Object.entries({
    organizationId: "organizations",
    personId: "people",
    projectId: "projects",
    opportunityId: "opportunities",
  })) {
    const id = data[field as keyof RecordData];
    if (
      id &&
      !(
        await db.query(
          "SELECT id FROM records WHERE id=$1 AND workspace_id=$2 AND kind=$3 FOR KEY SHARE",
          [id, w, kind],
        )
      ).rowCount
    )
      throw new HttpError(
        400,
        `The linked ${kind} record is not in this workspace.`,
      );
  }
  if (
    data.ownerId &&
    !(
      await db.query(
        "SELECT user_id FROM members WHERE workspace_id=$1 AND user_id=$2",
        [w, data.ownerId],
      )
    ).rowCount
  )
    throw new HttpError(400, "The owner must be a workspace member.");
}
export async function saveRecord(userId: string, w: string, input: unknown) {
  const body = z
    .object({
      id: z.uuid().optional(),
      kind: z.enum(kinds),
      version: z.number().int().positive().optional(),
      data: recordSchema,
      visibilityIds: scopeSchema.optional(),
      privateNote: z
        .object({
          content: z.string().max(20000),
          version: z.number().int().min(0),
        })
        .optional(),
    })
    .parse(input);
  return transaction(async (db) => {
    const role = await membership(w, userId, true, false, db);
    if (
      (body.visibilityIds !== undefined || body.privateNote !== undefined) &&
      role !== "owner"
    )
      throw new HttpError(
        403,
        "Only workspace owners can manage sharing or personal owner notes.",
      );
    if (body.visibilityIds !== undefined)
      await validateVisibility(db, w, body.visibilityIds);
    // Workspace lock makes reference checks, deletion, and import deduplication atomic.
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [w]);
    await checkRecordAccess(db, userId, w, body.id, body.data);
    await validateReferences(db, w, body.data);
    if (
      body.kind === "opportunities" &&
      !["Won", "Lost"].includes(body.data.stage) &&
      (!body.data.ownerId || !body.data.nextAction || !body.data.dueDate)
    )
      throw new HttpError(
        400,
        "Active opportunities need an owner, a next action, and a due date.",
      );
    if (body.kind === "opportunities") {
      body.data.category =
        defaultType(body.data.category) || normalizeType(body.data.category);
    }
    const id = body.id || randomUUID();
    const previous = body.id
      ? (
          await db.query(
            "SELECT data FROM records WHERE id=$1 AND workspace_id=$2",
            [id, w],
          )
        ).rows[0]?.data
      : undefined;
    let record;
    if (body.id) {
      if (!body.version)
        throw new HttpError(400, "A record version is required.");
      record = (
        await db.query(
          "UPDATE records SET visibility_ids=CASE WHEN $6::boolean THEN $7::uuid[] ELSE visibility_ids END,stage_changed_at=CASE WHEN data->>'stage' IS DISTINCT FROM $1::jsonb->>'stage' THEN now() ELSE stage_changed_at END,data=$1,version=version+1,updated_at=now() WHERE id=$2 AND workspace_id=$3 AND kind=$4 AND version=$5 RETURNING *",
          [
            body.data,
            id,
            w,
            body.kind,
            body.version,
            body.visibilityIds !== undefined,
            body.visibilityIds ?? null,
          ],
        )
      ).rows[0];
      if (!record)
        throw new HttpError(
          409,
          "This record changed or was removed. Close this panel and refresh before editing again.",
        );
    } else {
      record = (
        await db.query(
          "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [id, w, body.kind, body.data, body.visibilityIds ?? null],
        )
      ).rows[0];
    }
    if (body.privateNote) {
      const note = (
        await db.query(
          "SELECT version FROM record_private_notes WHERE record_id=$1 AND author_id=$2 FOR UPDATE",
          [id, userId],
        )
      ).rows[0];
      if ((note?.version || 0) !== body.privateNote.version)
        throw new HttpError(
          409,
          "Your private note changed in another session. Reopen the record before saving.",
        );
      await db.query(
        "INSERT INTO record_private_notes(record_id,author_id,content) VALUES($1,$2,$3) ON CONFLICT(record_id,author_id) DO UPDATE SET content=EXCLUDED.content,version=record_private_notes.version+1,updated_at=now()",
        [id, userId, body.privateNote.content],
      );
    }
    await audit(
      db,
      w,
      userId,
      body.id ? "Record updated" : "Record created",
      id,
      {
        kind: body.kind,
        name: body.data.name,
        version: record.version,
        changes: previous
          ? Object.fromEntries(
              ["stage", "status", "dueDate", "nextAction", "ownerId"]
                .filter((k) => previous[k] !== body.data[k as keyof RecordData])
                .map((k) => [
                  k,
                  { from: previous[k], to: body.data[k as keyof RecordData] },
                ]),
            )
          : {},
        relatedIds: [
          ...new Set([
            ...(await contextIds(db, w, body.data)),
            ...(await contextIds(db, w, previous)),
          ]),
        ],
      },
    );
    if (
      body.kind === "opportunities" &&
      body.data.category &&
      !defaultType(body.data.category)
    ) {
      await db.query(
        "INSERT INTO user_opportunity_types(user_id,key,label) VALUES($1,$2,$3) ON CONFLICT(user_id,key) DO NOTHING",
        [userId, typeKey(body.data.category), body.data.category],
      );
    }
    return redactRecord(record, await accessIds(db, userId, w));
  });
}
export async function deleteRecord(
  userId: string,
  w: string,
  id: string,
  version: number,
) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    await membership(w, userId, true, false, db);
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [w]);
    await checkRecordAccess(db, userId, w, id);
    const linked = await db.query(
      `SELECT id FROM records WHERE workspace_id=$1 AND id<>$2 AND (data->>'organizationId'=$2::text OR data->>'personId'=$2::text OR data->>'projectId'=$2::text OR data->>'opportunityId'=$2::text) LIMIT 1`,
      [w, id],
    );
    if (linked.rowCount)
      throw new HttpError(
        409,
        "Other records link here. Remove those links before deleting.",
      );
    const { rows } = await db.query(
      "DELETE FROM records WHERE workspace_id=$1 AND id=$2 AND version=$3 RETURNING *",
      [w, id, version],
    );
    if (!rows[0])
      throw new HttpError(
        409,
        "This record changed or was removed. Refresh and try again.",
      );
    await audit(db, w, userId, "Record deleted", id, {
      kind: rows[0].kind,
      name: rows[0].data.name,
      relatedIds: await contextIds(db, w, rows[0].data),
    });
    return { ok: true };
  });
}
export async function importRecords(userId: string, w: string, input: unknown) {
  const body = z
    .object({
      kind: z.enum(["people", "organizations"]),
      rows: z.array(recordSchema).min(1).max(500),
    })
    .parse(input);
  return transaction(async (db) => {
    await membership(w, userId, true, false, db);
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [w]);
    const importIds = await accessIds(db, userId, w);
    if (
      (
        await db.query(
          "SELECT scope_ids FROM members WHERE user_id=$1 AND workspace_id=$2",
          [userId, w],
        )
      ).rows[0].scope_ids !== null
    )
      throw new HttpError(
        403,
        "CSV import requires whole-workspace access. Add linked records individually.",
      );
    let imported = 0,
      skipped = 0;
    for (const data of body.rows) {
      await checkRecordAccess(db, userId, w, undefined, data);
      await validateReferences(db, w, data);
      const duplicate = (
        await db.query(
          `SELECT id FROM records WHERE workspace_id=$1 AND kind=$2 AND ($5::uuid[] IS NULL OR id=ANY($5)) AND (lower(data->>'name')=lower($3) OR ($4<>'' AND lower(data->>'email')=lower($4))) LIMIT 1`,
          [w, body.kind, data.name, data.email, importIds],
        )
      ).rowCount;
      if (duplicate) {
        skipped++;
        continue;
      }
      const importedId = randomUUID();
      await db.query(
        "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,$3,$4)",
        [importedId, w, body.kind, data],
      );
      importIds?.push(importedId);
      imported++;
    }
    await audit(db, w, userId, "CSV imported", null, {
      kind: body.kind,
      imported,
      skipped,
    });
    return { imported, skipped };
  });
}
export async function snapshot(userId: string, w: string) {
  return transaction(async (db) => {
    const role = await membership(w, userId, false, false, db);
    const ids = await accessIds(db, userId, w);
    const records = await db.query(
      "SELECT * FROM records WHERE workspace_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY updated_at DESC",
      [w, ids],
    );
    const members = await db.query(
      "SELECT u.id,u.name,m.role,m.scope_ids FROM members m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY u.name",
      [w],
    );
    const audits =
      ids === null
        ? await db.query(
            "SELECT a.id,a.action,a.record_id,a.detail,a.created_at,u.name AS actor FROM audit a JOIN users u ON u.id=a.actor_id WHERE workspace_id=$1 ORDER BY a.id DESC LIMIT 100",
            [w],
          )
        : { rows: [] };
    return {
      role,
      limited: members.rows.find((m) => m.id === userId)?.scope_ids !== null,
      records: records.rows.map((r) => redactRecord(r, ids)),
      members: members.rows.map((m) =>
        role === "owner" ? m : { id: m.id, name: m.name, role: m.role },
      ),
      audit: audits.rows,
    };
  });
}
export async function createInvite(userId: string, w: string, input: unknown) {
  const body = z
    .object({
      email: z.email().max(254),
      role: z.enum(["editor", "viewer"]),
      scopeIds: scopeSchema.default(null),
    })
    .parse(input);
  const raw = token();
  await transaction(async (db) => {
    await membership(w, userId, true, true, db);
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [w]);
    await validateScope(db, w, body.scopeIds);
    await db.query(
      "UPDATE invites SET revoked_at=now() WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
      [w, body.email.toLowerCase()],
    );
    await db.query(
      "INSERT INTO invites(hash,workspace_id,email,role,expires_at,scope_ids) VALUES($1,$2,$3,$4,now()+interval '7 days',$5)",
      [hash(raw), w, body.email.toLowerCase(), body.role, body.scopeIds],
    );
    await audit(db, w, userId, "Invitation created", null, {
      role: body.role,
      email: body.email,
    });
  });
  return { token: raw };
}
export async function acceptInvite(userId: string, raw: string) {
  return transaction(async (db) => {
    await lockActiveAccount(db, userId);
    const candidate = (
      await db.query("SELECT workspace_id FROM invites WHERE hash=$1", [
        hash(raw),
      ])
    ).rows[0];
    if (candidate)
      await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        candidate.workspace_id,
      ]);
    const invite = (
      await db.query(
        "SELECT * FROM invites WHERE hash=$1 AND expires_at>now() AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE",
        [hash(raw)],
      )
    ).rows[0];
    if (!invite)
      throw new HttpError(400, "This invitation is invalid or expired.");
    if (
      !(
        await db.query(
          "SELECT value FROM identities WHERE user_id=$1 AND kind='email' AND value=$2",
          [userId, invite.email],
        )
      ).rowCount
    )
      throw new HttpError(
        403,
        "Verify the email address this invitation was sent to in Settings, then open the invitation again.",
      );
    await db.query(
      "INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [invite.workspace_id, userId, invite.role, invite.scope_ids],
    );
    await db.query("UPDATE invites SET accepted_at=now() WHERE hash=$1", [
      hash(raw),
    ]);
    await audit(
      db,
      invite.workspace_id,
      userId,
      "Invitation accepted",
      null,
      {},
    );
    return { workspaceId: invite.workspace_id };
  });
}
export async function updateMember(userId: string, w: string, input: unknown) {
  const body = z
    .object({
      userId: z.uuid(),
      role: z.enum(["editor", "viewer", "remove"]),
      scopeIds: scopeSchema.optional(),
    })
    .parse(input);
  return transaction(async (db) => {
    await membership(w, userId, true, true, db);

    const target = (
      await db.query(
        "SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
        [w, body.userId],
      )
    ).rows[0];
    if (!target || target.role === "owner")
      throw new HttpError(400, "The workspace owner cannot be changed here.");
    if (body.scopeIds !== undefined) await validateScope(db, w, body.scopeIds);
    if (body.role === "remove") {
      if (
        (
          await db.query(
            "SELECT id FROM records WHERE workspace_id=$1 AND data->>'ownerId'=$2 LIMIT 1",
            [w, body.userId],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "Reassign this member’s records before removing them.",
        );
      await db.query(
        "UPDATE records SET visibility_ids=array_remove(visibility_ids,$2::uuid),version=version+1,updated_at=now() WHERE workspace_id=$1 AND $2::uuid=ANY(visibility_ids)",
        [w, body.userId],
      );
      await db.query(
        "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
        [w, body.userId],
      );
    } else
      await db.query(
        "UPDATE members SET role=$1,scope_ids=CASE WHEN $4::boolean THEN $5::uuid[] ELSE scope_ids END WHERE workspace_id=$2 AND user_id=$3",
        [
          body.role,
          w,
          body.userId,
          body.scopeIds !== undefined,
          body.scopeIds ?? null,
        ],
      );
    await audit(db, w, userId, "Member access changed", null, body);
    return { ok: true };
  });
}

async function contextIds(
  db: PoolClient,
  w: string,
  data?: RecordData,
): Promise<string[]> {
  if (!data) return [];
  const seeds = [
    data.personId,
    data.organizationId,
    data.projectId,
    data.opportunityId,
  ].filter(Boolean);
  if (!seeds.length) return [];
  const rows = await db.query(
    `WITH RECURSIVE parents AS (
 SELECT id,data FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[])
 UNION SELECT r.id,r.data FROM records r JOIN parents p ON r.id::text IN (p.data->>'personId',p.data->>'organizationId',p.data->>'projectId',p.data->>'opportunityId') WHERE r.workspace_id=$1
 ) SELECT id FROM parents`,
    [w, seeds],
  );
  return rows.rows.map((r) => r.id);
}
export async function timeline(userId: string, w: string, id: string) {
  return transaction(async (db) => {
    await membership(w, userId, false, false, db);
    const ids = await accessIds(db, userId, w);
    await checkRecordAccess(db, userId, w, id);

    z.uuid().parse(id);
    if (
      !(
        await db.query(
          "SELECT id FROM records WHERE workspace_id=$1 AND id=$2",
          [w, id],
        )
      ).rowCount
    )
      throw new HttpError(404, "Record not found.");
    const rows = await db.query(
      `WITH RECURSIVE related AS (
 SELECT id FROM records WHERE workspace_id=$1 AND id=$2
 UNION SELECT r.id FROM records r JOIN related p ON p.id::text IN(r.data->>'personId',r.data->>'organizationId',r.data->>'projectId',r.data->>'opportunityId') WHERE r.workspace_id=$1 AND ($3::uuid[] IS NULL OR r.id=ANY($3))
 ) SELECT a.id,a.record_id,a.action,a.detail,a.created_at,u.name AS actor,
 CASE WHEN r.kind='notes' AND a.id=(SELECT max(b.id) FROM audit b WHERE b.workspace_id=$1 AND b.record_id=r.id) THEN r.data->>'description' ELSE NULL END AS note
 FROM audit a JOIN users u ON u.id=a.actor_id LEFT JOIN records r ON r.id=a.record_id AND r.workspace_id=$1
 WHERE a.workspace_id=$1 AND ($3::uuid[] IS NULL OR a.record_id=ANY($3)) AND (a.record_id IN(SELECT id FROM related) OR a.detail->'relatedIds' @> to_jsonb(ARRAY[$2::text]))
 ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,
      [w, id, ids],
    );
    if (ids !== null) {
      const current = (
        await db.query(
          "SELECT id,kind,data FROM records WHERE id=ANY($1::uuid[]) AND workspace_id=$2",
          [ids, w],
        )
      ).rows;
      return {
        events: rows.rows.map((event) => {
          const record = current.find((r) => r.id === event.record_id);
          return {
            ...event,
            detail: { name: record?.data.name || "Record", kind: record?.kind },
          };
        }),
      };
    }
    return { events: rows.rows };
  });
}
export async function listInvites(userId: string, w: string) {
  await membership(w, userId, false, true);
  const rows = await pool().query(
    `SELECT id,email,role,scope_ids,created_at,expires_at,CASE WHEN revoked_at IS NOT NULL THEN 'Revoked' WHEN accepted_at IS NOT NULL THEN 'Accepted' WHEN expires_at<now() THEN 'Expired' ELSE 'Pending' END AS status FROM invites WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [w],
  );
  return { invites: rows.rows };
}
export async function revokeInvite(userId: string, w: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    await membership(w, userId, true, true, db);
    const r = await db.query(
      "UPDATE invites SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND accepted_at IS NULL RETURNING email",
      [id, w],
    );
    if (!r.rowCount)
      throw new HttpError(
        409,
        "This invitation has already been accepted or revoked.",
      );
    await audit(db, w, userId, "Invitation revoked", null, {
      email: r.rows[0].email,
    });
    return { ok: true };
  });
}
export async function previewInvite(raw: string) {
  const row = (
    await pool().query(
      `SELECT w.name,i.email,i.role,i.scope_ids FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE i.hash=$1 AND i.expires_at>now() AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
      [hash(raw)],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      400,
      "This invitation is expired, revoked, or already accepted. Ask the workspace owner for a new link.",
    );
  return row;
}
