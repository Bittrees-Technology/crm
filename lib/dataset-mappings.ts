import type { PoolClient } from "pg";
// Resolve accepted submissions as well as automatic imports, using stable IDs only.
export async function mappedProjectEntries(
  db: PoolClient,
  d: any,
  p: any,
  selectedIds?: string[],
) {
  const links = (
    await db.query(
      "SELECT entry_id,record_id,workspace_id FROM dataset_record_links WHERE draft_id=$1 AND workspace_id=$2",
      [d.id, p.workspace_id],
    )
  ).rows;
  const receipts = (
    await db.query(
      `SELECT s.workspace_id,p.decision,p.record_ids,(SELECT jsonb_agg(e->'id') FROM jsonb_array_elements(snapshot.entries) e) AS entry_ids FROM dataset_submissions x JOIN lead_drafts snapshot ON snapshot.id=x.snapshot_id JOIN lead_previews p ON p.id=x.review_id JOIN lead_searches s ON s.id=p.search_id WHERE x.draft_id=$1 AND s.workspace_id=$2 ORDER BY p.created_at DESC LIMIT 50`,
      [d.id, p.workspace_id],
    )
  ).rows;
  const map = new Map<string, string>();
  for (const r of receipts)
    for (const [i, index] of (r.decision?.accept || []).entries()) {
      const e = r.entry_ids[index],
        id = r.record_ids?.[i];
      if (e && id && !map.has(e)) map.set(e, id);
    }
  for (const l of links) map.set(l.entry_id, l.record_id);
  if (!map.size) return [];
  const records = (
    await db.query(
      `SELECT id,kind,${selectedIds ? "data" : "jsonb_build_object('category',data->>'category','investorFit',data->>'investorFit','investorVerification',data->>'investorVerification') AS data"},version FROM records r WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL AND kind IN ('people','organizations') AND (data->>'projectId'=$3 OR (kind='organizations' AND EXISTS(SELECT 1 FROM records person WHERE person.workspace_id=r.workspace_id AND person.kind='people' AND person.archived_at IS NULL AND person.data->>'projectId'=$3 AND person.data->>'organizationId'=r.id::text)))`,
      [
        p.workspace_id,
        [...map.entries()]
          .filter(([id]) => !selectedIds || selectedIds.includes(id))
          .map(([, recordId]) => recordId),
        p.project_id,
      ],
    )
  ).rows;
  const byId = new Map(records.map((r) => [r.id, r]));
  const result = [];
  const seen = new Set();
  for (const e of d.entries) {
    const r = byId.get(map.get(e.id));
    if (!r || r.kind !== e.kind) continue;
    // Ambiguous many-to-one aliases never silently propagate a label onto the canonical record.
    if (
      [...map.values()].filter((id) => id === r.id).length !== 1 ||
      seen.has(r.id)
    )
      continue;
    seen.add(r.id);
    result.push({ entry: e, record: r });
  }
  return result;
}
