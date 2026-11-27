import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

mkdirSync(path.join(process.cwd(), 'test', 'tmp'), { recursive: true });

test.describe("TrueHide — privacy & network monitoring", () => {
  test.beforeEach(async ({ page }) => {
    // Ensure we start from a clean state — land on the homepage.
    await page.goto('/');
  });

  test("no external network requests on any page (offline-mode check)", async ({ page, request }) => {
    // We'll navigate to each app page and assert zero unexpected external requests.
    // All assets are vendored; the only known external is Google Fonts which we replaced.
    const pages = [
      '/app/trueflatten/',
      '/app/trueblur/',
      '/app/truecrop/',
      '/app/truemetadata/',
    ];

    for (const rel of pages) {
      await page.goto('http://127.0.0.1:4173' + rel);

      // Collect all network requests during page load + idle.
      const requests = [];
      page.on('request', req => requests.push({ url: req.url(), method: req.method() }));
      page.on('requestfailed', req => requests.push({ url: req.url(), method: req.method(), failed: true }));
      page.on('requestfinished', req => requests.push({ url: req.url(), method: req.method(), finished: true }));

      // Wait for network to go idle (no pending requests).
      await page.waitForLoadState('networkidle');

      // Filter out same-origin and known-internal requests.
      const externalRequests = requests.filter(r => {
        try {
          const url = new URL(r.url);
          // Same-origin (baseURL 127.0.0.1:4173) is OK.
          if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return false;
          // Reject anything not the known self-hosted font or same-origin.
          return true;
        } catch {
          return true;
        }
      });

      // Allow the single expected self-hosted font (Inter woff2) and same-origin requests.
      // All other external loads are privacy violations.
      const unexpected = externalRequests.filter(r => {
        const u = new URL(r.url);
        // Block: any external host that isn't 127.0.0.1/localhost
        if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return true;
        // Block: anything with a path that looks like an external CDN or analytics
        if (r.url.includes('google')) return true;
        if (r.url.includes('analytics')) return true;
        if (r.url.includes('track')) return true;
        if (r.url.includes('doubleclick')) return true;
        // Allow: known self-hosted font
        if (r.url.endsWith('.woff2') || r.url.endsWith('.font')) return false;
        // Block everything else external
        return true;
      });

      console.log(`Page ${rel}: ${externalRequests.length} total external-like requests, ${unexpected.length} unexpected`);
      if (unexpected.length > 0) {
        console.log('  Unexpected requests:', unexpected.map(r => r.url).join(', '));
        throw new Error(`Privacy violation on ${rel}: unexpected external network requests`);
      }
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
      page.click('#cropButton'),
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
        await page.click('#flattenConfirm');
      })(),
    ]);
    await flattenDownload.saveAs(path.join(process.cwd(), 'test', 'tmp', 'privacy-flatten.pdf'));

    const external = (urls) =>
      urls.filter(url => {
        // In-memory object URLs and data URLs never leave the device.
        if (url.startsWith('blob:') || url.startsWith('data:')) return false;
        try {
          const u = new URL(url);
          return !(u.hostname === '127.0.0.1' || u.hostname === 'localhost');
        } catch {
          return true;
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