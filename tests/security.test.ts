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

test("AI selected-record grants enforce PKCE, privacy, current membership and revocation", async () => {
  const ai = await import("../lib/ai");
  const { createHash } = await import("node:crypto");
  const { recordSchema, kinds } = await import("../lib/model");
  const actor = randomUUID(),
    stranger = randomUUID(),
    reader = randomUUID(),
    w = randomUUID(),
    hidden = randomUUID(),
    ids = kinds.map(() => randomUUID());
  await pool().query(
    "INSERT INTO users(id,name) VALUES($1,'AI fixture'),($2,'Other fixture'),($3,'Viewer fixture')",
    [actor, stranger, reader],
  );
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'AI isolated fixture')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",
    [w, actor, reader],
  );
  await pool().query(
    "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,'projects',$3,$4)",
    [
      hidden,
      w,
      JSON.stringify(recordSchema.parse({ name: "HIDDEN_REFERENCE_SENTINEL" })),
      [actor],
    ],
  );
  for (let i = 0; i < kinds.length; i++)
    await pool().query(
      "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,$3,$4)",
      [
        ids[i],
        w,
        kinds[i],
        JSON.stringify(
          recordSchema.parse({
            name: "Selected " + kinds[i],
            projectId: hidden,
            ownerId: actor,
          }),
        ),
      ],
    );
  await pool().query(
    "INSERT INTO record_private_notes(record_id,author_id,content) VALUES($1,$2,'PRIVATE_OWNER_NOTE_SENTINEL')",
    [ids[0], actor],
  );
  const verifier = "v".repeat(64),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const input = {
    workspaceId: w,
    recordIds: ids,
    actions: ["read"],
    challenge,
    expiresInDays: 1,
  };
  delete process.env.AI_CONNECTOR_ENABLED;
  await assert.rejects(
    ai.authorize(actor, input),
    (e: any) => e.status === 404,
  );
  process.env.AI_CONNECTOR_ENABLED = "true";
  try {
    await assert.rejects(
      ai.authorize(stranger, input),
      (e: any) => e.status === 404,
    );
    await assert.rejects(
      ai.authorize(actor, { ...input, subjectId: stranger }),
    );
    await assert.rejects(
      ai.authorize(actor, { ...input, actions: ["publish"] }),
    );
    const visibleChoices = await ai.choices(reader, w);
    assert.equal(
      visibleChoices.items.some((r) => r.id === hidden),
      false,
    );
    assert.equal(
      JSON.stringify(visibleChoices).includes("PRIVATE_OWNER_NOTE_SENTINEL"),
      false,
    );
    await assert.rejects(ai.choices(stranger, w), (e: any) => e.status === 404);
    const approved = await ai.authorize(actor, input);
    await assert.rejects(
      ai.exchange({ code: approved.code, verifier: "x".repeat(64) }),
      (e: any) => e.status === 401,
    );
    const exchanged = await Promise.allSettled([
      ai.exchange({ code: approved.code, verifier }),
      ai.exchange({ code: approved.code, verifier }),
    ]);
    assert.equal(exchanged.filter((r) => r.status === "fulfilled").length, 1);
    const granted = (
      exchanged.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value;
    const result = await ai.read(granted.token, { recordIds: ids });
    assert.equal(result.records.length, 6);
    assert.equal(result.subjectId, actor);
    assert.equal(
      result.records.every(
        (r) => r.data.projectId === "" && r.data.ownerId === "",
      ),
      true,
    );
    assert.equal(
      JSON.stringify(result).includes("PRIVATE_OWNER_NOTE_SENTINEL"),
      false,
    );
    assert.equal(
      JSON.stringify(result).includes("HIDDEN_REFERENCE_SENTINEL"),
      false,
    );
    assert.equal(JSON.stringify(result).includes("visibility_ids"), false);
    await assert.rejects(
      ai.read(granted.token, { recordIds: [hidden] }),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      ai.read(granted.token, { recordIds: ids, subjectId: stranger }),
    );
    assert.equal((await ai.connections(actor))[0].last_used_at !== null, true);
    assert.deepEqual(await ai.connections(stranger), []);
    await assert.rejects(
      ai.revoke(stranger, granted.grantId),
      (e: any) => e.status === 404,
    );
    await ai.revoke(actor, granted.grantId);
    await assert.rejects(
      ai.read(granted.token, { recordIds: ids }),
      (e: any) => e.status === 401,
    );
    const pending = await ai.authorize(actor, input);
    await pool().query(
      "UPDATE ai_grants SET code_expires=now()-interval '1 second' WHERE id=$1",
      [pending.grantId],
    );
    await assert.rejects(
      ai.exchange({ code: pending.code, verifier }),
      (e: any) => e.status === 401,
    );
    const other = await ai.authorize(actor, input),
      active = await ai.exchange({ code: other.code, verifier });
    await pool().query(
      "UPDATE ai_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
      [active.grantId],
    );
    await assert.rejects(
      ai.read(active.token, { recordIds: ids }),
      (e: any) => e.status === 401,
    );
    // A separately shared record proves read-only members can opt in without gaining write rights.
    const readable = randomUUID();
    await pool().query(
      "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'notes',$3)",
      [readable, w, JSON.stringify(recordSchema.parse({ name: "Readable" }))],
    );
    const consent = await ai.authorize(reader, {
        ...input,
        recordIds: [readable],
      }),
      readGrant = await ai.exchange({ code: consent.code, verifier });
    assert.equal(
      (await ai.read(readGrant.token, { recordIds: [readable] })).records
        .length,
      1,
    );
    await pool().query("UPDATE records SET visibility_ids=$2 WHERE id=$1", [
      readable,
      [actor],
    ]);
    await assert.rejects(
      ai.read(readGrant.token, { recordIds: [readable] }),
      (e: any) => e.status === 404,
    );
    await pool().query("UPDATE records SET visibility_ids=NULL WHERE id=$1", [
      readable,
    ]);
    await pool().query(
      "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
      [w, reader],
    );
    await assert.rejects(
      ai.read(readGrant.token, { recordIds: [readable] }),
      (e: any) => e.status === 404,
    );
    // Disconnect reduces only the bearer grant, even after membership loss/expiry or feature shutdown.
    await pool().query(
      "UPDATE ai_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
      [readGrant.grantId],
    );
    delete process.env.AI_CONNECTOR_ENABLED;
    await assert.rejects(
      ai.revokeBearer("invalid", {}),
      (e: any) => e.status === 401,
    );
    await assert.rejects(
      ai.revokeBearer(readGrant.token, { grantId: granted.grantId }),
    );
    assert.deepEqual(await ai.revokeBearer(readGrant.token, {}), { ok: true });
    assert.deepEqual(await ai.revokeBearer(readGrant.token, {}), { ok: true });
    const disconnected = (
      await pool().query(
        "SELECT revoked_at,token_hash,code_hash FROM ai_grants WHERE id=$1",
        [readGrant.grantId],
      )
    ).rows[0];
    assert.ok(disconnected.revoked_at);
    assert.equal(disconnected.token_hash, null);
    assert.equal(disconnected.code_hash, null);
    assert.equal(
      (
        await pool().query("SELECT revoked_at FROM ai_grants WHERE id=$1", [
          active.grantId,
        ])
      ).rows[0].revoked_at,
      null,
    );
    process.env.AI_CONNECTOR_ENABLED = "true";
    await assert.rejects(
      ai.read(readGrant.token, { recordIds: [readable] }),
      (e: any) => e.status === 401,
    );
    const finalConsent = await ai.authorize(actor, input),
      finalGrant = await ai.exchange({ code: finalConsent.code, verifier });
    await pool().query("DELETE FROM records WHERE id=$1", [ids[0]]);
    await assert.rejects(
      ai.read(finalGrant.token, { recordIds: ids }),
      (e: any) => e.status === 404,
    );
    await pool().query("UPDATE users SET merged_into=$2 WHERE id=$1", [
      actor,
      stranger,
    ]);
    await assert.rejects(
      ai.read(finalGrant.token, { recordIds: [ids[1]] }),
      (e: any) => e.status === 401,
    );
  } finally {
    delete process.env.AI_CONNECTOR_ENABLED;
  }
});

