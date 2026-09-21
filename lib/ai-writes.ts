import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { membership } from "./service";
import { checkRecordAccess, referenceFields } from "./access";
import { resolveAccess } from "./access-graph";
import { recordSchema, HttpError } from "./model";
import { locked, selected, requireAiEnabled } from "./ai";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const kinds = z
  .array(z.enum(["notes", "tasks"]))
  .min(1)
  .max(2)
  .refine((a) => new Set(a).size === a.length);
const payloadSchema = z.strictObject({
  operationId: z.uuid(),
  targetId: z.uuid(),
  kind: z.enum(["notes", "tasks"]),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  dueDate: z.union([z.iso.date(), z.literal("")]),
  sources: z
    .array(
      z.strictObject({ id: z.uuid(), version: z.number().int().positive() }),
    )
    .min(1)
    .max(100)
    .refine((a) => new Set(a.map((r) => r.id)).size === a.length),
  projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Payload = z.infer<typeof payloadSchema>;
async function owned(db: PoolClient, user: string, id: string) {
  const g = (
    await db.query("SELECT * FROM ai_grants WHERE id=$1 AND user_id=$2", [
      z.uuid().parse(id),
      user,
    ])
  ).rows[0];
  if (!g) throw new HttpError(404, "Connection not found.");
  await membership(g.workspace_id, user, true, false, db);
  const current = (
    await db.query(
      "SELECT * FROM ai_grants WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [id, user],
    )
  ).rows[0];
  if (
    !current ||
    current.revoked_at ||
    !current.token_hash ||
    new Date(current.expires_at).getTime() <= Date.now()
  )
    throw new HttpError(401, "Connection expired or revoked.");
  return current;
}
/** Requires the source user's verified session; a read bearer cannot authorize writes. */
export async function authorizeWrites(user: string, raw: unknown) {
  requireAiEnabled();
  const input = z
    .strictObject({
      grantId: z.uuid(),
      targetId: z.uuid(),
      kinds,
      expiresInDays: z.number().int().min(1).max(30),
    })
    .parse(raw);
  return transaction(async (db) => {
    const g = await owned(db, user, input.grantId);
    if (!g.record_ids.includes(input.targetId))
      throw new HttpError(
        403,
        "Destination must be selected in this connection.",
      );
    await destination(db, g, input.targetId);
    const epoch = randomUUID();
    await db.query(
      "INSERT INTO ai_write_permissions(grant_id,epoch,target_id,kinds,expires_at) VALUES($1,$2,$3,$4,LEAST($5,now()+($6*interval '1 day'))) ON CONFLICT(grant_id) DO UPDATE SET epoch=EXCLUDED.epoch,target_id=EXCLUDED.target_id,kinds=EXCLUDED.kinds,expires_at=EXCLUDED.expires_at,revoked_at=NULL",
      [
        g.id,
        epoch,
        input.targetId,
        input.kinds,
        g.expires_at,
        input.expiresInDays,
      ],
    );
    return { epoch, targetId: input.targetId, kinds: input.kinds };
  });
}
async function destination(db: PoolClient, g: any, id: string) {
  await checkRecordAccess(db, g.user_id, g.workspace_id, id);
  const t = (
    await db.query(
      "SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND kind IN ('people','organizations','projects','opportunities')",
      [id, g.workspace_id],
    )
  ).rows[0];
  if (!t) throw new HttpError(404, "Destination unavailable.");
  return t;
}
async function permission(db: PoolClient, g: any) {
  const p = (
    await db.query("SELECT * FROM ai_write_permissions WHERE grant_id=$1", [
      g.id,
    ])
  ).rows[0];
  if (!p || p.revoked_at || new Date(p.expires_at).getTime() <= Date.now())
    throw new HttpError(403, "Reviewed write permission required.");
  return p;
}
async function inspect(db: PoolClient, g: any, p: any, input: Payload) {
  if (
    p.target_id !== input.targetId ||
    !p.kinds.includes(input.kind) ||
    input.sources.some((r) => !g.record_ids.includes(r.id))
  )
    throw new HttpError(403, "Outside this connection's scope.");
  const rows = await selected(
    db,
    g.user_id,
    g.workspace_id,
    input.sources.map((r) => r.id),
  );
  if (
    rows.some(
      (r) => input.sources.find((s) => s.id === r.id)?.version !== r.version,
    )
  )
    throw new HttpError(
      409,
      "Source records changed. Generate and review again.",
    );
  const projection = rows.map((r) => {
    const data = recordSchema.parse(r.data);
    data.ownerId = "";
    for (const field of referenceFields)
      if (data[field] && !input.sources.some((s) => s.id === data[field]))
        data[field] = "";
    return { id: r.id, kind: r.kind, version: r.version, data };
  });
  if (digest(projection) !== input.projectionHash)
    throw new HttpError(409, "Source projection changed. Review again.");
  const target = await destination(db, g, input.targetId);
  const field = (
    {
      people: "personId",
      organizations: "organizationId",
      projects: "projectId",
      opportunities: "opportunityId",
    } as Record<string, string>
  )[target.kind]!;
  const data = recordSchema.parse({
    name: input.name,
    description: input.description,
    dueDate: input.dueDate,
    [field]: target.id,
  });
  await checkRecordAccess(db, g.user_id, g.workspace_id, undefined, data);
  const records = (
    await db.query(
      "SELECT id,kind,data,visibility_ids FROM records WHERE workspace_id=$1",
      [g.workspace_id],
    )
  ).rows;
  const members = (
    await db.query(
      "SELECT user_id,role,scope_ids FROM members WHERE workspace_id=$1",
      [g.workspace_id],
    )
  ).rows;
  const proposed = {
    id: "proposed-ai-record",
    kind: input.kind,
    data,
    visibility_ids: target.visibility_ids,
  };
  const audience = members
    .filter((m) => resolveAccess([...records, proposed], m).has(proposed.id))
    .map((m) => m.user_id)
    .sort();
  return {
    target,
    data,
    audienceHash: digest(audience),
    audienceCount: audience.length,
  };
}
/** Preparation is permitted only after separate source-session write consent. No publication occurs. */
export async function prepare(bearer: string, raw: unknown) {
  requireAiEnabled();
  const input = payloadSchema.parse(raw);
  return transaction(async (db) => {
    const g = await locked(db, bearer, "token_hash", true),
      p = await permission(db, g);
    const state = await inspect(db, g, p, input),
      payloadHash = digest(input);
    const old = (
      await db.query(
        "SELECT * FROM ai_write_reviews WHERE user_id=$1 AND workspace_id=$2 AND operation_id=$3",
        [g.user_id, g.workspace_id, input.operationId],
      )
    ).rows[0];
    if (old) {
      if (
        old.cancelled_at ||
        old.grant_id !== g.id ||
        old.payload_hash !== payloadHash ||
        old.write_epoch !== p.epoch
      )
        throw new HttpError(
          409,
          "Operation changed. Use a new reviewed operation.",
        );
      return {
        reviewId: old.id,
        digest: old.digest,
        expiresAt: old.expires_at,
      };
    }
    const count = (
      await db.query(
        "SELECT count(*)::int n FROM ai_write_reviews WHERE grant_id=$1 AND record_id IS NULL AND expires_at>now()",
        [g.id],
      )
    ).rows[0].n;
    if (count >= 20) throw new HttpError(429, "Too many pending reviews.");
    const id = randomUUID(),
      expiresAt = new Date(
        Math.min(
          Date.now() + 10 * 60_000,
          new Date(p.expires_at).getTime(),
          new Date(g.expires_at).getTime(),
        ),
      );
    const actionDigest = digest({
      id,
      payloadHash,
      epoch: p.epoch,
      targetVersion: state.target.version,
      audienceHash: state.audienceHash,
      expiresAt: expiresAt.toISOString(),
    });
    await db.query(
      "INSERT INTO ai_write_reviews(id,grant_id,write_epoch,operation_id,payload_hash,payload,target_version,audience_hash,audience_count,digest,expires_at,user_id,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        id,
        g.id,
        p.epoch,
        input.operationId,
        payloadHash,
        input,
        state.target.version,
        state.audienceHash,
        state.audienceCount,
        actionDigest,
        expiresAt,
        g.user_id,
        g.workspace_id,
      ],
    );
    return { reviewId: id, digest: actionDigest, expiresAt };
  });
}
async function review(db: PoolClient, g: any, p: any, id: string) {
  const r = (
    await db.query(
      "SELECT * FROM ai_write_reviews WHERE id=$1 AND grant_id=$2 FOR UPDATE",
      [z.uuid().parse(id), g.id],
    )
  ).rows[0];
  if (!r) throw new HttpError(404, "Review not found.");
  if (
    r.cancelled_at ||
    r.write_epoch !== p.epoch ||
    new Date(r.expires_at).getTime() <= Date.now()
  )
    throw new HttpError(409, "Review expired or permission changed.");
  const state = await inspect(db, g, p, payloadSchema.parse(r.payload));
  if (
    state.target.version !== r.target_version ||
    state.audienceHash !== r.audience_hash
  )
    throw new HttpError(409, "Destination or audience changed. Review again.");
  return { r, state };
}
export async function reviewForUser(user: string, id: string) {
  requireAiEnabled();
  return transaction(async (db) => {
    const row = (
      await db.query("SELECT grant_id FROM ai_write_reviews WHERE id=$1", [
        z.uuid().parse(id),
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, "Review not found.");
    const g = await owned(db, user, row.grant_id),
      p = await permission(db, g),
      { r, state } = await review(db, g, p, id);
    return {
      reviewId: r.id,
      digest: r.digest,
      payload: r.payload,
      targetName: state.target.data.name,
      audience: {
        description: "Inherits the destination's current sharing",
        memberCount: r.audience_count,
      },
      expiresAt: r.expires_at,
      approved: !!r.approved_at,
    };
  });
}
export async function approve(user: string, raw: unknown) {
  const input = z
    .strictObject({
      reviewId: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(raw);
  requireAiEnabled();
  return transaction(async (db) => {
    const row = (
      await db.query("SELECT grant_id FROM ai_write_reviews WHERE id=$1", [
        input.reviewId,
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, "Review not found.");
    const g = await owned(db, user, row.grant_id),
      p = await permission(db, g),
      { r } = await review(db, g, p, input.reviewId);
    if (r.digest !== input.digest)
      throw new HttpError(409, "Review content changed.");
    await db.query(
      "UPDATE ai_write_reviews SET approved_at=COALESCE(approved_at,now()) WHERE id=$1",
      [r.id],
    );
    return { ok: true };
  });
}
export async function publish(bearer: string, raw: unknown) {
  requireAiEnabled();
  const input = z
    .strictObject({
      reviewId: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(raw);
  return transaction(async (db) => {
    const g = await locked(db, bearer, "token_hash", true),
      p = await permission(db, g);
    const receipt = (
      await db.query(
        "SELECT * FROM ai_write_reviews WHERE id=$1 AND grant_id=$2",
        [input.reviewId, g.id],
      )
    ).rows[0];
    if (!receipt || receipt.digest !== input.digest)
      throw new HttpError(404, "Review not found.");
    if (receipt.record_id) {
      await checkRecordAccess(db, g.user_id, g.workspace_id, receipt.record_id);
      const exists = await db.query(
        "SELECT id FROM records WHERE id=$1 AND workspace_id=$2",
        [receipt.record_id, g.workspace_id],
      );
      return {
        recordId: receipt.record_id,
        state: exists.rowCount ? "published" : "deleted",
        existing: true,
      };
    }
    const { r, state } = await review(db, g, p, input.reviewId);
    if (!r.approved_at)
      throw new HttpError(
        403,
        "The source user must approve the exact review first.",
      );
    const id = randomUUID();
    await db.query(
      "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        g.workspace_id,
        r.payload.kind,
        state.data,
        state.target.visibility_ids,
      ],
    );
    await db.query("UPDATE ai_write_reviews SET record_id=$2 WHERE id=$1", [
      r.id,
      id,
    ]);
    await db.query(
      "INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) VALUES($1,$2,'Reviewed AI content published',$3,$4)",
      [
        g.workspace_id,
        g.user_id,
        id,
        { reviewId: r.id, operationId: r.operation_id },
      ],
    );
    return { recordId: id, state: "published", existing: false };
  });
}

export async function revokeWrites(user: string, grantId: string) {
  z.uuid().parse(grantId);
  return transaction(async (db) => {
    const g = (
      await db.query(
        "SELECT id FROM ai_grants WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [grantId, user],
      )
    ).rows[0];
    if (!g) throw new HttpError(404, "Connection not found.");
    await db.query(
      "UPDATE ai_write_permissions SET revoked_at=COALESCE(revoked_at,now()) WHERE grant_id=$1",
      [grantId],
    );
    return { ok: true };
  });
}

export async function writeOptions(user: string, grantId: string) {
  requireAiEnabled();
  return transaction(async (db) => {
    const g = await owned(db, user, grantId);
    const rows = await selected(db, user, g.workspace_id, g.record_ids);
    const saved =
      (
        await db.query(
          "SELECT target_id,kinds,expires_at,revoked_at FROM ai_write_permissions WHERE grant_id=$1",
          [g.id],
        )
      ).rows[0] ?? null;
    return {
      targets: rows
        .filter((r) =>
          ["people", "organizations", "projects", "opportunities"].includes(
            r.kind,
          ),
        )
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          name: recordSchema.parse(r.data).name,
        })),
      permission: saved,
    };
  });
}
export async function writeStatus(bearer: string) {
  requireAiEnabled();
  return transaction(async (db) => {
    const g = await locked(db, bearer, "token_hash", true),
      p = await permission(db, g),
      target = await destination(db, g, p.target_id);
    return {
      grantId: g.id,
      epoch: p.epoch,
      targetId: p.target_id,
      targetName: target.data.name,
      kinds: p.kinds,
      expiresAt: p.expires_at,
    };
  });
}

export async function deleteReview(user: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    const row = (
      await db.query(
        "SELECT g.id FROM ai_grants g JOIN ai_write_reviews r ON r.grant_id=g.id WHERE r.id=$1 AND g.user_id=$2 FOR UPDATE OF g",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Review not found.");
    await db.query(
      "UPDATE ai_write_reviews SET payload='{}',cancelled_at=COALESCE(cancelled_at,now()) WHERE id=$1",
      [id],
    );
    return { ok: true };
  });
}
