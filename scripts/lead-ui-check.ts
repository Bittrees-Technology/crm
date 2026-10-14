import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
export async function checkLeads(
  page: Page,
  api: any,
  me: any,
  origin: string,
  accessibility: any,
) {
  const workspace = me.workspaces[0].id;
  await page.goto(origin + "/connect/ai/leads");
  await expect(
    page.getByRole("heading", { name: "Find organizations", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Workspace", { exact: true }).selectOption(workspace);
  await page
    .getByLabel("What makes an organization relevant?")
    .fill("Infrastructure for developer teams");
  await page
    .getByLabel("Permitted source domains, separated by commas")
    .fill("bittrees.org");
  await page.getByRole("button", { name: "Create search connection" }).click();
  const credential = page.getByLabel("Lead connection credential");
  await expect(credential).toBeVisible();
  const token = await credential.inputValue();
  assert.match(token, /^[a-f0-9]{64}$/);
  await accessibility(page, "Lead search brief");
  const response = await page.request.post(
    origin + "/api/integrations/leads/prepare",
    {
      headers: { Authorization: "Bearer " + token },
      data: {
        operationId: randomUUID(),
        candidates: [
          {
            name: "Synthetic research organization",
            website: "https://research-organization.org",
            summary: "Public test research",
            relevance: "Developer tooling",
            uncertainties: "Team size unverified",
            fit: "medium",
            evidence: "primary",
            sources: [
              {
                url: "https://bittrees.org/",
                retrievedAt: new Date().toISOString(),
              },
            ],
          },
        ],
      },
    },
  );
  assert.equal(response.status(), 200);
  const preview = await response.json();
  await page.goto(origin + preview.reviewPath);
  await expect(
    page.getByRole("heading", { name: "Review organizations" }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Synthetic research organization",
      exact: true,
    })
    .check();
  await accessibility(page, "Lead exact review");
  await page.screenshot({ path: "/tmp/crm-lead-review.png", fullPage: true });
  await page
    .getByRole("button", { name: "Import 1 selected organizations" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "1 organizations imported",
  );
  const records = (await api(page, "workspaces/" + workspace)).records;
  const record = records.find(
    (r: any) => r.data.name === "Synthetic research organization",
  );
  assert(record);
  assert.deepEqual(record.visibility_ids, []);
  await api(
    page,
    "workspaces/" + workspace + "/records",
    { id: record.id, version: record.version },
    "DELETE",
  );
  const searches = await api(page, "leads/searches");
  await api(page, "leads/searches", { id: searches[0].id }, "DELETE");
  const revoked = await page.request.post(
    origin + "/api/integrations/leads/brief",
    { headers: { Authorization: "Bearer " + token }, data: {} },
  );
  assert.equal(revoked.status(), 404);
}
