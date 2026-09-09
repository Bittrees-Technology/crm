import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { pool, transaction } from "../lib/db";
const origin = process.env.SMOKE_URL;
if (!origin) throw new Error("Set SMOKE_URL to the deployment under test.");
const email = `delivered+recovery-${randomUUID()}@resend.dev`,
  wallet = Wallet.createRandom();
const targetJar = new Map<string, string>(),
  sourceJar = new Map<string, string>();
let target: any, source: any;
async function api(
  jar: Map<string, string>,
  path: string,
  body?: unknown,
  expected = 200,
) {
  const r = await fetch(origin + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      origin: origin!,
      "Content-Type": "application/json",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of r.headers.getSetCookie()) {
    const pair = c.split(";")[0],
      i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const data = await r.json();
  assert.equal(r.status, expected, `${path}: ${data.error || r.status}`);
  return data;
}
async function emailCode(body: unknown) {
  const c = await api(targetJar, "auth/challenge", body);
  await new Promise((r) => setTimeout(r, 700));
  const headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}` };
  const list = await fetch("https://api.resend.com/emails", { headers }).then(
    (r) => r.json(),
  );
  const sent = list.data.find((m: any) => m.to.includes(email));
  assert.ok(sent, "Synthetic verification email accepted");
  await new Promise((r) => setTimeout(r, 700));
  const message = await fetch("https://api.resend.com/emails/" + sent.id, {
    headers,
  }).then((r) => r.json());
  const code = message.text.match(/code is (\d{8})/)?.[1];
  assert.ok(code);
  return api(targetJar, "auth/verify", { id: c.id, proof: code });
}
try {
  await emailCode({ kind: "email", value: email });
  target = await api(targetJar, "me");
  const c = await api(sourceJar, "auth/challenge", {
    kind: "ethereum",
    value: wallet.address,
  });
  await api(sourceJar, "auth/verify", {
    id: c.id,
    proof: await wallet.signMessage(c.message),
  });
  source = await api(sourceJar, "me");
  const task = await api(
    sourceJar,
    `workspaces/${source.workspaces[0].id}/records`,
    {
      kind: "tasks",
      data: { name: "Synthetic recovery record", ownerId: source.user.id },
    },
  );
  const link = await api(targetJar, "auth/challenge", {
    kind: "ethereum",
    value: wallet.address,
    link: true,
  });
  const { recovery } = await api(targetJar, "auth/verify", {
    id: link.id,
    proof: await wallet.signMessage(link.message),
    recover: true,
  });
  assert.ok(recovery);
  await api(
    targetJar,
    "auth/recover",
    { token: recovery.token, confirm: true },
    403,
  );
  const proof = await emailCode({
    kind: "email",
    value: email,
    link: true,
    recoveryToken: recovery.token,
  });
  assert.equal(proof.reauthenticated, true);
  await api(targetJar, "auth/recover", {
    token: recovery.token,
    confirm: true,
  });
  const me = await api(targetJar, "me");
  assert.equal(me.user.id, target.user.id);
  assert.equal(me.identities.length, 2);
  assert.equal(me.workspaces.length, 2);
  const workspace = await api(
    targetJar,
    `workspaces/${source.workspaces[0].id}`,
  );
  assert.equal(
    workspace.records.find((r: any) => r.id === task.id).data.ownerId,
    target.user.id,
  );
  await api(sourceJar, "me", undefined, 401);
  await api(sourceJar, "auth/logout", {});
  const again = await api(sourceJar, "auth/challenge", {
    kind: "ethereum",
    value: wallet.address,
  });
  await api(sourceJar, "auth/verify", {
    id: again.id,
    proof: await wallet.signMessage(again.message),
  });
  assert.equal((await api(sourceJar, "me")).user.id, target.user.id);
  console.log(
    "Live recovery passed: separate email/wallet accounts, both fresh proofs, explicit confirmation, preserved workspaces/assignment, old-session revocation, and wallet re-login to combined account. Only synthetic identities were used.",
  );
} finally {
  const ids = [target?.user.id, source?.user.id].filter(Boolean),
    workspaces = [target?.workspaces[0].id, source?.workspaces[0].id].filter(
      Boolean,
    );
  if (ids.length)
    await transaction(async (db) => {
      const valid = (
        await db.query(
          "SELECT user_id FROM identities WHERE (kind='email' AND value=$1) OR (kind='ethereum' AND value=$2)",
          [email, wallet.address.toLowerCase()],
        )
      ).rows;
      assert.ok(valid.every((r) => ids.includes(r.user_id)));
      await db.query(
        "DELETE FROM challenges WHERE recovery_hash IN(SELECT hash FROM identity_recoveries WHERE target_id=ANY($1::uuid[]) OR source_id=ANY($1::uuid[]))",
        [ids],
      );
      await db.query(
        "DELETE FROM identity_recoveries WHERE target_id=ANY($1::uuid[]) OR source_id=ANY($1::uuid[])",
        [ids],
      );
      for (const table of ["audit", "records", "invites", "members"])
        await db.query(
          `DELETE FROM ${table} WHERE workspace_id=ANY($1::uuid[])`,
          [workspaces],
        );
      await db.query("DELETE FROM workspaces WHERE id=ANY($1::uuid[])", [
        workspaces,
      ]);
      for (const table of ["digest_receipts", "sessions", "identities"])
        await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`, [
          ids,
        ]);
      await db.query(
        "DELETE FROM challenges WHERE user_id=ANY($1::uuid[]) OR value=$2 OR value=$3",
        [ids, email, wallet.address.toLowerCase()],
      );
      await db.query(
        "UPDATE users SET merged_into=NULL WHERE id=ANY($1::uuid[])",
        [ids],
      );
      await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
    });
  await pool().end();
  console.log("Synthetic recovery accounts cleaned up.");
}
