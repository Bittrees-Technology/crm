import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { pool, transaction } from "../lib/db";
import { sendDigest } from "../lib/digest";
const origin = process.env.SMOKE_URL || process.env.APP_URL!;
if (!origin) throw new Error("Set SMOKE_URL.");
const email = `delivered+crm-${randomUUID()}@resend.dev`;
const jar = new Map<string, string>();
let userId: string | undefined, workspaceId: string | undefined;
async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch(origin + "/api/" + path, {
    method,
    headers: {
      origin,
      "Content-Type": "application/json",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of r.headers.getSetCookie()) {
    const p = c.split(";")[0],
      i = p.indexOf("=");
    jar.set(p.slice(0, i), p.slice(i + 1));
  }
  const d = await r.json();
  assert.ok(r.ok, `${path}: ${d.error || r.status}`);
  return d;
}
async function resend(path: string) {
  const r = await fetch("https://api.resend.com/" + path, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  assert.ok(r.ok, `Email provider returned ${r.status}`);
  return r.json();
}
try {
  const c = await api("auth/challenge", { kind: "email", value: email });
  // Only inspect the uniquely labeled synthetic test recipient created by this run.
  const list = await resend("emails");
  const sent = list.data.find((m: { to: string[] }) => m.to.includes(email));
  assert.ok(sent, "Test verification email was accepted by provider");
  await new Promise((r) => setTimeout(r, 1000));
  const message = await resend("emails/" + sent.id);
  const code = message.text.match(/code is (\d{8})/)?.[1];
  assert.ok(code, "Verification code is present in test email");
  await api("auth/verify", { id: c.id, proof: code });
  const me = await api("me");
  userId = me.user.id;
  workspaceId = me.workspaces[0].id;
  const wallet = Wallet.createRandom();
  const wc = await api("auth/challenge", {
    kind: "ethereum",
    value: wallet.address,
    link: true,
  });
  await api("auth/verify", {
    id: wc.id,
    proof: await wallet.signMessage(wc.message),
  });
  const linked = await api("me");
  assert.equal(linked.user.id, userId);
  assert.equal(linked.identities.length, 2);
  await api("auth/logout", {});
  const login = await api("auth/challenge", {
    kind: "ethereum",
    value: wallet.address,
  });
  await api("auth/verify", {
    id: login.id,
    proof: await wallet.signMessage(login.message),
  });
  assert.equal((await api("me")).user.id, userId);
  assert.equal((await api("me/digest")).enabled, false);
  const day = new Date().toISOString().slice(0, 10);
  await api(`workspaces/${workspaceId}/records`, {
    kind: "tasks",
    data: {
      name: "Synthetic daily digest check",
      ownerId: userId,
      dueDate: day,
    },
  });
  await api("me/digest", { enabled: true, email }, "PATCH");
  // Exercise only this run's synthetic recipient, never the global cron queue.
  process.env.APP_URL = origin;
  process.env.EMAIL_FROM = message.from;
  assert.equal(await sendDigest(userId!, day), "sent");
  assert.equal(await sendDigest(userId!, day), "skipped");
  assert.equal((await api("me/digest")).last.status, "sent");
  await api("me/digest", { enabled: false, email }, "PATCH");
  const cron = await fetch(origin + "/api/cron/digest");
  assert.equal(cron.status, 401);
  console.log(
    "Daily digest check passed: verified opt-in, synthetic email accepted, duplicate prevented, opt-out saved, cron requires authentication.",
  );
  await api("auth/logout", {});
  console.log(
    "Production email test passed: provider accepted verification email; code sign-in, explicit wallet linking, and wallet re-login used the same account.",
  );
  console.log(
    "Delivery was tested with Resend’s synthetic test recipient, not a personal inbox.",
  );
} finally {
  if (userId && workspaceId) {
    await transaction(async (db) => {
      const check = (
        await db.query(
          "SELECT user_id FROM identities WHERE kind='email' AND value=$1",
          [email],
        )
      ).rows[0];
      assert.equal(check?.user_id, userId);
      await db.query("DELETE FROM audit WHERE workspace_id=$1", [workspaceId]);
      await db.query("DELETE FROM records WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query("DELETE FROM digest_receipts WHERE user_id=$1", [userId]);
      await db.query(
        "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, userId],
      );
      await db.query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
      await db.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      await db.query(
        "DELETE FROM challenges WHERE user_id=$1 OR (kind='email' AND value=$2)",
        [userId, email],
      );
      await db.query("DELETE FROM identities WHERE user_id=$1", [userId]);
      await db.query("DELETE FROM users WHERE id=$1", [userId]);
    });
    console.log("Temporary verification account removed.");
  }
  await pool().end();
}