test("AI writes require separate consent and exact source-user review, preserve sharing and reconcile duplicate publication", async () => {
  const ai = await import("../lib/ai"),
    writes = await import("../lib/ai-writes"),
    { createHash } = await import("node:crypto"),
    { recordSchema } = await import("../lib/model");
  const actor = randomUUID(),
    viewer = randomUUID(),
    stranger = randomUUID(),
    w = randomUUID(),
    target = randomUUID();
  await pool().query(
    "INSERT INTO users(id,name) VALUES($1,'Writer'),($2,'Viewer'),($3,'Stranger')",
    [actor, viewer, stranger],
  );
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'AI write fixture')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",
    [w, actor, viewer],
  );
  await pool().query(
    "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,'projects',$3,$4)",
    [
      target,
      w,
      recordSchema.parse({ name: "Selected destination" }),
      [actor, viewer],
    ],
  );
  const verifier = "w".repeat(64),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  process.env.AI_CONNECTOR_ENABLED = "true";
  try {
    const consent = await ai.authorize(actor, {
      workspaceId: w,
      recordIds: [target],
      actions: ["read"],
      challenge,
      expiresInDays: 1,
    });
    const g = await ai.exchange({ code: consent.code, verifier });
    const snapshot = await ai.read(g.token, { recordIds: [target] });
    const payload = {
      operationId: randomUUID(),
      targetId: target,
      kind: "notes",
      name: "Reviewed note",
      description: "Exact reviewed text",
      dueDate: "",
      sources: snapshot.records.map((r) => ({ id: r.id, version: r.version })),
      projectionHash: createHash("sha256")
        .update(JSON.stringify(snapshot.records))
        .digest("hex"),
    };
    await assert.rejects(
      writes.prepare(g.token, payload),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      writes.authorizeWrites(stranger, {
        grantId: g.grantId,
        targetId: target,
        kinds: ["notes"],
        expiresInDays: 1,
      }),
      (e: any) => e.status === 404,
    );
    await assert.rejects(
      writes.authorizeWrites(actor, {
        grantId: g.grantId,
        targetId: randomUUID(),
        kinds: ["notes"],
        expiresInDays: 1,
      }),
      (e: any) => e.status === 403,
    );
    const vConsent = await ai.authorize(viewer, {
      workspaceId: w,
      recordIds: [target],
      actions: ["read"],
      challenge,
      expiresInDays: 1,
    });
    const vg = await ai.exchange({ code: vConsent.code, verifier });
    await assert.rejects(
      writes.authorizeWrites(viewer, {
        grantId: vg.grantId,
        targetId: target,
        kinds: ["notes"],
        expiresInDays: 1,
      }),
      (e: any) => e.status === 403,
    );
    await writes.authorizeWrites(actor, {
      grantId: g.grantId,
      targetId: target,
      kinds: ["notes"],
      expiresInDays: 1,
    });
    await assert.rejects(
      writes.prepare(g.token, { ...payload, kind: "tasks" }),
      (e: any) => e.status === 403,
    );
    const prepared = await writes.prepare(g.token, payload);
    assert.equal(
      (await writes.prepare(g.token, payload)).reviewId,
      prepared.reviewId,
    );
    await assert.rejects(
      writes.prepare(g.token, { ...payload, description: "Changed text" }),
      (e: any) => e.status === 409,
    );
    const decision = { reviewId: prepared.reviewId, digest: prepared.digest };
    await assert.rejects(
      writes.publish(g.token, decision),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      writes.approve(stranger, decision),
      (e: any) => e.status === 404,
    );
    const review = await writes.reviewForUser(actor, prepared.reviewId);
    assert.equal(review.payload.description, payload.description);
    assert.equal(review.audience.memberCount, 2);
    await assert.rejects(
      writes.approve(actor, { ...decision, digest: "0".repeat(64) }),
      (e: any) => e.status === 409,
    );
    await writes.approve(actor, decision);
    const published = await Promise.all([
      writes.publish(g.token, decision),
      writes.publish(g.token, decision),
    ]);
    assert.equal(published[0].recordId, published[1].recordId);
    assert.equal(published.filter((r) => !r.existing).length, 1);
    const saved = (
      await pool().query("SELECT * FROM records WHERE id=$1", [
        published[0].recordId,
      ])
    ).rows[0];
    assert.equal(saved.data.description, payload.description);
    assert.equal(saved.data.projectId, target);
    assert.deepEqual(saved.visibility_ids, [actor, viewer]);
    assert.equal(saved.data.ownerId, "");
    const reconnectConsent = await ai.authorize(actor, {
      workspaceId: w,
      recordIds: [target],
      actions: ["read"],
      challenge,
      expiresInDays: 1,
    });
    const reconnect = await ai.exchange({
      code: reconnectConsent.code,
      verifier,
    });
    await writes.authorizeWrites(actor, {
      grantId: reconnect.grantId,
      targetId: target,
      kinds: ["notes"],
      expiresInDays: 1,
    });
    await assert.rejects(
      writes.prepare(reconnect.token, payload),
      (e: any) => e.status === 409,
    );
    // Audience change after approval must require a fresh review even without a target version change.
    const second = await writes.prepare(g.token, {
      ...payload,
      operationId: randomUUID(),
    });
    await writes.approve(actor, {
      reviewId: second.reviewId,
      digest: second.digest,
    });
    await pool().query(
      "UPDATE members SET scope_ids=$3 WHERE workspace_id=$1 AND user_id=$2",
      [w, viewer, []],
    );
    // Explicit sharing still grants the viewer. Remove it without bumping version to test audience hashing itself.
    await pool().query("UPDATE records SET visibility_ids=$2 WHERE id=$1", [
      target,
      [actor],
    ]);
    await assert.rejects(
      writes.publish(g.token, {
        reviewId: second.reviewId,
        digest: second.digest,
      }),
      (e: any) => e.status === 409,
    );
    await pool().query("UPDATE records SET visibility_ids=$2 WHERE id=$1", [
      target,
      [actor, viewer],
    ]);
    const third = await writes.prepare(g.token, {
      ...payload,
      operationId: randomUUID(),
    });
    await writes.approve(actor, {
      reviewId: third.reviewId,
      digest: third.digest,
    });
    await pool().query("UPDATE records SET version=version+1 WHERE id=$1", [
      target,
    ]);
    await assert.rejects(
      writes.publish(g.token, {
        reviewId: third.reviewId,
        digest: third.digest,
      }),
      (e: any) => e.status === 409,
    );
    const latest = await ai.read(g.token, { recordIds: [target] });
    const taskPayload = {
      ...payload,
      operationId: randomUUID(),
      kind: "tasks",
      name: "Reviewed task",
      dueDate: "2026-10-01",
      sources: latest.records.map((r) => ({ id: r.id, version: r.version })),
      projectionHash: createHash("sha256")
        .update(JSON.stringify(latest.records))
        .digest("hex"),
    };
    await writes.authorizeWrites(actor, {
      grantId: g.grantId,
      targetId: target,
      kinds: ["notes", "tasks"],
      expiresInDays: 1,
    });
    const taskReview = await writes.prepare(g.token, taskPayload);
    const taskDecision = {
      reviewId: taskReview.reviewId,
      digest: taskReview.digest,
    };
    await writes.approve(actor, taskDecision);
    // Reconsenting changes the permission epoch, invalidating outstanding approval.
    await writes.authorizeWrites(actor, {
      grantId: g.grantId,
      targetId: target,
      kinds: ["notes", "tasks"],
      expiresInDays: 1,
    });
    await assert.rejects(
      writes.publish(g.token, taskDecision),
      (e: any) => e.status === 409,
    );
    const fresh = await writes.prepare(g.token, {
      ...taskPayload,
      operationId: randomUUID(),
    });
    const freshDecision = { reviewId: fresh.reviewId, digest: fresh.digest };
    await writes.approve(actor, freshDecision);
    const taskReceipt = await writes.publish(g.token, freshDecision);
    const taskRecord = (
      await pool().query("SELECT kind,data FROM records WHERE id=$1", [
        taskReceipt.recordId,
      ])
    ).rows[0];
    assert.equal(taskRecord.kind, "tasks");
    assert.equal(taskRecord.data.dueDate, "2026-10-01");
    assert.equal(taskRecord.data.ownerId, "");
    await pool().query("DELETE FROM records WHERE id=$1", [
      taskReceipt.recordId,
    ]);
    const deletedReceipt = await writes.publish(g.token, freshDecision);
    assert.equal(deletedReceipt.state, "deleted");
    assert.equal(deletedReceipt.existing, true);
    assert.equal(
      (
        await pool().query("SELECT id FROM records WHERE id=$1", [
          taskReceipt.recordId,
        ])
      ).rowCount,
      0,
    );
    const discardedPayload = { ...taskPayload, operationId: randomUUID() };
    const discarded = await writes.prepare(g.token, discardedPayload);
    const discardDecision = {
      reviewId: discarded.reviewId,
      digest: discarded.digest,
    };
    await writes.approve(actor, discardDecision);
    await assert.rejects(
      writes.deleteReview(stranger, discarded.reviewId),
      (e: any) => e.status === 404,
    );
    await writes.deleteReview(actor, discarded.reviewId);
    assert.deepEqual(
      (
        await pool().query("SELECT payload FROM ai_write_reviews WHERE id=$1", [
          discarded.reviewId,
        ])
      ).rows[0].payload,
      {},
    );
    await assert.rejects(
      writes.publish(g.token, discardDecision),
      (e: any) => e.status === 409,
    );
    await assert.rejects(
      writes.prepare(g.token, discardedPayload),
      (e: any) => e.status === 409,
    );
    const expired = await writes.prepare(g.token, {
      ...taskPayload,
      operationId: randomUUID(),
    });
    await pool().query(
      "UPDATE ai_write_reviews SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.reviewId],
    );
    await assert.rejects(
      writes.approve(actor, {
        reviewId: expired.reviewId,
        digest: expired.digest,
      }),
      (e: any) => e.status === 409,
    );
    await writes.revokeWrites(actor, g.grantId);
    await assert.rejects(
      writes.prepare(g.token, { ...payload, operationId: randomUUID() }),
      (e: any) => e.status === 403,
    );
    assert.equal(
      (await ai.read(g.token, { recordIds: [target] })).records.length,
      1,
    );
  } finally {
    delete process.env.AI_CONNECTOR_ENABLED;
  }
});

test("save retries are atomic, scoped, payload-bound and never resurrect deleted records", async () => {
  const operationId = randomUUID();
  const body = {
    operationId,
    kind: "notes",
    data: { name: "Retry-safe note", description: "Synthetic only" },
    privateNote: { content: "Owner only", version: 0 },
  };
  const [a, b] = await Promise.all([
    saveRecord(owner, workspace, body),
    saveRecord(owner, workspace, body),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.version, 1);
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int n FROM audit WHERE record_id=$1",
        [a.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT version FROM record_private_notes WHERE record_id=$1",
        [a.id],
      )
    ).rows[0].version,
    1,
  );
  await assert.rejects(
    () =>
      saveRecord(owner, workspace, {
        ...body,
        data: { name: "Different payload" },
      }),
    /previous save succeeded/,
  );
  const update = {
    operationId: randomUUID(),
    id: a.id,
    version: 1,
    kind: "notes",
    data: { ...a.data, description: "Updated" },
  };
  const first = await saveRecord(owner, workspace, update);
  const repeat = await saveRecord(owner, workspace, update);
  assert.equal(first.version, 2);
  assert.equal(repeat.version, 2);
  await assert.rejects(
    () => saveRecord(other, workspace, body),
    /Workspace|role/,
  );
  await deleteRecord(owner, workspace, a.id, 2);
  await assert.rejects(
    () => saveRecord(owner, workspace, update),
    /changed or been removed/,
  );
  assert.equal(
    (
      await pool().query("SELECT count(*)::int n FROM records WHERE id=$1", [
        a.id,
      ])
    ).rows[0].n,
    0,
  );
});

