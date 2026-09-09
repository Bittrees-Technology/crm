import type { PoolClient } from "pg";
import { transaction } from "./db";
import {
  checkOrigin,
  cookie,
  cookieName,
  currentUser,
  hash,
  setCookie,
  token,
} from "./auth";
import { HttpError } from "./model";
export async function accountSummary(db: PoolClient, id: string) {
  const user = (
    await db.query("SELECT name,merged_into FROM users WHERE id=$1", [id])
  ).rows[0];
  if (!user || user.merged_into)
    throw new HttpError(
      409,
      "An account changed. Close this window and start linking again.",
    );
  const identities = (
    await db.query(
      "SELECT kind,value FROM identities WHERE user_id=$1 ORDER BY kind,value",
      [id],
    )
  ).rows;
  const workspaces = (
    await db.query(
      "SELECT w.id,w.name,m.role,(SELECT count(*)::int FROM records r WHERE r.workspace_id=w.id) AS records FROM members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.id",
      [id],
    )
  ).rows;
  return { name: user.name, identities, workspaces };
}
function fingerprint(summary: Awaited<ReturnType<typeof accountSummary>>) {
  return hash(
    JSON.stringify({
      identities: summary.identities,
      workspaces: summary.workspaces.map((w) => ({ id: w.id, role: w.role })),
    }),
  );
}
export async function createRecovery(
  db: PoolClient,
  req: Request,
  target: string,
  source: string,
) {
  const current = await accountSummary(db, target),
    other = await accountSummary(db, source),
    raw = token();
  await db.query(
    "INSERT INTO identity_recoveries(hash,target_id,source_id,session_hash,fingerprint,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
    [
      hash(raw),
      target,
      source,
      hash(cookie(req, cookieName)),
      fingerprint(current) + fingerprint(other),
    ],
  );
  return { token: raw, current, other };
}
export async function recoveryForSession(
  db: PoolClient,
  req: Request,
  recoveryHash: string,
  userId: string,
) {
  const r = (
    await db.query(
      "SELECT * FROM identity_recoveries WHERE hash=$1 FOR UPDATE",
      [recoveryHash],
    )
  ).rows[0];
  if (
    !r ||
    r.consumed ||
    new Date(r.expires_at).getTime() < Date.now() ||
    r.target_id !== userId ||
    r.session_hash !== hash(cookie(req, cookieName))
  )
    throw new HttpError(
      400,
      "This account recovery expired. Close this window and start linking again.",
    );
  return r;
}
export async function completeRecovery(req: Request, raw: string) {
  checkOrigin(req);
  const user = (await currentUser(req))!,
    sessionToken = token();
  await transaction(async (db) => {
    const r = await recoveryForSession(db, req, hash(raw), user.id);
    if (!r.current_verified)
      throw new HttpError(
        403,
        "Verify your current account before combining accounts.",
      );
    await db.query(
      "SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [[r.target_id, r.source_id]],
    );
    const current = await accountSummary(db, r.target_id),
      other = await accountSummary(db, r.source_id);
    if (r.fingerprint !== fingerprint(current) + fingerprint(other))
      throw new HttpError(
        409,
        "Account access changed during recovery. Close this window and review a fresh linking request.",
      );
    const workspaces = [
      ...new Set([...current.workspaces, ...other.workspaces].map((w) => w.id)),
    ];
    await db.query(
      "SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [workspaces],
    );
    // Workspaces stay separate. Preserve the strongest existing role in shared workspaces.
    await db.query(
      `INSERT INTO members(workspace_id,user_id,role) SELECT workspace_id,$1,role FROM members WHERE user_id=$2
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=CASE WHEN members.role='owner' OR EXCLUDED.role='owner' THEN 'owner' WHEN members.role='editor' OR EXCLUDED.role='editor' THEN 'editor' ELSE 'viewer' END`,
      [r.target_id, r.source_id],
    );
    await db.query(
      "UPDATE records SET data=jsonb_set(data,'{ownerId}',to_jsonb($1::text)),version=version+1,updated_at=now() WHERE data->>'ownerId'=$2::text",
      [r.target_id, r.source_id],
    );
    await db.query("UPDATE identities SET user_id=$1 WHERE user_id=$2", [
      r.target_id,
      r.source_id,
    ]);
    await db.query(
      "INSERT INTO user_opportunity_types(user_id,key,label) SELECT $1,key,label FROM user_opportunity_types WHERE user_id=$2 ON CONFLICT(user_id,key) DO NOTHING",
      [r.target_id, r.source_id],
    );
    await db.query("DELETE FROM user_opportunity_types WHERE user_id=$1", [
      r.source_id,
    ]);
    await db.query("DELETE FROM members WHERE user_id=$1", [r.source_id]);
    await db.query(
      "UPDATE users SET digest_enabled=false WHERE id=ANY($1::uuid[])",
      [[r.target_id, r.source_id]],
    );
    // Keep the old user row for historical attribution; it can no longer authenticate.
    await db.query("UPDATE users SET merged_into=$1 WHERE id=$2", [
      r.target_id,
      r.source_id,
    ]);
    await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [
      [r.target_id, r.source_id],
    ]);
    await db.query(
      "UPDATE identity_recoveries SET consumed=true WHERE target_id=ANY($1::uuid[]) OR source_id=ANY($1::uuid[])",
      [[r.target_id, r.source_id]],
    );
    for (const w of workspaces)
      await db.query(
        "INSERT INTO audit(workspace_id,actor_id,action,detail) VALUES($1,$2,'Accounts combined',$3)",
        [w, r.target_id, { name: other.name, sourceUserId: r.source_id }],
      );
    await db.query(
      "INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [hash(sessionToken), r.target_id],
    );
  });
  return {
    body: { ok: true },
    cookie: setCookie(cookieName, sessionToken, 604800),
  };
}
