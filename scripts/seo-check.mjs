import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const base = process.env.SEO_TEST_ORIGIN || "http://127.0.0.1:3041";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw Error("Use an isolated local build");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ["/", "/connect/autonote"]) {
    const response = await page.request.get(base + path);
    assert.equal(response.status(), 200);
    const html = await response.text();
    assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  }
  await page.goto(base + "/about");
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute("href"),
    "https://crm.bittrees.org/about",
  );
  assert.equal(
    await page.locator('meta[name="robots"]').getAttribute("content"),
    "index, follow",
  );
  assert.equal(
    await page.locator('meta[property="og:image"]').getAttribute("content"),
    "https://crm.bittrees.org/social-preview.png",
  );
  assert.equal(
    await page.locator('meta[name="twitter:card"]').getAttribute("content"),
    "summary_large_image",
  );
  assert.equal(await page.locator("h1").count(), 1);
  assert.equal(
    JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent(),
    )["@type"],
    "WebApplication",
  );
  const sitemap = await (await page.request.get(base + "/sitemap.xml")).text();
  assert.match(sitemap, /https:\/\/crm.bittrees.org\/about/);
  assert.equal((sitemap.match(/<loc>/g) || []).length, 1);
  for (const file of [
    "/favicon.svg",
    "/favicon-32.png",
    "/apple-touch-icon.png",
    "/social-preview.png",
  ])
    assert.equal((await page.request.get(base + file)).status(), 200, file);
  assert.match(
    (await page.request.get(base + "/api/health")).headers()["x-robots-tag"],
    /noindex/,
  );
  await mkdir("../artifacts/crm-seo", { recursive: true });
  for (const [name, width, height] of [
    ["desktop", 1440, 1050],
    ["mobile", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      "No horizontal overflow",
    );
    assert.deepEqual(
      (await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id),
      [],
    );
    await page.screenshot({
      path: `../artifacts/crm-seo/${name}.png`,
      fullPage: true,
    });
  }
  console.log(
    "SEO metadata, private noindex, assets, sitemap, mobile layout and accessibility passed.",
  );
} finally {
  await browser.close();
}
