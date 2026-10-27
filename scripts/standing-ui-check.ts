import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
export async function checkStandingImport(
  page: Page,
  api: any,
  me: any,
  origin: string,
  accessibility: any,
) {
  const workspace = me.workspaces[0].id,
    base = "workspaces/" + workspace;
  const records = (await api(page, base)).records;
  const org = records.find((r: any) => r.kind === "organizations");
  const person = records.find((r: any) => r.kind === "people");
  const a = {
    tier: "B",
    confidence: "Low",
    status: "Provisional analyst judgment",
    rationale:
      "Published institutional presence; further corroboration needed.",
    themeFit: "Needs qualification",
    fitBasis: "Directory hypothesis",
    fitStatus: "Directory-based hypothesis; unverified",
    reviewQueue: "Standard qualification",
    flags: ["No audited performance reviewed."],
    reviewedAt: "2026-10-18T12:00:00Z",
    sources: [
      {
        url: "https://example.com/team",
        retrievedAt: "2026-10-18T10:00:00Z",
        basis: "Official source",
      },
    ],
  };
  const upload = {
    schema: "bittrees-organization-standing.v1",
    rows: [{ name: org.data.name, website: org.data.website, assessment: a }],
  };
  await page.goto(origin + "/?view=organizations");
  await page
    .getByRole("button", { name: "Review standing file", exact: true })
    .click();
  await page.getByLabel("Standing review file", { exact: true }).setInputFiles({
    name: "standing.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(upload)),
  });
  await page
    .getByRole("button", { name: "Preview standing updates", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "1 organizations matched" }),
  ).toBeVisible();
  await page.locator(".standing-preview summary").click();
  await expect(
    page.getByRole("heading", { name: "Current assessment", exact: true }),
  ).toBeVisible();
  await accessibility(page, "Organization standing preview");
  await page
    .getByRole("button", {
      name: "Apply 1 reviewed standing updates",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Organization standing saved: 1 updated; 0 already matched. 1 organizations matched.",
      { exact: true },
    ),
  ).toBeVisible();
  const saved = (await api(page, base)).records.find(
    (r: any) => r.id === org.id,
  );
  assert.equal(saved.data.organizationStanding.tier, "B");
  assert.equal(saved.data.description, org.data.description);
  await page.getByLabel("Standing tier", { exact: true }).selectOption("B");
  await page
    .getByLabel("Sort investor research", { exact: true })
    .selectOption("standing");
  await expect(
    page.getByRole("button", { name: new RegExp(org.data.name) }).first(),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Standing view"));
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByLabel("Standing tier", { exact: true }).selectOption("all");
  await page
    .getByLabel("Sort investor research", { exact: true })
    .selectOption("name");
  await page
    .getByLabel("Saved views", { exact: true })
    .selectOption("Standing view");
  await expect(page.getByLabel("Standing tier", { exact: true })).toHaveValue(
    "B",
  );
  await expect(
    page.getByLabel("Sort investor research", { exact: true }),
  ).toHaveValue("standing");
  await page
    .getByRole("button", { name: "Open " + org.data.name, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Organization standing", exact: true }),
  ).toContainText("B · Established / institutional");
  await accessibility(page, "Organization standing profile");
  await page.keyboard.press("Escape");
  if (person?.data.organizationId === org.id) {
    await page.goto(origin + "/?view=people");
    await page
      .getByRole("button", { name: "Open " + person.data.name, exact: true })
      .click();
    const section = page.getByRole("region", {
      name: "Organization standing",
      exact: true,
    });
    await expect(section).toContainText("This does not rate the person.");
    await page.keyboard.press("Escape");
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(origin + "/?view=organizations");
    await page
      .getByRole("button", { name: "Open " + org.data.name, exact: true })
      .click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await accessibility(page, "Standing profile " + width);
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
