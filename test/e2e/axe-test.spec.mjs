import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";

// The plain `axe-core` package ships the browser build at axe.js; the
// `axe-core/playwright` subpath does NOT exist in the plain package.
// We inject the IIFE build into the page and call window.axe.run() there.
const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.js");

async function runAxe(page) {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(() =>
    window.axe.run(document, { resultTypes: ["violations"] }),
  );
}

/** Only critical/serious violations block; the rest are logged for manual review. */
function blocking(violations) {
  return violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
}

function summarize(violations) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    help: v.help,
  }));
}

test.describe("TrueHide — axe-core accessibility (automated pass; not a WCAG certification)", () => {
  test("landing page: no critical/serious violations", async ({ page }) => {
    await page.goto("/");
    const { violations } = await runAxe(page);
    const bad = blocking(violations);
    if (bad.length) test.info().annotations.push({ description: JSON.stringify(summarize(bad)), type: "a11y-blocking" });
    else if (violations.length) test.info().annotations.push({ description: JSON.stringify(summarize(violations)), type: "a11y-advisory" });
    expect(bad, JSON.stringify(summarize(bad), null, 2)).toHaveLength(0);
  });

  test("TrueFlatten (empty state): no critical/serious violations", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    const { violations } = await runAxe(page);
    const bad = blocking(violations);
    if (bad.length) test.info().annotations.push({ description: JSON.stringify(summarize(bad)), type: "a11y-blocking" });
    else if (violations.length) test.info().annotations.push({ description: JSON.stringify(summarize(violations)), type: "a11y-advisory" });
    expect(bad, JSON.stringify(summarize(bad), null, 2)).toHaveLength(0);
  });

  test("TrueFlatten export dialog: no critical/serious violations", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles("input[type=\"file\"]", "test/fixtures/secret.pdf");
    await expect(page.locator("#flattenButton")).toBeEnabled();
    await page.click("#flattenButton");
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
    const { violations } = await runAxe(page);
    const bad = blocking(violations);
    if (bad.length) test.info().annotations.push({ description: JSON.stringify(summarize(bad)), type: "a11y-blocking" });
    expect(bad, JSON.stringify(summarize(bad), null, 2)).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".truehide-modal-overlay")).toBeHidden();
  });

  test("TrueBlur (empty state): no critical/serious violations", async ({ page }) => {
    await page.goto("/app/trueblur/");
    const { violations } = await runAxe(page);
    const bad = blocking(violations);
    if (bad.length) test.info().annotations.push({ description: JSON.stringify(summarize(bad)), type: "a11y-blocking" });
    else if (violations.length) test.info().annotations.push({ description: JSON.stringify(summarize(violations)), type: "a11y-advisory" });
    expect(bad, JSON.stringify(summarize(bad), null, 2)).toHaveLength(0);
  });

  test("TrueCrop (empty state): no critical/serious violations", async ({ page }) => {
    await page.goto("/app/truecrop/");
    const { violations } = await runAxe(page);
    const bad = blocking(violations);
    if (bad.length) test.info().annotations.push({ description: JSON.stringify(summarize(bad)), type: "a11y-blocking" });
    else if (violations.length) test.info().annotations.push({ description: JSON.stringify(summarize(violations)), type: "a11y-advisory" });
    expect(bad, JSON.stringify(summarize(bad), null, 2)).toHaveLength(0);
  });

  test("shortcut help dialog: no critical/serious violations", async ({ page }) => {
    await page.goto("/app/truecrop/");
    await page.evaluate(() => window.TrueHide.showShortcutHelp());
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
    const { violations } = await runAxe(page);
    const bad = blocking(violations);
    if (bad.length) test.info().annotations.push({ description: JSON.stringify(summarize(bad)), type: "a11y-blocking" });
    expect(bad, JSON.stringify(summarize(bad), null, 2)).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".truehide-modal-overlay")).toBeHidden();
  });
});