test("paged workspace reads are bounded, complete, scoped and reject changed revisions", async () => {
  const w = randomUUID();
  await pool().query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    w,
    "Pagination fixture",
  ]);
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [w, owner],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')",
    [w, other],
  );
  for (let i = 0; i < 5; i++)
    await saveRecord(owner, w, {
      kind: "notes",
      data: { name: `Page ${i}`, description: "x".repeat(4000) },
      ...(i === 4 ? { visibilityIds: [] } : {}),
    });
  let page = await snapshot(other, w, { limit: 2 });
  assert.equal(page.records.length, 2);
  assert.ok(page.nextCursor);
  const second = await snapshot(other, w, {
    limit: 2,
    cursor: page.nextCursor!,
  });
  assert.equal(second.records.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...page.records, ...second.records].map((r) => r.id)).size,
    4,
  );
  assert.equal(
    JSON.stringify([...page.records, ...second.records]).includes("Page 4"),
    false,
  );
  await assert.rejects(
    () => snapshot(owner, w, { cursor: page.nextCursor! }),
    /Invalid page cursor/,
  );
  await assert.rejects(() => snapshot(other, w, { limit: 201 }), /200/);
  await saveRecord(owner, w, {
    kind: "notes",
    data: { name: "New during pagination" },
  });
  await assert.rejects(
    () => snapshot(other, w, { cursor: page.nextCursor! }),
    /changed while loading/,
  );
  page = await snapshot(other, w, { limit: 2 });
  await pool().query(
    "UPDATE members SET scope_ids=$1 WHERE workspace_id=$2 AND user_id=$3",
    [[], w, other],
  );
  await assert.rejects(
    () => snapshot(other, w, { cursor: page.nextCursor! }),
    /changed while loading/,
  );
  assert.equal((await snapshot(other, w, { limit: 2 })).records.length, 0);
});

test("Lead searches keep research separate from exact owner-approved imports", async () => {
  const leads = await import("../lib/leads");
  process.env.CRM_LEADS_ENABLED = "true";
  const brief = {
    target: "Developer infrastructure",
    sourceDomains: ["bittrees.org"],
    maxResults: 2,
    freshnessDays: 30,
  };
  const connection = await leads.createSearch(owner, {
    workspaceId: workspace,
    brief,
  });
  const candidate = {
    name: "Synthetic lead " + randomUUID(),
    website: "https://candidate-" + randomUUID() + ".org",
    summary: "Research supplied by agent",
    relevance: "Infrastructure",
    uncertainties: "Team size unknown",
    fit: "medium",
    evidence: "primary",
    sources: [
      { url: "https://bittrees.org/", retrievedAt: new Date().toISOString() },
    ],
  };
  const input = { operationId: randomUUID(), candidates: [candidate] };
  assert.equal(
    (await leads.agentBrief(connection.token)).brief.target,
    brief.target,
  );
  const preview = await leads.prepare(connection.token, input);
  assert.equal(
    (await leads.prepare(connection.token, input)).reviewId,
    preview.reviewId,
  );
  await assert.rejects(
    () =>
      leads.prepare(connection.token, {
        ...input,
        candidates: [{ ...candidate, name: "Changed" }],
      }),
    /already has a preview/,
  );
  await assert.rejects(
    () => leads.review(other, preview.reviewId),
    /unavailable/,
  );
  const review = await leads.review(owner, preview.reviewId);
  assert.equal(review.matches[0].length, 0);
  const result = await leads.approve(owner, {
    reviewId: review.id,
    digest: review.digest,
    accept: [0],
  });
  assert.equal(result.accepted, 1);
  assert.deepEqual(
    (
      await leads.approve(owner, {
        reviewId: review.id,
        digest: review.digest,
        accept: [0],
      })
    ).recordIds,
    result.recordIds,
  );
  const record = (
    await pool().query("SELECT * FROM records WHERE id=$1", result.recordIds)
  ).rows[0];
  assert.deepEqual(record.visibility_ids, []);
  assert.equal(record.data.communication, "Unknown");
  assert.match(record.data.description, /AI research/);
  await leads.revokeSearch(owner, connection.id);
  await assert.rejects(() => leads.agentBrief(connection.token), /unavailable/);
});
test("Lead review detects new duplicates and revoked owner authority", async () => {
  const leads = await import("../lib/leads");
  process.env.CRM_LEADS_ENABLED = "true";
  const w = randomUUID(),
    editor = randomUUID();
  await pool().query("INSERT INTO users(id,name) VALUES($1,'Lead editor')", [
    editor,
  ]);
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Lead tests')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')",
    [w, owner, editor],
  );
  await assert.rejects(
    () =>
      leads.createSearch(editor, {
        workspaceId: w,
        brief: { target: "Test", sourceDomains: ["bittrees.org"] },
      }),
    /role/,
  );
  const c = await leads.createSearch(owner, {
    workspaceId: w,
    brief: { target: "Test", sourceDomains: ["bittrees.org"] },
  });
  const candidate = {
    name: "Example organization",
    website: "https://bittrees.org",
    summary: "Test",
    relevance: "Test",
    uncertainties: "Unverified",
    fit: "low",
    evidence: "unconfirmed",
    sources: [
      { url: "https://bittrees.org/", retrievedAt: new Date().toISOString() },
    ],
  };
  const p = await leads.prepare(c.token, {
    operationId: randomUUID(),
    candidates: [candidate],
  });
  const r = await leads.review(owner, p.reviewId);
  await saveRecord(owner, w, {
    kind: "organizations",
    data: {
      name: candidate.name,
      website: candidate.website,
      communication: "Do not contact",
    },
  });
  await assert.rejects(
    () =>
      leads.approve(owner, {
        reviewId: p.reviewId,
        digest: r.digest,
        accept: [0],
      }),
    /duplicates changed/,
  );
  const fresh = await leads.review(owner, p.reviewId);
  assert.equal(fresh.matches[0][0].doNotContact, true);
  await assert.rejects(
    () =>
      leads.approve(owner, {
        reviewId: p.reviewId,
        digest: fresh.digest,
        accept: [0],
      }),
    /potential matches/,
  );
  await pool().query(
    "UPDATE members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [w, owner],
  );
  await assert.rejects(() => leads.agentBrief(c.token), /role/);
});

test("Archive is reversible, preserves links and sharing, blocks stale edits and excludes digests", async () => {
  const { archive } = await import("../lib/workflow");
  const w = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Archive test')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [w, owner],
  );
  const org = await saveRecord(owner, w, {
    kind: "organizations",
    data: { name: "Archive organization" },
    visibilityIds: [],
    privateNote: { content: "Preserve private note", version: 0 },
  });
  const person = await saveRecord(owner, w, {
    kind: "people",
    data: { name: "Linked person", organizationId: org.id },
  });
  const archived = await archive(owner, w, {
    id: org.id,
    version: org.version,
    archived: true,
  });
  assert.ok(archived.archived_at);
  assert.deepEqual(archived.visibility_ids, []);
  await assert.rejects(
    () =>
      saveRecord(owner, w, {
        id: org.id,
        version: archived.version,
        kind: "organizations",
        data: org.data,
      }),
    /Restore/,
  );
  await assert.rejects(
    () =>
      archive(other, w, {
        id: org.id,
        version: archived.version,
        archived: false,
      }),
    /not found/,
  );
  const restored = await archive(owner, w, {
    id: org.id,
    version: archived.version,
    archived: false,
  });
  assert.equal(restored.archived_at, null);
  assert.equal(
    (await snapshot(owner, w)).records.find((r) => r.id === person.id)?.data
      .organizationId,
    org.id,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT content FROM record_private_notes WHERE record_id=$1",
        [org.id],
      )
    ).rows[0].content,
    "Preserve private note",
  );
});
test("Saved views belong to a user and workspace, including read-only collaborators", async () => {
  const { views, deleteView } = await import("../lib/workflow");
  const w = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Views test')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",
    [w, owner, other],
  );
  const v = {
    name: "My view",
    page: "people",
    search: "Alice",
    filter: "all",
    board: false,
  };
  assert.equal((await views(other, w, v))[0].name, "My view");
  assert.deepEqual(await views(owner, w), []);
  await deleteView(other, w, v.name);
  assert.deepEqual(await views(other, w), []);
  await pool().query(
    "DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",
    [w, other],
  );
  await assert.rejects(() => views(other, w), /not found/);
});

