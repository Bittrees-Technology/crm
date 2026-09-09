import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { pool, transaction } from "../lib/db";
const origin = process.env.SMOKE_URL || process.env.APP_URL!;
if (!origin) throw new Error("Set SMOKE_URL.");
const jar = new Map<string, string>();
let userId: string | undefined;
let workspaceId: string | undefined;
const extraWorkspaces: string[] = [];
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
  let opportunity = await request(base + "/records", "POST", {
    kind: "opportunities",
    data: {
      name: "Temporary smoke opportunity",
      category: "Deployment custom type",
      organizationId: organization.id,
      personId: person.id,
      ownerId: userId,
      nextAction: "Verify deployment",
      dueDate: "2026-10-01",
    },
  });
  for (const currency of ["CAD", "JPY", "BTC", "ETH", "USDC", "BIT", "BTREE"]) {
    const value = "123456789.123456789123456789";
    opportunity = await request(base + "/records", "POST", {
      id: opportunity.id,
      version: opportunity.version,
      kind: "opportunities",
      data: { ...opportunity.data, currency, value },
    });
    const saved = (await request(base)).records.find(
      (r: any) => r.id === opportunity.id,
    );
    assert.equal(saved.data.currency, currency);
    assert.equal(saved.data.value, value);
  }
  assert.ok(
    (await request("me")).opportunityTypes.includes("Deployment custom type"),
  );
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
    visibilityIds: [],
    privateNote: { content: "Synthetic private deployment note", version: 0 },
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
  assert.equal(
    (await request(base + `/records/${task.id}/private-note`)).content,
    "Synthetic private deployment note",
  );
  const access = await request(base + "/access");
  assert.equal(
    access.members.find((m: any) => m.id === userId).records.length,
    4,
  );
  const exported = await request(base + "/export");
  assert.ok(
    !JSON.stringify(exported).includes("Synthetic private deployment note"),
  );
  assert.equal(exported.records.length, 4);
  assert.equal(
    exported.records.find((r: any) => r.id === opportunity.id).data.value,
    "123456789.123456789123456789",
  );
  const scopedInvite = await request(base + "/invites", "POST", {
    email: "scoped-verification@example.com",
    role: "viewer",
    scopeIds: [organization.id],
  });
  const invitationList = await request(base + "/invites");
  assert.deepEqual(invitationList.invites[0].scope_ids, [organization.id]);
  assert.deepEqual(
    (await request("invites/preview", "POST", { token: scopedInvite.token }))
      .scope_ids,
    [organization.id],
  );
  await request(base + "/invites", "DELETE", {
    id: invitationList.invites[0].id,
  });
  await request("me/digest", "PATCH", {
    enabled: false,
    email: "",
    options: { assignment: "all", daysAhead: 30, weekdaysOnly: true },
  });
  assert.equal((await request("me/digest")).options.assignment, "all");
  const preview = await request("me/digest/preview", "POST", {
    assignment: "all",
    daysAhead: 30,
  });
  assert.equal(typeof preview.text, "string");
  for (const record of [done, opportunity, person, organization])
    await request(base + "/records", "DELETE", {
      id: record.id,
      version: record.version,
    });
  const source = await request(
    "workspaces",
    "POST",
    { name: "Temporary merge source" },
    201,
  );
  extraWorkspaces.push(source.id);
  await request("workspaces/" + source.id, "PATCH", {
    name: "Renamed merge source",
  });
  const moving = await request("workspaces/" + source.id + "/records", "POST", {
    kind: "notes",
    data: { name: "Temporary moved note" },
  });
  const review = await request("workspaces/" + source.id + "/review", "POST", {
    action: "merge",
    targetId: workspaceId,
  });
  await request("workspaces/" + source.id + "/manage", "POST", {
    action: "merge",
    targetId: workspaceId,
    review: review.review,
    confirmName: review.source.name,
  });
  const moved = (await request(base)).records.find(
    (r: any) => r.id === moving.id,
  );
  assert.ok(moved);
  await request(base + "/records", "DELETE", {
    id: moved.id,
    version: moved.version,
  });
  const disposable = await request(
    "workspaces",
    "POST",
    { name: "Temporary delete check" },
    201,
  );
  extraWorkspaces.push(disposable.id);
  const deletion = await request(
    "workspaces/" + disposable.id + "/review",
    "POST",
    { action: "delete" },
  );
  await request("workspaces/" + disposable.id + "/manage", "POST", {
    action: "delete",
    review: deletion.review,
    confirmName: deletion.source.name,
  });
  assert.equal((await request("me")).workspaces.length, 1);
  await request("auth/logout", "POST");
  await request("me", "GET", undefined, 401);
  console.log(
    "HTTP smoke passed: SIWE sign-in, authenticated CRUD, linked records, conflict detection, audit, exact fiat/crypto/BIT/BTREE amounts, scoped invitations, email filters/preview, workspace rename/merge/delete, export, and logout.",
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
      for (const id of extraWorkspaces) {
        const owned = (
          await db.query(
            "SELECT 1 FROM members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",
            [id, userId],
          )
        ).rowCount;
        if (!owned) continue;
        await db.query("DELETE FROM audit WHERE workspace_id=$1", [id]);
        await db.query("DELETE FROM records WHERE workspace_id=$1", [id]);
        await db.query("DELETE FROM invites WHERE workspace_id=$1", [id]);
        await db.query(
          "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
          [id, userId],
        );
        await db.query("DELETE FROM workspaces WHERE id=$1", [id]);
      }
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
