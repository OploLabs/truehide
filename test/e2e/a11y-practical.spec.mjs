import { test, expect } from "@playwright/test";
import path from "node:path";

const SECRET = path.resolve("test/fixtures/secret.pdf");
const BLANK = path.resolve("test/fixtures/blank.png");

/**
 * Practical accessibility smoke checks: keyboard-only reachability,
 * accessible names for screen readers, and keyboard-driven dialogs.
 * These are smoke tests, not a WCAG certification.
 */

/**
 * Press Tab until the element with `targetId` is focused.
 * Returns the number of Tab presses used, or null if not reached within budget.
 */
async function tabUntil(page, targetId, budget = 60) {
  for (let i = 0; i < budget; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id || "");
    if (id === targetId) return i + 1;
  }
  return null;
}

test.describe("Accessibility — keyboard-only reachability", () => {
  test.setTimeout(120_000);

  test("TrueFlatten: export controls reachable by Tab; Enter opens the dialog; Escape closes it", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', SECRET);
    await expect(page.locator("#flattenButton")).toBeEnabled();

    // Move focus to the body first so Tab starts from a known position.
    await page.evaluate(() => document.activeElement?.blur());

    const stepsToFile = await tabUntil(page, "exportFilename");
    expect(
      stepsToFile,
      "export filename input should be reachable via Tab",
    ).not.toBeNull();

    const stepsToButton = await tabUntil(page, "flattenButton");
    expect(
      stepsToButton,
      "flatten button should be reachable via Tab",
    ).not.toBeNull();

    // Enter activates the focused button and opens the export dialog.
    await page.keyboard.press("Enter");
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();

    // The dialog is keyboard-operable: focus is trapped inside and Escape closes.
    const focusedInside = await page.evaluate(() =>
      document.querySelector(".truehide-modal-overlay").contains(document.activeElement),
    );
    expect(focusedInside, "focus should be trapped inside the open dialog").toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.locator(".truehide-modal-overlay")).toBeHidden();
    await expect(page.locator("#flattenButton")).toBeEnabled();
  });

  test("TrueCrop: toolbar controls reachable by Tab only", async ({ page }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles('input[type="file"]', BLANK);
    await expect(page.locator("#imageCanvas")).toBeVisible();

    // cropButton is disabled (and therefore out of the tab order) until a
    // selection exists, so create one first.
    const box = await page.locator("#selectionCanvas").boundingBox();
    const sx = box.x + box.width * 0.2;
    const sy = box.y + box.height * 0.2;
    const ex = box.x + box.width * 0.8;
    const ey = box.y + box.height * 0.8;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 3 });
    await page.mouse.move(ex, ey, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator("#cropButton")).toBeEnabled();

    for (const id of ["resetButton", "cropButton", "exportFilename"]) {
      const steps = await tabUntil(page, id);
      expect(steps, `${id} should be reachable via Tab`).not.toBeNull();
    }
  });

  test("TrueBlur: settings and actions reachable by Tab only", async ({ page }) => {
    await page.goto("/app/trueblur/");
    await page.setInputFiles('input[type="file"]', BLANK);
    await expect(page.locator("#imageCanvas")).toBeVisible();

    // applyButton is disabled (out of the tab order) until a selection exists.
    const box = await page.locator("#selectionCanvas").boundingBox();
    const sx = box.x + box.width * 0.2;
    const sy = box.y + box.height * 0.2;
    const ex = box.x + box.width * 0.8;
    const ey = box.y + box.height * 0.8;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 3 });
    await page.mouse.move(ex, ey, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator("#applyButton")).toBeEnabled();

    for (const id of ["effect", "applyButton", "downloadButton", "exportFilename"]) {
      const steps = await tabUntil(page, id);
      expect(steps, `${id} should be reachable via Tab`).not.toBeNull();
    }
  });

  test("shortcut help dialog opens and closes with the keyboard", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.evaluate(() => window.TrueHide.showShortcutHelp());
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".truehide-modal-overlay")).toBeHidden();
  });
});

test.describe("Accessibility — screen reader practical checks", () => {
  /**
   * Collect accessible names the way a screen reader would compute them:
   * aria-label → <label for> → (button) text content. Every control in the
   * list must yield a non-empty name.
   */
  async function accessibleNames(page, ids) {
    return page.evaluate((idList) => {
      return idList.map((id) => {
        const el = document.getElementById(id);
        if (!el) return { id, name: null, present: false };
        const aria = el.getAttribute("aria-label");
        if (aria) return { id, name: aria, present: true };
        if (el.labels?.length) return { id, name: el.labels[0].textContent.trim(), present: true };
        if (el.tagName === "BUTTON") return { id, name: el.textContent.trim(), present: true };
        return { id, name: null, present: true };
      });
    }, ids);
  }

  test("every interactive control on all three apps has an accessible name", async ({ page, context }) => {
    const cases = [
      {
        url: "/app/trueflatten/",
        ids: ["pdfInput", "exportFilename", "previousPage", "nextPage", "clearPage", "flattenButton"],
      },
      {
        url: "/app/truecrop/",
        ids: [
          "imageInput",
          "format",
          "resetButton",
          "undoButton",
          "redoButton",
          "clearButton",
          "cropButton",
          "exportFilename",
        ],
      },
      {
        url: "/app/trueblur/",
        ids: [
          "imageInput",
          "effect",
          "paintEffect",
          "brushSize",
          "blockSize",
          "variation",
          "falsepixelPixelSize",
          "falsepixelGradientSections",
          "undoButton",
          "redoButton",
          "resetButton",
          "clearSelection",
          "applyButton",
          "downloadButton",
          "exportFilename",
        ],
      },
    ];

    for (const { url, ids } of cases) {
      const probe = await context.newPage();
      await probe.goto(url);
      const results = await accessibleNames(probe, ids);
      const unnamed = results.filter((r) => !r.name || !r.name.length);
      expect(
        unnamed,
        `controls without accessible names on ${url}: ${JSON.stringify(unnamed)}`,
      ).toHaveLength(0);
      await probe.close();
    }
  });

  test("canvas previews expose a role and label for screen readers", async ({ page, context }) => {
    const checks = [
      { url: "/app/trueflatten/", id: "pdfCanvas" },
      { url: "/app/truecrop/", id: "imageCanvas" },
      { url: "/app/trueblur/", id: "imageCanvas" },
    ];

    for (const { url, id } of checks) {
      const probe = await context.newPage();
      await probe.goto(url);
      const info = await probe.evaluate((canvasId) => {
        const el = document.getElementById(canvasId);
        return {
          role: el?.getAttribute("role"),
          label: el?.getAttribute("aria-label"),
        };
      }, id);
      expect(info.role, `${url} #${id} should have an ARIA role`).toBe("img");
      expect(info.label?.length, `${url} #${id} should have an ARIA label`).toBeGreaterThan(0);
      await probe.close();
    }
  });
});