test("Project researcher can draft investors but only assigning owner can publish linked records", async () => {
  const leads = await import("../lib/leads");
  process.env.CRM_LEADS_ENABLED = "true";
  const w = randomUUID(),
    researcher = randomUUID(),
    coowner = randomUUID();
  await pool().query(
    "INSERT INTO users(id,name) VALUES($1,'Researcher'),($2,'Other owner')",
    [researcher, coowner],
  );
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Investor research test')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer'),($1,$4,'owner')",
    [w, owner, researcher, coowner],
  );
  const project = await saveRecord(owner, w, {
    kind: "projects",
    data: { name: "Investor campaign" },
  });
  await pool().query(
    "UPDATE members SET scope_ids=$3 WHERE workspace_id=$1 AND user_id=$2",
    [w, researcher, [project.id]],
  );
  const brief = { target: "Seed investors", sourceDomains: ["bittrees.org"] };
  await assert.rejects(
    () =>
      leads.createSearch(owner, {
        workspaceId: w,
        researcherId: researcher,
        brief,
      }),
    /require a project/,
  );
  const connection = await leads.createSearch(owner, {
    workspaceId: w,
    researcherId: researcher,
    projectId: project.id,
    brief,
  });
  assert.equal(connection.token, "");
  await assert.rejects(
    () => leads.connectSearch(owner, connection.id),
    /assigned researcher/,
  );
  const credential = await leads.connectSearch(researcher, connection.id);
  const rotated = await leads.connectSearch(researcher, connection.id);
  await assert.rejects(() => leads.agentBrief(credential.token), /unavailable/);
  const candidate = {
    name: "Investor firm",
    website: "https://investor-firm.org",
    summary: "Public thesis",
    relevance: "Seed",
    uncertainties: "Check size unknown",
    fit: "medium",
    evidence: "primary",
    category: "Venture capital",
    sources: [
      { url: "https://bittrees.org/", retrievedAt: new Date().toISOString() },
    ],
  };
  const existing = await saveRecord(owner, w, {
    kind: "organizations",
    data: { name: candidate.name, website: candidate.website },
  });
  const person = {
    ...candidate,
    kind: "people",
    name: "Investor person",
    title: "Partner",
    email: "partner@investor-firm.org",
    organizationIndex: 0,
  };
  const input = {
    operationId: randomUUID(),
    candidates: [
      candidate,
      person,
      {
        ...person,
        name: "Independent investor",
        email: "angel@investor-firm.org",
        organizationIndex: undefined,
        category: "Angel",
      },
    ],
  };
  const preview = await leads.prepare(rotated.token, input);
  const researcherReview = await leads.review(researcher, preview.reviewId);
  assert.equal(researcherReview.canApprove, false);
  assert.equal(researcherReview.digest, "");
  assert.deepEqual(researcherReview.matches, [[], [], []]);
  const review = await leads.review(owner, preview.reviewId);
  assert.equal(review.matches[0][0].id, existing.id);
  await assert.rejects(
    () =>
      leads.approve(researcher, {
        reviewId: preview.reviewId,
        digest: review.digest,
        accept: [1],
      }),
    /Only the owner/,
  );
  await assert.rejects(
    () => leads.review(coowner, preview.reviewId),
    /unavailable/,
  );
  await assert.rejects(
    () =>
      leads.approve(owner, {
        reviewId: preview.reviewId,
        digest: review.digest,
        accept: [1],
      }),
    /linked organization/,
  );
  // Removing project access disables both session and agent paths, including approval.
  await pool().query(
    "UPDATE members SET scope_ids='{}' WHERE workspace_id=$1 AND user_id=$2",
    [w, researcher],
  );
  await assert.rejects(() => leads.agentBrief(rotated.token), /active project/);
  await assert.rejects(
    () =>
      leads.approve(owner, {
        reviewId: preview.reviewId,
        digest: review.digest,
        accept: [0, 1],
      }),
    /active project/,
  );
  assert.deepEqual(await leads.listSearches(researcher), []);
  await pool().query(
    "UPDATE members SET scope_ids=$3 WHERE workspace_id=$1 AND user_id=$2",
    [w, researcher, [project.id]],
  );
  const decision = {
    reviewId: preview.reviewId,
    digest: review.digest,
    accept: [0, 1, 2],
    reuse: { 0: existing.id },
  };
  const [a, b] = await Promise.all([
    leads.approve(owner, decision),
    leads.approve(owner, decision),
  ]);
  assert.deepEqual(a.recordIds, b.recordIds);
  assert.equal(a.recordIds[0], existing.id);
  const rows = (
    await pool().query("SELECT * FROM records WHERE id=ANY($1::uuid[])", [
      a.recordIds.slice(1),
    ])
  ).rows;
  assert.equal(rows.length, 2);
  const linked = rows.find((r) => r.data.name === person.name);
  assert.equal(linked.kind, "people");
  assert.equal(linked.data.organizationId, existing.id);
  assert.equal(linked.data.projectId, project.id);
  assert.equal(linked.data.category, "Venture capital");
  assert.equal(linked.data.communication, "Unknown");
  assert.deepEqual(linked.visibility_ids, []);
  assert.equal(
    rows.find((r) => r.data.category === "Angel").data.organizationId,
    "",
  );
  assert.equal(
    (await snapshot(researcher, w)).records.some((r) =>
      a.recordIds.slice(1).includes(r.id),
    ),
    false,
  );
  assert.equal(
    (
      await pool().query("SELECT version FROM records WHERE id=$1", [
        existing.id,
      ])
    ).rows[0].version,
    existing.version,
  );
  await assert.rejects(
    () => leads.approve(owner, { ...decision, reuse: {} }),
    /already been decided/,
  );
  await leads.revokeSearch(researcher, connection.id);
  await assert.rejects(() => leads.agentBrief(rotated.token), /unavailable/);
});

test("Wallet invitations require the verified recipient and retain research scope and owner approval", async () => {
  const { previewInvite, listInvites, revokeInvite } =
    await import("../lib/service");
  const leads = await import("../lib/leads");
  const login = await walletLogin();
  const user = (await currentUser(request(cookiePair(login.result.cookie))))!
    .id;
  const w = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Wallet invite test')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [w, owner],
  );
  const project = await saveRecord(owner, w, {
    kind: "projects",
    data: { name: "Scoped research" },
  });
  const hidden = await saveRecord(owner, w, {
    kind: "organizations",
    data: { name: "Unrelated" },
  });
  const input = {
    wallet: login.wallet.address,
    role: "viewer",
    scopeIds: [project.id],
  };
  for (const invalid of [
    { ...input, wallet: "0x123" },
    { ...input, wallet: "0x" + "0".repeat(40) },
    { ...input, email: "x@example.com" },
    { role: "viewer" },
  ])
    await assert.rejects(() => createInvite(owner, w, invalid));
  await assert.rejects(
    () => createInvite(owner, w, { ...input, scopeIds: [randomUUID()] }),
    /Select at least/,
  );
  const old = await createInvite(owner, w, input);
  const invite = await createInvite(owner, w, {
    ...input,
    wallet: input.wallet.toLowerCase(),
  });
  await assert.rejects(
    () => acceptInvite(user, old.token),
    /invalid or expired/,
  );
  await assert.rejects(
    () => acceptInvite(other, invite.token),
    /invited Ethereum wallet/,
  );
  const preview = await previewInvite(invite.token);
  assert.equal(preview.wallet, input.wallet.toLowerCase());
  assert.equal(preview.email, null);
  await acceptInvite(user, invite.token);
  await assert.rejects(
    () => acceptInvite(user, invite.token),
    /invalid or expired/,
  );
  const view = await snapshot(user, w);
  assert.equal(view.role, "viewer");
  assert.equal(view.limited, true);
  assert(view.records.some((r) => r.id === project.id));
  assert(!view.records.some((r) => r.id === hidden.id));
  assert.equal(
    (
      await pool().query(
        "SELECT 1 FROM identities WHERE user_id=$1 AND kind='email'",
        [user],
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    () => saveRecord(user, w, { kind: "people", data: { name: "Blocked" } }),
    /role/,
  );
  process.env.CRM_LEADS_ENABLED = "true";
  const search = await leads.createSearch(owner, {
    workspaceId: w,
    projectId: project.id,
    researcherId: user,
    brief: { target: "Investors", sourceDomains: ["bittrees.org"] },
  });
  const conn = await leads.connectSearch(user, search.id);
  const draft = await leads.prepare(conn.token, {
    operationId: randomUUID(),
    candidates: [
      {
        name: "Investor",
        website: "https://bittrees.org",
        summary: "Research",
        relevance: "Seed",
        uncertainties: "Unverified",
        fit: "low",
        evidence: "unconfirmed",
        sources: [
          {
            url: "https://bittrees.org",
            retrievedAt: new Date().toISOString(),
          },
        ],
      },
    ],
  });
  const review = await leads.review(owner, draft.reviewId);
  await assert.rejects(
    () =>
      leads.approve(user, {
        reviewId: draft.reviewId,
        digest: review.digest,
        accept: [0],
      }),
    /Only the owner/,
  );
  assert.equal(
    (
      await leads.approve(owner, {
        reviewId: draft.reviewId,
        digest: review.digest,
        accept: [0],
      })
    ).accepted,
    1,
  );
  const pending = await createInvite(owner, w, input);
  const listing = await listInvites(owner, w);
  const row = listing.invites.find((i) => i.status === "Pending")!;
  assert.equal(row.wallet, input.wallet.toLowerCase());
  assert(!("hash" in row));
  await revokeInvite(owner, w, row.id);
  await assert.rejects(
    () => acceptInvite(user, pending.token),
    /invalid or expired/,
  );
  const expired = await createInvite(owner, w, input);
  await pool().query(
    "UPDATE invites SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [hash(expired.token)],
  );
  await assert.rejects(
    () => acceptInvite(user, expired.token),
    /invalid or expired/,
  );
});

test("Private research lists stay personal, share only to accessible projects, and require owner approval", async () => {
  process.env.CRM_LEADS_ENABLED = "true";
  const d = await import("../lib/lead-drafts");
  const leads = await import("../lib/leads");
  const login = await walletLogin();
  const researcher = (await currentUser(
    request(cookiePair(login.result.cookie)),
  ))!.id;
  const id = randomUUID(),
    firmId = randomUUID();
  const input = {
    id,
    name: "Independent investors",
    version: 0,
    entries: [
      {
        id: firmId,
        kind: "organizations",
        name: "Private manual firm",
        category: "Family office",
      },
      {
        id: randomUUID(),
        kind: "people",
        name: "Private manual partner",
        organizationId: firmId,
        title: "Partner",
      },
    ],
  };
  const receipts = await Promise.all([
    d.saveDraft(researcher, input),
    d.saveDraft(researcher, input),
  ]);
  assert.equal(receipts[0].version, 1);
  assert.deepEqual(receipts[0], receipts[1]);
  assert(!(await d.listDrafts(owner)).some((r) => r.id === id));
  await assert.rejects(() => d.getDraft(owner, id), /not found/);
  await assert.rejects(() => d.saveDraft(owner, input), /not found/);
  await assert.rejects(
    () => d.saveDraft(researcher, { ...input, name: "Stale" }),
    /another tab/,
  );
  await assert.rejects(
    () =>
      d.saveDraft(researcher, {
        ...input,
        id: randomUUID(),
        entries: [{ ...input.entries[1], organizationId: randomUUID() }],
      }),
    /organization in this list/,
  );
  const w = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Private list scope test')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [w, owner],
  );
  const project = await saveRecord(owner, w, {
    kind: "projects",
    data: { name: "Research destination" },
  });
  const hidden = await saveRecord(owner, w, {
    kind: "projects",
    data: { name: "Hidden destination" },
  });
  const share = {
    id,
    version: 1,
    workspaceId: w,
    projectId: project.id,
    ownerId: owner,
  };
  await assert.rejects(() => d.shareDraft(researcher, share));
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,'viewer',$3)",
    [w, researcher, [project.id]],
  );
  const targets = await d.shareTargets(researcher);
  assert.deepEqual(
    targets.find((t) => t.id === w)?.projects.map((p: { id: string }) => p.id),
    [project.id],
  );
  await assert.rejects(
    () => d.shareDraft(researcher, { ...share, projectId: hidden.id }),
    /active project/,
  );
  await assert.rejects(() =>
    d.shareDraft(researcher, { ...share, ownerId: researcher }),
  );
  const shared = await Promise.all([
    d.shareDraft(researcher, share),
    d.shareDraft(researcher, share),
  ]);
  assert.deepEqual(shared[0], shared[1]);
  await assert.rejects(
    () => d.saveDraft(researcher, { ...input, version: 1 }),
    /submitted/,
  );
  assert.equal((await snapshot(owner, w)).records.length, 2);
  const review = await leads.review(owner, shared[0].reviewId);
  assert.equal(review.candidates[0].researchMethod, "manual");
  const approval = {
    reviewId: shared[0].reviewId,
    digest: review.digest,
    accept: [0, 1],
  };
  await assert.rejects(
    () => leads.approve(researcher, approval),
    /Only the owner/,
  );
  await d.deleteDraft(researcher, { id, version: 1 });
  assert.equal((await leads.approve(owner, approval)).accepted, 2);
  const records = (await snapshot(owner, w)).records;
  const firm = records.find((r) => r.data.name === "Private manual firm")!;
  const person = records.find((r) => r.data.name === "Private manual partner")!;
  assert.equal(person.data.organizationId, firm.id);
  assert.equal(person.data.source, "Research list");
  assert.deepEqual(person.visibility_ids, []);
  assert(
    !(await snapshot(researcher, w)).records.some((r) => r.id === person.id),
  );
});

