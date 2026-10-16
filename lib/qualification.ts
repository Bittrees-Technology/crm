import { mappedProjectEntries } from "./dataset-mappings";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PoolClient } from "pg";
import { HttpError } from "./model";
import { permission } from "./project-automation";
import { saveRecordInTransaction } from "./service";
import { saveDraftInTransaction } from "./lead-drafts";
import {
  qualificationSchema,
  qualificationCategory,
  fitAssessmentSchema,
  investorAssessmentFields,
} from "./qualification-model";
const uuid = z.uuid();
const contextInput = z.strictObject({ projectId: uuid });
const ref = z.strictObject({
  entryId: uuid,
  recordVersion: z.number().int().positive(),
});
const syncInput = z.strictObject({
  projectId: uuid,
  datasetVersion: z.number().int().positive(),
  entries: z.array(ref).min(1).max(20),
});
const enrichInput = z
  .strictObject({
    projectId: uuid,
    datasetVersion: z.number().int().positive(),
    entryId: uuid,
    recordVersion: z.number().int().positive(),
    qualification: qualificationSchema.optional(),
    fitAssessment: fitAssessmentSchema.optional(),
  })
  .refine(
    (a) => !!a.qualification || !!a.fitAssessment,
    "Provide qualification evidence or a fit assessment.",
  );
export const qualificationTools = [
  {
    name: "qualification.context",
    description:
      "Read mapped people and organizations only in a project with explicit qualification permission. Includes research and CRM versions, never private notes.",
    inputSchema: z.toJSONSchema(contextInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "qualification.sync",
    description:
      "Sync existing qualification, fit and verification labels only, preserving every other CRM field and sharing setting. Requires explicit project qualification permission and current versions; max20 entries.",
    inputSchema: z.toJSONSchema(syncInput),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "qualification.enrich",
    description:
      "Save sourced qualification evidence for one mapped person and synchronize its qualification category and separate fit/verification labels. An optional sourced fitAssessment expresses promising fit independently of full verification. Preserves identity, descriptions, organization links, sources and permissions. Training remains pending or excluded.",
    inputSchema: z.toJSONSchema(enrichInput),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
];
export async function qualificationAgent(
  db: PoolClient,
  d: any,
  name: string,
  raw: unknown,
) {
  const projectId = uuid.parse((raw as any)?.projectId);
  const p = await permission(db, d, projectId, "qualification");
  const rows = await mappedProjectEntries(
    db,
    d,
    p,
    name === "qualification.context"
      ? undefined
      : name === "qualification.sync"
        ? syncInput.parse(raw).entries.map((r) => r.entryId)
        : name === "qualification.enrich"
          ? [enrichInput.parse(raw).entryId]
          : [],
  );
  if (name === "qualification.context") {
    contextInput.parse(raw);
    return {
      datasetId: d.id,
      datasetVersion: d.version,
      projectId,
      projectName: p.project_data.name,
      entries: rows.map(({ entry, record }) => ({
        entry,
        record: {
          id: record.id,
          version: record.version,
          category: record.data.category || "",
          investorFit: record.data.investorFit,
          investorVerification: record.data.investorVerification,
        },
      })),
    };
  }
  const a =
    name === "qualification.sync"
      ? syncInput.parse(raw)
      : name === "qualification.enrich"
        ? enrichInput.parse(raw)
        : null;
  if (!a) throw new HttpError(400, "Unknown qualification tool.");
  const refs =
    "entries" in a
      ? a.entries
      : [{ entryId: a.entryId, recordVersion: a.recordVersion }];
  if (new Set(refs.map((r) => r.entryId)).size !== refs.length)
    throw new HttpError(400, "Distinct entries required.");
  const selected = refs.map((ref) => {
    const row = rows.find((x) => x.entry.id === ref.entryId);
    if (!row)
      throw new HttpError(
        403,
        "Entry is not mapped to an active record in this connected project.",
      );
    return { ...row, expected: ref.recordVersion };
  });
  const enrichment = "entries" in a ? null : a;
  const researchPatch = enrichment
    ? {
        ...(enrichment.qualification
          ? { qualification: enrichment.qualification }
          : {}),
        ...(enrichment.fitAssessment
          ? { fitAssessment: enrichment.fitAssessment }
          : {}),
      }
    : {};
  if (enrichment && selected[0].entry.kind !== "people")
    throw new HttpError(
      400,
      "Enrichment is for a person, not an organization.",
    );
  const exactRetry =
    !!enrichment &&
    Object.entries(researchPatch).every(([key, value]) =>
      isDeepStrictEqual(selected[0].entry.research?.[key], value),
    );
  if (a.datasetVersion !== d.version && !exactRetry)
    throw new HttpError(409, "Dataset changed; refresh qualification context.");
  const desired = selected.map((row) => {
    const entry = enrichment
      ? {
          ...row.entry,
          research: { ...row.entry.research, ...researchPatch },
        }
      : row.entry;
    const category = qualificationCategory(entry, p.project_data.name);
    if (!category)
      throw new HttpError(400, "No recognized project qualification label.");
    const assessmentFields =
      row.entry.kind === "people" ? investorAssessmentFields(entry) : {};
    const unchanged =
      row.record.data.category === category &&
      Object.entries(assessmentFields).every(
        ([key, value]) => row.record.data[key] === value,
      );
    if (row.record.version !== row.expected && !unchanged)
      throw new HttpError(
        409,
        "CRM record changed; review current label before retrying.",
      );
    return { ...row, category, assessmentFields, unchanged };
  });
  let datasetVersion = d.version;
  if (enrichment && !exactRetry) {
    const entries = d.entries.map((e: any) =>
      e.id === selected[0].entry.id
        ? {
            ...e,
            category: desired[0].category,
            research: {
              ...e.research,
              ...researchPatch,
              training:
                e.research?.training === "excluded" ? "excluded" : "pending",
            },
          }
        : e,
    );
    const saved = await saveDraftInTransaction(db, d.user_id, {
      id: d.id,
      version: d.version,
      name: d.name,
      entries,
    });
    datasetVersion = saved.version;
  }
  const receipts = [];
  for (const row of desired) {
    if (row.unchanged) {
      receipts.push({
        entryId: row.entry.id,
        recordId: row.record.id,
        version: row.record.version,
        unchanged: true,
      });
      continue;
    }
    const saved = await saveRecordInTransaction(db, d.user_id, p.workspace_id, {
      id: row.record.id,
      kind: row.record.kind,
      version: row.record.version,
      data: {
        ...row.record.data,
        category: row.category,
        ...row.assessmentFields,
      },
    });
    receipts.push({
      entryId: row.entry.id,
      recordId: saved.id,
      version: saved.version,
      category: row.category,
    });
  }
  return { datasetId: d.id, datasetVersion, projectId, receipts };
}
