import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

mkdirSync(path.join(process.cwd(), 'test', 'tmp'), { recursive: true });

test.describe("TrueHide — privacy & network monitoring", () => {
  test.beforeEach(async ({ page }) => {
    // Ensure we start from a clean state — land on the homepage.
    await page.goto('/');
  });

  test("no external network requests on any app page (offline-mode check)", async ({ page }) => {
    // All four apps: every request — including the initial page load — must
    // stay on the local test origin. All assets are vendored locally.
    const pages = [
      '/app/trueflatten/',
      '/app/trueblur/',
      '/app/truecrop/',
      '/app/truemetadata/',
    ];

    for (const rel of pages) {
      const external = [];
      // Attach BEFORE navigation so initial page-load requests are captured.
      // A single 'request' listener sees every request once; adding
      // requestfailed/requestfinished on top would double-count them.
      const handler = req => {
        const url = req.url();
        // In-memory object URLs / pseudo-protocols never leave the device.
        if (/^(blob:|data:|file:|about:)/.test(url)) return;
        try {
          const u = new URL(url);
          // Only an http(s) connection to a non-local host is a violation.
          if ((u.protocol === 'http:' || u.protocol === 'https:') &&
              u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
            external.push(url);
          }
        } catch {
          // Unparseable URL: not an outbound network connection.
        }
      };

      page.on('request', handler);
      try {
        await page.goto(rel);
        // Wait for the network to go idle (no pending requests).
        await page.waitForLoadState('networkidle');
      } finally {
        page.off('request', handler);
      }

      console.log(`Page ${rel}: ${external.length} external request(s)`);
      expect(external, `unexpected external requests on ${rel}`).toEqual([]);
    }

    console.log('Privacy check passed: no unexpected external network requests on any page');
  });

  test("show shortcut help modal via TrueHide API", async ({ page }) => {
    await page.goto('http://127.0.0.1:4173/app/trueflatten/');

    // Open shortcut help via the TrueHide API (showShortcutHelp was
    // exposed in shared/shortcuts.js init; it creates a modal with a Close button).
    await page.evaluate(() => {
      if (window.TrueHide && window.TrueHide.showShortcutHelp) {
        window.TrueHide.showShortcutHelp();
      }
    });

    // Wait for the modal to appear.
    await page.waitForSelector('.truehide-modal-overlay', { timeout: 5000 });
    const modalVisible = await page.locator('.truehide-modal-overlay').isVisible();
    console.log('Shortcut help modal opened:', modalVisible);
    expect(modalVisible).toBeTruthy();

    // Close with Esc
    await page.keyboard.press('Escape');
    const modalGone = !(await page.locator('.truehide-modal-overlay').isVisible());
    console.log('Shortcut help modal closed:', modalGone);
    expect(modalGone).toBeTruthy();
  });

  test('user file content never leaves the device (no upload paths)', async ({ page }) => {
    test.setTimeout(180_000);
    const requests = [];
    page.on('request', req => requests.push(req.url()));

    // TrueCrop full data flow: load a local image, edit it, export it.
    await page.goto('/app/truecrop/');
    await page.setInputFiles('input[type="file"]', path.resolve('test/fixtures/blank.png'));
    await expect(page.locator('#imageCanvas')).toBeVisible();

    const box = await page.locator('#selectionCanvas').boundingBox();
    const sx = box.x + box.width * 0.1;
    const sy = box.y + box.height * 0.1;
    const ex = box.x + box.width * 0.9;
    const ey = box.y + box.height * 0.9;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator('#cropButton')).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.click('#cropButton');
        await page.click('#dlConfirm');
      })(),
    ]);
    await download.saveAs(path.join(process.cwd(), 'test', 'tmp', 'privacy-crop.png'));
    page.removeAllListeners('request');

    // TrueFlatten full data flow: load a local PDF, redact and flatten it.
    const flattenRequests = [];
    page.on('request', req => flattenRequests.push(req.url()));
    await page.goto('/app/trueflatten/');
    await page.setInputFiles('input[type="file"]', path.resolve('test/fixtures/secret.pdf'));
    await expect(page.locator('#flattenButton')).toBeEnabled();

    // Draw a redaction so the export actually rasterizes the page.
    // Keep the drag path inside the viewport (Firefox mangles off-screen
    // pointer coordinates and silently drops the redaction).
    await page.evaluate(() => {
      const c = document.getElementById("pdfCanvas");
      const top = c.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - 20));
    });
    const pdfBox = await page.locator("#pdfCanvas").boundingBox();
    const px1 = pdfBox.x + pdfBox.width * 0.2;
    const py1 = pdfBox.y + pdfBox.height * 0.1;
    const px2 = pdfBox.x + pdfBox.width * 0.8;
    const py2 = pdfBox.y + pdfBox.height * 0.4;
    await page.mouse.move(px1, py1);
    await page.mouse.down();
    await page.mouse.move(px2, py2, { steps: 3 });
    await page.mouse.up();

    // Two-step export: confirm the modal to trigger the download.
    const [flattenDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      (async () => {
        await page.click('#flattenButton');
        await page.click('#dlConfirm');
      })(),
    ]);
    await flattenDownload.saveAs(path.join(process.cwd(), 'test', 'tmp', 'privacy-flatten.pdf'));

    const external = (urls) =>
      urls.filter(url => {
        // In-memory object URLs and data URLs never leave the device.
        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
        try {
          const u = new URL(url);
          // Only flag real outbound http(s) connections to non-local hosts;
          // pseudo-protocols (about:, view-source:) are not network traffic.
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
          return !(u.hostname === '127.0.0.1' || u.hostname === 'localhost');
        } catch {
          return false;
        }
      });

    const cropExternal = external(requests);
    const flattenExternal = external(flattenRequests);
    console.log(`Crop flow: ${requests.length} requests, ${cropExternal.length} external.`);
    console.log(`Flatten flow: ${flattenRequests.length} requests, ${flattenExternal.length} external.`);
    expect(cropExternal, JSON.stringify(cropExternal)).toHaveLength(0);
    expect(flattenExternal, JSON.stringify(flattenExternal)).toHaveLength(0);
  });
});