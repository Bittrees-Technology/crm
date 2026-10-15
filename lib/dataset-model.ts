import { z } from "zod";
import { publicUrl } from "./lead-model";
export const researchSchema = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        url: publicUrl,
        retrievedAt: z.iso.datetime(),
        claim: z.string().trim().max(500),
        usage: z.string().trim().max(200).default("Unknown"),
      }),
    )
    .max(3)
    .default([]),
  relevance: z.string().trim().max(500).default(""),
  uncertainties: z.string().trim().max(500).default(""),
  verification: z
    .enum(["unverified", "verified", "disputed"])
    .default("unverified"),
  training: z.enum(["pending", "eligible", "excluded"]).default("pending"),
});
export const datasetVersion = "1.1";
// A training export is deliberately separate from the lossless research backup.
export function trainingRows(draft: {
  id: string;
  version: number;
  entries: any[];
}) {
  const eligible = draft.entries.filter(
    (e) => e.research?.training === "eligible",
  );
  const ids = new Set(eligible.map((e) => e.id));
  return eligible.map(({ email: _email, ...entry }) => ({
    schemaVersion: datasetVersion,
    datasetId: draft.id,
    datasetVersion: draft.version,
    ...entry,
    organizationId: ids.has(entry.organizationId) ? entry.organizationId : "",
  }));
}
