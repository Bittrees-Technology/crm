import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { pool, schema } from "../lib/db";
import { viewSchema } from "../lib/workflow";
import { recordSchema } from "../lib/model";
import { saveRecord, importRecords } from "../lib/service";
import { reviewOrganizationStanding } from "../lib/organization-standing";
import {
  standingFor,
  standingOrder,
  standingUploadSchema,
} from "../lib/organization-standing-model";
const owner = randomUUID(),
  editor = randomUUID(),
  stranger = randomUUID(),
  workspace = randomUUID();
const isolated = "standing_test_" + randomUUID().replaceAll("-", "");
let admin: Pool;
const assessment = {
  tier: "B" as const,
  confidence: "Low" as const,
  status: "Provisional analyst judgment" as const,
  rationale: "Published institutional history; returns unverified.",
  themeFit: "Needs qualification",
  fitBasis: "Directory hypothesis",
  fitStatus: "Directory-based hypothesis; unverified" as const,
  reviewQueue: "Standard qualification",
  flags: ["Limited corroboration"],
  reviewedAt: "2026-10-18T15:33:38.259471+00:00",
  sources: [
    {
      url: "https://example.com/about",
      retrievedAt: "2026-10-18T12:00:00Z",
      basis: "Official self-description",
    },
  ],
};
const orgIds = Array.from({ length: 617 }, () => randomUUID());
const upload = {
  schema: "bittrees-organization-standing.v1" as const,
  rows: orgIds.map((_, i) => ({
    name: `Organization ${i}`,
    website: `https://example${i}.com/`,
    assessment,
  })),
};
before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/crm_test"
  )
    throw Error("Isolated local crm_test required");
  admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${isolated}`);
  url.searchParams.set("options", `-c search_path=${isolated}`);
  process.env.DATABASE_URL = url.href;
  await pool().query(schema);
  for (const id of [owner, editor, stranger])
    await pool().query(
      "INSERT INTO users(id,name) VALUES($1,'Synthetic user')",
      [id],
    );
  await pool().query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Synthetic standing workspace')",
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
  for (let i = 0; i < orgIds.length; i++)
    await pool().query(
      "INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,'organizations',$3,$4)",
      [
        orgIds[i],
        workspace,
        recordSchema.parse({
          name: upload.rows[i].name,
          website: upload.rows[i].website,
          description: "Preserve context",
          investorVerification: "Incomplete",
          email: `team@example${i}.com`,
          ownerId: owner,
        }),
        [owner],
      ],
    );
  await pool().query(
    "INSERT INTO record_private_notes(record_id,author_id,content) VALUES($1,$2,'Preserve private note')",
    [orgIds[0], owner],
  );
});
after(async () => {
  await pool().end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${isolated} CASCADE`);
    await admin.end();
  }
});
test("owner-only preview, identities, stale conflict, atomic 617-row preservation and idempotency", async () => {
  await assert.rejects(
    reviewOrganizationStanding(editor, workspace, { upload }),
    /role does not allow/,
  );
  await assert.rejects(
    reviewOrganizationStanding(stranger, workspace, { upload }),
    /not found/,
  );
  const revision = (await pool().query("SELECT read_revision FROM workspaces WHERE id=$1", [workspace])).rows[0].read_revision;
  assert(Number(revision) > 0, "The isolated schema must have its own revision triggers even when other schemas already have namesake triggers");
  const p = await reviewOrganizationStanding(owner, workspace, { upload });
  assert.equal(p.matched, 617);
  assert.equal(p.changed, 617);
  assert.equal(
    (
      await pool().query(
        "SELECT count(*) FROM records WHERE data ? 'organizationStanding'",
      )
    ).rows[0].count,
    "0",
  );
  const bad = structuredClone(upload);
  bad.rows[0].website = "https://different.example";
  await assert.rejects(
    reviewOrganizationStanding(owner, workspace, { upload: bad }),
    /Website differs/,
  );
  await assert.rejects(
    reviewOrganizationStanding(owner, workspace, {
      upload: { ...upload, rows: [...upload.rows, upload.rows[0]] },
    }),
    /appear once/,
  );
  const duplicate = randomUUID();
  await pool().query(
    "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'organizations',$3)",
    [
      duplicate,
      workspace,
      { name: "Organization 0", website: upload.rows[0].website },
    ],
  );
  await assert.rejects(
    reviewOrganizationStanding(owner, workspace, { upload }),
    /uniquely match/,
  );
  await pool().query("DELETE FROM records WHERE id=$1", [duplicate]);
  await pool().query("UPDATE records SET version=version+1 WHERE id=$1", [
    orgIds[0],
  ]);
  await assert.rejects(
    reviewOrganizationStanding(owner, workspace, { upload, digest: p.digest }),
    /changed after preview/,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT count(*) FROM records WHERE data ? 'organizationStanding'",
      )
    ).rows[0].count,
    "0",
  );
  const before = (await pool().query("SELECT * FROM records ORDER BY id")).rows;
  const fresh = await reviewOrganizationStanding(owner, workspace, { upload });
  assert.equal(
    (
      await reviewOrganizationStanding(owner, workspace, {
        upload,
        digest: fresh.digest,
      })
    ).updated,
    617,
  );
  const updated = (await pool().query("SELECT * FROM records ORDER BY id"))
    .rows;
  for (let i = 0; i < before.length; i++) {
    const { organizationStanding, ...unchanged } = updated[i].data;
    assert.deepEqual(unchanged, before[i].data);
    assert.equal(organizationStanding.tier, "B");
    assert.deepEqual(updated[i].visibility_ids, before[i].visibility_ids);
    assert.equal(updated[i].version, before[i].version + 1);
  }
  assert.equal(
    (await pool().query("SELECT content FROM record_private_notes")).rows[0]
      .content,
    "Preserve private note",
  );
  assert.equal(
    (
      await pool().query(
        "SELECT count(*) FROM audit WHERE action='Organization standing reviewed'",
      )
    ).rows[0].count,
    "617",
  );
  assert.equal(
    (
      await reviewOrganizationStanding(owner, workspace, {
        upload,
        digest: fresh.digest,
      })
    ).updated,
    0,
  );
});
test("ordinary edits preserve standing; generic saves and CSV cannot inject it", async () => {
  const r = (
    await pool().query("SELECT * FROM records WHERE id=$1", [orgIds[0]])
  ).rows[0];
  const { organizationStanding, ...legacy } = r.data;
  const saved = await saveRecord(owner, workspace, {
    id: r.id,
    kind: "organizations",
    version: r.version,
    data: { ...legacy, description: "Edited description" },
  });
  assert.deepEqual(saved.data.organizationStanding, organizationStanding);
  await assert.rejects(
    saveRecord(owner, workspace, {
      kind: "organizations",
      data: { name: "Injected", organizationStanding: assessment },
    }),
    /owner review import/,
  );
  await assert.rejects(
    importRecords(owner, workspace, {
      kind: "organizations",
      rows: [{ name: "Injected", organizationStanding: assessment }],
    }),
    /owner review import/,
  );
});
test("people use available linked organizations; platform/unrated separate; reject invented confidence and unsafe URLs", () => {
  const org: any = {
    id: orgIds[0],
    kind: "organizations",
    data: { organizationStanding: assessment },
  };
  const person: any = { kind: "people", data: { organizationId: org.id } };
  assert.equal(standingFor(person, [org])?.assessment.tier, "B");
  assert.equal(standingFor(person, []), undefined);
  assert.equal(
    standingFor(person, [{ ...org, archived_at: "2026-10-20" }]),
    undefined,
  );
  assert(standingOrder("C") < standingOrder("P"));
  assert(standingOrder("P") < standingOrder("U"));
  assert(standingOrder("U") < standingOrder());
  assert(
    !standingUploadSchema.safeParse({
      ...upload,
      rows: [
        {
          ...upload.rows[0],
          assessment: { ...assessment, confidence: "High" },
        },
      ],
    }).success,
  );
  assert(
    !standingUploadSchema.safeParse({
      ...upload,
      rows: [
        {
          ...upload.rows[0],
          assessment: {
            ...assessment,
            sources: [{ ...assessment.sources[0], url: "javascript:alert(1)" }],
          },
        },
      ],
    }).success,
  );
});

test("saved views retain standing tier and sort without changing legacy views", () => {
  const old = {
    name: "Investors",
    page: "organizations",
    search: "",
    filter: "all",
    board: false,
  };
  assert.deepEqual(viewSchema.parse(old), old);
  assert.equal(
    viewSchema.parse({ ...old, standingTier: "A", standingSort: "standing" })
      .standingSort,
    "standing",
  );
});

test("unknown source retrieval dates remain explicit rather than invented", () => {
  const copy = structuredClone(upload) as any;
  copy.rows[0].assessment.sources[0].retrievedAt = null;
  assert.equal(
    standingUploadSchema.parse(copy).rows[0].assessment.sources[0].retrievedAt,
    null,
  );
});
