import { z } from "zod";
import type { CrmRecord } from "./model";

export const standingLabels = {
  A: "Leading / high visibility",
  B: "Established / institutional",
  C: "Active / developing evidence",
  P: "Separate platform route",
  U: "Insufficient evidence",
} as const;
const source = z.strictObject({
  url: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .refine((v) => {
      const u = new URL(v);
      return !u.username && !u.password;
    }, "Source URLs cannot contain credentials."),
  retrievedAt: z.iso.datetime({ offset: true }).nullable(),
  basis: z.string().trim().max(1000),
  claim: z.string().trim().max(1000).optional(),
});
export const organizationStandingSchema = z.strictObject({
  tier: z.enum(["A", "B", "C", "P", "U"]),
  confidence: z.enum(["Low", "Medium"]),
  status: z.literal("Provisional analyst judgment"),
  rationale: z.string().trim().min(1).max(2000),
  themeFit: z.string().trim().max(200),
  fitBasis: z.string().trim().max(1000),
  fitStatus: z.literal("Directory-based hypothesis; unverified"),
  reviewQueue: z.string().trim().max(200),
  flags: z.array(z.string().trim().max(1000)).max(20),
  reviewedAt: z.iso.datetime({ offset: true }),
  sources: z.array(source).max(10),
});
export type OrganizationStanding = z.infer<typeof organizationStandingSchema>;
export const standingUploadSchema = z.strictObject({
  schema: z.literal("bittrees-organization-standing.v1"),
  rows: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        website: z.union([
          z.url({ protocol: /^https?$/ }).max(2000),
          z.literal(""),
        ]),
        assessment: organizationStandingSchema,
      }),
    )
    .min(1),
});
export function standingFor(record: CrmRecord, records: CrmRecord[]) {
  const organization =
    record.kind === "organizations"
      ? record
      : record.kind === "people"
        ? records.find(
            (r) =>
              r.id === record.data.organizationId &&
              r.kind === "organizations" &&
              !r.archived_at,
          )
        : undefined;
  return organization?.data.organizationStanding
    ? { organization, assessment: organization.data.organizationStanding }
    : undefined;
}
export function standingOrder(tier?: string) {
  return (
    ({ A: 1, B: 2, C: 3, P: 4, U: 5 } as Record<string, number>)[tier || ""] ||
    6
  );
}
