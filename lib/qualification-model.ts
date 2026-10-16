import { z } from "zod";
import { publicUrl } from "./lead-model";
export const investorFitLabels = [
  "Promising fit",
  "Needs research",
  "Low fit",
] as const;
export const fitAssessmentSchema = z.strictObject({
  status: z.enum(investorFitLabels),
  reviewedAt: z.iso.datetime(),
  rationale: z.string().trim().min(20).max(700),
  sources: z
    .array(
      z.strictObject({
        url: publicUrl,
        retrievedAt: z.iso.datetime(),
        quote: z.string().trim().min(10).max(1500),
      }),
    )
    .min(1)
    .max(6),
});
export const qualificationGateNames: Record<string, string> = {
  investmentRole: "Current investment responsibility",
  individualUS: "Individual US location",
  bitcoinLeverage: "Bitcoin reserves and leverage mandate",
  crossBorder: "Portugal / Luxembourg investment scope",
  vehicle: "External preferred shares and early vehicle",
  ticket: "Investment ticket capacity",
};
export const qualificationLabels = [
  "Priority research",
  "Needs research",
  "Low mandate fit",
  "Outside US target",
  "Support contact",
  "Duplicate alias",
  "Qualified",
] as const;
export const qualificationGates = [
  "investmentRole",
  "individualUS",
  "bitcoinLeverage",
  "crossBorder",
  "vehicle",
  "ticket",
] as const;
const gate = z.strictObject({
  status: z.enum(["supported", "unknown", "contradicted"]),
  evidence: z.string().trim().max(500),
  url: z.union([publicUrl, z.literal("")]),
});
export const qualificationSchema = z
  .strictObject({
    status: z.enum(qualificationLabels),
    reviewedAt: z.iso.datetime(),
    summary: z.string().trim().min(1).max(500),
    gates: z.strictObject({
      investmentRole: gate,
      individualUS: gate,
      bitcoinLeverage: gate,
      crossBorder: gate,
      vehicle: gate,
      ticket: gate,
    }),
    sources: z
      .array(
        z.strictObject({
          url: publicUrl,
          retrievedAt: z.iso.datetime(),
          quote: z.string().min(10).max(1500),
        }),
      )
      .min(1)
      .max(6),
  })
  .superRefine((q, ctx) => {
    for (const k of qualificationGates) {
      const g = q.gates[k];
      if (
        g.status !== "unknown" &&
        (!g.evidence ||
          !q.sources.some(
            (s) => s.url === g.url && s.quote.includes(g.evidence),
          ))
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Each supported or contradicted gate needs an exact cited source excerpt.",
          path: ["gates", k],
        });
    }
    if (
      q.status === "Qualified" &&
      qualificationGates.some((k) => q.gates[k].status !== "supported")
    )
      ctx.addIssue({
        code: "custom",
        message: "Qualified requires evidence for every mandate gate.",
      });
  });
export function qualificationCategory(entry: any, projectName: string) {
  const s = entry.research?.qualification?.status;
  return s
    ? `${projectName} | ${s}`
    : qualificationLabels.some(
          (v) =>
            v !== "Qualified" && entry.category === `${projectName} | ${v}`,
        )
      ? entry.category
      : entry.research?.fitAssessment
        ? `${projectName} | Needs research`
        : null;
}
// Fit is an analyst assessment, independent of the strict evidence checklist.
// Keep the legacy category intact for existing companion readback contracts.
export function investorAssessmentFields(entry: any): {
  investorFit?: (typeof investorFitLabels)[number];
  investorVerification?: "Fully verified" | "Incomplete";
} {
  const fit = entry.research?.fitAssessment;
  const q = entry.research?.qualification;
  if (!fit && !q) return {};
  return {
    ...(fit ? { investorFit: fit.status } : {}),
    investorVerification:
      q?.status === "Qualified" &&
      qualificationGates.every((k) => q.gates[k].status === "supported")
        ? ("Fully verified" as const)
        : ("Incomplete" as const),
  };
}
