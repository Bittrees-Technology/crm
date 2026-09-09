import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
import { pool, transaction } from "../lib/db";
import { formatAmount } from "../lib/currencies";
type Api = (
  page: Page,
  path: string,
  body?: unknown,
  method?: string,
) => Promise<any>;
export async function checkWorkflows(
  page: Page,
  api: Api,
  me: any,
  origin: string,
  checkAccessibility: (page: Page, label: string) => Promise<void>,
) {
  const base = "workspaces/" + me.workspaces[0].id;
  const names: Record<string, string> = {
    organizations: "organization",
    people: "person",
    projects: "project",
    opportunities: "opportunity",
    tasks: "task",
    notes: "note",
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [kind, singular] of Object.entries(names)) {
    await page.goto(origin + "/?view=" + kind);
    await page
      .getByRole("button", {
        name:
          kind === "opportunities"
            ? "Add opportunity in Proposal"
            : "Add " + singular,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel(
        kind === "tasks" ? "Task" : kind === "notes" ? "Note title" : "Name",
        { exact: true },
      )
      .fill("UX " + singular);
    if (kind === "people") {
      await dialog
        .getByLabel("Email address", { exact: true })
        .fill("invalid-email");
      await dialog.getByRole("button", { name: "Save record" }).click();
      assert.equal(
        await dialog
          .getByLabel("Email address", { exact: true })
          .evaluate((e: HTMLInputElement) => e.validity.valid),
        false,
      );
      await dialog
        .getByLabel("Email address", { exact: true })
        .fill("ux-contact@example.com");
    }
    if (kind === "opportunities") {
      await expect(
        dialog.getByRole("combobox", { name: "Stage", exact: true }),
      ).toHaveValue("Proposal");
      await expect(
        dialog
          .getByRole("combobox", { name: "Opportunity type", exact: true })
          .locator("option", { hasText: "Sponsorship" }),
      ).toHaveCount(1);
      await dialog
        .getByRole("button", { name: "Create custom type", exact: true })
        .click();
      await dialog
        .getByLabel("Custom opportunity type", { exact: true })
        .fill("UX custom type");
      await dialog.getByLabel("Estimated value", { exact: true }).fill("12.50");
      await dialog
        .getByLabel("Next action", { exact: true })
        .fill("Review partnership");
      await dialog
        .getByLabel("Next action due", { exact: false })
        .fill("2026-10-01");
    }
    await dialog
      .getByLabel(kind === "notes" ? "Note" : "Description / context", {
        exact: true,
      })
      .fill("UX workflow check");
    await checkAccessibility(page, kind + " editor");
    await dialog.getByRole("button", { name: "Save record" }).click();
    await expect(dialog).not.toBeVisible();
    await checkAccessibility(page, kind + " records");
    await expect(
      page.getByText("UX " + singular, { exact: true }),
    ).toBeVisible();
  }
  const records = (await api(page, base)).records;
  assert.equal(records.length, 6);
  assert.equal(
    records.find((r: any) => r.kind === "opportunities").data.value,
    "12.50",
  );
  assert.ok(
    (await api(page, "me")).opportunityTypes.includes("UX custom type"),
  );
  await page.goto(origin + "/?view=opportunities");
  await page
    .getByRole("button", { name: "Add opportunity in Proposal", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Opportunity type", exact: true })
    .selectOption("UX custom type");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("dialog").getByLabel("Close", { exact: true }).click();
  // Search, saved views, browser navigation, and exports.
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByLabel("Search records").fill("UX person");
  page.once("dialog", (d) => d.accept("UX saved view"));
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByLabel("Search records").fill("no matches");
  await expect(
    page.getByRole("heading", { name: "No matching records" }),
  ).toBeVisible();
  await page.getByLabel("Saved views").selectOption("UX saved view");
  await expect(page.getByText("UX person", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Organizations", exact: true })
    .click();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: /^People \d+/ }),
  ).toBeVisible();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  assert.match((await csvDownload).suggestedFilename(), /\.csv$/);
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByText(/12[.,]50/).first()).toBeVisible();
  await checkAccessibility(page, "Reports");
  // Every denomination can be edited, persisted, reopened, and totaled exactly.
  for (const [currency, value] of [
    ["CAD", "123.45"],
    ["BTC", "0.00000001"],
    ["ETH", "0.000000000000000001"],
    ["USDC", "1.000001"],
    ["BIT", "123456789.123456789123456789"],
    ["BTREE", "0.000000000000000001"],
    ["EUR", "12.50"],
  ]) {
    await page
      .getByRole("button", { name: "Opportunities", exact: true })
      .click();
    await page.getByText("UX opportunity", { exact: true }).click();
    const editor = page.getByRole("dialog");
    await editor
      .getByRole("combobox", { name: "Currency", exact: true })
      .selectOption(currency);
    await editor.getByLabel("Estimated value", { exact: true }).fill(value);
    await editor.getByRole("button", { name: "Save record" }).click();
    await expect(editor).not.toBeVisible();
    await page.reload();
    await page.getByText("UX opportunity", { exact: true }).click();
    await expect(
      editor.getByLabel("Estimated value", { exact: true }),
    ).toHaveValue(value);
    await expect(
      editor.getByRole("combobox", { name: "Currency", exact: true }),
    ).toHaveValue(currency);
    await editor.getByLabel("Close", { exact: true }).click();
    const saved = (await api(page, base)).records.find(
      (r: any) => r.kind === "opportunities",
    );
    assert.equal(saved.data.value, value);
    assert.equal(saved.data.currency, currency);
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(
      page.getByRole("columnheader", { name: currency, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", {
        name: formatAmount(value, currency),
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export all workspace data" }).click();
  const stream = await (await jsonDownload).createReadStream();
  let text = "";
  for await (const chunk of stream!) text += chunk.toString();
  assert.equal(JSON.parse(text).records.length, 6);
  // Profile/workspace names and creating/switching an empty workspace.
  await page.getByLabel("Display name", { exact: true }).fill("UX tester");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect
    .poll(async () => (await api(page, "me")).user.name)
    .toBe("UX tester");
  await page.getByLabel("Workspace name", { exact: true }).fill("UX workspace");
  await page
    .getByRole("button", { name: "Save workspace", exact: true })
    .click();
  await expect
    .poll(async () => (await api(page, "me")).workspaces[0].name)
    .toBe("UX workspace");
  await page.getByLabel("Workspace name", { exact: true }).fill("My workspace");
  await page
    .getByRole("button", { name: "Save workspace", exact: true })
    .click();
  await expect
    .poll(async () => (await api(page, "me")).workspaces[0].name)
    .toBe("My workspace");
  await page
    .getByRole("button", { name: "Create another workspace", exact: true })
    .click();
  const create = page.getByRole("dialog");
  await create
    .getByLabel("Workspace name", { exact: true })
    .fill("UX temporary workspace");
  await create
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(create).not.toBeVisible();
  const extra = (await api(page, "me")).workspaces.find(
    (w: any) => w.name === "UX temporary workspace",
  );
  assert.ok(extra);
  assert.equal((await api(page, "workspaces/" + extra.id)).records.length, 0);
  await page
    .getByRole("button", { name: "Opportunities", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add opportunity in Proposal", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Opportunity type", exact: true })
      .locator("option", { hasText: "UX custom type" }),
  ).toHaveCount(1);
  await page.getByRole("dialog").getByLabel("Close", { exact: true }).click();
  await page
    .getByLabel("Workspace", { exact: true })
    .selectOption(me.workspaces[0].id);
  await transaction(async (db) => {
    await db.query("DELETE FROM members WHERE workspace_id=$1 AND user_id=$2", [
      extra.id,
      me.user.id,
    ]);
    await db.query("DELETE FROM workspaces WHERE id=$1", [extra.id]);
  });
  // Unsaved edits, failure recovery, optimistic conflicts, and expired-session recovery.
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByText("UX person", { exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Unsaved contact");
  page.once("dialog", (d) => d.dismiss());
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(dialog).toBeVisible();
  await page.route("**/api/workspaces/*/records", (route) => route.abort());
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not connect");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "Unsaved contact",
  );
  await page.unroute("**/api/workspaces/*/records");
  const person = records.find((r: any) => r.kind === "people");
  await api(page, base + "/records", {
    ...person,
    data: { ...person.data, title: "Concurrent edit" },
  });
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "changed or was removed",
  );
  page.once("dialog", (d) => d.accept());
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Refresh workspace", exact: true })
    .click();
  await page.getByText("UX person", { exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Recovered contact");
  await pool().query(
    "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
    [me.user.id],
  );
  await dialog.getByRole("button", { name: "Save record" }).click();
  const session = page.getByRole("dialog", { name: "Your session expired" });
  await expect(session).toBeVisible();
  await session
    .getByRole("button", { name: "Sign in with Ethereum", exact: true })
    .click();
  await expect(session).not.toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "Recovered contact",
  );
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(dialog).not.toBeVisible();
  // CSV validation/import and duplicate preview.
  await page.getByRole("button", { name: "Import CSV" }).click();
  let importer = page.getByRole("dialog");
  await importer.locator("input[type=file]").setInputFiles({
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("name,email\nUX imported,ux-import@example.com\n"),
  });
  await importer.getByRole("button", { name: "Import 1 records" }).click();
  await expect(importer).not.toBeVisible();
  await page.getByRole("button", { name: "Import CSV" }).click();
  importer = page.getByRole("dialog");
  await importer.locator("input[type=file]").setInputFiles({
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("name,email\nUX imported,ux-import@example.com\n"),
  });
  await expect(
    importer.getByText("All 1 rows already exist.", { exact: true }),
  ).toBeVisible();
  await importer.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Filter records").selectOption("mine");
  await expect(page.getByText("UX imported", { exact: true })).toHaveCount(0);
  await page.getByLabel("Filter records").selectOption("all");
  await expect(page.getByText("UX imported", { exact: true })).toBeVisible();
  // Delete each record through its UI, then leave a clean workspace for the remaining checks.
  for (const r of (await api(page, base)).records) {
    await page.goto(origin + "/?view=" + r.kind);
    await page.getByText(r.data.name, { exact: true }).click();
    const edit = page.getByRole("dialog");
    page.once("dialog", (d) => d.accept());
    await edit.getByRole("button", { name: "Delete record" }).click();
    await expect(edit).not.toBeVisible();
  }
  assert.equal((await api(page, base)).records.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/?view=settings");
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Close navigation" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Close navigation" }),
  ).toHaveCount(0);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Mobile page must not overflow horizontally",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(errors, [], "Browser should not report application errors");
  console.log(
    "Full UI workflows passed: all six record forms, validation, decimal amounts, search/views, history navigation, reports, exports, CSV/duplicates, unsaved edits, failed requests, edit conflicts, expired sessions, deletion, and mobile navigation.",
  );
}
