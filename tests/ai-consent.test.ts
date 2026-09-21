import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
test("AI consent gets a unique nonce, private cache policy and no third-party origins", () => {
  const a = proxy(new NextRequest("http://127.0.0.1:3040/connect/ai")),
    b = proxy(new NextRequest("http://127.0.0.1:3040/connect/ai"));
  const csp = a.headers.get("Content-Security-Policy")!;
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert(!csp.includes("https:"));
  assert(!csp.includes("'unsafe-inline'"));
  assert.notEqual(csp, b.headers.get("Content-Security-Policy"));
  assert.equal(a.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(a.headers.get("Cache-Control"), "private, no-store");
  assert.equal(
    a.headers.get("x-middleware-request-content-security-policy"),
    csp,
  );
});
