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
    visibilityIds: [f.sourceId],
    privateNote: { content: "Recovered private context", version: 0 },
  });
  await pool().query(
    "INSERT INTO user_opportunity_types(user_id,key,label) VALUES($1,'source label','Source label'),($2,'target label','Target label')",
    [f.sourceId, f.targetId],
  );
  await pool().query(
    "INSERT INTO record_private_notes(record_id,author_id,content) VALUES($1,$2,'Existing target context')",
    [record.id, f.targetId],
  );
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
  assert.deepEqual(
    (
      await pool().query(
        "SELECT label FROM user_opportunity_types WHERE user_id=$1 ORDER BY label",
        [f.targetId],
      )
    ).rows.map((r) => r.label),
    ["Source label", "Target label"],
  );
  assert.equal(
    (
      await pool().query(
        "SELECT * FROM user_opportunity_types WHERE user_id=$1",
        [f.sourceId],
      )
    ).rowCount,
    0,
  );
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
  assert.equal(kept.version, record.version + 2);
  assert.deepEqual(kept.visibility_ids, [f.targetId]);
  const { privateNote } = await import("../lib/sharing");
  const recoveredNote = await privateNote(
    f.targetId,
    sourceWorkspace,
    record.id,
  );
  assert.match(recoveredNote.content, /Recovered private context/);
  assert.match(recoveredNote.content, /Existing target context/);
  assert.equal(
    (
      await pool().query(
        "SELECT * FROM record_private_notes WHERE author_id=$1",
        [f.sourceId],
      )
    ).rowCount,
    0,
  );
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

test("custom opportunity types persist per user, deduplicate, and roll back with failed saves", async () => {
  const list = async (id: string) =>
    (
      await pool().query(
        "SELECT label FROM user_opportunity_types WHERE user_id=$1",
        [id],
      )
    ).rows.map((r) => r.label);
  const first = await saveRecord(owner, workspace, {
    kind: "opportunities",
    data: {
      name: "Custom type test",
      stage: "Won",
      category: "  Ecosystem   grant  ",
    },
  });
  assert.equal(first.data.category, "Ecosystem grant");
  const second = await saveRecord(owner, workspace, {
    kind: "opportunities",
    data: {
      name: "Custom type duplicate",
      stage: "Won",
      category: "ecosystem grant",
    },
  });
  assert.deepEqual(await list(owner), ["Ecosystem grant"]);
  assert.deepEqual(await list(other), []);
  await assert.rejects(
    () =>
      saveRecord(other, workspace, {
        kind: "opportunities",
        data: { name: "Denied", stage: "Won", category: "Not saved" },
      }),
    /Workspace not found/,
  );
  await assert.rejects(
    () =>
      saveRecord(owner, workspace, {
        id: first.id,
        version: 999,
        kind: "opportunities",
        data: { ...first.data, category: "Failed save label" },
      }),
    /record changed/,
  );
  assert.deepEqual(await list(owner), ["Ecosystem grant"]);
  const builtIn = await saveRecord(owner, workspace, {
    kind: "opportunities",
    data: { name: "Default type", stage: "Won", category: " grant " },
  });
  assert.equal(builtIn.data.category, "Grant");
  for (const record of [first, second, builtIn])
    await deleteRecord(owner, workspace, record.id, record.version);
  assert.deepEqual(await list(owner), ["Ecosystem grant"]);
});

