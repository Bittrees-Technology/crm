import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { pool, schema } from "../lib/db";
import {
  startChallenge,
  verifyChallenge,
  currentUser,
  checkOrigin,
  cookieName,
  hash,
} from "../lib/auth";
import {
  saveRecord,
  snapshot,
  deleteRecord,
  importRecords,
  createInvite,
  acceptInvite,
  updateMember,
} from "../lib/service";
const origin = process.env.APP_URL!;
const request = (cookie = "", url = origin) =>
  new Request(url + "/api/test", {
    method: "POST",
    headers: { origin: url, cookie },
  });
const cookiePair = (s: string) => s.split(";")[0];
let owner: string,
  other: string,
  workspace: string,
  otherWorkspace: string,
  session: string;
async function walletLogin(
  wallet = Wallet.createRandom(),
  linkCookie?: string,
) {
  const challenge = await startChallenge(request(linkCookie), {
    kind: "ethereum",
    value: wallet.address,
    link: !!linkCookie,
  });
  const proof = await wallet.signMessage(challenge.body.message!);
  const result = await verifyChallenge(
    request(
      [cookiePair(challenge.cookie), linkCookie].filter(Boolean).join("; "),
    ),
    { id: challenge.body.id, proof },
  );
  return { challenge, proof, result, wallet };
}
before(async () => {
  if (!process.env.DATABASE_URL?.endsWith("/crm_test"))
    throw new Error("Tests require a dedicated crm_test database.");
  await pool().query(schema);
  await pool().query(
    "TRUNCATE invites,audit,records,members,workspaces,challenges,sessions,identities,users,rate_limits RESTART IDENTITY CASCADE",
  );
  const a = await walletLogin();
  session = cookiePair(a.result.cookie);
  owner = (await currentUser(request(session)))!.id;
  workspace = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      owner,
    ])
  ).rows[0].workspace_id;
  const b = await walletLogin();
  other = (await currentUser(request(cookiePair(b.result.cookie))))!.id;
  otherWorkspace = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      other,
    ])
  ).rows[0].workspace_id;
});
after(() => pool().end());
test("SIWE creates a verified identity and an expiring session", async () => {
  assert.ok(owner);
  const r = await pool().query("SELECT * FROM identities WHERE user_id=$1", [
    owner,
  ]);
  assert.equal(r.rows[0].kind, "ethereum");
});
test("SIWE challenges are single-use", async () => {
  const a = await walletLogin();
  await assert.rejects(
    async () =>
      verifyChallenge(request(cookiePair(a.challenge.cookie)), {
        id: a.challenge.body.id,
        proof: a.proof,
      }),
    /expired/,
  );
});
test("SIWE is bound to browser, message, and origin", async () => {
  const wallet = Wallet.createRandom(),
    c = await startChallenge(request(), {
      kind: "ethereum",
      value: wallet.address,
    }),
    proof = await wallet.signMessage(c.body.message!);
  await assert.rejects(
    async () => verifyChallenge(request(), { id: c.body.id, proof }),
    /expired/,
  );
  assert.throws(
    () => checkOrigin(request("", "https://attacker.example")),
    /origin/,
  );
  await assert.rejects(
    async () =>
      verifyChallenge(request(cookiePair(c.cookie)), {
        id: c.body.id,
        proof: await wallet.signMessage(
          c.body.message!.replace("Sign in", "Log in"),
        ),
      }),
    /Verification failed/,
  );
});
test("expired SIWE challenge cannot create a session", async () => {
  const wallet = Wallet.createRandom(),
    c = await startChallenge(request(), {
      kind: "ethereum",
      value: wallet.address,
    });
  await pool().query(
    "UPDATE challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
    [c.body.id],
  );
  await assert.rejects(
    async () =>
      verifyChallenge(request(cookiePair(c.cookie)), {
        id: c.body.id,
        proof: await wallet.signMessage(c.body.message!),
      }),
    /expired/,
  );
});
test("invalid proofs are bounded to five attempts", async () => {
  const wallet = Wallet.createRandom(),
    c = await startChallenge(request(), {
      kind: "ethereum",
      value: wallet.address,
    });
  for (let i = 0; i < 5; i++)
    await assert.rejects(async () =>
      verifyChallenge(request(cookiePair(c.cookie)), {
        id: c.body.id,
        proof: "bad",
      }),
    );
  await assert.rejects(
    async () =>
      verifyChallenge(request(cookiePair(c.cookie)), {
        id: c.body.id,
        proof: await wallet.signMessage(c.body.message!),
      }),
    /expired/,
  );
});
test("unrelated users cannot read or edit another workspace", async () => {
  await assert.rejects(() => snapshot(other, workspace), /not found/);
  await assert.rejects(
    () =>
      saveRecord(other, workspace, {
        kind: "people",
        data: { name: "No access" },
      }),
    /not found/,
  );
});
test("cross-workspace relation IDs are rejected", async () => {
  const org = await saveRecord(other, otherWorkspace, {
    kind: "organizations",
    data: { name: "Other org" },
  });
  await assert.rejects(
    () =>
      saveRecord(owner, workspace, {
        kind: "people",
        data: { name: "Contact", organizationId: org.id },
      }),
    /not in this workspace/,
  );
});
test("record writes detect conflicts and references prevent deletion", async () => {
  const org = await saveRecord(owner, workspace, {
    kind: "organizations",
    data: { name: "Our org" },
  });
  const person = await saveRecord(owner, workspace, {
    kind: "people",
    data: { name: "Pat", organizationId: org.id },
  });
  const updated = await saveRecord(owner, workspace, {
    id: person.id,
    version: 1,
    kind: "people",
    data: { ...person.data, title: "Lead" },
  });
  assert.equal(updated.version, 2);
  await assert.rejects(
    () =>
      saveRecord(owner, workspace, {
        id: person.id,
        version: 1,
        kind: "people",
        data: { name: "Stale" },
      }),
    /changed/,
  );
  await assert.rejects(
    () => deleteRecord(owner, workspace, org.id, 1),
    /Other records/,
  );
  await deleteRecord(owner, workspace, person.id, 2);
  await deleteRecord(owner, workspace, org.id, 1);
});
test("active opportunities require an assigned owner and dated next step", async () => {
  await assert.rejects(
    () =>
      saveRecord(owner, workspace, {
        kind: "opportunities",
        data: { name: "Unowned" },
      }),
    /owner/,
  );
  const r = await saveRecord(owner, workspace, {
    kind: "opportunities",
    data: {
      name: "Partner",
      ownerId: owner,
      nextAction: "Call",
      dueDate: "2026-10-01",
    },
  });
  assert.equal(r.data.stage, "Introduction");
});
test("CSV import is atomic, validates records, and skips duplicates", async () => {
  const r = await importRecords(owner, workspace, {
    kind: "people",
    rows: [
      { name: "A", email: "a@example.com" },
      { name: "A", email: "a@example.com" },
      { name: "B" },
    ],
  });
  assert.deepEqual(r, { imported: 2, skipped: 1 });
  await assert.rejects(() =>
    importRecords(owner, workspace, {
      kind: "people",
      rows: [{ name: "Valid" }, { name: "Bad", email: "broken" }],
    }),
  );
  const s = await snapshot(owner, workspace);
  assert.ok(!s.records.some((r) => r.data.name === "Valid"));
});
test("viewer role is enforced for mutation and invites", async () => {
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')",
    [workspace, other],
  );
  await snapshot(other, workspace);
  await assert.rejects(
    () => saveRecord(other, workspace, { kind: "notes", data: { name: "No" } }),
    /role/,
  );
  await assert.rejects(
    () =>
      createInvite(other, workspace, {
        email: "x@example.com",
        role: "editor",
      }),
    /role/,
  );
});
test("invites require the specific verified email and cannot be reused", async () => {
  const invitation = await createInvite(owner, workspace, {
    email: "invitee@example.com",
    role: "editor",
  });
  await assert.rejects(
    () => acceptInvite(other, invitation.token),
    /Verify the email/,
  );
  await pool().query(
    "INSERT INTO identities(kind,value,user_id) VALUES('email','invitee@example.com',$1)",
    [other],
  );
  await acceptInvite(other, invitation.token);
  await assert.rejects(
    () => acceptInvite(other, invitation.token),
    /invalid or expired/,
  );
});
test("owner can revoke a member and access stops immediately", async () => {
  await updateMember(owner, workspace, { userId: other, role: "remove" });
  await assert.rejects(() => snapshot(other, workspace), /not found/);
  await assert.rejects(
    () => updateMember(owner, workspace, { userId: owner, role: "viewer" }),
    /owner/,
  );
});
test("explicit wallet linking preserves user and rotates session", async () => {
  const r = await walletLogin(Wallet.createRandom(), session);
  assert.equal(
    (await currentUser(request(cookiePair(r.result.cookie))))!.id,
    owner,
  );
  await assert.rejects(() => currentUser(request(session)), /sign in/);
  session = cookiePair(r.result.cookie);
});
test("identity already owned by another account cannot be linked", async () => {
  const a = await walletLogin();
  const c = await startChallenge(request(session), {
    kind: "ethereum",
    value: a.wallet.address,
    link: true,
  });
  await assert.rejects(
    async () =>
      verifyChallenge(request(`${cookiePair(c.cookie)}; ${session}`), {
        id: c.body.id,
        proof: await a.wallet.signMessage(c.body.message!),
      }),
    /already belongs/,
  );
});
test("email code can link to wallet account and later sign in to same user", async () => {
  let code = "";
  const log = console.info;
  console.info = (v: string) => {
    code = v.split(": ").at(-1)!;
  };
  let c;
  try {
    c = await startChallenge(request(session), {
      kind: "email",
      value: "owner@example.com",
      link: true,
    });
  } finally {
    console.info = log;
  }
  assert.match(code, /^\d{8}$/);
  const v = await verifyChallenge(
    request(`${cookiePair(c.cookie)}; ${session}`),
    { id: c.body.id, proof: code },
  );
  assert.equal((await currentUser(request(cookiePair(v.cookie))))!.id, owner);
  console.info = (v: string) => {
    code = v.split(": ").at(-1)!;
  };
  let second;
  try {
    second = await startChallenge(request(), {
      kind: "email",
      value: "owner@example.com",
    });
  } finally {
    console.info = log;
  }
  const signedIn = await verifyChallenge(request(cookiePair(second.cookie)), {
    id: second.body.id,
    proof: code,
  });
  assert.equal(
    (await currentUser(request(cookiePair(signedIn.cookie))))!.id,
    owner,
  );
});
test("expired sessions fail and session secrets are only stored as hashes", async () => {
  const a = await walletLogin();
  const raw = cookiePair(a.result.cookie).slice(cookieName.length + 1);
  const db = await pool().query("SELECT hash FROM sessions WHERE hash=$1", [
    hash(raw),
  ]);
  assert.equal(db.rows[0].hash, hash(raw));
  assert.notEqual(db.rows[0].hash, raw);
  await pool().query(
    "UPDATE sessions SET expires_at=now()-interval '1 day' WHERE hash=$1",
    [hash(raw)],
  );
  await assert.rejects(
    () => currentUser(request(cookiePair(a.result.cookie))),
    /sign in/,
  );
});
