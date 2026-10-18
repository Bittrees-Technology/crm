import test from "node:test";
import assert from "node:assert/strict";
import {
  briefSchema,
  candidateSchema,
  validateCandidates,
  publicUrl,
} from "../lib/lead-model";
test("Lead validation rejects stale, excluded, duplicate and non-permitted sources", () => {
  const brief = briefSchema.parse({
    target: "Tools",
    sourceDomains: ["bittrees.org"],
    exclusions: ["Excluded"],
  });
  const c = candidateSchema.parse({
    name: "Research",
    website: "https://research.org",
    summary: "Tools",
    relevance: "Useful",
    uncertainties: "Unknown",
    fit: "high",
    evidence: "primary",
    sources: [
      { url: "https://bittrees.org/", retrievedAt: new Date().toISOString() },
    ],
  });
  validateCandidates(brief, [c]);
  assert.throws(() => validateCandidates(brief, [c, c]), /one candidate/);
  assert.throws(
    () => validateCandidates(brief, [{ ...c, name: "Excluded" }]),
    /exclusion/,
  );
  assert.throws(
    () =>
      validateCandidates(brief, [
        {
          ...c,
          sources: [
            { ...c.sources[0], url: "https://bittrees.org.attacker.com" },
          ],
        },
      ]),
    /permitted/,
  );
  assert.throws(
    () =>
      validateCandidates(brief, [
        {
          ...c,
          sources: [{ ...c.sources[0], retrievedAt: "2020-01-01T00:00:00Z" }],
        },
      ]),
    /freshness/,
  );
  for (const url of [
    "http://company.org",
    "https://127.0.0.1",
    "https://localhost",
    "https://user:pass@company.org",
    "https://company.org:123",
  ])
    assert.equal(publicUrl.safeParse(url).success, false);
});

test("Investor people can share a firm domain and links must point to organizations", () => {
  const brief = briefSchema.parse({
    target: "Investors",
    sourceDomains: ["bittrees.org"],
  });
  const org = candidateSchema.parse({
    name: "Firm",
    website: "https://bittrees.org",
    summary: "Research",
    relevance: "Seed",
    uncertainties: "",
    fit: "high",
    evidence: "primary",
    sources: [
      { url: "https://bittrees.org", retrievedAt: new Date().toISOString() },
    ],
  });
  const person = candidateSchema.parse({
    ...org,
    kind: "people",
    name: "Person one",
    organizationIndex: 0,
  });
  validateCandidates(brief, [org, person, { ...person, name: "Person two" }]);
  assert.throws(
    () => validateCandidates(brief, [org, { ...person, organizationIndex: 1 }]),
    /Link people/,
  );
  assert.throws(
    () => validateCandidates(brief, [{ ...org, organizationIndex: 0 }]),
    /Link people/,
  );
});

test("Task proposals require explicit assignment scope and valid linked contacts", () => {
  const brief = briefSchema.parse({
    target: "Vendors",
    sourceDomains: ["bittrees.org"],
  });
  const task = candidateSchema.parse({
    kind: "tasks",
    name: "Verify vendor",
    website: "https://bittrees.org",
    summary: "Verify shipping",
    relevance: "Follow-up",
    uncertainties: "",
    fit: "high",
    evidence: "primary",
    sources: [
      { url: "https://bittrees.org", retrievedAt: new Date().toISOString() },
    ],
  });
  assert.throws(() => validateCandidates(brief, [task]), /explicit/);
  validateCandidates({ ...brief, allowTasks: true }, [task]);
  assert.throws(
    () =>
      validateCandidates({ ...brief, allowTasks: true }, [
        { ...task, contactIndex: 0 },
      ]),
    /contact/,
  );
});

test("owners choose larger research targets without changing an existing brief's allowance", () => {
  const brief = briefSchema.parse({
    target: "Investors",
    sourceDomains: ["bittrees.org"],
    maxResults: 2000,
  });
  const base = candidateSchema.parse({
    researchMethod: "manual",
    name: "Firm",
    website: "",
    summary: "Research",
    relevance: "Research",
    uncertainties: "Unconfirmed",
    fit: "medium",
    evidence: "unconfirmed",
    sources: [],
  });
  const batch = Array.from({ length: 625 }, (_, i) => ({
    ...base,
    kind: "people" as const,
    name: `Person ${i}`,
    organizationIndex: 625,
  }));
  const linked = [...batch, base];
  validateCandidates(brief, linked);
  assert.throws(
    () => validateCandidates({ ...brief, maxResults: 20 }, linked),
    /Too many/,
  );
  assert.throws(
    () =>
      validateCandidates(brief, [
        { ...base, kind: "people", organizationIndex: 626 },
      ]),
    /Link people/,
  );
});