async function scopedFixture() {
  const a = await walletLogin(),
    b = await walletLogin();
  const actor = (await currentUser(request(cookiePair(a.result.cookie))))!.id;
  const collaborator = (await currentUser(
    request(cookiePair(b.result.cookie)),
  ))!.id;
  const w = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      actor,
    ])
  ).rows[0].workspace_id;
  const root = await saveRecord(actor, w, {
    kind: "projects",
    data: { name: "Shared project" },
  });
  const hidden = await saveRecord(actor, w, {
    kind: "organizations",
    data: { name: "Private organization" },
  });
  const task = await saveRecord(actor, w, {
    kind: "tasks",
    data: {
      name: "Shared task",
      projectId: root.id,
      organizationId: hidden.id,
      ownerId: collaborator,
      dueDate: new Date().toISOString().slice(0, 10),
    },
  }).catch(async () => {
    await pool().query(
      "INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,'editor',$3)",
      [w, collaborator, [root.id]],
    );
    return saveRecord(actor, w, {
      kind: "tasks",
      data: {
        name: "Shared task",
        projectId: root.id,
        organizationId: hidden.id,
        ownerId: collaborator,
        dueDate: new Date().toISOString().slice(0, 10),
      },
    });
  });
  return { actor, collaborator, w, root, hidden, task };
}
test("project-limited collaborators cannot read, export, edit, import, or link hidden records", async () => {
  const { timeline } = await import("../lib/service");
  const f = await scopedFixture();
  const view = await snapshot(f.collaborator, f.w);
  assert.equal(view.limited, true);
  assert.deepEqual(
    new Set(view.records.map((r) => r.id)),
    new Set([f.root.id, f.task.id]),
  );
  assert.equal(
    view.records.find((r) => r.id === f.task.id)!.data.organizationId,
    "",
  );
  assert.equal(view.audit.length, 0);
  assert.doesNotMatch(JSON.stringify(view), /Private organization/);
  await assert.rejects(
    () => timeline(f.collaborator, f.w, f.hidden.id),
    /Record not found/,
  );
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        id: f.hidden.id,
        version: 1,
        kind: "organizations",
        data: { ...f.hidden.data, name: "Unauthorized" },
      }),
    /Record not found/,
  );
  await assert.rejects(
    () => deleteRecord(f.collaborator, f.w, f.hidden.id, 1),
    /Record not found/,
  );
  await assert.rejects(
    () =>
      importRecords(f.collaborator, f.w, {
        kind: "people",
        rows: [{ name: "No import" }],
      }),
    /whole-workspace/,
  );
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        kind: "tasks",
        data: {
          name: "Hidden link",
          organizationId: f.hidden.id,
          projectId: f.root.id,
        },
      }),
    /outside your/,
  );
  const edited = await saveRecord(f.collaborator, f.w, {
    id: f.task.id,
    version: f.task.version,
    kind: "tasks",
    data: {
      ...view.records.find((r) => r.id === f.task.id)!.data,
      name: "Updated visible task",
    },
  });
  assert.equal(edited.data.organizationId, "");
  assert.equal(
    (await pool().query("SELECT data FROM records WHERE id=$1", [f.task.id]))
      .rows[0].data.organizationId,
    f.hidden.id,
  );
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        id: f.task.id,
        version: edited.version,
        kind: "tasks",
        data: { ...edited.data, projectId: "" },
      }),
    /Keep this record linked/,
  );
  const events = await timeline(f.collaborator, f.w, f.root.id);
  assert.doesNotMatch(
    JSON.stringify(events),
    new RegExp(f.hidden.id + "|Private organization"),
  );
  await updateMember(f.actor, f.w, {
    userId: f.collaborator,
    role: "viewer",
    scopeIds: [f.hidden.id],
  });
  const changed = await snapshot(f.collaborator, f.w);
  assert.ok(changed.records.some((r) => r.id === f.hidden.id));
  assert.ok(!changed.records.some((r) => r.id === f.root.id));
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        kind: "tasks",
        data: { name: "Viewer write", organizationId: f.hidden.id },
      }),
    /role does not allow/,
  );
});
test("scoped invitations keep their scope on acceptance and reject foreign roots", async () => {
  const f = await scopedFixture();
  const login = await walletLogin();
  const invited = (await currentUser(request(cookiePair(login.result.cookie))))!
    .id;
  const email = `scope-${randomUUID()}@example.com`;
  await pool().query(
    "INSERT INTO identities(kind,value,user_id) VALUES('email',$1,$2)",
    [email, invited],
  );
  await assert.rejects(
    () =>
      createInvite(f.actor, f.w, {
        email,
        role: "editor",
        scopeIds: [randomUUID()],
      }),
    /Select at least/,
  );
  const invite = await createInvite(f.actor, f.w, {
    email,
    role: "viewer",
    scopeIds: [f.root.id],
  });
  await acceptInvite(invited, invite.token);
  const view = await snapshot(invited, f.w);
  assert.equal(view.role, "viewer");
  assert.equal(view.limited, true);
  assert.ok(!view.records.some((r) => r.id === f.hidden.id));
});
test("workspace management requires ownership and a fresh typed review, preserves links on merge, and supports deletion", async () => {
  const { workspaceOperation } = await import("../lib/workspaces");
  const f = await scopedFixture();
  const target = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Merge destination')",
    [target],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [target, f.actor],
  );
  await assert.rejects(
    () => workspaceOperation(f.collaborator, f.w, { action: "delete" }),
    /must own/,
  );
  const first: any = await workspaceOperation(f.actor, f.w, {
    action: "merge",
    targetId: target,
  });
  await assert.rejects(
    () =>
      workspaceOperation(
        f.actor,
        f.w,
        {
          action: "merge",
          targetId: target,
          review: first.review,
          confirmName: "wrong",
        },
        true,
      ),
    /did not match/,
  );
  await saveRecord(f.actor, f.w, {
    kind: "notes",
    data: { name: "After review", projectId: f.root.id },
    privateNote: { content: "Preserve private on merge", version: 0 },
    visibilityIds: [],
  });
  await assert.rejects(
    () =>
      workspaceOperation(
        f.actor,
        f.w,
        {
          action: "merge",
          targetId: target,
          review: first.review,
          confirmName: first.source.name,
        },
        true,
      ),
    /workspace changed/,
  );
  const review: any = await workspaceOperation(f.actor, f.w, {
    action: "merge",
    targetId: target,
  });
  await workspaceOperation(
    f.actor,
    f.w,
    {
      action: "merge",
      targetId: target,
      review: review.review,
      confirmName: review.source.name,
    },
    true,
  );
  const merged = await snapshot(f.actor, target);
  assert.equal(
    merged.records.find((r) => r.id === f.task.id)!.data.projectId,
    f.root.id,
  );
  assert.equal(
    merged.records.find((r) => r.id === f.task.id)!.version,
    f.task.version + 1,
  );
  const privateRecord = merged.records.find(
    (r) => r.data.name === "After review",
  )!;
  assert.deepEqual(privateRecord.visibility_ids, []);
  const { privateNote } = await import("../lib/sharing");
  assert.equal(
    (await privateNote(f.actor, target, privateRecord.id)).content,
    "Preserve private on merge",
  );
  const limited = await snapshot(f.collaborator, target);
  assert.equal(limited.limited, true);
  assert.ok(!limited.records.some((r) => r.id === f.hidden.id));
  assert.equal(
    (await pool().query("SELECT id FROM workspaces WHERE id=$1", [f.w]))
      .rowCount,
    0,
  );
  const last: any = await workspaceOperation(f.actor, target, {
    action: "delete",
  });
  await assert.rejects(
    () =>
      workspaceOperation(
        f.actor,
        target,
        {
          action: "delete",
          review: last.review,
          confirmName: last.source.name,
        },
        true,
      ),
    /last workspace/,
  );
  const backup = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Kept workspace')",
    [backup],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [backup, f.actor],
  );
  const deletion: any = await workspaceOperation(f.actor, target, {
    action: "delete",
  });
  await workspaceOperation(
    f.actor,
    target,
    {
      action: "delete",
      review: deletion.review,
      confirmName: deletion.source.name,
    },
    true,
  );
  assert.equal(
    (
      await pool().query("SELECT id FROM records WHERE workspace_id=$1", [
        target,
      ])
    ).rowCount,
    0,
  );
});
test("daily email filters and preview respect scoped access, assignments, workspace selection, and dates", async () => {
  const { previewDigest, saveDigestPreference, sendDigest } =
    await import("../lib/digest");
  const f = await scopedFixture();
  const day = new Date().toISOString().slice(0, 10);
  await saveRecord(f.actor, f.w, {
    kind: "tasks",
    data: {
      name: "Hidden digest item",
      organizationId: f.hidden.id,
      ownerId: f.collaborator,
      dueDate: day,
    },
  });
  await saveRecord(f.actor, f.w, {
    kind: "tasks",
    data: {
      name: "Visible team follow-up",
      projectId: f.root.id,
      ownerId: f.actor,
      dueDate: day,
    },
  });
  const mine = await previewDigest(f.collaborator, { daysAhead: 0 });
  assert.match(mine.text, /Shared task/);
  assert.doesNotMatch(
    mine.text,
    /Hidden digest item|Private organization|Visible team follow-up/,
  );
  const all = await previewDigest(f.collaborator, {
    assignment: "all",
    daysAhead: 0,
  });
  assert.match(all.text, /Visible team follow-up/);
  assert.doesNotMatch(all.text, /Hidden digest item|Private organization/);
  assert.equal(
    (await previewDigest(f.collaborator, { workspaceIds: [] })).count,
    0,
  );
  assert.equal(
    (await previewDigest(f.collaborator, { kinds: ["opportunities"] })).count,
    0,
  );
  const email = `digest-${randomUUID()}@example.com`;
  await pool().query(
    "INSERT INTO identities(kind,value,user_id) VALUES('email',$1,$2)",
    [email, f.collaborator],
  );
  await saveDigestPreference(f.collaborator, {
    enabled: true,
    email,
    options: { assignment: "all", daysAhead: 0 },
  });
  let message: any;
  assert.equal(
    await sendDigest(f.collaborator, day, async (m) => {
      message = m;
    }),
    "sent",
  );
  assert.match(message.text, /Due today/);
  assert.match(message.text, /workspace=/);
  assert.match(message.html, /Open this record/);
  assert.doesNotMatch(message.text, /Hidden digest item|Private organization/);
});

