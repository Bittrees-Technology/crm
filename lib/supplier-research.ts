import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { PoolClient } from "pg";
import { HttpError } from "./model";

export const supplierUrls = z
  .array(z.string().max(300).url())
  .min(1)
  .max(16)
  .superRefine((urls, ctx) => {
    const hosts = new Set<string>();
    for (const raw of urls) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid HTTPS supplier URL.",
        });
        continue;
      }
      const host = u.hostname.replace(/^www\./, "");
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.port ||
        isIP(host.replace(/[\[\]]/g, "")) ||
        !host.includes(".") ||
        host.endsWith(".local") ||
        host.endsWith(".localhost")
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Use public HTTPS supplier URLs without credentials, queries, fragments, ports or IP addresses.",
        });
      hosts.add(host);
    }
    if (hosts.size !== 1 || new Set(urls).size !== urls.length)
      ctx.addIssue({
        code: "custom",
        message: "Use unique URLs on one supplier hostname (www is optional).",
      });
  });
export const supplierSelection = z
  .strictObject({
    projectId: z.uuid(),
    organizationId: z.uuid(),
    organizationVersion: z.number().int().positive(),
    parents: z
      .array(
        z.strictObject({ id: z.uuid(), version: z.number().int().positive() }),
      )
      .min(1)
      .max(32),
    urls: supplierUrls,
  })
  .refine(
    (x) => new Set(x.parents.map((p) => p.id)).size === x.parents.length,
    "Select each task once.",
  );
function canonical(value: any): any {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
}
export function supplierSignature(value: unknown) {
  return createHmac("sha256", process.env.AUTH_SECRET!)
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function trustedSupplierData(data: any) {
  const p = data?.supplierPreparation;
  if (!p || !data.supplierResearch || !/^[a-f0-9]{64}$/.test(p.signature || ""))
    return false;
  const { signature, ...payload } = p;
  const expected = supplierSignature(payload);
  return (
    typeof signature === "string" &&
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) &&
    supplierSignature(data.supplierResearch) ===
      supplierSignature({ version: 1, urls: p.urls }) &&
    data.projectId === p.projectId &&
    data.organizationId === p.organizationId &&
    data.ownerId === p.ownerId &&
    data.category === "AI review"
  );
}
export async function validateSupplierTask(db: PoolClient, task: any) {
  if (!task.data?.supplierPreparation && !task.data?.supplierResearch) return;
  if (!trustedSupplierData(task.data))
    throw new HttpError(
      409,
      "Supplier research approval is invalid. Prepare a new review.",
    );
  const p = task.data.supplierPreparation;
  const rows = (
    await db.query(
      "SELECT id,version,kind,data,archived_at FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
      [
        task.workspace_id || p.workspaceId,
        [
          p.organizationId,
          ...p.parents.map((x: any) => x.id),
          ...(p.contacts || []).map((x: any) => x.id),
        ],
      ],
    )
  ).rows;
  const org = rows.find((r: any) => r.id === p.organizationId);
  if (
    !org ||
    org.archived_at ||
    org.kind !== "organizations" ||
    org.version !== p.organizationVersion
  )
    throw new HttpError(
      409,
      "Supplier organization changed. Review the sources again.",
    );
  for (const contact of p.contacts || []) {
    const r = rows.find((r: any) => r.id === contact.id);
    if (
      !r ||
      r.archived_at ||
      r.kind !== "people" ||
      r.version !== contact.version ||
      r.data.organizationId !== contact.organizationId
    )
      throw new HttpError(
        409,
        "Supplier contact link changed. Review the sources again.",
      );
  }
  for (const parent of p.parents) {
    const r = rows.find((r: any) => r.id === parent.id);
    if (
      !r ||
      r.archived_at ||
      r.kind !== "tasks" ||
      r.version !== parent.version ||
      r.data.ownerId !== p.ownerId ||
      (r.data.organizationId ||
        (p.contacts || []).find((c: any) => c.id === r.data.personId)
          ?.organizationId) !== p.organizationId
    )
      throw new HttpError(
        409,
        "Supplier confirmation task changed. Prepare a new review.",
      );
  }
}

export function withoutSupplierMetadata(data: any) {
  const { supplierResearch, supplierPreparation, sourceTaskIds, ...rest } =
    data || {};
  return rest;
}
