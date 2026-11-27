import { test, expect } from "@playwright/test";
import path from "node:path";

const BLANK = path.resolve("test/fixtures/blank.png");
const SECRET = path.resolve("test/fixtures/secret.pdf");

// Must match the CACHE constant in sw.js.
const CACHE_NAME = "truehide-v10";
// The SHELL list in sw.js has 30 entries (27 + 3 for TrueMetadata).
const MIN_SHELL_ENTRIES = 30;

/**
 * Load the site once (online) so the service worker registers and populates
 * its cache. The `serviceworker` context event only fires on transitions
 * observed by the context, and the worker is typically already activated by
 * the time the test runs — so poll the in-page cache store instead.
 */
async function warmServiceWorker(context, page) {
  await page.goto("/");
  await page.evaluate(
    async ([cacheName, minEntries]) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const regs = await navigator.serviceWorker.getRegistrations();
        const active = regs.some((r) => r.active);
        let count = 0;
        if (active) {
          const cache = await caches.open(cacheName);
          count = (await cache.keys()).length;
        }
        if (active && count >= minEntries) return;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(
        `service worker did not populate cache "${cacheName}" (need ${minEntries}+ entries)`,
      );
    },
    [CACHE_NAME, MIN_SHELL_ENTRIES],
  );
  // Reload so the worker controls this client (it claims clients on activate).
  await page.reload();
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length > 0,
        ),
      { timeout: 10_000 },
    )
    .toBeTruthy();
}

test.describe("Offline — service worker cache", () => {
  test.setTimeout(120_000);

  test("app works offline: TrueCrop is served and functional", async ({ page, context }) => {
    await warmServiceWorker(context, page);
    await context.setOffline(true);

    // Navigating while offline must be answered from the SW cache.
    await page.goto("/app/truecrop/");
    // The app's own page (not the landing-page fallback) must be served.
    await expect(page.locator("h1")).toContainText("TrueCrop");

    // Full functionality offline: load a local file and see the canvas render.
    await page.setInputFiles("input[type=\"file\"]", BLANK);
    await expect(page.locator("#imageCanvas")).toBeVisible();
  });

  test("vendored libraries load offline: TrueFlatten renders a PDF", async ({ page, context }) => {
    await warmServiceWorker(context, page);
    await context.setOffline(true);

    await page.goto("/app/trueflatten/");

    // Both vendored libraries must have executed (served from cache).
    const libs = await page.evaluate(() => ({
      pdfjs: Boolean(window.pdfjsLib),
      jspdf: Boolean(window.jspdf),
    }));
    expect(libs.pdfjs, "pdf.js should be available offline").toBe(true);
    expect(libs.jspdf, "jsPDF should be available offline").toBe(true);

    // Load and render a PDF completely offline.
    await page.setInputFiles("input[type=\"file\"]", SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();
    await expect(page.locator("#flattenButton")).toBeEnabled();
  });
});
