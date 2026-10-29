import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { pool, schema } from "../lib/db";
import { recordSchema } from "../lib/model";
import { saveRecord, importRecords } from "../lib/service";
import { reviewPeopleContacts } from "../lib/contact-research";
import {
  contactUploadSchema,
  publicContactSchema,
} from "../lib/contact-research-model";
const owner = randomUUID(),
  editor = randomUUID(),
  outsider = randomUUID(),
  workspace = randomUUID(),
  person = randomUUID(),
  other = randomUUID(),
  organization = randomUUID();
const isolated = "contact_test_" + randomUUID().replaceAll("-", "");
let admin: Pool;
const original = recordSchema.parse({
  name: "Synthetic Alice",
  organizationId: organization,
  ownerId: owner,
  description: "Keep prior qualification and context.",
  website: "https://fund.org/team/alice",
  communication: "Do not contact",
  investorFit: "Needs research",
  investorVerification: "Incomplete",
});
const contact = {
  kind: "email" as const,
  value: "alice@fund.org",
  sourceURL: "https://fund.org/team/alice",
  retrievedAt: "2026-10-29T00:00:00Z",
  evidence: "Official named biography publishes this professional address.",
  status: "Public source; delivery unverified" as const,
};
const upload = {
  schema: "bittrees-people-contact-review.v1" as const,
  rows: [
    {
      id: person,
      name: original.name,
      expected: {
        email: original.email,
        website: original.website,
        description: original.description,
        organizationId: organization,
      },
      contacts: [
        contact,
        {
          ...contact,
          kind: "LinkedIn" as const,
          value: "https://www.linkedin.com/in/synthetic-alice",
        },
      ],
    },
  ],
};
before(async () => {
  const u = new URL(process.env.DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    u.pathname !== "/crm_test"
  )
    throw Error("Local isolated crm_test required");
  admin = new Pool({ connectionString: u.href });
  await admin.query(`CREATE SCHEMA ${isolated}`);
  u.searchParams.set("options", `-c search_path=${isolated}`);
  process.env.DATABASE_URL = u.href;
  await pool().query(schema);
  for (const id of [owner, editor, outsider])
    await pool().query(
      "INSERT INTO users(id,name) VALUES($1,'Synthetic user')",
      [id],
    );
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Synthetic contact workspace')",
    [workspace],
  );
  for (const [id, role] of [
    [owner, "owner"],
    [editor, "editor"],
  ])
    await pool().query(
      "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspace, id, role],
    );
  await pool().query(
    "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'organizations',$3)",
    [organization, workspace, recordSchema.parse({ name: "Synthetic Fund" })],
  );
  await pool().query(
    "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,'people',$3,$4)",
    [person, workspace, original, [owner]],
  );
  await pool().query(
    "INSERT INTO record_private_notes(record_id,author_id,content) VALUES($1,$2,'Private note stays private')",
    [person, owner],
  );
});
after(async () => {
  await pool().end();
  await admin.query(`DROP SCHEMA ${isolated} CASCADE`);
  await admin.end();
});
test("only workspace owners may preview or apply", async () => {
  for (const id of [editor, outsider])
    await assert.rejects(reviewPeopleContacts(id, workspace, { upload }));
});
test("validate direct personal routes and reject generic mailboxes, share links and credential URLs", () => {
  assert(contactUploadSchema.safeParse(upload).success);
  for (const value of ["info@fund.org", "press@fund.org", "investors@fund.org"])
    assert(!publicContactSchema.safeParse({ ...contact, value }).success);
  for (const c of [
    { kind: "X", value: "https://x.com/intent" },
    { kind: "LinkedIn", value: "https://www.linkedin.com/company/fund" },
    { kind: "Telegram", value: "https://t.me/share" },
    { kind: "X", value: "https://user:secret@x.com/alice" },
  ])
    assert(!publicContactSchema.safeParse({ ...contact, ...c }).success);
});
test("identity, organization, duplicate and stale context fail atomically", async () => {
  for (const rows of [
    [...upload.rows, ...upload.rows],
    [{ ...upload.rows[0], name: "Another Alice" }],
    [
      {
        ...upload.rows[0],
        expected: { ...upload.rows[0].expected, organizationId: randomUUID() },
      },
    ],
    [
      {
        ...upload.rows[0],
        expected: { ...upload.rows[0].expected, description: "Stale context" },
      },
    ],
    [...upload.rows, { ...upload.rows[0], id: other }],
  ])
    await assert.rejects(
      reviewPeopleContacts(owner, workspace, { upload: { ...upload, rows } }),
    );
  const r = (
    await pool().query("SELECT data,version FROM records WHERE id=$1", [person])
  ).rows[0];
  assert.deepEqual(r.data, original);
  assert.equal(r.version, 1);
});
test("preview is read-only and rejects a changed file or concurrent record version", async () => {
  const p = await reviewPeopleContacts(owner, workspace, { upload });
  assert.equal("changed" in p && p.changed, 1);
  assert.equal(
    (await pool().query("SELECT version FROM records WHERE id=$1", [person]))
      .rows[0].version,
    1,
  );
  await assert.rejects(
    reviewPeopleContacts(owner, workspace, {
      upload: {
        ...upload,
        rows: [
          {
            ...upload.rows[0],
            contacts: [{ ...contact, value: "other@fund.org" }],
          },
        ],
      },
      digest: p.digest,
    }),
  );
  await pool().query("UPDATE records SET version=version+1 WHERE id=$1", [
    person,
  ]);
  await assert.rejects(
    reviewPeopleContacts(owner, workspace, { upload, digest: p.digest }),
  );
});
test("owner applies current preview, preserving private notes, sharing, qualifications and unrelated fields; retry is idempotent", async () => {
  const p = await reviewPeopleContacts(owner, workspace, { upload });
  const result = await reviewPeopleContacts(owner, workspace, {
    upload,
    digest: p.digest,
  });
  assert.equal("updated" in result && result.updated, 1);
  const r = (
    await pool().query(
      "SELECT data,version,visibility_ids FROM records WHERE id=$1",
      [person],
    )
  ).rows[0];
  assert.deepEqual(r.data, {
    ...original,
    email: contact.value,
    publicContacts: upload.rows[0].contacts,
  });
  assert.deepEqual(r.visibility_ids, [owner]);
  assert.equal(
    (
      await pool().query(
        "SELECT content FROM record_private_notes WHERE record_id=$1",
        [person],
      )
    ).rows[0].content,
    "Private note stays private",
  );
  const again = await reviewPeopleContacts(owner, workspace, {
    upload,
    digest: p.digest,
  });
  assert.equal("updated" in again && again.updated, 0);
  assert.equal(
    (await pool().query("SELECT version FROM records WHERE id=$1", [person]))
      .rows[0].version,
    r.version,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT count(*)::int n FROM audit WHERE record_id=$1",
        [person],
      )
    ).rows[0].n,
    1,
  );
});
test("ordinary edits preserve reviewed contacts and cannot inject evidence", async () => {
  const r = (
    await pool().query("SELECT data,version FROM records WHERE id=$1", [person])
  ).rows[0];
  await assert.rejects(
    saveRecord(owner, workspace, {
      id: person,
      kind: "people",
      version: r.version,
      data: {
        ...r.data,
        publicContacts: [{ ...contact, value: "injected@fund.org" }],
      },
    }),
  );
  await assert.rejects(
    importRecords(owner, workspace, {
      kind: "people",
      rows: [{ name: "Injected evidence", publicContacts: [contact] }],
    }),
  );
  const omitted = { ...r.data };
  delete omitted.publicContacts;
  await saveRecord(owner, workspace, {
    id: person,
    kind: "people",
    version: r.version,
    data: omitted,
  });
  assert.deepEqual(
    (await pool().query("SELECT data FROM records WHERE id=$1", [person]))
      .rows[0].data.publicContacts,
    r.data.publicContacts,
  );
});
test("never overwrite an existing different personal email or import into an archived record", async () => {
  await assert.rejects(
    reviewPeopleContacts(owner, workspace, {
      upload: {
        ...upload,
        rows: [
          {
            ...upload.rows[0],
            expected: { ...upload.rows[0].expected, email: contact.value },
            contacts: [{ ...contact, value: "alternative@fund.org" }],
          },
        ],
      },
    }),
  );
  await pool().query("UPDATE records SET archived_at=now() WHERE id=$1", [
    person,
  ]);
  await assert.rejects(reviewPeopleContacts(owner, workspace, { upload }));
});
