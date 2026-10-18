import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
export async function checkBacklogConsent(page: Page, origin: string) {
  let approvals = 0;
  const endpoint = origin + "/api/datasets/backlog/consent";
  const review = {
    operator: "Local Bittrees AI",
    principal: "agent:11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T01:00:00.000Z",
    projects: Array.from({ length: 11 }, (_, i) => ({
      sourceProjectId: "site-" + i,
      crmProjectId: "project-" + i,
      name: "Destination " + i,
    })),
  };
  await page.route(endpoint, async (route) => {
    const body = route.request().postDataJSON();
    if (body.confirmed) approvals++;
    await route.fulfill({
      json: {
        review,
        ...(body.confirmed
          ? {
              envelope: {
                metadata: { connectionId: "fixture" },
                ciphertext: "synthetic-ciphertext",
              },
            }
          : {}),
      },
    });
  });
  try {
    await page.goto(origin + "/connect/ai/projects");
    await page.getByText("Agent backlog through MCP", { exact: true }).click();
    await page
      .getByLabel("Signed activation receipt", { exact: true })
      .fill('{"synthetic":true}');
    await page
      .getByRole("button", { name: "Review backlog connection", exact: true })
      .click();
    await expect(
      page.getByText("site-10 → Destination 10", { exact: true }),
    ).toBeVisible();
    const approve = page.getByRole("button", {
      name: "Approve dedicated backlog connection",
      exact: true,
    });
    await expect(approve).toBeDisabled();
    assert.equal(approvals, 0);
    await page
      .getByLabel("I approve these destinations and this exact expiry.", {
        exact: true,
      })
      .check();
    await approve.click();
    await expect(
      page.getByRole("button", {
        name: "Download encrypted handoff",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(approvals, 1);
    await expect(approve).toBeDisabled();
    await page.screenshot({
      path: "/tmp/crm-backlog-consent-review.png",
      fullPage: true,
    });
    await page
      .getByLabel("Signed activation receipt", { exact: true })
      .fill("{}");
    await expect(
      page.getByRole("button", {
        name: "Download encrypted handoff",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await page.unroute(endpoint);
  }
}