test("private owner notes are author-only and never enter shared records, activity, or digests", async () => {
  const { privateNote, inspectAccess } = await import("../lib/sharing");
  const { timeline } = await import("../lib/service");
  const { previewDigest } = await import("../lib/digest");
  const f = await scopedFixture();
  const secret = "AUTHOR ONLY secret context";
  const r = await saveRecord(f.actor, f.w, {
    id: f.task.id,
    kind: "tasks",
    version: f.task.version,
    data: f.task.data,
    privateNote: { content: secret, version: 0 },
  });
  assert.equal((await privateNote(f.actor, f.w, r.id)).content, secret);
  await assert.rejects(
    () => privateNote(f.collaborator, f.w, r.id),
    /role does not allow/,
  );
  await assert.rejects(
    () => inspectAccess(f.collaborator, f.w),
    /role does not allow/,
  );
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        id: r.id,
        kind: r.kind,
        version: r.version,
        data: r.data,
        privateNote: { content: "injected", version: 0 },
      }),
    /Only workspace owners/,
  );
  for (const user of [f.actor, f.collaborator]) {
    assert.ok(!JSON.stringify(await snapshot(user, f.w)).includes(secret));
    assert.ok(
      !JSON.stringify(await timeline(user, f.w, r.id)).includes(secret),
    );
    assert.ok(
      !JSON.stringify(
        await previewDigest(user, { assignment: "all" }),
      ).includes(secret),
    );
  }
  await pool().query(
    "UPDATE members SET role='owner',scope_ids=NULL WHERE workspace_id=$1 AND user_id=$2",
    [f.w, f.collaborator],
  );
  assert.deepEqual(await privateNote(f.collaborator, f.w, r.id), {
    content: "",
    version: 0,
  });
  const second = await saveRecord(f.collaborator, f.w, {
    id: r.id,
    kind: r.kind,
    version: r.version,
    data: r.data,
    privateNote: { content: "SECOND OWNER", version: 0 },
  });
  assert.equal((await privateNote(f.actor, f.w, r.id)).content, secret);
  assert.equal(
    (await privateNote(f.collaborator, f.w, r.id)).content,
    "SECOND OWNER",
  );
  await assert.rejects(
    () =>
      saveRecord(f.actor, f.w, {
        id: r.id,
        kind: r.kind,
        version: second.version,
        data: { ...r.data, name: "Must roll back" },
        visibilityIds: [],
        privateNote: { content: "stale", version: 0 },
      }),
    /private note changed/,
  );
  const unchanged = (await snapshot(f.actor, f.w)).records.find(
    (v: any) => v.id === r.id,
  )!;
  assert.equal(unchanged.data.name, r.data.name);
  assert.equal(unchanged.visibility_ids, null);
  assert.equal((await privateNote(f.actor, f.w, r.id)).content, secret);
});
test("record sharing restricts whole-workspace members and grants scoped members only the selected record", async () => {
  const { inspectAccess } = await import("../lib/sharing");
  const f = await scopedFixture();
  const child = await saveRecord(f.actor, f.w, {
    kind: "notes",
    data: { name: "Hidden child", organizationId: f.hidden.id },
  });
  const direct = await saveRecord(f.actor, f.w, {
    id: f.hidden.id,
    kind: f.hidden.kind,
    version: f.hidden.version,
    data: f.hidden.data,
    visibilityIds: [f.collaborator],
  });
  let view = await snapshot(f.collaborator, f.w);
  assert.ok(view.records.some((r: any) => r.id === direct.id));
  assert.ok(!view.records.some((r: any) => r.id === child.id));
  assert.ok(view.records.every((r: any) => !("visibility_ids" in r)));
  const blocked = await saveRecord(f.actor, f.w, {
    id: f.root.id,
    kind: f.root.kind,
    version: f.root.version,
    data: f.root.data,
    visibilityIds: [],
  });
  view = await snapshot(f.collaborator, f.w);
  assert.deepEqual(
    view.records.map((r: any) => r.id),
    [direct.id],
  );
  await updateMember(f.actor, f.w, {
    userId: f.collaborator,
    role: "editor",
    scopeIds: null,
  });
  view = await snapshot(f.collaborator, f.w);
  assert.ok(!view.records.some((r: any) => r.id === blocked.id));
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        id: blocked.id,
        kind: blocked.kind,
        version: blocked.version,
        data: blocked.data,
      }),
    /not found/,
  );
  await assert.rejects(
    () =>
      saveRecord(f.collaborator, f.w, {
        id: direct.id,
        kind: direct.kind,
        version: direct.version,
        data: direct.data,
        visibilityIds: null,
      }),
    /Only workspace owners/,
  );
  await assert.rejects(
    () =>
      saveRecord(f.actor, f.w, {
        id: direct.id,
        kind: direct.kind,
        version: direct.version,
        data: direct.data,
        visibilityIds: [randomUUID()],
      }),
    /current workspace members/,
  );
  await assert.rejects(
    () =>
      importRecords(f.collaborator, f.w, {
        kind: "people",
        rows: [{ name: "Illegal link", projectId: blocked.id }],
      }),
    /outside your collaboration access/,
  );
  assert.deepEqual(
    await importRecords(f.collaborator, f.w, {
      kind: "people",
      rows: [{ name: "Deduplicate new" }, { name: "Deduplicate new" }],
    }),
    { imported: 1, skipped: 1 },
  );
  const report = await inspectAccess(f.actor, f.w);
  for (const member of report.members) {
    const actual = await snapshot(member.id, f.w);
    assert.deepEqual(
      member.records.map((r) => r.id).sort(),
      actual.records.map((r: any) => r.id).sort(),
    );
  }
  await saveRecord(f.actor, f.w, {
    id: f.task.id,
    kind: f.task.kind,
    version: f.task.version,
    data: { ...f.task.data, ownerId: f.actor },
  });
  await updateMember(f.actor, f.w, { userId: f.collaborator, role: "remove" });
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'editor')",
    [f.w, f.collaborator],
  );
  const reinvited = await snapshot(f.collaborator, f.w);
  assert.ok(!reinvited.records.some((r: any) => r.id === direct.id));
});

