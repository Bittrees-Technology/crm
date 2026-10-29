import { z } from "zod";

export const contactTypes = {
  email: "Email",
  phone: "Phone",
  website: "Website",
  linkedin: "LinkedIn",
  x: "X / Twitter",
  social: "Other social",
  address: "Postal address",
} as const;
export type ContactType = keyof typeof contactTypes;
export const contactMethodSchema = z
  .object({
    type: z.enum([
      "email",
      "phone",
      "website",
      "linkedin",
      "x",
      "social",
      "address",
    ]),
    label: z.string().trim().max(80),
    value: z.string().trim().min(1, "Enter a contact value.").max(1000),
  })
  .strict()
  .superRefine((contact, ctx) => {
    let valid = true;
    if (contact.type === "email")
      valid = z.email().safeParse(contact.value).success;
    else if (contact.type === "phone")
      valid =
        /^[+0-9(). #xext-]{3,80}$/i.test(contact.value) &&
        /[0-9]{3}/.test(contact.value.replace(/\D/g, ""));
    else if (contact.type !== "address") {
      try {
        const url = new URL(contact.value);
        valid =
          ["http:", "https:"].includes(url.protocol) &&
          !!url.hostname &&
          !url.username &&
          !url.password;
        if (contact.type === "linkedin")
          valid &&= /(^|\.)linkedin\.com$/i.test(url.hostname);
        if (contact.type === "x")
          valid &&= /(^|\.)(x|twitter)\.com$/i.test(url.hostname);
      } catch {
        valid = false;
      }
    }
    if (!valid)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          contact.type === "email"
            ? "Enter a valid email address."
            : contact.type === "phone"
              ? "Enter a valid phone number."
              : `Enter a full HTTP(S) ${contactTypes[contact.type]} URL.`,
      });
  });
export type ContactMethod = z.infer<typeof contactMethodSchema>;
export function contactHref(contact: ContactMethod): string | undefined {
  if (!contactMethodSchema.safeParse(contact).success) return undefined;
  if (contact.type === "address") return undefined;
  if (contact.type === "email") return `mailto:${contact.value}`;
  if (contact.type === "phone") {
    const extension = contact.value.match(/(?:ext\.?|x|#)\s*(\d+)$/i);
    const number = (
      extension ? contact.value.slice(0, extension.index) : contact.value
    ).replace(/[^+0-9]/g, "");
    return `tel:${number}${extension ? `;ext=${extension[1]}` : ""}`;
  }
  return contact.value;
}
