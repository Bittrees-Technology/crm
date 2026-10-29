import { test } from "node:test";
import assert from "node:assert/strict";
import { recordSchema } from "../lib/model";
import { viewSchema } from "../lib/workflow";
import {
  availableContacts,
  contactAvailabilityValues,
  matchesContactAvailability,
  normalizeContactAvailability,
} from "../lib/contact-availability";

test("contact presence combines primary, additional, and reviewed contact fields", () => {
  const data = recordSchema.parse({
    name: "Contact",
    email: "primary@example.com",
    website: "https://www.linkedin.com/in/person",
    contactMethods: [
      { type: "phone", label: "Work", value: "+1 212 555 0199" },
      {
        type: "social",
        label: "Personal",
        value: "https://twitter.com/person",
      },
      {
        type: "social",
        label: "Mastodon",
        value: "https://social.example/@person",
      },
      { type: "address", label: "Office", value: "New York, NY" },
    ],
    publicContacts: [
      {
        kind: "Telegram",
        value: "https://t.me/person",
        sourceURL: "https://firm.org/person",
        retrievedAt: "2026-10-29T00:00:00Z",
        evidence: "Named professional biography links this account.",
        status: "Public source; delivery unverified",
      },
    ],
  });
  const original = JSON.stringify(data);
  assert.deepEqual(
    [...availableContacts(data)].sort(),
    [
      "any",
      "email",
      "phone",
      "website",
      "social",
      "linkedin",
      "x",
      "telegram",
      "otherSocial",
      "address",
    ].sort(),
  );
  for (const filter of contactAvailabilityValues) {
    assert.equal(
      matchesContactAvailability(data, filter),
      !filter.startsWith("missing:"),
      filter,
    );
  }
  assert.equal(
    JSON.stringify(data),
    original,
    "presence checks do not mutate records",
  );
});
test("missing information is the complement of has, and descriptions/sources are not contacts", () => {
  const blank = recordSchema.parse({
    name: "Missing",
    description:
      "Email person@example.com or see https://linkedin.com/in/person",
    source: "https://x.com/person",
  });
  for (const filter of contactAvailabilityValues) {
    assert.equal(
      matchesContactAvailability(blank, filter),
      !filter.startsWith("has:"),
      filter,
    );
  }
  for (const [type, value, expected] of [
    ["email", "additional@example.com", "email"],
    ["website", "https://firm.org", "website"],
    ["linkedin", "https://linkedin.com/company/firm", "linkedin"],
    ["x", "https://x.com/firm", "x"],
    ["social", "https://t.me/firmname", "telegram"],
  ]) {
    const data = recordSchema.parse({
      name: "Organization",
      contactMethods: [{ type, label: "Work", value }],
    });
    assert.equal(availableContacts(data).has(expected as any), true);
    assert.equal(availableContacts(data).has("email"), expected === "email");
  }
  for (const website of [
    "https://linkedin.com.evil.org/in/person",
    "https://firm.org/?social=x.com/person",
  ]) {
    assert.equal(
      availableContacts(
        recordSchema.parse({ name: "Not a social", website }),
      ).has("social"),
      false,
    );
  }
});
test("saved contact filters are bounded and backward compatible", () => {
  const old = {
    name: "Old view",
    page: "people",
    search: "",
    filter: "all",
    board: false,
  };
  assert.deepEqual(viewSchema.parse(old), old);
  for (const value of contactAvailabilityValues)
    assert.equal(
      viewSchema.parse({ ...old, contactAvailability: value })
        .contactAvailability,
      value,
    );
  assert.equal(
    viewSchema.safeParse({ ...old, contactAvailability: "has:privateNote" })
      .success,
    false,
  );
  assert.equal(normalizeContactAvailability(undefined), "all");
  assert.equal(normalizeContactAvailability("unknown"), "all");
});

test("reviewed contacts count without primary or additional fields", () => {
  for (const [kind, value, field] of [
    ["email", "person@example.com", "email"],
    ["LinkedIn", "https://linkedin.com/in/person", "linkedin"],
    ["X", "https://x.com/person", "x"],
    ["Telegram", "https://t.me/person", "telegram"],
  ]) {
    const data = recordSchema.parse({
      name: "Reviewed",
      publicContacts: [
        {
          kind,
          value,
          sourceURL: "https://firm.org/person",
          retrievedAt: "2026-10-29T00:00:00Z",
          evidence: "Named professional biography links this account.",
          status: "Public source; delivery unverified",
        },
      ],
    });
    assert.equal(matchesContactAvailability(data, `has:${field}` as any), true);
    assert.equal(
      matchesContactAvailability(data, `missing:${field}` as any),
      false,
    );
    assert.equal(
      matchesContactAvailability(data, "has:social"),
      kind !== "email",
    );
  }
});
