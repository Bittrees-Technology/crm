import type { RecordData } from "./model";

export const contactFields = {
  any: "contact info",
  email: "email",
  phone: "a phone number",
  website: "a website / public profile",
  social: "social profiles",
  linkedin: "LinkedIn",
  x: "X / Twitter",
  telegram: "Telegram",
  otherSocial: "other social profiles",
  address: "a postal address",
} as const;
type ContactField = keyof typeof contactFields;
export const contactAvailabilityValues = [
  "all",
  "has:any",
  "missing:any",
  "has:email",
  "missing:email",
  "has:phone",
  "missing:phone",
  "has:website",
  "missing:website",
  "has:social",
  "missing:social",
  "has:linkedin",
  "missing:linkedin",
  "has:x",
  "missing:x",
  "has:telegram",
  "missing:telegram",
  "has:otherSocial",
  "missing:otherSocial",
  "has:address",
  "missing:address",
] as const;
export type ContactAvailability = (typeof contactAvailabilityValues)[number];
export function normalizeContactAvailability(
  value: unknown,
): ContactAvailability {
  return contactAvailabilityValues.includes(value as ContactAvailability)
    ? (value as ContactAvailability)
    : "all";
}
function socialPlatform(value: string): ContactField | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const domain = (name: string) => host === name || host.endsWith("." + name);
    if (domain("linkedin.com")) return "linkedin";
    if (domain("x.com") || domain("twitter.com")) return "x";
    if (domain("t.me") || domain("telegram.me")) return "telegram";
    if (
      [
        "facebook.com",
        "instagram.com",
        "threads.net",
        "threads.com",
        "bsky.app",
        "youtube.com",
        "youtu.be",
        "tiktok.com",
        "github.com",
      ].some(domain)
    )
      return "otherSocial";
  } catch {
    /* A non-URL is not a social profile. */
  }
}
/** Presence of stored contact information, not delivery, identity, or investor verification. */
export function availableContacts(data: RecordData): Set<ContactField> {
  const present = new Set<ContactField>();
  const add = (field: ContactField) => {
    present.add(field);
    present.add("any");
  };
  const social = (value: string, fallback?: ContactField) => {
    const platform = socialPlatform(value) || fallback;
    if (platform) {
      add(platform);
      add("social");
    }
  };
  if (data.email?.trim()) add("email");
  if (data.website?.trim()) {
    add("website");
    social(data.website);
  }
  for (const contact of data.contactMethods || []) {
    if (!contact.value.trim()) continue;
    switch (contact.type) {
      case "email":
        add("email");
        break;
      case "phone":
        add("phone");
        break;
      case "address":
        add("address");
        break;
      case "website":
        add("website");
        social(contact.value);
        break;
      case "linkedin":
        social(contact.value, "linkedin");
        break;
      case "x":
        social(contact.value, "x");
        break;
      case "social":
        social(contact.value, "otherSocial");
        break;
    }
  }
  for (const contact of data.publicContacts || []) {
    if (!contact.value.trim()) continue;
    if (contact.kind === "email") add("email");
    else
      social(
        contact.value,
        contact.kind === "LinkedIn"
          ? "linkedin"
          : contact.kind === "X"
            ? "x"
            : "telegram",
      );
  }
  return present;
}
export function matchesContactAvailability(
  data: RecordData,
  value: ContactAvailability,
): boolean {
  const filter = normalizeContactAvailability(value);
  if (filter === "all") return true;
  const [mode, field] = filter.split(":");
  const has = availableContacts(data).has(field as ContactField);
  return mode === "has" ? has : !has;
}
