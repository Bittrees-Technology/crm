import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";

export async function checkRecordReadability(
  page: Page,
  origin: string,
  accessibility: (page: Page, label: string) => Promise<void>,
) {
  const initialViewport = page.viewportSize()!;
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const [kind, name] of [
      ["people", "UX person"],
      ["organizations", "UX organization"],
      ["projects", "UX project"],
      ["tasks", "UX task"],
      ["notes", "UX note"],
      ["opportunities", "UX opportunity"],
    ]) {
      await page.goto(origin + "/?view=" + kind);
      if (kind === "opportunities")
        await page
          .getByRole("button", { name: "Table view", exact: true })
          .click();
      const row = page
        .locator(".records-table tbody tr")
        .filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toBeVisible();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${kind} list overflows at ${width}px`,
      );
      if (width <= 1200) {
        const cells = await row.locator("td").evaluateAll((cells) =>
          cells.map((e) => {
            const r = e.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
          }),
        );
        assert(
          cells.every((r) => r.left >= 0 && r.right <= width && r.width > 0),
          `${kind} hides a column at ${width}px`,
        );
      }
      await row.locator(".record-link").click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByLabel("Record profile", { exact: true }),
      ).toBeVisible();
      const dimensions = await dialog.locator(".record-body").evaluate((e) => {
        const body = e.getBoundingClientRect(),
          profile = e
            .querySelector(".record-profile-sections")!
            .getBoundingClientRect(),
          style = getComputedStyle(e);
        return {
          inset: profile.left - body.left,
          rightInset: body.right - profile.right,
          padding: parseFloat(style.paddingLeft),
          overflow: e.scrollWidth > e.clientWidth,
        };
      });
      assert(
        dimensions.inset >= 16 &&
          dimensions.rightInset >= 16 &&
          dimensions.padding >= 16,
        `${kind} needs text gutters at ${width}px`,
      );
      assert(!dimensions.overflow, `${kind} profile overflows at ${width}px`);
      if (kind === "organizations")
        await expect(
          dialog.getByRole("link", {
            name: "ux-organization@example.com",
            exact: true,
          }),
        ).toBeVisible();
      if (kind === "tasks")
        await expect(
          dialog
            .getByLabel("Record profile", { exact: true })
            .getByRole("button", { name: "UX organization", exact: true }),
        ).toBeVisible();
      if (kind === "people") {
        await expect(
          dialog.locator(".record-prose").getByRole("link", {
            name: "https://example.com/public-evidence",
            exact: true,
          }),
        ).toHaveAttribute("href", "https://example.com/public-evidence");
      }
      if (width === 390)
        await accessibility(page, kind + " readable profile on mobile");
      if (width === 900 && kind === "people")
        await page.screenshot({
          path: "/tmp/crm-readable-person.png",
          fullPage: true,
        });
      if (width === 390 && kind === "tasks")
        await page.screenshot({
          path: "/tmp/crm-readable-task-mobile.png",
          fullPage: true,
        });
      await dialog.getByLabel("Close", { exact: true }).click();
    }
  }
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await page.setViewportSize(initialViewport);
}