test("Remote MCP authenticates discovery and cannot bypass sourced drafts or publication approval", async () => {
  process.env.CRM_LEADS_ENABLED = "true";
  const leads = await import("../lib/leads");
  const { leadMcp } = await import("../lib/lead-mcp-http");
  const c = await leads.createSearch(owner, {
    workspaceId: workspace,
    brief: { target: "Remote research", sourceDomains: ["bittrees.org"] },
  });
  const req = new Request(origin + "/api/integrations/leads/mcp");
  const rpc = (method: string, params?: unknown) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  const initialized: any = await leadMcp(
    req,
    c.token,
    rpc("initialize", { protocolVersion: "2025-11-25" }),
  );
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  const listing: any = await leadMcp(req, c.token, rpc("tools/list"));
  assert.deepEqual(
    listing.result.tools.map((t: any) => t.name),
    ["leads.status", "leads.brief", "leads.preview"],
  );
  assert.equal(
    await leadMcp(req, c.token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    null,
  );
  await assert.rejects(
    () =>
      leadMcp(
        new Request(req.url, { headers: { Origin: "https://evil.example" } }),
        c.token,
        rpc("tools/list"),
      ),
    /origin/i,
  );
  await assert.rejects(
    () =>
      leadMcp(
        new Request(req.url, {
          headers: { "MCP-Protocol-Version": "invalid" },
        }),
        c.token,
        rpc("tools/list"),
      ),
    /protocol/,
  );
  const candidate = {
    name: "Manual bypass",
    researchMethod: "manual",
    website: "",
    summary: "x",
    relevance: "x",
    uncertainties: "x",
    fit: "low",
    evidence: "unconfirmed",
    sources: [],
  };
  const bypass: any = await leadMcp(
    req,
    c.token,
    rpc("tools/call", {
      name: "leads.preview",
      arguments: { operationId: randomUUID(), candidates: [candidate] },
    }),
  );
  assert.equal(bypass.result.isError, true);
  const unknown: any = await leadMcp(
    req,
    c.token,
    rpc("tools/call", { name: "leads.publish", arguments: {} }),
  );
  assert.equal(unknown.error.code, -32602);
  await leads.revokeSearch(owner, c.id);
  await assert.rejects(
    () => leadMcp(req, c.token, rpc("tools/list")),
    /unavailable/,
  );
});

test("Combining verified accounts preserves personal research and revokes researcher credentials", async () => {
  process.env.CRM_LEADS_ENABLED = "true";
  const d = await import("../lib/lead-drafts"),
    leads = await import("../lib/leads");
  const { completeRecovery } = await import("../lib/recovery");
  const f = await recoveryFixture();
  const w = f.recovery.current.workspaces[0].id;
  const project = await saveRecord(f.targetId, w, {
    kind: "projects",
    data: { name: "Recovery research" },
  });
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,'viewer',$3)",
    [w, f.sourceId, [project.id]],
  );
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
  const draft = {
    id: randomUUID(),
    name: "Recovered private list",
    version: 0,
    entries: [{ id: randomUUID(), kind: "people", name: "Recovery person" }],
  };
  await d.saveDraft(f.sourceId, draft);
  const search = await leads.createSearch(f.targetId, {
    workspaceId: w,
    projectId: project.id,
    researcherId: f.sourceId,
    brief: { target: "Recovery research", sourceDomains: ["bittrees.org"] },
  });
  const connection = await leads.connectSearch(f.sourceId, search.id);
  await leads.agentBrief(connection.token);
  await verifyRecoveryCurrent(f);
  await completeRecovery(request(f.targetSession), f.recovery.token);
  assert.equal(
    (await d.getDraft(f.targetId, draft.id)).entries[0].name,
    "Recovery person",
  );
  assert.equal((await d.getDraft(f.targetId, draft.id)).version, 2);
  await assert.rejects(
    () => d.getDraft(f.sourceId, draft.id),
    /account changed/,
  );
  await assert.rejects(() => leads.agentBrief(connection.token), /unavailable/);
  const moved = (
    await pool().query(
      "SELECT user_id,researcher_id,token_hash,revoked_at FROM lead_searches WHERE id=$1",
      [search.id],
    )
  ).rows[0];
  assert.equal(moved.researcher_id, f.targetId);
  assert.equal(moved.token_hash, null);
  assert(moved.revoked_at);
});

test("Workspace merging retains research receipts without transferring live grants", async () => {
  process.env.CRM_LEADS_ENABLED = "true";
  const d = await import("../lib/lead-drafts"),
    leads = await import("../lib/leads");
  const { workspaceOperation } = await import("../lib/workspaces");
  const source = randomUUID(),
    target = randomUUID();
  for (const id of [source, target]) {
    await pool().query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
      id,
      id,
    ]);
    await pool().query(
      "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [id, owner],
    );
  }
  const project = await saveRecord(owner, source, {
    kind: "projects",
    data: { name: "Merge research" },
  });
  const draft = {
    id: randomUUID(),
    name: "Merge private list",
    version: 0,
    entries: [{ id: randomUUID(), kind: "people", name: "Merge person" }],
  };
  await d.saveDraft(owner, draft);
  const shared = await d.shareDraft(owner, {
    id: draft.id,
    version: 1,
    workspaceId: source,
    projectId: project.id,
    ownerId: owner,
  });
  const search = await leads.createSearch(owner, {
    workspaceId: source,
    brief: { target: "Merge research", sourceDomains: ["bittrees.org"] },
  });
  const { authorize } = await import("../lib/autonote");
  await authorize(owner, {
    workspaceId: source,
    targetId: project.id,
    challenge: "a".repeat(43),
    state: "b".repeat(64),
  });
  const note = await saveRecord(owner, source, {
    kind: "notes",
    data: { name: "Preserved AutoNote", projectId: project.id },
  });
  await pool().query(
    "INSERT INTO autonote_receipts(user_id,workspace_id,target_id,meeting_id,item_id,record_id) VALUES($1,$2,$3,$4,'summary',$5)",
    [owner, source, project.id, randomUUID(), note.id],
  );
  const review = await workspaceOperation(owner, source, {
    action: "merge",
    targetId: target,
  });
  await workspaceOperation(
    owner,
    source,
    {
      action: "merge",
      targetId: target,
      review: review.review,
      confirmName: source,
    },
    true,
  );
  assert(
    (
      await pool().query("SELECT id FROM lead_previews WHERE id=$1", [
        shared.reviewId,
      ])
    ).rowCount,
  );
  const searches = await leads.listSearches(owner);
  assert(
    searches.some(
      (s) =>
        s.preview_id === shared.reviewId &&
        s.workspace_id === target &&
        s.revoked_at,
    ),
  );
  assert.equal(
    (await d.listDrafts(owner)).find((l) => l.id === draft.id)?.status,
    "withdrawn",
  );
  const autoGrant = (
    await pool().query(
      "SELECT workspace_id,revoked_at,code_hash FROM autonote_grants WHERE target_id=$1",
      [project.id],
    )
  ).rows[0];
  assert.equal(autoGrant.workspace_id, target);
  assert(autoGrant.revoked_at);
  assert.equal(autoGrant.code_hash, null);
  assert.equal(
    (
      await pool().query(
        "SELECT workspace_id FROM autonote_receipts WHERE record_id=$1",
        [note.id],
      )
    ).rows[0].workspace_id,
    target,
  );

  assert.equal((await d.getDraft(owner, draft.id)).entries.length, 1);
  await assert.rejects(() => leads.agentBrief(search.token), /unavailable/);
});

