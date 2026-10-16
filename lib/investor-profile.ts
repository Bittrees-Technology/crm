import { z } from "zod";
import { transaction } from "./db";
import { membership } from "./service";
import { HttpError } from "./model";
import {
  qualificationGates,
  qualificationGateNames,
} from "./qualification-model";

// Private dataset evidence is visible only to the owner who authored it.
// Resolve stable import receipts; never infer a mapping from names.
export async function investorProfile(
  userId: string,
  workspace: string,
  recordId: string,
) {
  z.uuid().parse(recordId);
  return transaction(async (db) => {
    await membership(workspace, userId, false, true, db);
    const record = (
      await db.query(
        "SELECT id FROM records WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL AND kind='people'",
        [recordId, workspace],
      )
    ).rows[0];
    if (!record) throw new HttpError(404, "Person not found.");
    const rows = (
      await db.query(
        `WITH mappings AS (
      SELECT l.draft_id,l.entry_id FROM dataset_record_links l JOIN lead_drafts d ON d.id=l.draft_id AND d.user_id=$1
      WHERE l.workspace_id=$2 AND l.record_id=$3
      UNION
      SELECT x.draft_id,(snapshot.entries->(a.value::int)->>'id')::uuid AS entry_id
      FROM dataset_submissions x JOIN lead_drafts d ON d.id=x.draft_id AND d.user_id=$1
      JOIN lead_drafts snapshot ON snapshot.id=x.snapshot_id
      JOIN lead_previews p ON p.id=x.review_id JOIN lead_searches s ON s.id=p.search_id
      CROSS JOIN LATERAL jsonb_array_elements_text(p.decision->'accept') WITH ORDINALITY a(value,ord)
      WHERE s.workspace_id=$2 AND p.record_ids[a.ord::int]=$3
    ) SELECT d.id AS dataset_id,d.name AS dataset_name,e->'research'->'fitAssessment' AS fit,
      e->'research'->'qualification' AS qualification
      FROM mappings m JOIN lead_drafts d ON d.id=m.draft_id AND d.user_id=$1
      CROSS JOIN LATERAL jsonb_array_elements(d.entries) e
      WHERE e->>'id'=m.entry_id::text AND e->>'kind'='people'
      AND (SELECT count(*) FROM mappings same WHERE same.draft_id=m.draft_id)=1
      ORDER BY d.updated_at DESC LIMIT 10`,
        [userId, workspace, recordId],
      )
    ).rows;
    return {
      assessments: rows
        .filter((r) => r.fit || r.qualification)
        .map((r) => ({
          ...r,
          verification:
            r.qualification?.status === "Qualified" &&
            qualificationGates.every(
              (k) => r.qualification.gates[k].status === "supported",
            )
              ? "Fully verified"
              : "Incomplete",
          missingEvidence: qualificationGates
            .filter((k) => r.qualification?.gates?.[k]?.status !== "supported")
            .map((k) => ({
              key: k,
              label: qualificationGateNames[k],
              status: r.qualification?.gates?.[k]?.status || "unknown",
            })),
        })),
    };
  });
}
