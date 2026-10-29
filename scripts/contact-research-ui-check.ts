import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
export async function checkContactResearch(
  page: Page,
  api: any,
  me: any,
  origin: string,
  accessibility: any,
) {
  const base = "workspaces/" + me.workspaces[0].id;
  const records = (await api(page, base)).records;
  const person = records.find((r: any) => r.kind === "people");
  const contact = {
    kind: "X",
    value: "https://x.com/synthetic_crm",
    sourceURL: "https://fund.org/team/synthetic",
    retrievedAt: "2026-10-29T00:00:00Z",
    evidence: "Synthetic official named professional card links this profile.",
    status: "Public source; delivery unverified",
  };
  const upload = {
    schema: "bittrees-people-contact-review.v1",
    rows: [
      {
        id: person.id,
        name: person.data.name,
        expected: {
          email: person.data.email,
          website: person.data.website,
          description: person.data.description,
          organizationId: person.data.organizationId,
        },
        contacts: [contact],
      },
    ],
  };
  await page.goto(origin + "/?view=people");
  await page
    .getByRole("button", { name: "Review contact file", exact: true })
    .click();
  await page
    .getByLabel("Contact research file", { exact: true })
    .setInputFiles({
      name: "contacts.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(upload)),
    });
  await page
    .getByRole("button", { name: "Preview contact updates", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "1 people matched" }),
  ).toBeVisible();
  await page.locator(".standing-preview summary").click();
  await accessibility(page, "People contact review preview");
  await page
    .getByRole("button", {
      name: "Apply 1 reviewed contact updates",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Public contacts saved: 1 people updated; 0 already matched.",
      { exact: true },
    ),
  ).toBeVisible();
  const saved = (await api(page, base)).records.find(
    (r: any) => r.id === person.id,
  );
  assert.deepEqual(saved.data, { ...person.data, publicContacts: [contact] });
  await page
    .getByRole("button", { name: "Open " + person.data.name, exact: true })
    .click();
  await expect(
    page.getByRole("region", {
      name: "Public professional contacts",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: contact.value, exact: true }),
  ).toHaveAttribute("href", contact.value);
  await accessibility(page, "Person sourced social links");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
}
