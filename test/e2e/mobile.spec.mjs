import { test, expect } from "@playwright/test";
import path from "node:path";

const BLANK = path.resolve("test/fixtures/blank.png");
const SECRET = path.resolve("test/fixtures/secret.pdf");

// iPhone-class viewport with touch; mouse events still work in both projects.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe("Mobile viewport (390×844) — core flows", () => {
  test("TrueCrop: file selection, edit, export", async ({ page }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles("input[type=\"file\"]", BLANK);
    await expect(page.locator("#imageCanvas")).toBeVisible();

    // Selection (move before down — pointerdown fires at last mouse position).
    const box = await page.locator("#selectionCanvas").boundingBox();
    const sx = box.x + box.width * 0.1;
    const sy = box.y + box.height * 0.1;
    const ex = box.x + box.width * 0.9;
    const ey = box.y + box.height * 0.9;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 4 });
    await page.mouse.up();

    await expect(page.locator("#cropButton")).toBeEnabled();
    expect(await page.locator("#dimensions").textContent()).toMatch(/px/);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#cropButton"),
    ]);
    expect(download.suggestedFilename()).toBe("blank-cropped.png");
  });

  test("TrueBlur: file selection, apply, undo/redo, export", async ({ page }) => {
    await page.goto("/app/trueblur/");
    await page.setInputFiles("input[type=\"file\"]", BLANK);
    await expect(page.locator("#imageCanvas")).toBeVisible();

    // Drag a selection on the overlay canvas.
    const box = await page.locator("#selectionCanvas").boundingBox();
    const sx = box.x + box.width * 0.2;
    const sy = box.y + box.height * 0.2;
    const ex = box.x + box.width * 0.8;
    const ey = box.y + box.height * 0.8;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 4 });
    await page.mouse.up();

    await expect(page.locator("#applyButton")).toBeEnabled();
    await page.click("#applyButton");
    await expect(page.locator("#undoButton")).toBeEnabled();

    // Undo → redo cycle.
    await page.click("#undoButton");
    await expect(page.locator("#redoButton")).toBeEnabled();
    await page.click("#redoButton");
    await expect(page.locator("#undoButton")).toBeEnabled();

    // Export.
    await page.click("#applyButton");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#downloadButton"),
    ]);
    expect(download.suggestedFilename()).toBe("blank.png");
  });

  test("TrueFlatten: load, redact, open export dialog, cancel", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles("input[type=\"file\"]", SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();
    await expect(page.locator("#flattenButton")).toBeEnabled();

    // Redaction drag.
    const box = await page.locator("#pdfCanvas").boundingBox();
    const sx = box.x + box.width * 0.2;
    const sy = box.y + box.height * 0.1;
    const ex = box.x + box.width * 0.8;
    const ey = box.y + box.height * 0.5;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(1);

    // Open the export dialog, then cancel — the app must remain usable.
    await page.click("#flattenButton");
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
    await page.click("#cancelButton");
    await expect(page.locator(".truehide-modal-overlay")).toBeHidden();
    await expect(page.locator("#flattenButton")).toBeEnabled();
  });

  test("dialog + shortcut help on mobile", async ({ page }) => {
    await page.goto("/app/trueblur/");
    await page.evaluate(() => window.TrueHide.showShortcutHelp());
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".truehide-modal-overlay")).toBeHidden();
  });
});
