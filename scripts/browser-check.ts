import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chromium, expect, type Page } from "@playwright/test";
import { Wallet, getBytes } from "ethers";
import pg from "pg";
import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { pool, transaction, schema } from "../lib/db";
import { checkAdminWorkflows } from "./admin-workflows";
import { checkWorkflows } from "./ui-workflows";
const origin = "http://127.0.0.1:3040";
if (
  process.env.APP_URL !== origin ||
  process.env.DEV_EMAIL_CONSOLE !== "true" ||
  !process.env.DATABASE_URL?.includes("127.0.0.1")
)
  throw new Error("Browser check requires the local development environment.");
// Use a separate disposable database so repeated browser runs never share user data or auth limits.
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
try {
  if (
    !(
      await admin.query(
        "SELECT 1 FROM pg_database WHERE datname='crm_browser_test'",
      )
    ).rowCount
  )
    await admin.query("CREATE DATABASE crm_browser_test");
} finally {
  await admin.end();
}
const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.pathname = "/crm_browser_test";
process.env.DATABASE_URL = testUrl.toString();
await pool().query(schema);
await pool().query(
  "TRUNCATE users,workspaces,rate_limits RESTART IDENTITY CASCADE",
);
const codes = new Map<string, string>();
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3040",
  ],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
server.stdout.on("data", (chunk) => {
  logs += chunk.toString();
  for (const m of logs.matchAll(
    /\[LOCAL EMAIL ONLY\] (browser-check-[^\s:]+): (\d{8})/g,
  ))
    codes.set(m[1], m[2]);
});
server.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});
const browser = await chromium.launch();
const accounts: { id: string; workspace: string }[] = [];
async function api(
  page: Page,
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await page.request.fetch(origin + "/api/" + path, {
    method,
    headers: { Origin: origin },
    data: body,
  });
  const d = await r.json();
  assert.ok(r.ok(), `${path}: ${d.error || r.status()}`);
  return d;
}
async function emailFlow(page: Page, email: string) {
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send verification code", exact: true })
    .click();
  await expect(
    page.getByLabel("Verification code", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => codes.get(email)).toBeTruthy();
  await page
    .getByLabel("Verification code", { exact: true })
    .fill(codes.get(email)!);
  await page
    .getByRole("button", { name: "Verify and continue", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
async function walletPage() {
  const context = await browser.newContext();
  const wallet = Wallet.createRandom();
  await context.exposeBinding("testWalletSign", async (_, hex: string) =>
    wallet.signMessage(getBytes(hex)),
  );
  await context.addInitScript(`
  window.walletMode='normal';window.ethereum={request:async({method,params})=>{
   if(method==='eth_requestAccounts'){
    if(window.walletMode==='pending') return new Promise(()=>{});
    if(window.walletMode==='reject') throw Object.assign(new Error('Declined'),{code:4001});
    return [${JSON.stringify(wallet.address)}];
   }
   if(method==='eth_chainId')return '0x2105';
   if(method==='personal_sign')return window.testWalletSign(params[0]);
   throw new Error('Unexpected provider method '+method);
  }};
 `);
  return context.newPage();
}
const accessibilityFindings: unknown[] = [];
async function accessibility(page: Page, label: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  if (result.violations.length)
    accessibilityFindings.push({
      screen: label,
      violations: result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    });
}
async function remember(page: Page) {
  const me = await api(page, "me");
  accounts.push({ id: me.user.id, workspace: me.workspaces[0].id });
  return me;
}
try {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(origin + "/api/health")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 60000 },
    )
    .toBe(true);
  const page = await walletPage();
  await page.goto(origin);
  // Reproduce a silent wallet and ensure the email path can recover immediately.
  await page.evaluate(() => {
    (window as any).walletMode = "pending";
  });
  await page
    .getByRole("button", { name: "Sign in with Ethereum", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel wallet request / use email" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel wallet request / use email" })
    .click();
  await expect(page.getByLabel("Email address", { exact: true })).toBeEnabled();
  const email = `browser-check-${randomUUID()}@example.com`;
  await emailFlow(page, email);
  const first = await remember(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Link wallet", exact: true }).click();
  await page.evaluate(() => {
    (window as any).walletMode = "reject";
  });
  await page
    .getByRole("button", { name: "Link Ethereum wallet", exact: true })
    .click();
  await expect(
    page.getByText("You declined the wallet request.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).walletMode = "normal";
  });
  await page
    .getByRole("button", { name: "Link Ethereum wallet", exact: true })
    .click();
  await expect(
    page.getByText("Two verified ways to sign in", { exact: true }),
  ).toBeVisible();
  let me = await api(page, "me");
  assert.equal(me.user.id, first.user.id);
  assert.equal(me.identities.length, 2);
  await page.goto(origin + "/?view=settings");
  await expect(
    page.getByText("Two verified ways to sign in", { exact: true }),
  ).toBeVisible();
  await accessibility(page, "Settings");
  await checkWorkflows(page, api, first, origin, accessibility);
  await checkAdminWorkflows(page, api, first, origin, accessibility);
  await page.goto(origin + "/?view=settings");
  // Opt-in is explicit, persists, and can be turned off again.
  const digest = page.getByLabel("Email me a daily digest");
  await expect(digest).not.toBeChecked();
  await digest.check();
  await page.getByRole("button", { name: "Save email preference" }).click();
  await expect(
    page.getByText("Daily digest enabled.", { exact: true }),
  ).toBeVisible();
  assert.equal((await api(page, "me/digest")).enabled, true);
  await digest.uncheck();
  await page.getByRole("button", { name: "Save email preference" }).click();
  await expect(
    page.getByText("Daily digest turned off.", { exact: true }),
  ).toBeVisible();
  // Invitation management through the UI, with old-link invalidation.
  await page
    .getByLabel("Invite by verified email")
    .fill("browser-invite@example.com");
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = page.getByLabel("Invitation link · expires in seven days");
  await expect(link).toHaveValue(/invite=/);
  const old = await link.inputValue();
  await page
    .getByRole("button", { name: "Recreate link", exact: true })
    .click();
  await expect(link).not.toHaveValue(old);
  const oldPreview = await page.request.post(origin + "/api/invites/preview", {
    headers: { Origin: origin },
    data: { token: new URL(old).searchParams.get("invite") },
  });
  assert.equal(oldPreview.status(), 400);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/crm-settings-verified.png",
    fullPage: true,
  });
  // Set up linked records, then operate the real quick controls and timeline.
  const base = `workspaces/${first.workspaces[0].id}`;
  const person = await api(page, base + "/records", {
    kind: "people",
    data: { name: "Browser contact" },
  });
  await api(page, base + "/records", {
    kind: "notes",
    data: {
      name: "Meeting notes",
      personId: person.id,
      description: "Follow up on the partnership.",
    },
  });
  await api(page, base + "/records", {
    kind: "tasks",
    data: {
      name: "Browser follow-up",
      personId: person.id,
      ownerId: first.user.id,
      dueDate: "2026-09-10",
    },
  });
  await api(page, base + "/records", {
    kind: "opportunities",
    data: {
      name: "Browser partnership",
      personId: person.id,
      ownerId: first.user.id,
      nextAction: "Arrange a call",
      dueDate: "2026-09-10",
    },
  });
  await page.goto(origin + "/?view=tasks");
  await page.getByLabel("Due date for Browser follow-up").fill("2026-09-15");
  await page.getByLabel("Due date for Browser follow-up").press("Enter");
  await expect
    .poll(async () => {
      const s = await api(page, base);
      return s.records.find((r: any) => r.data.name === "Browser follow-up")
        ?.data.dueDate;
    })
    .toBe("2026-09-15");
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Opportunities", exact: true })
    .click();
  await page
    .getByLabel("Stage for Browser partnership")
    .selectOption("Proposal");
  await expect
    .poll(async () => {
      const s = await api(page, base);
      return s.records.find((r: any) => r.data.name === "Browser partnership")
        ?.data.stage;
    })
    .toBe("Proposal");
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByText("Browser contact", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Relationship history" }),
  ).toBeVisible();
  await expect(page.getByText("Task completed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Follow up on the partnership.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Stage: Introduction → Proposal", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Relationship history" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/crm-relationship-history.png",
    fullPage: true,
  });
  // Inverse path: wallet first, then email, still one account.
  const second = await walletPage();
  await second.goto(origin);
  await second
    .getByRole("button", { name: "Sign in with Ethereum", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  const secondMe = await remember(second);
  await second.getByRole("button", { name: "Settings", exact: true }).click();
  await second.getByRole("button", { name: "Link email", exact: true }).click();
  const secondEmail = `browser-check-${randomUUID()}@example.com`;
  await emailFlow(second, secondEmail);
  me = await api(second, "me");
  assert.equal(me.user.id, secondMe.user.id);
  assert.equal(me.identities.length, 2);
  await second.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () =>
      second
        .locator(".sidebar")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  await second.screenshot({
    path: "/tmp/crm-settings-mobile.png",
    fullPage: true,
  });
  const invitation = await api(page, base + "/invites", {
    email: secondEmail,
    role: "editor",
  });
  await second.goto(origin + "/?invite=" + invitation.token);
  await expect(
    second.getByText("Join My workspace as editor.", { exact: false }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await api(second, "me")).workspaces.some(
        (w: any) => w.id === first.workspaces[0].id,
      ),
    )
    .toBe(true);
  // Verify member permissions in the interface, then restore the invited editor.
  await api(
    page,
    base + "/members",
    { userId: secondMe.user.id, role: "viewer" },
    "PATCH",
  );
  await second.goto(origin + "/?view=people");
  await expect(
    second.getByRole("button", { name: "Add person", exact: true }),
  ).toHaveCount(0);
  await second.getByText("Browser contact", { exact: true }).click();
  await expect(
    second.getByRole("button", { name: "Save record", exact: true }),
  ).toHaveCount(0);
  await second
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await api(
    page,
    base + "/members",
    { userId: secondMe.user.id, role: "editor" },
    "PATCH",
  );
  const scopeProject = await api(page, base + "/records", {
    kind: "projects",
    data: { name: "Member scope project" },
  });
  await page.goto(origin + "/?view=settings");
  await page
    .getByRole("button", {
      name: `Whole workspace · Edit access for ${secondMe.user.name}`,
      exact: true,
    })
    .click();
  let memberScope = page
    .locator(".member-access")
    .filter({ hasText: `Edit access for ${secondMe.user.name}` });
  await memberScope.getByLabel("Access area").selectOption("selected");
  await memberScope
    .getByLabel("Member scope project · projects", { exact: true })
    .check();
  await memberScope
    .getByRole("button", { name: "Save collaboration access", exact: true })
    .click();
  await expect.poll(async () => (await api(second, base)).limited).toBe(true);
  assert.deepEqual(
    (await api(second, base)).records.map((r: any) => r.id),
    [scopeProject.id],
  );
  await page
    .getByRole("button", {
      name: `Limited access · Edit access for ${secondMe.user.name}`,
      exact: true,
    })
    .click();
  memberScope = page
    .locator(".member-access")
    .filter({ hasText: `Edit access for ${secondMe.user.name}` });
  await memberScope.getByLabel("Access area").selectOption("all");
  await memberScope
    .getByRole("button", { name: "Save collaboration access", exact: true })
    .click();
  await expect.poll(async () => (await api(second, base)).limited).toBe(false);
  await api(
    page,
    base + "/records",
    { id: scopeProject.id, version: scopeProject.version },
    "DELETE",
  );
  // Reproduce the reported duplicate-account collision and finish explicit recovery.
  await second.setViewportSize({ width: 1280, height: 900 });
  await second.goto(origin + "/?view=settings");
  await second
    .getByRole("button", { name: "Link email or wallet", exact: true })
    .click();
  await second.getByLabel("Email address", { exact: true }).fill(email);
  await second
    .getByRole("button", { name: "Send verification code", exact: true })
    .click();
  await expect(
    second.getByLabel("Verification code", { exact: true }),
  ).toBeVisible();
  await second
    .getByLabel("Verification code", { exact: true })
    .fill(codes.get(email)!);
  await second
    .getByRole("button", { name: "Verify and continue", exact: true })
    .click();
  await expect(
    second.getByRole("heading", { name: "Two accounts, one person?" }),
  ).toBeVisible();
  await accessibility(second, "Account recovery");
  await second.screenshot({
    path: "/tmp/crm-account-recovery.png",
    fullPage: true,
  });
  await second
    .getByRole("button", { name: "Verify current account", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Verify current wallet", exact: true })
    .click();
  await expect(
    second.getByText("Both accounts verified.", { exact: false }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Confirm and combine accounts", exact: true })
    .click();
  await expect(second.getByRole("dialog")).not.toBeVisible();
  const recovered = await api(second, "me");
  assert.equal(recovered.user.id, secondMe.user.id);
  assert.equal(recovered.identities.length, 4);
  assert.equal(recovered.workspaces.length, 2);
  assert.ok(
    (await api(second, base)).records.some(
      (r: any) => r.data.name === "Browser follow-up",
    ),
  );
  assert.equal((await page.request.get(origin + "/api/me")).status(), 401);
  // Timeout recovery and missing provider, without touching any real wallet.
  const timeout = await walletPage();
  await timeout.goto(origin);
  await timeout.clock.install();
  await timeout.evaluate(() => {
    (window as any).walletMode = "pending";
  });
  await timeout
    .getByRole("button", { name: "Sign in with Ethereum", exact: true })
    .click();
  await timeout.clock.fastForward(31000);
  await expect(
    timeout.getByText("The wallet did not respond.", { exact: false }),
  ).toBeVisible();
  await expect(
    timeout.getByLabel("Email address", { exact: true }),
  ).toBeEnabled();
  const plain = await (await browser.newContext()).newPage();
  await plain.goto(origin);
  await plain
    .getByRole("button", { name: "Sign in with Ethereum", exact: true })
    .click();
  await expect(plain.getByText(/wallet extension/i)).toBeVisible();
  await expect(
    plain.getByLabel("Email address", { exact: true }),
  ).toBeEnabled();
  await accessibility(plain, "Sign-in");
  const demo = await (await browser.newContext()).newPage();
  await demo.goto(origin + "/?demo=1");
  await expect(
    demo.getByText("All names and records are fictional.", { exact: false }),
  ).toBeVisible();
  await demo.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(demo.getByLabel("Email me a daily digest")).toBeDisabled();
  await accessibility(demo, "Demo settings");
  writeFileSync(
    "/tmp/crm-accessibility.json",
    JSON.stringify(accessibilityFindings, null, 2),
  );
  assert.deepEqual(accessibilityFindings, [], "Accessibility checks");
  console.log(
    "Browser checks passed: cancellation, timeout, rejection recovery, email → wallet, wallet → email, persistence, quick actions, timeline, invitations, and opt-in digest.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill("SIGTERM");
  const ids = accounts.map((a) => a.id);
  await pool().query(
    "DELETE FROM challenges WHERE recovery_hash IN (SELECT hash FROM identity_recoveries WHERE target_id=ANY($1::uuid[]) OR source_id=ANY($1::uuid[]))",
    [ids],
  );
  await pool().query(
    "DELETE FROM identity_recoveries WHERE target_id=ANY($1::uuid[]) OR source_id=ANY($1::uuid[])",
    [ids],
  );
  for (const a of accounts)
    await transaction(async (db) => {
      await db.query("DELETE FROM audit WHERE workspace_id=$1", [a.workspace]);
      await db.query("DELETE FROM records WHERE workspace_id=$1", [
        a.workspace,
      ]);
      await db.query("DELETE FROM invites WHERE workspace_id=$1", [
        a.workspace,
      ]);
      await db.query("DELETE FROM members WHERE workspace_id=$1", [
        a.workspace,
      ]);
      await db.query("DELETE FROM workspaces WHERE id=$1", [a.workspace]);
      await db.query("DELETE FROM digest_receipts WHERE user_id=$1", [a.id]);
      await db.query("DELETE FROM sessions WHERE user_id=$1", [a.id]);
      await db.query(
        "DELETE FROM challenges WHERE user_id=$1 OR (kind,value) IN (SELECT kind,value FROM identities WHERE user_id=$1)",
        [a.id],
      );
      await db.query("DELETE FROM identities WHERE user_id=$1", [a.id]);
      await db.query("DELETE FROM users WHERE id=$1", [a.id]);
    });
  await pool().end();
}
