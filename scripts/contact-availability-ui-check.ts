import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";

export async function checkContactAvailability(
  page: Page,
  api: any,
  me: any,
  origin: string,
  accessibility: any,
) {
  const base = "workspaces/" + me.workspaces[0].id;
  for (const kind of ["people", "organizations"]) {
    for (const populated of [false, true])
      await api(page, base + "/records", {
        kind,
        data: {
          name: `Filter ${kind} ${populated ? "complete" : "missing"}`,
          ...(populated
            ? {
                email: "contact@example.com",
                website:
                  "https://www.linkedin.com/" +
                  (kind === "people" ? "in/person" : "company/firm"),
                contactMethods: [
                  { type: "phone", label: "Work", value: "+1 212 555 0199" },
                  {
                    type: "social",
                    label: "Work",
                    value: "https://twitter.com/filter_fixture",
                  },
                  { type: "address", label: "Office", value: "New York, NY" },
                ],
              }
            : {}),
        },
      });
    await page.goto(origin + "/?view=" + kind);
    await page
      .getByLabel("Search records", { exact: true })
      .fill("Filter " + kind);
    const filter = page.getByLabel("Contact availability", { exact: true });
    const rows = page.locator(".records-table tbody tr");
    for (const field of [
      "any",
      "email",
      "phone",
      "website",
      "social",
      "linkedin",
      "x",
      "address",
    ]) {
      await filter.selectOption("has:" + field);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(`Filter ${kind} complete`);
      await filter.selectOption("missing:" + field);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(`Filter ${kind} missing`);
    }
    await filter.selectOption("has:telegram");
    await page.getByLabel("Search records", { exact: true }).fill("");
    await expect(
      page.getByRole("heading", { name: "No matching records", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("0 matching records", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Search records", { exact: true })
      .fill("Filter " + kind);
    await filter.selectOption("missing:email");
    page.once("dialog", (d) => d.accept("Missing email " + kind));
    await page.getByRole("button", { name: "Save view", exact: true }).click();
    await expect(
      page
        .getByLabel("Saved views")
        .locator("option", { hasText: "Missing email " + kind }),
    ).toHaveCount(1);
    await page.reload();
    await page.getByLabel("Saved views").selectOption("Missing email " + kind);
    await expect(filter).toHaveValue("missing:email");
    await expect(
      page.getByLabel("Search records", { exact: true }),
    ).toHaveValue("Filter " + kind);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(`Filter ${kind} missing`);
    assert.equal(
      (await api(page, "me/views?workspace=" + me.workspaces[0].id)).some(
        (v: any) =>
          v.name === "Missing email " + kind &&
          v.contactAvailability === "missing:email",
      ),
      true,
    );
    await page.setViewportSize({ width: 390, height: 950 });
    await accessibility(page, kind + " contact filters on mobile");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    if (process.env.CRM_CONTACT_FILTER_SCREENSHOTS === "true")
      await page.screenshot({
        path: `/tmp/crm-contact-filter-${kind}-mobile.png`,
        fullPage: true,
      });
    await page.setViewportSize({ width: 1440, height: 950 });
    await filter.selectOption("all");
    await expect(rows).toHaveCount(2);
  }
  await page.goto(origin + "/?view=people");
  await page
    .getByLabel("Search records", { exact: true })
    .fill("Contact review fixture");
  await page
    .getByLabel("Contact availability", { exact: true })
    .selectOption("has:x");
  await expect(page.locator(".records-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".records-table tbody tr")).toContainText(
    "Contact review fixture",
  );
  await page
    .getByLabel("Contact availability", { exact: true })
    .selectOption("all");
  await page.getByLabel("Search records", { exact: true }).fill("");
}
