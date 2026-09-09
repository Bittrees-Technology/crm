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

test("wallet sign-in messages use the requested network", async () => {
  const w = Wallet.createRandom();
  const c = await startChallenge(request(), {
    kind: "ethereum",
    value: w.address,
    chainId: 8453,
  });
  assert.match(c.body.message!, /Chain ID: 8453/);
  const v = await verifyChallenge(request(cookiePair(c.cookie)), {
    id: c.body.id,
    proof: await w.signMessage(c.body.message!),
  });
  assert.ok(await currentUser(request(cookiePair(v.cookie))));
});
test("invitation recreation revokes old links and owner can revoke the replacement", async () => {
  const { listInvites, revokeInvite, previewInvite } =
    await import("../lib/service");
  const a = await createInvite(owner, workspace, {
    email: "fresh@example.com",
    role: "viewer",
  });
  const b = await createInvite(owner, workspace, {
    email: "fresh@example.com",
    role: "editor",
  });
  await assert.rejects(() => previewInvite(a.token), /expired, revoked/);
  assert.equal((await previewInvite(b.token)).role, "editor");
  const list = await listInvites(owner, workspace);
  assert.ok(list.invites.every((r) => !("hash" in r)));
  const pending = list.invites.find(
    (r) => r.email === "fresh@example.com" && r.status === "Pending",
  );
  assert.ok(pending);
  await assert.rejects(
    () => revokeInvite(other, workspace, pending.id),
    /not found/,
  );
  await revokeInvite(owner, workspace, pending.id);
  await assert.rejects(() => previewInvite(b.token), /expired, revoked/);
});
test("relationship timeline includes indirect task completions, stage changes, and notes", async () => {
  const { timeline } = await import("../lib/service");
  const org = await saveRecord(owner, workspace, {
    kind: "organizations",
    data: { name: "Timeline organization" },
  });
  const person = await saveRecord(owner, workspace, {
    kind: "people",
    data: { name: "Timeline contact", organizationId: org.id },
  });
  const opp = await saveRecord(owner, workspace, {
    kind: "opportunities",
    data: {
      name: "Timeline opportunity",
      personId: person.id,
      ownerId: owner,
      nextAction: "Talk",
      dueDate: "2026-10-03",
    },
  });
  await saveRecord(owner, workspace, {
    id: opp.id,
    version: 1,
    kind: opp.kind,
    data: { ...opp.data, stage: "Proposal" },
  });
  const task = await saveRecord(owner, workspace, {
    kind: "tasks",
    data: { name: "Timeline task", opportunityId: opp.id },
  });
  const done = await saveRecord(owner, workspace, {
    id: task.id,
    version: 1,
    kind: "tasks",
    data: { ...task.data, status: "Done" },
  });
  await saveRecord(owner, workspace, {
    kind: "notes",
    data: {
      name: "Timeline note",
      personId: person.id,
      description: "Useful context",
    },
  });
  const history = await timeline(owner, workspace, org.id);
  assert.ok(
    history.events.some((e) => e.detail.changes?.status?.to === "Done"),
  );
  assert.ok(
    history.events.some((e) => e.detail.changes?.stage?.to === "Proposal"),
  );
  assert.ok(history.events.some((e) => e.note === "Useful context"));
  await deleteRecord(owner, workspace, done.id, done.version);
  assert.ok(
    (await timeline(owner, workspace, org.id)).events.some(
      (e) => e.action === "Record deleted" && e.detail.name === "Timeline task",
    ),
  );
  await assert.rejects(() => timeline(other, workspace, org.id), /not found/);
});
test("daily digest is opt-in, verified, assigned-only, skips empty work, and deduplicates concurrent runs", async () => {
  const { sendDigest, saveDigestPreference } = await import("../lib/digest");
  const sent: { message: any; key: string }[] = [];
  const sender = async (message: any, key: string) => {
    sent.push({ message, key });
  };
  assert.equal(await sendDigest(owner, "2026-10-02", sender), "skipped");
  await assert.rejects(
    () =>
      saveDigestPreference(owner, {
        enabled: true,
        email: "not-verified@example.com",
      }),
    /verify/,
  );
  await saveDigestPreference(owner, {
    enabled: true,
    email: "owner@example.com",
  });
  await saveRecord(owner, workspace, {
    kind: "tasks",
    data: { name: "Digest due task", ownerId: owner, dueDate: "2026-10-02" },
  });
  await saveRecord(owner, workspace, {
    kind: "tasks",
    data: {
      name: "Completed excluded",
      ownerId: owner,
      dueDate: "2026-10-02",
      status: "Done",
    },
  });
  await saveRecord(owner, workspace, {
    kind: "tasks",
    data: { name: "Unassigned excluded", dueDate: "2026-10-02" },
  });
  await saveRecord(owner, workspace, {
    kind: "tasks",
    data: { name: "Future excluded", ownerId: owner, dueDate: "2026-11-01" },
  });
  const result = await Promise.all([
    sendDigest(owner, "2026-10-02", sender),
    sendDigest(owner, "2026-10-02", sender),
  ]);
  assert.deepEqual(result.sort(), ["sent", "skipped"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.text, /Digest due task/);
  assert.doesNotMatch(
    sent[0].message.text,
    /Completed excluded|Unassigned excluded|Future excluded/,
  );
  assert.deepEqual(sent[0].message.to, ["owner@example.com"]);
  await saveDigestPreference(owner, {
    enabled: false,
    email: "owner@example.com",
  });
  assert.equal(await sendDigest(owner, "2026-10-03", sender), "skipped");
});
test("digest retries preserve provider idempotency and disabling cancels delivery", async () => {
  const { sendDigest, saveDigestPreference } = await import("../lib/digest");
  await saveDigestPreference(owner, {
    enabled: true,
    email: "owner@example.com",
  });
  let first: any;
  let key = "";
  assert.equal(
    await sendDigest(owner, "2026-10-04", async (m, k) => {
      first = m;
      key = k;
      throw new Error("Temporary provider error");
    }),
    "failed",
  );
  assert.equal(
    await sendDigest(owner, "2026-10-04", async (m, k) => {
      assert.deepEqual(m, first);
      assert.equal(k, key);
    }),
    "sent",
  );
  assert.equal(
    await sendDigest(owner, "2026-10-05", async () => {
      throw new Error("Temporary provider error");
    }),
    "failed",
  );
  await saveDigestPreference(owner, {
    enabled: false,
    email: "owner@example.com",
  });
  assert.equal(
    await sendDigest(owner, "2026-10-05", async () => {
      throw new Error("Should not send");
    }),
    "skipped",
  );
});
test("empty digests and removed workspace access never deliver record contents", async () => {
  const { sendDigest, saveDigestPreference } = await import("../lib/digest");
  // The other account has a verified invitation email but no due work in its own workspace.
  const email = (
    await pool().query(
      "SELECT value FROM identities WHERE user_id=$1 AND kind='email' LIMIT 1",
      [other],
    )
  ).rows[0].value;
  await saveDigestPreference(other, { enabled: true, email });
  let delivered = 0;
  assert.equal(
    await sendDigest(other, "2026-10-06", async () => {
      delivered++;
    }),
    "skipped",
  );
  assert.equal(delivered, 0);
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'editor')",
    [workspace, other],
  );
  await saveRecord(owner, workspace, {
    kind: "tasks",
    data: {
      name: "Revoked private follow-up",
      ownerId: other,
      dueDate: "2026-10-06",
    },
  });
  assert.equal(
    await sendDigest(other, "2026-10-06", async () => {
      throw new Error("Temporary outage");
    }),
    "failed",
  );
  await pool().query(
    "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
    [workspace, other],
  );
  assert.equal(
    await sendDigest(other, "2026-10-06", async () => {
      delivered++;
    }),
    "skipped",
  );
  assert.equal(delivered, 0);
});
async function recoveryFixture() {
  const target = await walletLogin(),
    source = await walletLogin();
  const targetSession = cookiePair(target.result.cookie),
    sourceSession = cookiePair(source.result.cookie);
  const targetId = (await currentUser(request(targetSession)))!.id,
    sourceId = (await currentUser(request(sourceSession)))!.id;
  const c = await startChallenge(request(targetSession), {
    kind: "ethereum",
    value: source.wallet.address,
    link: true,
  });
  const result = await verifyChallenge(
    request(`${targetSession}; ${cookiePair(c.cookie)}`),
    {
      id: c.body.id,
      proof: await source.wallet.signMessage(c.body.message!),
      recover: true,
    },
  );
  const recovery = (result.body as any).recovery;
  assert.ok(recovery?.token);
  return {
    target,
    source,
    targetSession,
    sourceSession,
    targetId,
    sourceId,
    recovery,
  };
}
async function verifyRecoveryCurrent(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
) {
  const c = await startChallenge(request(f.targetSession), {
    kind: "ethereum",
    value: f.target.wallet.address,
    link: true,
    recoveryToken: f.recovery.token,
  });
  const result = await verifyChallenge(
    request(`${f.targetSession}; ${cookiePair(c.cookie)}`),
    {
      id: c.body.id,
      proof: await f.target.wallet.signMessage(c.body.message!),
    },
  );
  assert.equal((result.body as any).reauthenticated, true);
}
test("account recovery requires both proofs and preserves records, roles, identities and history atomically", async () => {
  const { completeRecovery } = await import("../lib/recovery");
  const f = await recoveryFixture();
  await assert.rejects(
    () => completeRecovery(request(f.targetSession), f.recovery.token),
    /Verify your current/,
  );
  await assert.rejects(
    () => completeRecovery(request(f.sourceSession), f.recovery.token),
    /expired/,
  );
  const sourceWorkspace = f.recovery.other.workspaces[0].id;
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')",
    [sourceWorkspace, f.targetId],
  );
  // Access changed since preview: start over so the confirmation accurately reflects the new role.
  const c = await startChallenge(request(f.targetSession), {
    kind: "ethereum",
    value: f.source.wallet.address,
    link: true,
  });
  f.recovery = (
    await verifyChallenge(
      request(`${f.targetSession}; ${cookiePair(c.cookie)}`),
      {
        id: c.body.id,
        proof: await f.source.wallet.signMessage(c.body.message!),
        recover: true,
      },
    )
  ).body.recovery!;
  const record = await saveRecord(f.sourceId, sourceWorkspace, {
    kind: "tasks",
    data: { name: "Keep this assigned task", ownerId: f.sourceId },
  });
  await verifyRecoveryCurrent(f);
  const results = await Promise.allSettled([
    completeRecovery(request(f.targetSession), f.recovery.token),
    completeRecovery(request(f.targetSession), f.recovery.token),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const result = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof completeRecovery>>
    >
  ).value;
  assert.equal(
    (await currentUser(request(cookiePair(result.cookie))))!.id,
    f.targetId,
  );
  assert.equal(await currentUser(request(f.sourceSession), false), undefined);
  assert.equal(await currentUser(request(f.targetSession), false), undefined);
  const snapshotAfter = await snapshot(f.targetId, sourceWorkspace);
  assert.equal(snapshotAfter.role, "owner");
  await assert.rejects(
    () =>
      saveRecord(f.sourceId, sourceWorkspace, {
        kind: "tasks",
        data: { name: "Stale source write" },
      }),
    /account changed/,
  );
  const kept = snapshotAfter.records.find((r) => r.id === record.id);
  assert.equal(kept.data.name, record.data.name);
  assert.equal(kept.data.ownerId, f.targetId);
  assert.equal(kept.version, record.version + 1);
  assert.ok(snapshotAfter.audit.some((a) => a.action === "Record created"));
  assert.ok(snapshotAfter.audit.some((a) => a.action === "Accounts combined"));
  assert.equal(
    (
      await pool().query("SELECT * FROM identities WHERE user_id=$1", [
        f.targetId,
      ])
    ).rowCount,
    2,
  );
  assert.equal(
    (await pool().query("SELECT * FROM members WHERE user_id=$1", [f.targetId]))
      .rowCount,
    2,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT merged_into,digest_enabled FROM users WHERE id=$1",
        [f.sourceId],
      )
    ).rows[0].merged_into,
    f.targetId,
  );
  const signIn = await walletLogin(f.source.wallet);
  assert.equal(
    (await currentUser(request(cookiePair(signIn.result.cookie))))!.id,
    f.targetId,
  );
});
test("recovery rejects a wrong current method, changed access, expired intent and bad proof without moving identities", async () => {
  const { completeRecovery } = await import("../lib/recovery");
  const f = await recoveryFixture();
  await assert.rejects(
    () =>
      startChallenge(request(f.targetSession), {
        kind: "ethereum",
        value: f.source.wallet.address,
        link: true,
        recoveryToken: f.recovery.token,
      }),
    /current account/,
  );
  await verifyRecoveryCurrent(f);
  await pool().query("UPDATE members SET role='editor' WHERE user_id=$1", [
    f.sourceId,
  ]);
  await assert.rejects(
    () => completeRecovery(request(f.targetSession), f.recovery.token),
    /access changed/,
  );
  assert.equal(
    (
      await pool().query("SELECT user_id FROM identities WHERE value=$1", [
        f.source.wallet.address.toLowerCase(),
      ])
    ).rows[0].user_id,
    f.sourceId,
  );
  await pool().query(
    "UPDATE identity_recoveries SET expires_at=now()-interval '1 minute' WHERE hash=$1",
    [hash(f.recovery.token)],
  );
  await assert.rejects(
    () => completeRecovery(request(f.targetSession), f.recovery.token),
    /expired/,
  );
  const c = await startChallenge(request(f.targetSession), {
    kind: "ethereum",
    value: f.source.wallet.address,
    link: true,
  });
  await assert.rejects(
    () =>
      verifyChallenge(request(`${f.targetSession}; ${cookiePair(c.cookie)}`), {
        id: c.body.id,
        proof: "bad",
        recover: true,
      }),
    /Verification failed/,
  );
});