test("MCP tasks flow through exact owner approval, linked records, status reconciliation and revocation", async () => {
  process.env.CRM_LEADS_ENABLED = "true";
  const leads = await import("../lib/leads");
  const w = randomUUID();
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Task flow test')",
    [w],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [w, owner],
  );
  const project = await saveRecord(owner, w, {
    kind: "projects",
    data: { name: "Task research" },
  });
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,'viewer',$3)",
    [w, other, [project.id]],
  );
  const s = await leads.createSearch(owner, {
    workspaceId: w,
    projectId: project.id,
    researcherId: other,
    brief: {
      target: "Task research",
      sourceDomains: ["bittrees.org"],
      allowTasks: true,
    },
  });
  const connection = await leads.connectSearch(other, s.id),
    op = randomUUID();
  assert.deepEqual(
    await leads.agentStatus(connection.token, { operationId: op }),
    { state: "not_found" },
  );
  const base = {
    website: "https://bittrees.org",
    summary: "Public research",
    relevance: "Business fit",
    uncertainties: "Unverified",
    fit: "medium",
    evidence: "unconfirmed",
    sources: [
      { url: "https://bittrees.org", retrievedAt: new Date().toISOString() },
    ],
  };
  const input = {
    operationId: op,
    candidates: [
      { ...base, kind: "organizations", name: "Task firm" },
      { ...base, kind: "people", name: "Task contact", organizationIndex: 0 },
      {
        ...base,
        kind: "tasks",
        name: "Review business fit",
        contactIndex: 1,
        organizationIndex: 0,
      },
    ],
  };
  const preview = await leads.prepare(connection.token, input);
  assert.equal(
    (await leads.agentStatus(connection.token, { operationId: op })).state,
    "awaiting_review",
  );
  const review = await leads.review(owner, preview.reviewId);
  await assert.rejects(
    () =>
      leads.approve(owner, {
        reviewId: preview.reviewId,
        digest: review.digest,
        accept: [2],
      }),
    /linked contact/,
  );
  await assert.rejects(
    () =>
      leads.approve(other, {
        reviewId: preview.reviewId,
        digest: review.digest,
        accept: [0, 1, 2],
      }),
    /Only the owner/,
  );
  const results = await Promise.all(
    [0, 1].map(() =>
      leads.approve(owner, {
        reviewId: preview.reviewId,
        digest: review.digest,
        accept: [0, 1, 2],
      }),
    ),
  );
  assert.deepEqual(results[0].recordIds, results[1].recordIds);
  const records = (await snapshot(owner, w)).records;
  const task = records.find((r) => r.kind === "tasks")!,
    person = records.find((r) => r.kind === "people")!,
    firm = records.find((r) => r.kind === "organizations")!;
  assert.equal(task.data.personId, person.id);
  assert.equal(task.data.organizationId, firm.id);
  assert.equal(task.data.projectId, project.id);
  assert.equal(task.data.ownerId, owner);
  assert.equal(task.data.dueDate, "");
  assert.equal(task.data.status, "Open");
  assert.deepEqual(task.visibility_ids, []);
  assert(!(await snapshot(other, w)).records.some((r) => r.id === task.id));
  const status = await leads.agentStatus(connection.token, { operationId: op });
  assert.equal(status.state, "decided");
  assert.equal(status.accepted, 3);
  assert(!("recordIds" in status));
  assert.equal((await leads.prepare(connection.token, input)).state, "decided");
  await leads.revokeSearch(owner, s.id);
  await assert.rejects(
    () => leads.agentStatus(connection.token, { operationId: op }),
    /unavailable/,
  );
});

test("Dataset MCP scopes reads and writes, exports training, and shares immutable copies for owner approval", async () => {
  const ds = await import("../lib/datasets");
  const drafts = await import("../lib/lead-drafts");
  const leads = await import("../lib/leads");
  const mcp = await import("../lib/dataset-mcp");
  const login = await walletLogin();
  const user = (await currentUser(request(cookiePair(login.result.cookie))))!
    .id;
  const w = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      user,
    ])
  ).rows[0].workspace_id;
  const org = await saveRecord(user, w, {
    kind: "organizations",
    data: { name: "Dataset firm" },
  });
  const person = await saveRecord(user, w, {
    kind: "people",
    data: {
      name: "Dataset partner",
      organizationId: org.id,
      email: "public@bittrees.org",
    },
  });
  await pool().query(
    "INSERT INTO record_private_notes(record_id,author_id,content) VALUES($1,$2,$3)",
    [person.id, user, "NEVER_EXPORT_PRIVATE_NOTE"],
  );
  const id = randomUUID();
  await drafts.saveDraft(user, {
    id,
    version: 0,
    name: "Dataset pilot",
    entries: [],
  });
  await assert.rejects(
    () =>
      ds.datasetImport(user, {
        id,
        version: 1,
        workspaceId: w,
        recordIds: [person.id],
      }),
    /linked organization/,
  );
  await ds.datasetImport(user, {
    id,
    version: 1,
    workspaceId: w,
    recordIds: [org.id, person.id],
  });
  const c = await ds.datasetConnect(user, { id });
  const bearer = c.token!;
  await assert.rejects(() => ds.datasetConnect(other, { id }), /not found/);
  let read: any = await ds.datasetAgent(bearer, "dataset.read", {});
  assert.equal(read.entries.length, 2);
  assert.equal(read.crm.length, 2);
  assert(!JSON.stringify(read).includes("NEVER_EXPORT_PRIVATE_NOTE"));
  assert.equal(
    read.entries.find((e: any) => e.kind === "people").organizationId,
    read.entries.find((e: any) => e.kind === "organizations").id,
  );
  assert.deepEqual(
    await ds.datasetAgent(bearer, "dataset.read", { revision: read.revision }),
    { unchanged: true, revision: read.revision },
  );
  const entry = read.entries[0];
  entry.research = {
    sources: [
      {
        url: "https://bittrees.org/",
        retrievedAt: new Date().toISOString(),
        claim: "Public source",
        usage: "Unknown",
      },
    ],
    relevance: "Potential investor",
    uncertainties: "Mandate needs confirmation",
    verification: "unverified",
    training: "pending",
  };
  const input = {
    version: read.version,
    name: read.name,
    entries: read.entries,
  };
  const saved: any = await ds.datasetAgent(bearer, "dataset.save", input);
  assert.deepEqual(await ds.datasetAgent(bearer, "dataset.save", input), saved);
  await assert.rejects(
    () => ds.datasetAgent(bearer, "dataset.save", { ...input, name: "Stale" }),
    /another tab/,
  );
  await assert.rejects(
    () =>
      ds.datasetAgent(bearer, "dataset.save", {
        ...input,
        version: saved.version,
        entries: [
          { ...entry, research: { ...entry.research, training: "eligible" } },
        ],
      }),
    /human training/,
  );
  assert.deepEqual(await ds.datasetRead(user, id, true), []);
  read = await ds.datasetAgent(bearer, "dataset.read", {});
  await drafts.saveDraft(user, {
    id,
    version: read.version,
    name: read.name,
    entries: read.entries.map((e: any) => ({
      ...e,
      research: { ...e.research, training: "eligible" },
    })),
  });
  read = await ds.datasetAgent(bearer, "dataset.read", {});
  await ds.datasetAgent(bearer, "dataset.save", {
    version: read.version,
    name: read.name,
    entries: read.entries,
  });
  const training: any = await ds.datasetRead(user, id, true);
  assert.equal(training.length, 2);
  assert(!training.some((e: any) => "email" in e));
  const destination = { id: randomUUID() };
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Dataset target')",
    [destination.id],
  );
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [destination.id, owner],
  );
  const project = await saveRecord(owner, destination.id, {
    kind: "projects",
    data: { name: "BBRF dataset test" },
  });
  read = await ds.datasetAgent(bearer, "dataset.read", {});
  const share = {
    id,
    version: read.version,
    entryIds: read.entries.map((e: any) => e.id),
    workspaceId: destination.id,
    projectId: project.id,
    ownerId: owner,
    operationId: randomUUID(),
  };
  await assert.rejects(() => ds.datasetShare(user, share));
  await pool().query(
    "INSERT INTO members(workspace_id,user_id,role,scope_ids) VALUES($1,$2,'viewer',$3)",
    [destination.id, user, [project.id]],
  );
  const result = await ds.datasetShare(user, share);
  assert.deepEqual(await ds.datasetShare(user, share), result);
  await assert.rejects(() => ds.datasetShare(user, { ...share, entryIds: [] }));
  assert.equal((await drafts.getDraft(user, id)).shared_search_id, null);
  const review = await leads.review(owner, result.reviewId);
  await assert.rejects(() =>
    leads.approve(user, {
      reviewId: result.reviewId,
      digest: review.digest,
      accept: [0, 1],
    }),
  );
  await leads.approve(owner, {
    reviewId: result.reviewId,
    digest: review.digest,
    accept: [0, 1],
  });
  const published = (await snapshot(owner, destination.id)).records;
  assert.equal(
    published.filter((r: any) => ["people", "organizations"].includes(r.kind))
      .length,
    2,
  );
  assert.equal(
    published.find((r: any) => r.kind === "people")!.data.organizationId,
    published.find((r: any) => r.kind === "organizations")!.id,
  );
  read = await ds.datasetAgent(bearer, "dataset.read", {});
  assert.equal(read.submissions[0].status, "reviewed");
  assert.equal(read.submissions[0].accepted, 2);
  assert.deepEqual(read.submissions[0].mappings, []);
  const rpc: any = await mcp.datasetMcp(
    bearer,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    null,
  );
  assert.equal(rpc.result.tools.length, 11);
  await assert.rejects(() =>
    mcp.datasetMcp(
      "a".repeat(64),
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      null,
    ),
  );
  await ds.datasetConnect(user, { id, revoke: true });
  await assert.rejects(
    () => ds.datasetAgent(bearer, "dataset.read", {}),
    /expired or revoked/,
  );
});

