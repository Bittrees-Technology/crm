import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { pool, transaction } from "../lib/db";
const origin = process.env.SMOKE_URL || process.env.APP_URL!;
if (!origin) throw new Error("Set SMOKE_URL.");
const jar = new Map<string, string>();
let userId: string | undefined;
let workspaceId: string | undefined;
const wallet = Wallet.createRandom();
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  expected = 200,
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
    const pair = c.split(";")[0];
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  const data = await r.json();
  assert.equal(
    r.status,
    expected,
    `${method} ${path}: ${data.error || r.status}`,
  );
  return data;
}
try {
  await request("health");
  await request("me", "GET", undefined, 401);
  const c = await request("auth/challenge", "POST", {
    kind: "ethereum",
    value: wallet.address,
  });
  await request("auth/verify", "POST", {
    id: c.id,
    proof: await wallet.signMessage(c.message),
  });
  const me = await request("me");
  userId = me.user.id;
  workspaceId = me.workspaces[0].id;
  const base = "workspaces/" + workspaceId;
  await request("me", "PATCH", { name: "Automated deployment verification" });
  const organization = await request(base + "/records", "POST", {
    kind: "organizations",
    data: { name: "Temporary smoke organization" },
  });
  const person = await request(base + "/records", "POST", {
    kind: "people",
    data: {
      name: "Temporary smoke contact",
      email: "smoke@example.com",
      organizationId: organization.id,
      ownerId: userId,
    },
  });
  const opportunity = await request(base + "/records", "POST", {
    kind: "opportunities",
    data: {
      name: "Temporary smoke opportunity",
      organizationId: organization.id,
      personId: person.id,
      ownerId: userId,
      nextAction: "Verify deployment",
      dueDate: "2026-10-01",
    },
  });
  const task = await request(base + "/records", "POST", {
    kind: "tasks",
    data: {
      name: "Temporary smoke task",
      opportunityId: opportunity.id,
      ownerId: userId,
    },
  });
  const done = await request(base + "/records", "POST", {
    id: task.id,
    version: task.version,
    kind: "tasks",
    data: { ...task.data, status: "Done" },
  });
  await request(
    base + "/records",
    "POST",
    { id: task.id, version: task.version, kind: "tasks", data: task.data },
    409,
  );
  const snapshot = await request(base);
  assert.equal(snapshot.records.length, 4);
  assert.ok(snapshot.audit.length >= 5);
  const exported = await request(base + "/export");
  assert.equal(exported.records.length, 4);
  for (const record of [done, opportunity, person, organization])
    await request(base + "/records", "DELETE", {
      id: record.id,
      version: record.version,
    });
  await request("auth/logout", "POST");
  await request("me", "GET", undefined, 401);
  console.log(
    "HTTP smoke passed: SIWE sign-in, authenticated CRUD, linked records, conflict detection, audit, export, and logout.",
  );
} finally {
  // Clean only the new random wallet identity created by this invocation.
  // DATABASE_URL must refer to the deployment under test; otherwise nothing is deleted.
  if (userId && workspaceId && process.env.DATABASE_URL) {
    await transaction(async (db) => {
      const identity = (
        await db.query(
          "SELECT user_id FROM identities WHERE kind='ethereum' AND value=$1",
          [wallet.address.toLowerCase()],
        )
      ).rows[0];
      if (identity?.user_id !== userId)
        throw new Error("Smoke cleanup database does not match deployment.");
      const rows = (
        await db.query("SELECT id FROM records WHERE workspace_id=$1", [
          workspaceId,
        ])
      ).rows;
      if (rows.some((r) => !r.id)) throw new Error("Unexpected smoke data.");
      await db.query("DELETE FROM audit WHERE workspace_id=$1", [workspaceId]);
      await db.query("DELETE FROM records WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query("DELETE FROM invites WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query(
        "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, userId],
      );
      await db.query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
      await db.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      await db.query(
        "DELETE FROM challenges WHERE user_id=$1 OR (kind='ethereum' AND value=$2)",
        [userId, wallet.address.toLowerCase()],
      );
      await db.query("DELETE FROM identities WHERE user_id=$1", [userId]);
      await db.query("DELETE FROM users WHERE id=$1", [userId]);
    });
    console.log("Temporary verification account and records removed.");
  }
  await pool().end();
}