test("AutoNote grants enforce PKCE, sharing, idempotency and revocation", async () => {
  const api = await import("../lib/autonote");
  const { createHash, randomBytes } = await import("node:crypto");
  const actor = await walletLogin(),
    uid = (await currentUser(request(cookiePair(actor.result.cookie))))!.id;
  const ws = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      uid,
    ])
  ).rows[0].workspace_id;
  const dest = await saveRecord(uid, ws, {
    kind: "organizations",
    data: { name: "Synthetic AutoNote target" },
    visibilityIds: [uid],
  });
  const verifier = randomBytes(32).toString("hex"),
    state = randomBytes(32).toString("hex");
  const connect = await api.authorize(uid, {
    workspaceId: ws,
    targetId: dest.id,
    state,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const code = new URL(connect.url).searchParams.get("code")!;
  await assert.rejects(api.exchange({ code, verifier: "0".repeat(64) }));
  const grant = await api.exchange({ code, verifier });
  await assert.rejects(api.exchange({ code, verifier }));
  const content = {
    meetingId: randomUUID(),
    title: "Synthetic meeting",
    summary: "Approved summary",
    actions: [{ id: "action-1", text: "Prepare report", dueDate: null }],
  };
  await assert.rejects(
    api.publish(grant.token, { ...content, summary: " ", actions: [] }),
  );
  await assert.rejects(
    api.publish(grant.token, {
      ...content,
      actions: [content.actions[0], content.actions[0]],
    }),
  );
  const first = await api.publish(grant.token, content),
    repeated = await api.publish(grant.token, content);
  assert.equal(first.items.length, 2);
  assert.ok(repeated.items.every((i) => i.existing));
  assert.deepEqual(
    first.items.map((i) => i.recordId),
    repeated.items.map((i) => i.recordId),
  );
  for (const item of first.items) {
    const record = (
      await pool().query("SELECT * FROM records WHERE id=$1", [item.recordId])
    ).rows[0];
    assert.deepEqual(record.visibility_ids, [uid]);
    assert.equal(record.data.organizationId, dest.id);
    assert.ok(!record.data.ownerId);
  }
  await pool().query(
    "UPDATE members SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",
    [uid, ws],
  );
  await assert.rejects(
    api.publish(grant.token, { ...content, meetingId: randomUUID() }),
  );
  await pool().query(
    "UPDATE members SET role='owner' WHERE user_id=$1 AND workspace_id=$2",
    [uid, ws],
  );
  await api.revokeUser(uid, grant.grantId);
  await assert.rejects(api.publish(grant.token, content));
});