test("Dataset updates require exact human review and preserve CRM sharing and private notes", async () => {
  const ds = await import("../lib/datasets");
  const drafts = await import("../lib/lead-drafts");
  const login = await walletLogin();
  const user = (await currentUser(request(cookiePair(login.result.cookie))))!
    .id;
  const w = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      user,
    ])
  ).rows[0].workspace_id;
  const record = await saveRecord(user, w, {
    kind: "organizations",
    data: { name: "Versioned firm", description: "Original" },
    visibilityIds: [],
    privateNote: { version: 0, content: "Keep private" },
  });
  const id = randomUUID();
  await drafts.saveDraft(user, {
    id,
    version: 0,
    name: "Updates",
    entries: [],
  });
  await ds.datasetImport(user, {
    id,
    version: 1,
    workspaceId: w,
    recordIds: [record.id],
  });
  const c = await ds.datasetConnect(user, { id });
  let d: any = await ds.datasetAgent(c.token!, "dataset.read", {});
  d.entries[0].description = "Researched revision";
  await ds.datasetAgent(c.token!, "dataset.save", {
    version: d.version,
    name: d.name,
    entries: d.entries,
  });
  let proposals = await ds.datasetUpdates(user, id);
  assert.equal(proposals.length, 1);
  await saveRecord(user, w, {
    id: record.id,
    kind: "organizations",
    version: record.version,
    data: { ...record.data, title: "Concurrent edit" },
  });
  await assert.rejects(
    () =>
      ds.datasetApply(user, {
        id,
        entryId: proposals[0].entryId,
        digest: proposals[0].digest,
      }),
    /changed/,
  );
  proposals = await ds.datasetUpdates(user, id);
  const result = await ds.datasetApply(user, {
    id,
    entryId: proposals[0].entryId,
    digest: proposals[0].digest,
  });
  assert.equal(result.version, 3);
  const updated = (
    await pool().query("SELECT * FROM records WHERE id=$1", [record.id])
  ).rows[0];
  assert.equal(updated.data.description, "Researched revision");
  assert.deepEqual(updated.visibility_ids, []);
  assert.equal(
    (
      await pool().query(
        "SELECT content FROM record_private_notes WHERE record_id=$1",
        [record.id],
      )
    ).rows[0].content,
    "Keep private",
  );
  await assert.rejects(
    () =>
      ds.datasetApply(other, {
        id,
        entryId: proposals[0].entryId,
        digest: proposals[0].digest,
      }),
    /not found/,
  );
  await assert.rejects(
    () => ds.datasetAgent(c.token!, "dataset.apply", {}),
    /Unknown/,
  );
  await pool().query(
    "UPDATE members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [w, user],
  );
  await pool().query("UPDATE records SET visibility_ids='{}' WHERE id=$1", [
    record.id,
  ]);
  d = await ds.datasetAgent(c.token!, "dataset.read", {});
  assert.deepEqual(d.crm, []);
  assert.equal(d.links[0].status, "unavailable");
  assert.deepEqual(await ds.datasetUpdates(user, id), []);
  await ds.datasetAgent(c.token!, "dataset.save", {
    version: d.version,
    name: d.name,
    entries: [],
  });
  assert.equal(
    (
      await pool().query(
        "SELECT * FROM dataset_record_links WHERE draft_id=$1",
        [id],
      )
    ).rowCount,
    0,
  );
  await pool().query(
    "UPDATE dataset_connections SET expires_at=now()-interval '1 second' WHERE draft_id=$1",
    [id],
  );
  await assert.rejects(
    () => ds.datasetAgent(c.token!, "dataset.read", {}),
    /expired or revoked/,
  );
});

test("project dataset import requires exact owner preview; MCP sync preserves approval and privacy", async () => {
  process.env.CRM_LEADS_ENABLED = "true";
  const ds = await import("../lib/datasets");
  const drafts = await import("../lib/lead-drafts");
  const login = await walletLogin();
  const user = (await currentUser(request(cookiePair(login.result.cookie))))!
    .id;
  const w = (
    await pool().query("SELECT workspace_id FROM members WHERE user_id=$1", [
      user,
    ])
  ).rows[0].workspace_id;
  const id = randomUUID(),
    entryId = randomUUID();
  await drafts.saveDraft(user, {
    id,
    version: 0,
    name: "Project sync",
    entries: [
      {
        id: entryId,
        kind: "projects",
        name: "Synthetic project",
        source: "https://example.org",
        description: "Original",
      },
    ],
  });
  const connection = await ds.datasetConnect(user, { id });
  const selection = { id, workspaceId: w, entryIds: [entryId] };
  const p = await ds.datasetProjectPreview(user, selection);
  assert.equal(p.rows[0].data.source, "https://example.org");
  assert.equal((await snapshot(user, w)).records.length, 0);
  await assert.rejects(() =>
    ds.datasetProjectApprove(other, { ...selection, digest: p.digest }),
  );
  await assert.rejects(
    () =>
      ds.datasetAgent(connection.token!, "dataset.projects.approve", {
        ...selection,
        digest: p.digest,
      }),
    /Unknown/,
  );
  await ds.datasetAgent(connection.token!, "dataset.save", {
    version: 1,
    name: "Project sync",
    entries: [
      {
        id: entryId,
        kind: "projects",
        name: "Synthetic project",
        description: "Changed before approval",
      },
    ],
  });
  await assert.rejects(
    () => ds.datasetProjectApprove(user, { ...selection, digest: p.digest }),
    /changed/,
  );
  const fresh = await ds.datasetProjectPreview(user, selection);
  const approved = await ds.datasetProjectApprove(user, {
    ...selection,
    digest: fresh.digest,
  });
  assert.equal(approved.records.length, 1);
  await assert.rejects(
    () =>
      ds.datasetProjectApprove(user, { ...selection, digest: fresh.digest }),
    /changed/,
  );
  assert.equal((await snapshot(user, w)).records.length, 1);
  const record = (await snapshot(user, w)).records[0];
  assert.deepEqual(record.visibility_ids, []);
  await saveRecord(user, w, {
    id: record.id,
    kind: "projects",
    version: record.version,
    data: { ...record.data, description: "CRM-side revision" },
    privateNote: { version: 0, content: "Never send to dataset" },
  });
  let d: any = await ds.datasetAgent(connection.token!, "dataset.read", {});
  assert.equal(d.crm[0].data.description, "CRM-side revision");
  assert(!JSON.stringify(d).includes("Never send"));
  assert.equal(d.entries[0].description, "Changed before approval");
  d.entries[0].description = "Agent proposed revision";
  await ds.datasetAgent(connection.token!, "dataset.save", {
    version: d.version,
    name: d.name,
    entries: d.entries,
  });
  assert.equal(
    (await snapshot(user, w)).records[0].data.description,
    "CRM-side revision",
  );
  const updates = await ds.datasetUpdates(user, id);
  await ds.datasetApply(user, { id, entryId, digest: updates[0].digest });
  d = await ds.datasetAgent(connection.token!, "dataset.read", {});
  assert.equal(d.crm[0].data.description, "Agent proposed revision");
  const duplicate = randomUUID();
  await drafts.saveDraft(user, {
    id: duplicate,
    version: 0,
    name: "Duplicate",
    entries: [
      { id: randomUUID(), kind: "projects", name: " synthetic PROJECT " },
    ],
  });
  const dup = await drafts.getDraft(user, duplicate);
  assert.match(
    (
      await ds.datasetProjectPreview(user, {
        id: duplicate,
        workspaceId: w,
        entryIds: [dup.entries[0].id],
      })
    ).rows[0].blocked,
    /already exists/,
  );
  await ds.datasetConnect(user, { id, revoke: true });
  await assert.rejects(
    () => ds.datasetAgent(connection.token!, "dataset.read", {}),
    /revoked/,
  );
});

