import test from "node:test";
import assert from "node:assert/strict";
import {
  investorAssessmentFields,
  qualificationCategory,
  qualificationGates,
  qualificationSchema,
} from "../lib/qualification-model";
test("promising fit does not imply verified and preserves companion category", () => {
  const entry = {
    category: "BBRF-PT | Priority research",
    research: { fitAssessment: { status: "Promising fit" } },
  };
  assert.deepEqual(investorAssessmentFields(entry), {
    investorFit: "Promising fit",
    investorVerification: "Incomplete",
  });
  assert.equal(qualificationCategory(entry, "BBRF-PT"), entry.category);
  const gates = Object.fromEntries(
    qualificationGates.map((k) => [
      k,
      {
        status: "supported",
        evidence: "Public source evidence",
        url: "https://example.com/team",
      },
    ]),
  );
  const q = {
    status: "Qualified",
    reviewedAt: new Date().toISOString(),
    summary: "All checks supported",
    gates,
    sources: [
      {
        url: "https://example.com/team",
        retrievedAt: new Date().toISOString(),
        quote: "Public source evidence",
      },
    ],
  };
  assert(qualificationSchema.safeParse(q).success);
  assert.equal(
    investorAssessmentFields({ research: { qualification: q } })
      .investorVerification,
    "Fully verified",
  );
  gates.ticket.status = "unknown";
  assert(!qualificationSchema.safeParse(q).success);
  assert.equal(
    investorAssessmentFields({ research: { qualification: q } })
      .investorVerification,
    "Incomplete",
  );
});
