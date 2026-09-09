import assert from "node:assert/strict";
import { pool } from "../lib/db";
import { expect, type Page } from "@playwright/test";
export async function checkAdminWorkflows(
  page: Page,
  api: (page: Page, path: string, body?: any, method?: string) => Promise<any>,
  me: any,
  origin: string,
  accessibility: (page: Page, label: string) => Promise<void>,
) {
  const original = me.workspaces[0].id;
  let root = await api(page, `workspaces/${original}/records`, {
    kind: "projects",
    data: { name: "Access test project" },
  });
  await page.goto(
    origin + `/?workspace=${original}&view=projects&record=${root.id}`,
  );
  await expect(
    page.getByRole("dialog").getByLabel("Name", { exact: true }),
  ).toHaveValue("Access test project");
  const dialog = page.getByRole("dialog");
  await dialog
    .locator("summary")
    .filter({ hasText: "Your private note" })
    .click();
  await dialog
    .getByLabel("Private context", { exact: true })
    .fill("Browser author-only context");
  await dialog
    .locator("summary")
    .filter({ hasText: "Sharing & access" })
    .click();
  await dialog
    .getByLabel("Record access", { exact: true })
    .selectOption("selected");
  await accessibility(page, "Private note and sharing editor");
  await page.screenshot({
    path: "/tmp/crm-private-sharing-verified.png",
    fullPage: true,
  });
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .getByLabel("Record access", { exact: true })
    .scrollIntoViewIfNeeded();
  await accessibility(page, "Mobile private sharing editor");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "/tmp/crm-private-sharing-mobile.png",
    fullPage: true,
  });
  if (desktop) await page.setViewportSize(desktop);

  await dialog
    .getByRole("button", { name: "Save record", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  root = (await api(page, `workspaces/${original}`)).records.find(
    (r: any) => r.id === root.id,
  );
  assert.deepEqual(root.visibility_ids, []);
  assert.equal(
    (await api(page, `workspaces/${original}/records/${root.id}/private-note`))
      .content,
    "Browser author-only context",
  );
  assert.ok(
    !JSON.stringify(await api(page, `workspaces/${original}`)).includes(
      "Browser author-only context",
    ),
  );
  await page.goto(
    origin + `/?workspace=${original}&view=projects&record=${root.id}`,
  );
  await dialog
    .locator("summary")
    .filter({ hasText: "Your private note" })
    .click();
  await expect(
    dialog.getByLabel("Private context", { exact: true }),
  ).toHaveValue("Browser author-only context");
  await dialog
    .locator("summary")
    .filter({ hasText: "Sharing & access" })
    .click();
  await dialog
    .getByLabel("Record access", { exact: true })
    .selectOption("workspace");
  await dialog
    .getByRole("button", { name: "Save record", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  root = (await api(page, `workspaces/${original}`)).records.find(
    (r: any) => r.id === root.id,
  );

  await page.goto(origin + "/?view=settings");
  await page
    .locator("summary")
    .filter({ hasText: "Review who can access each record" })
    .click();
  await expect(
    page.getByLabel("Review access for", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Find accessible records", { exact: true })
    .fill("Access test project");
  await expect(
    page.locator(".access-row").filter({ hasText: "Access test project" }),
  ).toBeVisible();
  await accessibility(page, "Effective access inspector");
  const invite = page.locator("form.invite-form");
  await invite
    .getByLabel("Invite by verified email")
    .fill("scoped-ui@example.com");
  await invite.getByLabel("Access area").selectOption("selected");
  await expect(
    invite.getByRole("button", { name: "Create invite link" }),
  ).toBeDisabled();
  await invite
    .getByLabel("Access test project · projects", { exact: true })
    .check();
  await invite.getByRole("button", { name: "Create invite link" }).click();
  await expect(
    page.getByLabel("Invitation link · expires in seven days"),
  ).toHaveValue(/invite=/);
  const invitations = await api(page, `workspaces/${original}/invites`);
  assert.deepEqual(invitations.invites[0].scope_ids, [root.id]);
  await page
    .getByRole("button", { name: "Recreate link", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await api(page, `workspaces/${original}/invites`)).invites.length,
    )
    .toBe(2);
  assert.deepEqual(
    (await api(page, `workspaces/${original}/invites`)).invites[0].scope_ids,
    [root.id],
  );
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await pool().query("DELETE FROM invites WHERE workspace_id=$1 AND email=$2", [
    original,
    "scoped-ui@example.com",
  ]);
  await page.getByLabel("Follow-up ownership").selectOption("all");
  await page.getByLabel("Look-ahead window").selectOption("3");
  await page.getByLabel("Weekdays only (UTC)").check();
  await page.getByRole("button", { name: "Save email preference" }).click();
  await expect
    .poll(async () => (await api(page, "me/digest")).options.daysAhead)
    .toBe(3);
  await page.getByRole("button", { name: "Preview follow-up email" }).click();
  await expect(
    page.getByRole("region", { name: "Follow-up email preview" }),
  ).toBeVisible();
  await accessibility(page, "Scoped invite and email controls");
  await api(
    page,
    "me/digest",
    {
      enabled: false,
      email: me.identities.find((i: any) => i.kind === "email")?.value || "",
      options: {},
    },
    "PATCH",
  );
  const source = await api(page, "workspaces", { name: "UI merge source" });
  await api(page, `workspaces/${source.id}/records`, {
    kind: "notes",
    data: { name: "UI merge record" },
  });
  await page.goto(origin + `/?view=settings&workspace=${source.id}`);
  await page
    .getByRole("button", { name: "Merge workspace", exact: true })
    .click();
  await page.getByLabel("Destination workspace").selectOption(original);
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm merge", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Type the source workspace name to confirm")
    .fill("UI merge source");
  await accessibility(page, "Workspace merge review");
  await page
    .getByRole("button", { name: "Confirm merge", exact: true })
    .click();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue(
    original,
  );
  const moved = (await api(page, `workspaces/${original}`)).records.find(
    (r: any) => r.data.name === "UI merge record",
  );
  assert.ok(moved);
  const remove = await api(page, "workspaces", { name: "UI delete workspace" });
  await page.goto(origin + `/?view=settings&workspace=${remove.id}`);
  await page
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByLabel("Type the source workspace name to confirm")
    .fill("UI delete workspace");
  await accessibility(page, "Workspace deletion review");
  await page
    .getByRole("button", { name: "Permanently delete workspace", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await api(page, "me")).workspaces.some((w: any) => w.id === remove.id),
    )
    .toBe(false);
  for (const record of [moved, root])
    await api(
      page,
      `workspaces/${original}/records`,
      { id: record.id, version: record.version },
      "DELETE",
    );
  await page.goto(origin + "/?view=settings");
  console.log(
    "Workspace merge/delete, scoped invitations, and configurable email UI checks passed.",
  );
}