test("dataset append supports large private research, exact retries and owner-only publication", async () => {
  const drafts = await import("../lib/lead-drafts");
  const ds = await import("../lib/datasets");
  const id = randomUUID();
  await drafts.saveDraft(owner, {
    id,
    name: "Research append test",
    version: 0,
    entries: [],
  });
  const c = await ds.datasetConnect(owner, { id });
  let version = 1;
  const ids: string[] = [];
  for (let batch = 0; batch < 11; batch++) {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: randomUUID(),
      kind: "people",
      name: `US research person ${batch * 20 + i}`,
      research: { training: "pending" },
    }));
    ids.push(...entries.map((e) => e.id));
    const result: any = await ds.datasetAgent(c.token!, "dataset.append", {
      version,
      entries,
    });
    assert.equal(result.added, 20);
    version = result.version;
    const retry: any = await ds.datasetAgent(c.token!, "dataset.append", {
      version: version - 1,
      entries,
    });
    assert.equal(retry.added, 0);
  }
  const current: any = await ds.datasetAgent(c.token!, "dataset.read", {});
  assert.equal(current.entries.length, 220);
  await assert.rejects(() =>
    ds.datasetAgent(c.token!, "dataset.append", {
      version: 1,
      entries: [{ id: randomUUID(), kind: "people", name: "Late writer" }],
    }),
  );
  await assert.rejects(() =>
    ds.datasetAgent(c.token!, "dataset.append", {
      version,
      entries: [
        { id: randomUUID(), kind: "people", name: "US research person 0" },
      ],
    }),
  );
  await assert.rejects(() =>
    ds.datasetAgent(c.token!, "dataset.append", {
      version,
      entries: [{ id: ids[0], kind: "people", name: "Overwritten" }],
    }),
  );
  await assert.rejects(() =>
    ds.datasetAgent(c.token!, "dataset.append", {
      version,
      entries: [
        {
          id: randomUUID(),
          kind: "people",
          name: "Training bypass",
          research: { training: "eligible" },
        },
      ],
    }),
  );
  await assert.rejects(() => ds.datasetAgent(c.token!, "dataset.share", {}));
  await ds.datasetConnect(owner, { id, revoke: true });
  await assert.rejects(() =>
    ds.datasetAgent(c.token!, "dataset.append", {
      version,
      entries: [{ id: randomUUID(), kind: "people", name: "Revoked" }],
    }),
  );
});

test("Standing research accepts more than five daily batches while retaining review and revocation checks", async () => {
  const leads = await import("../lib/leads");
  process.env.CRM_LEADS_ENABLED = "true";
  const connection = await leads.createSearch(owner, {
    workspaceId: workspace,
    brief: {
      target: "Synthetic supplier research",
      sourceDomains: ["bittrees.org"],
      maxResults: 2,
      freshnessDays: 30,
    },
  });
  await pool().query("UPDATE lead_searches SET standing=true WHERE id=$1", [
    connection.id,
  ]);
  const input = () => ({
    operationId: randomUUID(),
    candidates: [
      {
        name: "Synthetic supplier " + randomUUID(),
        website: "https://bittrees.org",
        summary: "Synthetic public evidence",
        relevance: "Infrastructure",
        uncertainties: "Unverified",
        fit: "medium",
        evidence: "primary",
        sources: [
          {
            url: "https://bittrees.org/",
            retrievedAt: new Date().toISOString(),
          },
        ],
      },
    ],
  });
  const first = input();
  const preview = await leads.prepare(connection.token, first);
  for (let i = 1; i < 10; i++)
    assert.equal(
      (await leads.prepare(connection.token, input())).state,
      "awaiting_review",
    );
  assert.equal(
    (await leads.prepare(connection.token, first)).reviewId,
    preview.reviewId,
  );
  await assert.rejects(
    leads.prepare(connection.token, input()),
    /review limit reached/,
  );
  await leads.revokeSearch(owner, connection.id);
  await assert.rejects(
    leads.agentBrief(connection.token),
    /unavailable|revoked/,
  );
});

test("explicit project permissions gate automatic leads and versioned local AI tasks", async () => {
  const ds = await import("../lib/datasets"),
    drafts = await import("../lib/lead-drafts"),
    automation = await import("../lib/project-automation");
  const project = await saveRecord(owner, workspace, {
    kind: "projects",
    data: { name: "Automation isolated project" },
  });
  const unrelated = await saveRecord(owner, workspace, {
    kind: "projects",
    data: { name: "Unconnected project" },
  });
  const id = randomUUID();
  await drafts.saveDraft(owner, {
    id,
    name: "Automation test",
    version: 0,
    entries: [],
  });
  const c = await ds.datasetConnect(owner, { id });
  const call = (name: string, args: any) =>
    ds.datasetAgent(c.token!, name, args) as Promise<any>;
  assert.deepEqual((await call("projects.list", {})).projects, []);
  await assert.rejects(() => call("project.read", { projectId: project.id }));
  await automation.configureProject(owner, {
    datasetId: id,
    projectId: project.id,
    autoLeads: true,
    tasks: true,
  });
  await assert.rejects(() =>
    automation.configureProject(other, {
      datasetId: id,
      projectId: project.id,
      autoLeads: true,
      tasks: true,
    }),
  );
  const org = randomUUID(),
    person = randomUUID();
  const entries = [
    { id: org, kind: "organizations", name: "Unique automation organization" },
    {
      id: person,
      kind: "people",
      name: "Unique automation person",
      organizationId: org,
      research: { training: "pending" },
    },
  ];
  const added = await call("dataset.append", { version: 1, entries });
  assert.equal(added.crm.added, 2);
  const linked = (
    await pool().query(
      "SELECT r.* FROM records r JOIN dataset_record_links l ON l.record_id=r.id WHERE l.draft_id=$1",
      [id],
    )
  ).rows;
  assert.equal(linked.length, 2);
  assert.ok(linked.every((r) => r.data.projectId === project.id));
  assert.equal(
    linked.find((r) => r.kind === "people").data.organizationId,
    linked.find((r) => r.kind === "organizations").id,
  );
  await call("dataset.append", { version: 1, entries });
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int AS n FROM dataset_record_links WHERE draft_id=$1",
        [id],
      )
    ).rows[0].n,
    2,
  );
  await assert.rejects(() => call("project.read", { projectId: unrelated.id }));
  const operationId = randomUUID();
  const task = await call("tasks.create", {
    projectId: project.id,
    operationId,
    name: "Draft investor qualification questions",
    description: "Draft questions; do not send them.",
    mode: "AI draft",
  });
  assert.equal(
    (
      await call("tasks.create", {
        projectId: project.id,
        operationId,
        name: "Draft investor qualification questions",
        description: "Draft questions; do not send them.",
        mode: "AI draft",
      })
    ).id,
    task.id,
  );
  const listed = await call("tasks.list", { projectId: project.id });
  assert.equal(listed.tasks[0].id, task.id);
  const change = {
    projectId: project.id,
    taskId: task.id,
    version: task.version,
    operationId: randomUUID(),
    name: "Updated qualification questions",
    description: "Updated owner instructions",
    mode: "AI review",
    status: "Open",
    dueDate: "2026-12-01",
  };
  const updated = await call("tasks.update", change);
  assert.equal(updated.version, task.version + 1);
  assert.equal(updated.data.ownerId, owner);
  assert.equal(updated.data.projectId, project.id);
  assert.equal((await call("tasks.update", change)).version, updated.version);
  await assert.rejects(() =>
    call("tasks.update", {
      ...change,
      operationId: randomUUID(),
      name: "Stale overwrite",
    }),
  );
  await assert.rejects(() =>
    call("tasks.update", {
      ...change,
      projectId: unrelated.id,
      version: updated.version,
      operationId: randomUUID(),
    }),
  );
  const runId = randomUUID();
  const claimed = await call("tasks.claim", { projectId: project.id, runId });
  assert.equal(claimed.task.id, task.id);
  assert.equal(
    (await call("tasks.claim", { projectId: project.id, runId: randomUUID() }))
      .task,
    null,
  );
  const result = await call("tasks.finish", {
    projectId: project.id,
    runId,
    result: "Draft: Which instrument types and geographies do you allocate to?",
  });
  assert.equal(result.taskId, task.id);
  assert.deepEqual(
    await call("tasks.finish", {
      projectId: project.id,
      runId,
      result:
        "Draft: Which instrument types and geographies do you allocate to?",
    }),
    result,
  );
  await assert.rejects(() =>
    call("tasks.finish", {
      projectId: unrelated.id,
      runId,
      result: "Different project",
    }),
  );
  const t2 = await call("tasks.create", {
    projectId: project.id,
    operationId: randomUUID(),
    name: "Review research",
    description: "Summarize uncertainty.",
    mode: "AI review",
  });
  const r2 = randomUUID();
  await call("tasks.claim", { projectId: project.id, runId: r2 });
  await saveRecord(owner, workspace, {
    id: t2.id,
    kind: "tasks",
    version: t2.version,
    data: { ...t2.data, description: "Changed by human" },
  });
  await assert.rejects(() =>
    call("tasks.finish", {
      projectId: project.id,
      runId: r2,
      result: "Stale result",
    }),
  );
  await automation.configureProject(owner, {
    datasetId: id,
    projectId: project.id,
    autoLeads: false,
    tasks: false,
  });
  await assert.rejects(() =>
    call("tasks.create", {
      projectId: project.id,
      operationId: randomUUID(),
      name: "Denied",
      description: "",
      mode: "AI draft",
    }),
  );
  assert.deepEqual((await call("projects.list", {})).projects, []);
  await automation.configureProject(owner, {
    datasetId: id,
    projectId: project.id,
    autoLeads: true,
    tasks: true,
  });
  const replacement = await ds.datasetConnect(owner, { id });
  assert.deepEqual(
    ((await ds.datasetAgent(replacement.token!, "projects.list", {})) as any)
      .projects,
    [],
  );
  await ds.datasetConnect(owner, { id, revoke: true });
});
