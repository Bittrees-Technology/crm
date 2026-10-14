import test from "node:test";
import assert from "node:assert/strict";
import { calendarDay, matchesFollowup } from "../lib/followups";
import { digestOptionsSchema } from "../lib/digest-options";
import { sameImportIdentity } from "../lib/import-matches";
import { recordSchema } from "../lib/model";
test("Timezone day boundaries and follow-up ownership are shared by Today and digest", () => {
  const date = new Date("2026-10-14T01:00:00Z");
  assert.equal(calendarDay(date, "America/Los_Angeles"), "2026-10-13");
  assert.equal(calendarDay(date, "Asia/Tokyo"), "2026-10-14");
  assert.equal(
    digestOptionsSchema.safeParse({ timeZone: "not/a-zone" }).success,
    false,
  );
  const options = digestOptionsSchema.parse({});
  const r = {
    kind: "tasks",
    data: { ownerId: "a", status: "Open", dueDate: "2026-10-14" },
  };
  assert(matchesFollowup(r, "a", "2026-10-14", options));
  assert(!matchesFollowup(r, "b", "2026-10-14", options));
  assert(
    !matchesFollowup(
      { ...r, archived_at: "2026-10-14" },
      "a",
      "2026-10-14",
      options,
    ),
  );
});
test("Import matching distinguishes people with the same name and different emails", () => {
  const a = recordSchema.parse({ name: "Alex", email: "alex@one.org" }),
    b = recordSchema.parse({ name: "Alex", email: "alex@two.org" });
  assert(!sameImportIdentity(a, b));
  assert(sameImportIdentity(a, { ...b, email: a.email }));
});
