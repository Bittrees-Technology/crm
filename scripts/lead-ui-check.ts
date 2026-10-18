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
    .getByLabel("What makes a candidate relevant?")
    .fill("Infrastructure for developer teams");
  await page
    .getByLabel("Permitted source domains, separated by commas")
    .fill("bittrees.org");
  await page.getByRole("button", { name: "Create search connection" }).click();
  const credential = page.getByLabel("Lead connection credential");
  await expect(credential).toBeVisible();
  const token = await credential.inputValue();
  assert.match(token, /^[a-f0-9]{64}$/);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.locator("#agent-setup").getByRole("status")).toContainText(
    "CRM connection verified",
  );
  await page.getByLabel("Show configuration and credential").check();
  const config = JSON.parse(
    await page.getByLabel("MCP configuration", { exact: true }).inputValue(),
  );
  assert.equal(
    config.mcpServers["bittrees-leads"].headers.Authorization,
    "Bearer " + token,
  );
  assert.equal(
    config.mcpServers["bittrees-leads"].url,
    origin + "/api/integrations/leads/mcp",
  );
  await page.getByLabel("AI app", { exact: true }).selectOption("vscode");
  const vscode = JSON.parse(
    await page.getByLabel("MCP configuration", { exact: true }).inputValue(),
  );
  assert.equal(vscode.servers["bittrees-leads"].type, "http");
  await page
    .getByRole("button", { name: "Copy MCP configuration", exact: true })
    .click();
  await expect(page.locator("#agent-setup").getByRole("status")).toContainText(
    /copied|Clipboard unavailable/,
  );
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
    .getByLabel("What makes a candidate relevant?")
    .fill("Investor assignment browser test");
  await owner
    .getByLabel("Permitted source domains, separated by commas")
    .fill("bittrees.org");
  await owner
    .getByLabel("Allow proposed follow-up tasks (review required; no outreach)")
    .check();
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
  const operationId = randomUUID();
  const response = await researcher.request.post(
    origin + "/api/integrations/leads/prepare",
    {
      headers: { Authorization: "Bearer " + token },
      data: {
        operationId,
        candidates: [
          candidate,
          {
            ...candidate,
            kind: "people",
            name: "Browser investor partner",
            title: "Partner",
            organizationIndex: 0,
          },
          {
            ...candidate,
            kind: "tasks",
            name: "Browser follow-up task",
            contactIndex: 1,
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
    .getByRole("button", {
      name: "Select all available candidates",
      exact: true,
    })
    .click();
  for (const name of [
    "Browser investor firm",
    "Browser investor partner",
    "Browser follow-up task",
  ])
    await expect(
      owner.getByRole("checkbox", { name, exact: true }),
    ).toBeChecked();
  await owner
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(
    owner.getByRole("checkbox", {
      name: "Browser investor partner",
      exact: true,
    }),
  ).not.toBeChecked();
  await owner
    .getByRole("button", {
      name: "Select all available candidates",
      exact: true,
    })
    .click();
  await accessibility(owner, "Investor person, organization and task approval");
  await owner.screenshot({
    path: "/tmp/crm-investor-review.png",
    fullPage: true,
  });
  await owner.getByRole("button", { name: "Publish 3 selected leads" }).click();
  await expect(owner.getByRole("status")).toContainText("3 leads accepted");
  await expect(owner.getByRole("status")).toContainText("Set a due date");
  await expect(
    owner.getByRole("link", { name: "Open destination workspace" }),
  ).toHaveAttribute("href", "/?workspace=" + workspace);
  const reconciled = await researcher.request.post(
    origin + "/api/integrations/leads/status",
    { headers: { Authorization: "Bearer " + token }, data: { operationId } },
  );
  assert.equal(reconciled.status(), 200);
  assert.equal((await reconciled.json()).accepted, 3);
  const records = (await api(owner, base)).records;
  const firm = records.find((r: any) => r.data.name === candidate.name);
  const person = records.find(
    (r: any) => r.data.name === "Browser investor partner",
  );
  const task = records.find(
    (r: any) => r.data.name === "Browser follow-up task",
  );
  assert.equal(task.data.personId, person.id);
  assert.equal(task.data.organizationId, firm.id);
  assert.equal(task.data.dueDate, "");
  assert.equal(person.data.organizationId, firm.id);
  assert.equal(person.data.category, "Venture capital");
  assert.deepEqual(person.visibility_ids, []);
  assert.equal(
    (await api(researcher, base)).records.some((r: any) => r.id === person.id),
    false,
  );
  await researcher.goto(origin + "/connect/ai/leads");
  const savedListResponse = researcher.waitForResponse(
    (r) =>
      r.url().endsWith("/api/leads/draft") && r.request().method() === "POST",
  );
  await researcher
    .getByRole("button", { name: "New private list", exact: true })
    .click();
  const createdList = await savedListResponse;
  assert.equal(
    createdList.status(),
    200,
    "Create private list request must succeed",
  );
  await expect(
    researcher.getByRole("heading", { name: "Edit private list", exact: true }),
  ).toBeVisible();
  await researcher
    .getByLabel("List name", { exact: true })
    .fill("Manual investor shortlist");
  await researcher
    .getByRole("button", { name: "Save list name", exact: true })
    .click();
  await expect(researcher.getByRole("status")).toContainText(
    "Private list saved",
  );
  await researcher
    .getByRole("button", { name: "Add organization to list", exact: true })
    .click();
  await researcher
    .getByLabel("Name", { exact: true })
    .fill("Manual browser firm");
  await researcher
    .getByRole("button", { name: "Save entry privately", exact: true })
    .click();
  await expect(
    researcher.getByRole("heading", {
      name: "Manual browser firm",
      exact: true,
    }),
  ).toBeVisible();
  await researcher
    .getByRole("button", { name: "Add person to list", exact: true })
    .click();
  await researcher
    .getByLabel("Name", { exact: true })
    .fill("Manual browser partner");
  await researcher
    .getByLabel("Related organization", { exact: true })
    .selectOption({ label: "Manual browser firm" });
  await accessibility(researcher, "Private research entry on mobile");
  await researcher
    .getByRole("button", { name: "Save entry privately", exact: true })
    .click();
  await expect(
    researcher.getByRole("heading", {
      name: "Manual browser partner",
      exact: true,
    }),
  ).toBeVisible();
  await researcher
    .getByRole("button", { name: "Back to private lists", exact: true })
    .click();
  await researcher
    .getByRole("button", { name: "Refresh private lists", exact: true })
    .click();
  await researcher.reload();
  await researcher
    .getByRole("button", { name: "Manual investor shortlist", exact: true })
    .click();
  await expect(
    researcher.getByRole("heading", {
      name: "Manual browser partner",
      exact: true,
    }),
  ).toBeVisible();
  const privateLists = await api(researcher, "leads/drafts");
  const privateList = privateLists.find(
    (l: any) => l.name === "Manual investor shortlist",
  );
  assert(
    !(await api(owner, "leads/drafts")).some(
      (l: any) => l.id === privateList.id,
    ),
  );
  const panel = researcher.locator("details").filter({
    has: researcher.getByText("Dataset, agent connection & sharing", {
      exact: true,
    }),
  });
  await panel.locator("summary").click();
  await panel
    .getByRole("button", {
      name: "Select all people and organizations",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("checkbox", {
      name: "Manual browser firm (organizations)",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    panel.getByRole("checkbox", {
      name: "Manual browser partner (people)",
      exact: true,
    }),
  ).toBeChecked();
  await panel
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(
    panel.getByRole("checkbox", {
      name: "Manual browser partner (people)",
      exact: true,
    }),
  ).not.toBeChecked();
  await panel
    .getByLabel("Training eligibility for Manual browser firm", { exact: true })
    .selectOption("eligible");
  await expect(panel.getByRole("status")).toContainText(
    "Training decision saved",
  );
  const exported = await researcher.request.get(
    origin + "/api/datasets/export?id=" + privateList.id + "&training=true",
  );
  assert.equal(exported.status(), 200);
  const training = JSON.parse((await exported.text()).trim());
  assert.equal(training.name, "Manual browser firm");
  assert(!("email" in training));
  researcher.once("dialog", (d) => d.accept());
  const connectionResponse = researcher.waitForResponse(
    (r) =>
      r.url().endsWith("/api/datasets/connect") &&
      r.request().method() === "POST",
  );
  await panel
    .getByRole("button", {
      name: "Create / replace dataset connection",
      exact: true,
    })
    .click();
  const connection = await (await connectionResponse).json();
  assert(connection.token);
  await expect(
    panel.getByRole("button", { name: "Copy MCP configuration", exact: true }),
  ).toBeVisible();
  assert(!(await panel.innerText()).includes(connection.token));
  const mcpResponse = await researcher.request.post(
    origin + "/api/integrations/datasets/mcp",
    {
      headers: { Authorization: "Bearer " + connection.token, Origin: origin },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dataset.read", arguments: {} },
      },
    },
  );
  assert.equal(mcpResponse.status(), 200);
  const mcpRead = JSON.parse((await mcpResponse.json()).result.content[0].text);
  assert.equal(mcpRead.entries.length, 2);
  await accessibility(researcher, "Dataset controls on mobile");
  await panel
    .getByRole("button", { name: "Revoke dataset connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("revoked");
  const denied = await researcher.request.post(
    origin + "/api/integrations/datasets/mcp",
    {
      headers: { Authorization: "Bearer " + connection.token, Origin: origin },
      data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    },
  );
  assert.equal(denied.status(), 401);
  await panel.locator("summary").click();
  await researcher
    .getByLabel("Share with workspace", { exact: true })
    .selectOption(workspace);
  await researcher
    .getByLabel("Destination project", { exact: true })
    .selectOption(project.id);
  const targets = await api(researcher, "leads/share-targets");
  await researcher
    .getByLabel("Approving owner", { exact: true })
    .selectOption(targets.find((t: any) => t.id === workspace).owners[0].id);
  researcher.once("dialog", (d) => d.accept());
  await researcher
    .getByRole("button", { name: "Share list for approval", exact: true })
    .click();
  await expect(researcher.getByRole("status")).toContainText("List submitted");
  await accessibility(researcher, "Submitted private list");
  await researcher.screenshot({
    path: "/tmp/crm-private-research.png",
    fullPage: true,
  });
  const searches = await api(owner, "leads/searches");
  const manual = searches.find(
    (s: any) => s.brief.target === "Manual investor shortlist",
  );
  await owner.goto(origin + "/connect/ai/leads?review=" + manual.preview_id);
  await owner
    .getByRole("checkbox", { name: "Manual browser firm", exact: true })
    .check();
  await owner
    .getByRole("checkbox", { name: "Manual browser partner", exact: true })
    .check();
  await owner
    .getByRole("button", { name: "Publish 2 selected leads", exact: true })
    .click();
  await expect(owner.getByRole("status")).toContainText("2 leads accepted");
  const manualRecords = (await api(owner, base)).records.filter((r: any) =>
    r.data.name.startsWith("Manual browser"),
  );
  assert.equal(manualRecords.length, 2);
  assert.equal(
    manualRecords.find((r: any) => r.kind === "people").data.organizationId,
    manualRecords.find((r: any) => r.kind === "organizations").id,
  );
  for (const r of manualRecords.sort((a: any) =>
    a.kind === "people" ? -1 : 1,
  ))
    await api(
      owner,
      base + "/records",
      { id: r.id, version: r.version },
      "DELETE",
    );
  const savedDraft = await api(researcher, "leads/draft?id=" + privateList.id);
  await api(
    researcher,
    "leads/draft",
    { id: privateList.id, version: savedDraft.version },
    "DELETE",
  );
  for (const record of [task, person, firm, project])
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
