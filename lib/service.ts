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
export async function membership(
  workspaceId: string,
  userId: string,
  write = false,
  owner = false,
  db: Pick<PoolClient, "query"> = pool(),
) {
  z.uuid().parse(workspaceId);
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
    })
    .parse(input);
  return transaction(async (db) => {
    await membership(w, userId, true, false, db);
    // Workspace lock makes reference checks, deletion, and import deduplication atomic.
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [w]);
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
    const id = body.id || randomUUID();
    let record;
    if (body.id) {
      if (!body.version)
        throw new HttpError(400, "A record version is required.");
      record = (
        await db.query(
          "UPDATE records SET stage_changed_at=CASE WHEN data->>'stage' IS DISTINCT FROM $1::jsonb->>'stage' THEN now() ELSE stage_changed_at END,data=$1,version=version+1,updated_at=now() WHERE id=$2 AND workspace_id=$3 AND kind=$4 AND version=$5 RETURNING *",
          [body.data, id, w, body.kind, body.version],
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
          "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,$3,$4) RETURNING *",
          [id, w, body.kind, body.data],
        )
      ).rows[0];
    }
    await audit(
      db,
      w,
      userId,
      body.id ? "Record updated" : "Record created",
      id,
      { kind: body.kind, name: body.data.name, version: record.version },
    );
    return record;
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
    let imported = 0,
      skipped = 0;
    for (const data of body.rows) {
      await validateReferences(db, w, data);
      const duplicate = (
        await db.query(
          `SELECT id FROM records WHERE workspace_id=$1 AND kind=$2 AND (lower(data->>'name')=lower($3) OR ($4<>'' AND lower(data->>'email')=lower($4))) LIMIT 1`,
          [w, body.kind, data.name, data.email],
        )
      ).rowCount;
      if (duplicate) {
        skipped++;
        continue;
      }
      await db.query(
        "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,$3,$4)",
        [randomUUID(), w, body.kind, data],
      );
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
  const role = await membership(w, userId);
  const [records, members, audits] = await Promise.all([
    pool().query(
      "SELECT * FROM records WHERE workspace_id=$1 ORDER BY updated_at DESC",
      [w],
    ),
    pool().query(
      "SELECT u.id,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY u.name",
      [w],
    ),
    pool().query(
      "SELECT a.id,a.action,a.record_id,a.detail,a.created_at,u.name AS actor FROM audit a JOIN users u ON u.id=a.actor_id WHERE workspace_id=$1 ORDER BY a.id DESC LIMIT 100",
      [w],
    ),
  ]);
  return {
    role,
    records: records.rows,
    members: members.rows,
    audit: audits.rows,
  };
}
export async function createInvite(userId: string, w: string, input: unknown) {
  const body = z
    .object({ email: z.email().max(254), role: z.enum(["editor", "viewer"]) })
    .parse(input);
  const raw = token();
  await transaction(async (db) => {
    await membership(w, userId, true, true, db);
    await db.query(
      "INSERT INTO invites(hash,workspace_id,email,role,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
      [hash(raw), w, body.email.toLowerCase(), body.role],
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
    const invite = (
      await db.query(
        "SELECT * FROM invites WHERE hash=$1 AND expires_at>now() AND accepted_at IS NULL FOR UPDATE",
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
      "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [invite.workspace_id, userId, invite.role],
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
    .object({ userId: z.uuid(), role: z.enum(["editor", "viewer", "remove"]) })
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
        "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
        [w, body.userId],
      );
    } else
      await db.query(
        "UPDATE members SET role=$1 WHERE workspace_id=$2 AND user_id=$3",
        [body.role, w, body.userId],
      );
    await audit(db, w, userId, "Member access changed", null, body);
    return { ok: true };
  });
}
