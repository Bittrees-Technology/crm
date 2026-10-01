import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db";
import { recordSchema } from "../lib/model";
import { accessProjection } from "../lib/access";
const url = new URL(process.env.DATABASE_URL || "http://invalid");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/crm_test")
  throw new Error("Synthetic benchmark requires isolated local crm_test");
const db = await pool().connect();
try {
  await db.query("BEGIN");
  const workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    workspace,
    "Synthetic transfer benchmark",
  ]);
  const data = recordSchema.parse({
    name: "Synthetic lead",
    description: "x".repeat(4000),
  });
  await db.query(
    "INSERT INTO records(id,workspace_id,kind,data) SELECT gen_random_uuid(),$1,'people',$2 FROM generate_series(1,1000)",
    [workspace, data],
  );
  const full = (
    await db.query("SELECT * FROM records WHERE workspace_id=$1", [workspace])
  ).rows;
  const graph = (
    await db.query(
      `SELECT ${accessProjection} FROM records WHERE workspace_id=$1`,
      [workspace],
    )
  ).rows;
  const ids = (
    await db.query("SELECT id FROM records WHERE workspace_id=$1", [workspace])
  ).rows;
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const result = {
    syntheticRecords: 1000,
    fullRecordPayloadBytes: bytes(full),
    singleRecordPayloadBytes: bytes(full[0]),
    previousPermissionPayloadBytes: bytes(
      full.map(({ id, kind, data, visibility_ids }) => ({
        id,
        kind,
        data,
        visibility_ids,
      })),
    ),
    scopedPermissionPayloadBytes: bytes(graph),
    wholeWorkspacePermissionPayloadBytes: bytes(ids),
  };
  assert.ok(
    result.singleRecordPayloadBytes < result.fullRecordPayloadBytes / 100,
  );
  assert.ok(
    result.scopedPermissionPayloadBytes <
      result.previousPermissionPayloadBytes / 10,
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.query("ROLLBACK");
  db.release();
  await pool().end();
}
