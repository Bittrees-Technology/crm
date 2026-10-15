import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../integrations/lead-mcp.mjs";
test("MCP adapter exposes brief, preview and status tools and keeps credential out of results", async () => {
  const token = "a".repeat(64);
  const calls: any[] = [];
  const run = handler({
    token,
    request: async (url: any, options: any) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ reviewId: "review" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await run({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const list: any = await run({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    list.result.tools.map((t: any) => t.name),
    ["leads.status", "leads.brief", "leads.preview"],
  );
  const result = await run({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "leads.preview",
      arguments: { operationId: "op", candidates: [] },
    },
  });
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + token);
  assert.equal(calls[0].options.redirect, "error");
  assert(!JSON.stringify(result).includes(token));
  assert.throws(
    () => handler({ token, origin: "https://attacker.org" }),
    /Unsupported/,
  );
});
