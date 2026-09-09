import { test } from "node:test";
import assert from "node:assert/strict";
import { bounded, walletIdentity, walletError } from "../lib/auth-client";
test("wallet waits are bounded and late answers do not resume cancelled flows", async () => {
  const signal = new AbortController();
  await assert.rejects(
    () => bounded(new Promise(() => {}), signal.signal, 10, "Timed out"),
    /Timed out/,
  );
  let resolve: (v: unknown) => void = () => {};
  const pending = new Promise((r) => (resolve = r)),
    controller = new AbortController(),
    requests: string[] = [];
  const p = walletIdentity(
    { request: () => pending },
    controller.signal,
    () => {},
    async (path) => {
      requests.push(path);
      return {};
    },
    true,
  );
  controller.abort();
  await assert.rejects(() => p, /cancelled/);
  resolve(["0x0000000000000000000000000000000000000001"]);
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(requests, []);
});
test("wallet errors distinguish rejection from an already open request", () => {
  assert.match(walletError({ code: 4001 }), /declined/);
  assert.match(walletError({ code: -32002 }), /already open/);
});
