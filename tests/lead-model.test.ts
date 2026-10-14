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
