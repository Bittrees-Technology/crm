import test from "node:test";
import assert from "node:assert/strict";
import { candidateSchema } from "../lib/lead-model";
import { publishableCandidates } from "../lib/lead-selection";

test("bulk selection includes large batches and excludes blocked linked groups", () => {
  const org = candidateSchema.parse({
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
  const candidates = Array.from({ length: 601 }, (_, i) => ({
    ...org,
    kind: "people" as const,
    name: `Person ${i}`,
    organizationIndex: 601,
  }));
  const batch = [
    ...candidates,
    org,
    { ...org, kind: "tasks" as const, name: "Review contact", contactIndex: 0 },
  ];
  const matches: unknown[][] = batch.map(() => []);
  assert.equal(publishableCandidates(batch, matches, {}).length, 603);
  matches[601] = [{}];
  assert.deepEqual(publishableCandidates(batch, matches, {}), []);
  assert.equal(
    publishableCandidates(batch, matches, { "601": "chosen-existing-record" })
      .length,
    603,
  );
});
