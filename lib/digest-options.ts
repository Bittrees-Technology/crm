import { z } from "zod";
export const digestOptionsSchema = z.object({
  timeZone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid IANA timezone.")
    .default("UTC"),
  assignment: z.enum(["mine", "all"]).default("mine"),
  daysAhead: z.number().int().min(0).max(30).default(7),
  includeOverdue: z.boolean().default(true),
  kinds: z
    .array(z.enum(["tasks", "opportunities"]))
    .min(1)
    .max(2)
    .default(["tasks", "opportunities"]),
  workspaceIds: z.array(z.uuid()).max(100).nullable().default(null),
  weekdaysOnly: z.boolean().default(false),
});
export type DigestOptions = z.infer<typeof digestOptionsSchema>;
export const defaultDigestOptions: DigestOptions = digestOptionsSchema.parse(
  {},
);
