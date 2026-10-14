import { z } from "zod";
const line = z.string().trim().min(1).max(500);
export const publicUrl = z
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
  }, "Use a public HTTPS URL without credentials, ports or fragments.");
export const briefSchema = z.strictObject({
  target: line,
  geography: z.string().trim().max(200).default(""),
  exclusions: z.array(line).max(20).default([]),
  sourceDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/),
    )
    .min(1)
    .max(20),
  maxResults: z.number().int().min(1).max(20).default(20),
  freshnessDays: z.number().int().min(1).max(365).default(30),
});
export const candidateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  website: publicUrl,
  summary: line,
  relevance: line,
  uncertainties: z.string().trim().max(500),
  fit: z.enum(["high", "medium", "low"]),
  evidence: z.enum(["primary", "secondary", "unconfirmed"]),
  sources: z
    .array(z.strictObject({ url: publicUrl, retrievedAt: z.iso.datetime() }))
    .min(1)
    .max(3),
});
export type Candidate = z.infer<typeof candidateSchema>;
export type Brief = z.infer<typeof briefSchema>;
export function domain(url: string) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}
export function validateCandidates(
  brief: Brief,
  candidates: Candidate[],
  now = Date.now(),
) {
  if (candidates.length > brief.maxResults)
    throw Error("Too many candidates for this brief.");
  const domains = new Set<string>();
  for (const c of candidates) {
    const host = domain(c.website);
    if (domains.has(host))
      throw Error("Review one candidate per organization website.");
    domains.add(host);
    if (
      brief.exclusions.some((term) =>
        `${c.name} ${host} ${c.summary}`
          .toLowerCase()
          .includes(term.toLowerCase()),
      )
    )
      throw Error("A candidate matches a brief exclusion.");
    for (const source of c.sources) {
      const h = domain(source.url),
        date = Date.parse(source.retrievedAt);
      if (
        !brief.sourceDomains.some(
          (d) =>
            h === d.replace(/^www\./, "") ||
            h.endsWith("." + d.replace(/^www\./, "")),
        )
      )
        throw Error("A source is outside the permitted domains.");
      if (date > now + 60000 || date < now - brief.freshnessDays * 86400000)
        throw Error(
          "A source retrieval date falls outside the freshness window.",
        );
    }
  }
}
export function leadDescription(c: Candidate) {
  return (
    `AI research — review before use\n${c.summary}\nRelevance: ${c.relevance}\nFit: ${c.fit}; evidence: ${c.evidence}\nUnresolved: ${c.uncertainties || "None reported (not independently verified)"}\n` +
    c.sources.map((s) => `${s.url} (retrieved ${s.retrievedAt})`).join("\n")
  );
}
