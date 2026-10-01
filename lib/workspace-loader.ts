import type { CrmRecord } from "./model";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
// Commit only a complete, single-revision view. Partial pages must never feed reports.
export async function loadWorkspacePages<T extends { records: CrmRecord[] }>(
  request: (path: string) => Promise<T & { nextCursor?: string | null }>,
  workspace: string,
  progress: (count: number) => void = () => {},
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let first: T | undefined,
        cursor: string | null = null;
      const records: CrmRecord[] = [];
      const seen = new Set<string>();
      do {
        const page = await request(
          `workspaces/${workspace}?paged=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        first ??= page;
        records.push(...page.records);
        progress(records.length);
        cursor = page.nextCursor || null;
        if (cursor && seen.has(cursor))
          throw new Error(
            "Workspace loading could not finish. Please refresh.",
          );
        if (cursor) seen.add(cursor);
      } while (cursor);
      records.sort(
        (a, b) =>
          b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id),
      );
      return { ...first!, records };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409 || attempt === 1)
        throw e;
      progress(0);
    }
  }
  throw new Error("Workspace changed while loading. Please refresh.");
}
