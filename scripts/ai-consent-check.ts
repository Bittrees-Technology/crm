import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { expect, request, type Page } from "@playwright/test";
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
    kind: "projects",
    data: {
      name: "AI consent synthetic project",
      description: "Shared fixture only",
    },
  });
  let publishedRecordId: string | undefined;
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
      .getByLabel("AI consent synthetic project · projects", { exact: true })
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
      .getByRole("button", { name: "Manage reviewed writes", exact: true })
      .click();
    await page
      .getByLabel("Write destination", { exact: true })
      .selectOption(record.id);
    await page.getByLabel("Create notes", { exact: true }).check();
    await page
      .getByRole("button", { name: "Review write permission", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Allow reviewed writes", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Revoke write permission",
        exact: true,
      }),
    ).toBeVisible();
    const bearer = async (path: string, body: unknown) =>
      page.request.post(origin + "/api/integrations/ai/" + path, {
        headers: { Authorization: "Bearer " + grant.token },
        data: body,
      });
    const sourceResponse = await bearer("read", { recordIds: [record.id] });
    assert.equal(sourceResponse.status(), 200);
    const source = await sourceResponse.json();
    const preparedResponse = await bearer("writes/prepare", {
      operationId: randomUUID(),
      targetId: record.id,
      kind: "notes",
      name: "Synthetic reviewed note",
      description: "Exact synthetic review body",
      dueDate: "",
      sources: source.records.map((r: any) => ({
        id: r.id,
        version: r.version,
      })),
      projectionHash: createHash("sha256")
        .update(JSON.stringify(source.records))
        .digest("hex"),
    });
    assert.equal(preparedResponse.status(), 200);
    const prepared = await preparedResponse.json();
    const decision = { reviewId: prepared.reviewId, digest: prepared.digest };
    assert.equal((await bearer("writes/publish", decision)).status(), 403);
    const unauthenticated = await request.newContext();
    try {
      const denied = await unauthenticated.post(
        origin + "/api/integrations/ai/writes/approve",
        {
          headers: { Origin: origin, Authorization: "Bearer " + grant.token },
          data: decision,
        },
      );
      assert.equal(denied.status(), 401);
    } finally {
      await unauthenticated.dispose();
    }
    await page.goto(origin + "/connect/ai?review=" + prepared.reviewId);
    await expect(
      page.getByText("Exact synthetic review body", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Approve exact proposal", exact: true })
      .click();
    await expect(
      page.getByText(
        "Approved. Return to the companion to publish this exact proposal.",
        { exact: true },
      ),
    ).toBeVisible();
    const result = await bearer("writes/publish", decision);
    assert.equal(result.status(), 200);
    const receipt = await result.json();
    publishedRecordId = receipt.recordId;
    const repeated = await (await bearer("writes/publish", decision)).json();
    assert.equal(repeated.recordId, publishedRecordId);
    assert.equal(repeated.existing, true);
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "Delete proposal copy", exact: true })
      .click();
    await expect(
      page.getByText(
        "Proposal copy deleted. Any published CRM record remains in CRM and can be deleted there.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Revoke connection", exact: true })
      .click();
    await expect(page.getByText(/Revoked · Expires/)).toBeVisible();
    assert.equal(
      (await api(page, "integrations/ai/connections"))[0].revoked_at !== null,
      true,
    );
    // Retry after source UI revocation must acknowledge without requiring a browser session.
    for (let attempt = 0; attempt < 2; attempt++) {
      const disconnected = await page.request.post(
        origin + "/api/integrations/ai/disconnect",
        {
          headers: { Authorization: "Bearer " + grant.token },
          data: {},
        },
      );
      assert.equal(disconnected.status(), 200);
      assert.deepEqual(await disconnected.json(), { ok: true });
    }
    assert.deepEqual(outgoing, []);
    assert.equal(await page.locator('script[src*="insights"]').count(), 0);
  } finally {
    page.off("request", collect);
    page.off("console", onConsole);
    if (publishedRecordId)
      await api(
        page,
        "workspaces/" + workspace + "/records",
        { id: publishedRecordId, version: 1 },
        "DELETE",
      );
    await api(
      page,
      "workspaces/" + workspace + "/records",
      { id: record.id, version: record.version },
      "DELETE",
    );
    await page.goto(origin + "/?view=settings");
  }
}
