import type { Candidate } from "./lead-model";

/** UI selection only; the server still rechecks matches, links and authority. */
export function publishableCandidates(
  candidates: Candidate[],
  matches: unknown[][],
  reuse: Record<string, string>,
) {
  const selected = new Set(
    candidates.flatMap((_, i) =>
      !matches[i]?.length || reuse[String(i)] ? [i] : [],
    ),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of selected) {
      const c = candidates[i];
      if (
        [c.organizationIndex, c.contactIndex].some(
          (parent) => parent !== undefined && !selected.has(parent),
        )
      ) {
        selected.delete(i);
        changed = true;
      }
    }
  }
  return [...selected];
}
