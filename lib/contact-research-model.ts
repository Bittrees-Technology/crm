import { z } from "zod";
const sourceUrl = z
  .url({ protocol: /^https$/ })
  .max(800)
  .refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(u.hostname) &&
      !/(^|\.)(localhost|local|internal|test|invalid|example)$/i.test(
        u.hostname,
      )
    );
  }, "Use a public HTTPS source URL.");
const generic =
  /^(info|hello|contact|enquiries|inquiries|team|office|press|media|investors?|careers|jobs|support|privacy|dpo|compliance|admin|general|reception|pitch|deals|funding)@/i;
export const publicContactSchema = z
  .strictObject({
    kind: z.enum(["email", "LinkedIn", "X", "Telegram"]),
    value: z.string().min(3).max(800),
    sourceURL: sourceUrl,
    retrievedAt: z.iso.datetime({ offset: true }),
    evidence: z.string().trim().min(10).max(700),
    status: z.literal("Public source; delivery unverified"),
  })
  .superRefine((c, ctx) => {
    let valid = false;
    if (c.kind === "email")
      valid = z.email().safeParse(c.value).success && !generic.test(c.value);
    else {
      try {
        const u = new URL(c.value),
          host = u.hostname.toLowerCase().replace(/^www\./, "");
        valid =
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.port &&
          !u.search &&
          !u.hash;
        if (c.kind === "LinkedIn")
          valid &&=
            host === "linkedin.com" && /^\/in\/[^/]+\/?$/.test(u.pathname);
        if (c.kind === "X")
          valid &&=
            ["x.com", "twitter.com"].includes(host) &&
            /^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname) &&
            !/^\/(home|intent|share|search|explore|login|signup|privacy|tos|i)\/?$/i.test(
              u.pathname,
            );
        if (c.kind === "Telegram")
          valid &&=
            host === "t.me" &&
            /^\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/.test(u.pathname) &&
            !/^\/(share|joinchat|telegram)\/?$/i.test(u.pathname);
      } catch {
        valid = false;
      }
    }
    if (!valid)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "Use a named professional email or a direct personal social profile.",
      });
  });
export type PublicContact = z.infer<typeof publicContactSchema>;
export const contactKey = (c: Pick<PublicContact, "kind" | "value">) =>
  c.kind +
  ":" +
  c.value
    .normalize("NFKC")
    .toLowerCase()
    .replace("https://twitter.com/", "https://x.com/")
    .replace(/\/$/, "");
export const contactUploadSchema = z.strictObject({
  schema: z.literal("bittrees-people-contact-review.v1"),
  rows: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().trim().min(1).max(200),
        expected: z.strictObject({
          email: z.string().max(4000),
          website: z.string().max(4000),
          description: z.string().max(4000),
          organizationId: z.union([z.uuid(), z.literal("")]),
        }),
        contacts: z.array(publicContactSchema).min(1).max(12),
      }),
    )
    .min(1)
    .max(500),
});
