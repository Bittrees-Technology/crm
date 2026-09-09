import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAccess, type AccessRecord } from "../lib/access-graph";
import { recordSchema } from "../lib/model";
const record = (
  id: string,
  refs: Record<string, string> = {},
  visibility_ids: string[] | null = null,
): AccessRecord => ({
  id,
  kind: "projects",
  data: { ...recordSchema.parse({ name: id }), ...refs },
  visibility_ids,
});
test("access graph handles cycles, hidden barriers, alternate paths, and direct grants", () => {
  const member = { user_id: "user", role: "editor", scope_ids: ["root"] };
  const records = [
    record("root", { projectId: "child" }),
    record("hidden", { projectId: "root" }, []),
    record("child", { projectId: "hidden" }),
    record("alternate", { projectId: "hidden", organizationId: "root" }),
    record("direct", {}, ["user"]),
    record("direct-child", { projectId: "direct" }),
  ];
  assert.deepEqual([...resolveAccess(records, member).keys()].sort(), [
    "alternate",
    "direct",
    "root",
  ]);
  records[1].visibility_ids = null;
  assert.ok(resolveAccess(records, member).has("child"));
  assert.equal(
    resolveAccess(records, { ...member, role: "owner" }).size,
    records.length,
  );
});
