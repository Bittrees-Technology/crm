import type { RecordData } from "./model";
export const referenceFields = [
  "organizationId",
  "personId",
  "projectId",
  "opportunityId",
] as const;
export type AccessRecord = {
  id: string;
  kind: string;
  data: RecordData;
  visibility_ids?: string[] | null;
};
export type AccessMember = {
  user_id: string;
  role: string;
  scope_ids: string[] | null;
};
// The same graph powers enforcement and the owner's access inspector.
// Explicit record sharing is a direct grant, not a new inheritable workspace scope.
export function resolveAccess(
  records: AccessRecord[],
  member: AccessMember,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const add = (id: string, reason: string) =>
    result.set(id, [...new Set([...(result.get(id) || []), reason])]);
  const allowed = (r: AccessRecord) =>
    r.visibility_ids == null || r.visibility_ids.includes(member.user_id);
  if (member.role === "owner") {
    for (const r of records) add(r.id, "Workspace owner");
    return result;
  }
  if (member.scope_ids === null) {
    for (const r of records)
      if (allowed(r))
        add(
          r.id,
          r.visibility_ids == null
            ? "Whole-workspace access"
            : "Selected for this record",
        );
    return result;
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  const children = new Map<string, AccessRecord[]>();
  for (const r of records)
    for (const field of referenceFields) {
      if (r.data[field])
        children.set(r.data[field], [
          ...(children.get(r.data[field]) || []),
          r,
        ]);
    }
  for (const rootId of member.scope_ids) {
    const root = byId.get(rootId);
    if (!root || !allowed(root)) continue;
    const queue = [root],
      visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const r = queue[index];
      if (visited.has(r.id) || !allowed(r)) continue;
      visited.add(r.id);
      add(
        r.id,
        r.id === rootId
          ? `Shared ${root.kind}: ${root.data.name}`
          : `Linked beneath ${root.data.name}`,
      );
      queue.push(...(children.get(r.id) || []));
    }
  }
  for (const r of records)
    if (r.visibility_ids?.includes(member.user_id))
      add(r.id, "Selected for this record");
  return result;
}
