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
    page.getByRole("heading", { name: "Lead research", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Workspace", { exact: true }).selectOption(workspace);
  await page
    .getByLabel("What makes an investor relevant?")
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
    page.getByRole("heading", { name: "Review investor leads" }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Synthetic research organization",
      exact: true,
    })
    .check();
  await accessibility(page, "Lead exact review");
  await page.screenshot({ path: "/tmp/crm-lead-review.png", fullPage: true });
  await page.getByRole("button", { name: "Publish 1 selected leads" }).click();
  await expect(page.getByRole("status")).toContainText("1 leads accepted");
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

export async function checkInvestorAssignment(
  owner: Page,
  researcher: Page,
  api: any,
  workspace: string,
  researcherId: string,
  origin: string,
  accessibility: any,
) {
  const base = `workspaces/${workspace}`;
  const project = await api(owner, base + "/records", {
    kind: "projects",
    data: { name: "Investor research project" },
  });
  await api(
    owner,
    base + "/members",
    { userId: researcherId, role: "viewer", scopeIds: [project.id] },
    "PATCH",
  );
  await owner.goto(origin + "/connect/ai/leads");
  await owner.getByLabel("Workspace", { exact: true }).selectOption(workspace);
  await owner
    .getByLabel("Research project", { exact: true })
    .selectOption(project.id);
  await owner
    .getByLabel("Assigned researcher", { exact: true })
    .selectOption(researcherId);
  await owner
    .getByLabel("What makes an investor relevant?")
    .fill("Investor assignment browser test");
  await owner
    .getByLabel("Permitted source domains, separated by commas")
    .fill("bittrees.org");
  await owner.getByRole("button", { name: "Create search connection" }).click();
  await expect(owner.getByRole("status")).toContainText("Research assigned");
  await expect(owner.getByLabel("Lead connection credential")).toHaveCount(0);
  await researcher.goto(origin + "/connect/ai/leads");
  await researcher
    .getByRole("button", { name: "Connect / replace agent credential" })
    .click();
  const credential = researcher.getByLabel("Lead connection credential");
  await expect(credential).toBeVisible();
  const token = await credential.inputValue();
  const candidate = {
    name: "Browser investor firm",
    website: "https://browser-investor.org",
    summary: "Sourced thesis",
    relevance: "Seed investor",
    uncertainties: "Ticket size unknown",
    fit: "medium",
    evidence: "primary",
    category: "Venture capital",
    sources: [
      { url: "https://bittrees.org", retrievedAt: new Date().toISOString() },
    ],
  };
  const response = await researcher.request.post(
    origin + "/api/integrations/leads/prepare",
    {
      headers: { Authorization: "Bearer " + token },
      data: {
        operationId: randomUUID(),
        candidates: [
          candidate,
          {
            ...candidate,
            kind: "people",
            name: "Browser investor partner",
            title: "Partner",
            organizationIndex: 0,
          },
        ],
      },
    },
  );
  assert.equal(response.status(), 200);
  const preview = await response.json();
  await researcher.goto(origin + preview.reviewPath);
  await expect(
    researcher.getByRole("heading", { name: "Submitted investor leads" }),
  ).toBeVisible();
  await expect(
    researcher.getByRole("button", { name: "Reject all candidates" }),
  ).toBeDisabled();
  await accessibility(researcher, "Scoped researcher draft on mobile");
  assert.equal(
    await researcher.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await owner.goto(origin + preview.reviewPath);
  await owner
    .getByRole("checkbox", { name: "Browser investor firm", exact: true })
    .check();
  await owner
    .getByRole("checkbox", { name: "Browser investor partner", exact: true })
    .check();
  await accessibility(owner, "Investor person and organization approval");
  await owner.screenshot({
    path: "/tmp/crm-investor-review.png",
    fullPage: true,
  });
  await owner.getByRole("button", { name: "Publish 2 selected leads" }).click();
  await expect(owner.getByRole("status")).toContainText("2 leads accepted");
  const records = (await api(owner, base)).records;
  const firm = records.find((r: any) => r.data.name === candidate.name);
  const person = records.find(
    (r: any) => r.data.name === "Browser investor partner",
  );
  assert.equal(person.data.organizationId, firm.id);
  assert.equal(person.data.category, "Venture capital");
  assert.deepEqual(person.visibility_ids, []);
  assert.equal(
    (await api(researcher, base)).records.some((r: any) => r.id === person.id),
    false,
  );
  for (const record of [person, firm, project])
    await api(
      owner,
      base + "/records",
      { id: record.id, version: record.version },
      "DELETE",
    );
  await api(
    owner,
    base + "/members",
    { userId: researcherId, role: "editor", scopeIds: null },
    "PATCH",
  );
}
