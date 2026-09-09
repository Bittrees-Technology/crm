import { z } from "zod";
import { currencyCodes, validAmount } from "./currencies";
export const kinds = [
  "people",
  "organizations",
  "opportunities",
  "projects",
  "tasks",
  "notes",
] as const;
export type Kind = (typeof kinds)[number];
export const stages = [
  "Introduction",
  "Qualified",
  "Discovery",
  "Proposal",
  "Won",
  "Lost",
] as const;
const text = z.string().trim().max(4000).default("");
const short = z.string().trim().max(200).default("");
const ref = z.union([z.uuid(), z.literal("")]).default("");
const date = z.union([z.iso.date(), z.literal("")]).default("");
export const recordSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.union([z.email(), z.literal("")]).default(""),
    organizationId: ref,
    personId: ref,
    projectId: ref,
    opportunityId: ref,
    ownerId: ref,
    title: short,
    website: z
      .union([z.url({ protocol: /^https?$/ }), z.literal("")])
      .default(""),
    category: short,
    source: short,
    description: text,
    nextAction: short,
    dueDate: date,
    stage: z.enum(stages).default("Introduction"),
    value: z
      .union([z.number(), z.string().max(32)])
      .refine(
        validAmount,
        "Enter an amount from 0 to 1 trillion, with up to 18 decimal places.",
      )
      .default(0),
    currency: z.enum(currencyCodes).default("EUR"),
    status: z.enum(["Open", "Done"]).default("Open"),
    wallet: z
      .union([z.string().regex(/^0x[a-fA-F0-9]{40}$/), z.literal("")])
      .default(""),
    communication: z
      .enum(["Unknown", "Allowed", "Do not contact"])
      .default("Unknown"),
  })
  .strict();
export type RecordData = z.infer<typeof recordSchema>;
export type CrmRecord = {
  id: string;
  kind: Kind;
  data: RecordData;
  version: number;
  created_at: string;
  updated_at: string;
  stage_changed_at?: string;
  visibility_ids?: string[] | null;
};
export type OwnerRecordFields = {
  visibilityIds?: string[] | null;
  privateNote?: { content: string; version: number };
};
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
