import { test } from "node:test";
import assert from "node:assert/strict";
import { recordSchema } from "../lib/model";
import { contactMethodSchema, contactHref } from "../lib/contact-methods";

test("contact fields preserve legacy primary contacts and repeated labeled values", () => {
  const legacy = recordSchema.parse({
    name: "Contact",
    email: "primary@example.com",
    website: "https://example.com",
  });
  assert.equal(Object.hasOwn(legacy, "contactMethods"), false);
  const contactMethods = [
    { type: "email", label: "Personal", value: "other@example.com" },
    { type: "phone", label: "Mobile", value: "+351 912 345 678" },
    {
      type: "linkedin",
      label: "Work",
      value: "https://www.linkedin.com/in/example",
    },
    { type: "x", label: "", value: "https://twitter.com/example" },
    {
      type: "address",
      label: "Office",
      value: "123 Main St\nNew York, NY 10001",
    },
    {
      type: "social",
      label: "Mastodon",
      value: "https://example.social/@example",
    },
  ];
  const saved = recordSchema.parse(
    JSON.parse(JSON.stringify({ ...legacy, contactMethods })),
  );
  assert.deepEqual(saved.contactMethods, contactMethods);
  assert.equal(saved.email, legacy.email);
  assert.equal(saved.website, legacy.website);
  assert.equal(contactHref(saved.contactMethods![1]), "tel:+351912345678");
  assert.equal(contactHref(saved.contactMethods![4]), undefined);
  assert.equal(
    contactHref({
      type: "phone",
      label: "Office",
      value: "+1 (212) 555-0199 ext 42",
    }),
    "tel:+12125550199;ext=42",
  );
  assert.deepEqual(
    recordSchema.parse({ ...saved, contactMethods: [] }).contactMethods,
    [],
  );
});
test("invalid and unsafe contact values cannot be saved or linked", () => {
  for (const [type, value] of [
    ["email", "bad"],
    ["email", "a@example.com\r\nBcc:b@example.com"],
    ["phone", "abc"],
    ["website", "javascript:alert(1)"],
    ["social", "https://user:password@example.com"],
    ["linkedin", "https://linkedin.com.evil.example/me"],
    ["x", "https://example.com/x"],
    ["address", " "],
  ]) {
    assert.equal(
      contactMethodSchema.safeParse({ type, value, label: "" }).success,
      false,
      type + value,
    );
  }
  assert.equal(
    recordSchema.safeParse({
      name: "Bounded",
      contactMethods: Array.from({ length: 21 }, () => ({
        type: "email",
        label: "",
        value: "a@example.com",
      })),
    }).success,
    false,
  );
});
