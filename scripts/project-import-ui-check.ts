import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
export async function checkProjectImport(
  page: Page,
  api: any,
  me: any,
  origin: string,
  accessibility: any,
) {
  const id = randomUUID(),
    entryId = randomUUID(),
    name = "Project import UI " + id;
  await api(page, "leads/draft", {
    id,
    version: 0,
    name,
    entries: [
      {
        id: entryId,
        kind: "projects",
        name: "Synthetic reviewed project " + id,
        description: "Visible preview",
        source: "https://example.org",
      },
    ],
  });
  await page.goto(origin + "/connect/ai/leads");
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByText("Dataset, agent connection & sharing", { exact: true })
    .click();
  await page
    .getByLabel("Project destination")
    .selectOption(me.workspaces[0].id);
  const fieldset = page.getByRole("group", {
    name: "Preview and approve project imports",
  });
  await fieldset.getByRole("checkbox").check();
  await fieldset
    .getByRole("button", { name: "Preview project import" })
    .click();
  await expect(
    fieldset.getByText("Visible preview", { exact: true }),
  ).toBeVisible();
  await accessibility(page, "Project import preview");
  await fieldset
    .getByRole("button", { name: "Approve and create 1 projects" })
    .click();
  await expect(fieldset.getByRole("status")).toContainText(
    "Approved projects created",
  );
  const snapshot = await api(page, "workspaces/" + me.workspaces[0].id);
  const records = snapshot.records.filter(
    (r: any) => r.data.name === "Synthetic reviewed project " + id,
  );
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].visibility_ids, []);
  await api(page, "leads/draft", { id, version: 1 }, "DELETE");
  await api(
    page,
    "workspaces/" + me.workspaces[0].id + "/records",
    { id: records[0].id, version: records[0].version },
    "DELETE",
  );
}
