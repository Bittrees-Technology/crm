import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
type Api = (
  page: Page,
  path: string,
  body?: unknown,
  method?: string,
) => Promise<any>;
export async function checkAiConsent(
  page: Page,
  api: Api,
  me: any,
  origin: string,
) {
  const workspace = me.workspaces[0].id;
  const record = await api(page, "workspaces/" + workspace + "/records", {
    kind: "notes",
    data: {
      name: "AI consent synthetic note",
      description: "Shared fixture only",
    },
  });
  const verifier = "v".repeat(64),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const outgoing: string[] = [];
  const collect = (request: { url(): string }) => {
    if (!request.url().startsWith(origin)) outgoing.push(request.url());
  };
  page.on("request", collect);
  const errors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") errors.push(message.text());
  };
  page.on("console", onConsole);

  try {
    const response = await page.goto(
      origin + "/connect/ai?challenge=" + challenge,
    );
    assert.match(response!.headers()["content-security-policy"], /nonce-/);
    await expect(
      page.getByRole("heading", { name: "Connect your local AI", exact: true }),
    ).toBeVisible();
    try {
      await page
        .getByLabel("Workspace", { exact: true })
        .selectOption(workspace);
    } catch (error) {
      console.error(
        "AI consent initialization diagnostics",
        JSON.stringify({
          text: await page.locator("body").innerText(),
          errors: errors.slice(0, 5),
        }),
      );
      throw error;
    }
    await page
      .getByLabel("AI consent synthetic note · notes", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Review connection", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Allow read access to 1 selected record",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal((await api(page, "integrations/ai/connections")).length, 0);
    await page
      .getByRole("button", { name: "Allow selected read access", exact: true })
      .click();
    const code = await page
      .getByLabel("Connection code", { exact: true })
      .inputValue();
    assert.match(code, /^[a-f0-9]{64}$/);
    const grant = await api(page, "integrations/ai/exchange", {
      code,
      verifier,
    });
    assert.deepEqual(grant.recordIds, [record.id]);
    await page
      .getByRole("button", { name: "Revoke connection", exact: true })
      .click();
    await expect(page.getByText(/Revoked · Expires/)).toBeVisible();
    assert.equal(
      (await api(page, "integrations/ai/connections"))[0].revoked_at !== null,
      true,
    );
    assert.deepEqual(outgoing, []);
    assert.equal(await page.locator('script[src*="insights"]').count(), 0);
  } finally {
    page.off("request", collect);
    page.off("console", onConsole);
    await api(
      page,
      "workspaces/" + workspace + "/records",
      { id: record.id, version: record.version },
      "DELETE",
    );
    await page.goto(origin + "/?view=settings");
  }
}
