import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, loadWorkspacePages } from "../lib/workspace-loader";
import { recordSchema, type CrmRecord } from "../lib/model";
const record = (id: string): CrmRecord => ({
  id,
  kind: "notes",
  version: 1,
  data: recordSchema.parse({ name: id }),
  updated_at: "2026-10-01",
  created_at: "2026-10-01",
});
test("pages commit a complete view and restart once after concurrent changes", async () => {
  let calls = 0;
  const result = await loadWorkspacePages(async () => {
    calls++;
    if (calls === 1)
      return { records: [record("old")], nextCursor: "old-page" };
    if (calls === 2) throw new ApiError("changed", 409);
    if (calls === 3) return { records: [record("a")], nextCursor: "new-page" };
    return { records: [record("b")], nextCursor: null };
  }, "workspace");
  assert.deepEqual(
    result.records.map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(calls, 4);
});
test("failed/looping pages cannot publish partial records or retry forever", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      loadWorkspacePages(async () => {
        calls++;
        throw new ApiError("changed", 409);
      }, "workspace"),
    /changed/,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    () =>
      loadWorkspacePages(
        async () => ({ records: [record("a")], nextCursor: "same" }),
        "workspace",
      ),
    /could not finish/,
  );
});
