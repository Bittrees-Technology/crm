import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publish } from "../lib/autonote";

// Exercise the real publisher and authorization code with a strict in-memory
// query double. No database connection or environment credentials are used.
test("AutoNote batches receipts without bypassing replay access or current grants", async () => {
  const user = randomUUID(),
    workspace = randomUUID(),
    targetId = randomUUID();
  const grant = {
    id: randomUUID(),
    user_id: user,
    workspace_id: workspace,
    target_id: targetId,
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null as Date | null,
  };
  const target = {
    id: targetId,
    kind: "organizations",
    data: { name: "Target" },
    visibility_ids: [user],
  };
  const records = new Map<string, any>([[targetId, target]]);
  const receipts = new Map<string, string>();
  const queries: { sql: string; args: any[] }[] = [];
  let role = "editor";
  const db = {
    release() {},
    async query(sql: string, args: any[] = []) {
      queries.push({ sql, args });
      const rows = (values: any[]) => ({ rows: values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return rows([]);
      if (sql.includes("FROM autonote_grants"))
        return rows(grant.revoked_at ? [] : [grant]);
      if (sql.includes("FROM users")) return rows([{ merged_into: null }]);
      if (sql.includes("FROM workspaces")) return rows([{ id: workspace }]);
      if (sql.includes("FROM members"))
        return rows([{ user_id: user, role, scope_ids: null }]);
      if (sql.startsWith("SELECT * FROM records")) return rows([target]);
      if (sql.includes("FROM records")) return rows([...records.values()]);
      if (sql.includes("FROM autonote_receipts")) {
        assert.deepEqual(args.slice(0, 4), [
          user,
          workspace,
          targetId,
          content.meetingId,
        ]);
        assert.match(sql, /item_id=ANY\(\$5::text\[\]\)/);
        return rows(
          args[4]
            .filter((id: string) => receipts.has(id))
            .map((id: string) => ({
              item_id: id,
              record_id: receipts.get(id),
            })),
        );
      }
      if (sql.startsWith("INSERT INTO records")) {
        assert.equal(args[1], workspace);
        assert.deepEqual(args[4], target.visibility_ids);
        records.set(args[0], {
          id: args[0],
          kind: args[2],
          data: args[3],
          visibility_ids: args[4],
        });
        return rows([]);
      }
      if (sql.startsWith("INSERT INTO autonote_receipts")) {
        receipts.set(args[4], args[5]);
        return rows([]);
      }
      if (sql.startsWith("INSERT INTO audit")) return rows([]);
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const globalDb = globalThis as any;
  const oldPool = globalDb.crmPool,
    oldUrl = process.env.DATABASE_URL;
  globalDb.crmPool = { connect: async () => db };
  process.env.DATABASE_URL = "postgres://unused/never-connected";
  const content = {
    meetingId: randomUUID(),
    title: "Meeting",
    summary: "Summary",
    actions: Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      text: `Action ${i}`,
      dueDate: null,
    })),
  };
  const receiptQueries = () =>
    queries.filter((q) => q.sql.includes("FROM autonote_receipts"));
  try {
    const first = await publish("test-token", content);
    assert.equal(first.items.length, 31);
    assert.equal(receiptQueries().length, 1);
    assert.ok(first.items.every((i) => !i.existing));
    queries.length = 0;
    const repeat = await publish("test-token", content);
    assert.deepEqual(
      repeat.items.map((i) => i.recordId),
      first.items.map((i) => i.recordId),
    );
    assert.ok(repeat.items.every((i) => i.existing));
    assert.equal(receiptQueries().length, 1);
    assert.equal(queries.filter((q) => q.sql.startsWith("INSERT")).length, 0);

    // A partial retry creates only the missing delivery and preserves order.
    receipts.delete("action:29");
    queries.length = 0;
    const mixed = await publish("test-token", content);
    assert.equal(mixed.items.filter((i) => !i.existing).length, 1);
    assert.equal(mixed.items.at(-1)?.itemId, "action:29");
    assert.equal(receiptQueries().length, 1);

    // Previously published private content is not disclosed after access loss.
    records.get(first.items[0].recordId).visibility_ids = [randomUUID()];
    await assert.rejects(publish("test-token", content), /Record not found/);
    role = "viewer";
    queries.length = 0;
    await assert.rejects(publish("test-token", content), /workspace role/);
    assert.equal(receiptQueries().length, 0);
    role = "editor";
    grant.revoked_at = new Date();
    await assert.rejects(
      publish("test-token", content),
      /expired or was revoked/,
    );
  } finally {
    globalDb.crmPool = oldPool;
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
  }
});
