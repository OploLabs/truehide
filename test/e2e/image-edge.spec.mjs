import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const FIX = (name) => path.resolve("test/fixtures", name);
const OUT_DIR = path.resolve("test/tmp");

/** Drag a selection across an image tool's display canvas. */
async function dragSelection(page, x1, y1, x2, y2) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.locator("#selectionCanvas").boundingBox();
  const sx = box.x + box.width * x1;
  const sy = box.y + box.height * y1;
  const ex = box.x + box.width * x2;
  const ey = box.y + box.height * y2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 });
  await page.mouse.move(ex, ey, { steps: 4 });
  await page.mouse.up();
}

/** PNG IHDR color type (offset 25): 6 = RGBA. */
function pngColorType(buf) {
  return buf[25];
}

test.describe("TrueCrop — transparency, large images, unusual formats", () => {
  test.setTimeout(120_000);

  test("transparency is preserved in a PNG export", async ({ page }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles('input[type="file"]', FIX("transparent.png"));
    await expect(page.locator("#sourceDimensions")).toContainText("128 × 128");

    // Select the fully transparent right half of the fixture.
    await dragSelection(page, 0.55, 0.1, 0.95, 0.9);
    await expect(page.locator("#cropButton")).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#cropButton"),
    ]);
    expect(download.suggestedFilename()).toBe("transparent-cropped.png");

    mkdirSync(OUT_DIR, { recursive: true });
    const savedPath = path.join(OUT_DIR, "crop-transparent-export.png");
    await download.saveAs(savedPath);
    const raw = readFileSync(savedPath);

    // Valid RGBA PNG.
    expect(raw.subarray(1, 4).toString()).toBe("PNG");
    expect(pngColorType(raw), "PNG color type must be 6 (RGBA)").toBe(6);

    // The exported pixels themselves must be transparent.
    const check = await page.evaluate(async (b64Str) => {
      const bin = atob(b64Str);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
      ).data;
      return { w: bitmap.width, h: bitmap.height, alpha: d[3] };
    }, raw.toString("base64"));

    expect(check.w).toBeGreaterThanOrEqual(40);
    expect(check.alpha, "cropped region of the transparent half must be alpha 0").toBe(0);
  });

  test("large image (1024×640) loads, reports dimensions, and exports at the reported size", async ({ page }) => {
    // The 1024×640 display canvas plus the toolbars needs a tall viewport so
    // every synthetic pointer coordinate lands inside it (browsers don't
    // deliver synthetic pointer events outside the viewport).
    await page.setViewportSize({ width: 1280, height: 1500 });
    await page.goto("/app/truecrop/");
    await page.setInputFiles('input[type="file"]', FIX("large.png"));
    await expect(page.locator("#sourceDimensions")).toContainText("1,024 × 640");

    // A central selection; the app reports the exact output size — verify the
    // exported bitmap matches it.
    await dragSelection(page, 0.35, 0.3, 0.65, 0.7);

    const reported = await page.locator("#outputDimensions").innerText();
    const m = reported.match(/([\d,]+)\s*×\s*([\d,]+)\s*px/);
    expect(m, `could not parse output dimensions from "${reported}"`).not.toBeNull();
    const expected = {
      w: Number(m[1].replace(/,/g, "")),
      h: Number(m[2].replace(/,/g, "")),
    };
    expect(expected.w).toBeGreaterThan(0);

    await page.selectOption("#format", "image/jpeg");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#cropButton"),
    ]);

    mkdirSync(OUT_DIR, { recursive: true });
    const savedPath = path.join(OUT_DIR, "crop-large-export.jpg");
    await download.saveAs(savedPath);
    const raw = readFileSync(savedPath);
    expect(raw[0]).toBe(0xff);
    expect(raw[1], "exported file must be a real JPEG").toBe(0xd8);

    const dims = await page.evaluate(async (b64Str) => {
      const bin = atob(b64Str);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      return { w: bitmap.width, h: bitmap.height };
    }, raw.toString("base64"));

    expect(dims.w, `expected ${expected.w}px wide`).toBe(expected.w);
    expect(dims.h, `expected ${expected.h}px tall`).toBe(expected.h);
  });

  test("WebP input is accepted by both image tools", async ({ page, context }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles('input[type="file"]', FIX("sample.webp"));
    await expect(page.locator("#imageCanvas")).toBeVisible();
    await expect(page.locator("#sourceDimensions")).toContainText("96 × 96");

    const blur = await context.newPage();
    await blur.goto("/app/trueblur/");
    await blur.setInputFiles('input[type="file"]', FIX("sample.webp"));
    await expect(blur.locator("#imageCanvas")).toBeVisible();
    await expect(blur.locator("#imageDimensions")).toContainText("96");
    await blur.close();
  });

  test("non-image files are rejected by both image tools", async ({ page, context }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles('input[type="file"]', FIX("notes.txt"));
    await expect(page.locator(".toast", { hasText: "Please select a valid image" })).toBeVisible();
    await expect(page.locator("#emptyState")).toBeVisible();

    const blur = await context.newPage();
    await blur.goto("/app/trueblur/");
    await blur.setInputFiles('input[type="file"]', FIX("notes.txt"));
    await expect(blur.locator(".toast", { hasText: "Please select a valid image" })).toBeVisible();
    await expect(blur.locator("#emptyState")).toBeVisible();
    await blur.close();
  });

  test("corrupt images fail gracefully in both tools", async ({ page, context }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles('input[type="file"]', FIX("corrupt.png"));
    await expect(page.locator(".toast", { hasText: "Could not load this image" })).toBeVisible();
    await expect(page.locator("#emptyState")).toBeVisible();

    const blur = await context.newPage();
    await blur.goto("/app/trueblur/");
    await blur.setInputFiles('input[type="file"]', FIX("corrupt.png"));
    await expect(blur.locator(".toast", { hasText: "Could not load this image" })).toBeVisible();
    await expect(blur.locator("#emptyState")).toBeVisible();
    await blur.close();
  });
});

test.describe("TrueBlur — undo / redo actually restores pixels", () => {
  test.setTimeout(120_000);

  /** Strided hash of the visible canvas pixels (changes when the effect hits). */
  async function pixelHash(page) {
    return page.evaluate(() => {
      const c = document.getElementById("imageCanvas");
      const d = c.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, c.width, c.height)
        .data;
      let h = 0;
      for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
      return h;
    });
  }

  test("solid black effect, then Ctrl+Z restores and Ctrl+Y reapplies", async ({ page }) => {
    await page.goto("/app/trueblur/");
    await page.setInputFiles('input[type="file"]', FIX("transparent.png"));
    await expect(page.locator("#imageCanvas")).toBeVisible();

    await page.selectOption("#effect", "solid");
    await dragSelection(page, 0.2, 0.2, 0.8, 0.8);
    await expect(page.locator("#applyButton")).toBeEnabled();

    const before = await pixelHash(page);
    await page.click("#applyButton");
    await expect(page.locator("#undoButton")).toBeEnabled();
    const after = await pixelHash(page);
    expect(after, "effect must change the pixels").not.toBe(before);

    await page.keyboard.press("Control+z");
    expect(await pixelHash(page), "undo must restore the original pixels").toBe(before);
    expect(await page.locator("#redoButton").isEnabled()).toBe(true);

    await page.keyboard.press("Control+y");
    expect(await pixelHash(page), "redo must reapply the effect").toBe(after);
    expect(await page.locator("#undoButton").isEnabled()).toBe(true);
  });
});
