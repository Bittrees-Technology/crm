import test from "node:test";
import assert from "node:assert/strict";
import {
  supplierUrls,
  supplierSignature,
  trustedSupplierData,
} from "../lib/supplier-research";
test("supplier URL authority rejects ambiguous and private destinations", () => {
  for (const urls of [
    ["http://supplier.example.com/"],
    ["https://127.0.0.1/"],
    ["https://[::1]/"],
    ["https://user:pass@supplier.example.com/"],
    ["https://supplier.example.com/?q=secret"],
    ["https://supplier.example.com/#a"],
    ["https://supplier.example.com:444/"],
    ["https://a.example.com/", "https://b.example.com/"],
    ["https://supplier.local/"],
    ["https://supplier.example.com/", "https://supplier.example.com/"],
  ])
    assert.equal(
      supplierUrls.safeParse(urls).success,
      false,
      JSON.stringify(urls),
    );
  assert.equal(
    supplierUrls.safeParse([
      "https://supplier.example.com/",
      "https://www.supplier.example.com/team",
    ]).success,
    true,
  );
});
test("signed supplier metadata survives JSONB ordering but not altered bindings", () => {
  const p = {
    version: 1,
    projectId: "project",
    organizationId: "org",
    ownerId: "user",
    urls: ["https://supplier.example.com/"],
  };
  const data = {
    projectId: "project",
    organizationId: "org",
    ownerId: "user",
    category: "AI review",
    supplierResearch: { urls: p.urls, version: 1 },
    supplierPreparation: { ...p, signature: supplierSignature(p) },
  };
  assert.equal(trustedSupplierData(data), true);
  assert.equal(trustedSupplierData({ ...data, projectId: "other" }), false);
  assert.equal(
    trustedSupplierData({
      ...data,
      supplierResearch: { version: 1, urls: ["https://evil.example.com/"] },
    }),
    false,
  );
});
