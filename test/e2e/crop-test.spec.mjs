import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const BLANK = path.resolve("test/fixtures/blank.png");
const OUT_DIR = path.resolve("test/tmp");

/**
 * Load the 64×64 fixture into TrueCrop.
 */
async function openBlankImage(page) {
  await page.goto("/app/truecrop/");
  await page.setInputFiles("input[type=\"file\"]", BLANK);
  await expect(page.locator("#imageCanvas")).toBeVisible();
}

/**
 * Drag a selection across the display canvas.
 *
 * Root cause of the earlier failures: Playwright dispatches `pointerdown` at
 * the location the mouse was LAST MOVED TO. Calling `mouse.down(x, y)` without
 * a prior `mouse.move(x, y)` fires pointerdown at (0,0) on <body>, so the
 * selection canvas never saw the gesture. Always move first.
 */
async function drawSelection(page) {
  const box = await page.locator("#selectionCanvas").boundingBox();
  const sx = box.x + box.width * 0.1;
  const sy = box.y + box.height * 0.1;
  const ex = box.x + box.width * 0.9;
  const ey = box.y + box.height * 0.9;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 3 });
  await page.mouse.move(ex, ey, { steps: 3 });
  await page.mouse.up();

  await expect(page.locator("#cropButton")).toBeEnabled({ timeout: 5000 });
}

/**
 * Parse the "N × M px" text shown in #outputDimensions.
 */
async function expectedOutputDims(page) {
  const text = await page.locator("#outputDimensions").textContent();
  const m = text.match(/([\d,]+)\s*×\s*([\d,]+)\s*px/);
  expect(m, `could not parse output dimensions from "${text}"`).not.toBeNull();
  return {
    width: Number(m[1].replace(/,/g, "")),
    height: Number(m[2].replace(/,/g, "")),
  };
}

function pngDimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

function isJpeg(buf) {
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function isWebp(buf) {
  return (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  );
}

/**
 * Decode any real image format (png/jpeg/webp) in the browser and return its
 * intrinsic dimensions.
 */
async function decodeInBrowser(page, buf, mime) {
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  return page.evaluate(
    async (src) => {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("could not decode image"));
        i.src = src;
      });
      return { width: img.naturalWidth, height: img.naturalHeight };
    },
    dataUrl,
  );
}

test.describe("TrueCrop — full flow", () => {
  test("loads an image and shows canvas", async ({ page }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles("input[type=\"file\"]", BLANK);
    await expect(page.locator("#imageCanvas")).toBeVisible();
  });

  test("has undo/redo buttons", async ({ page }) => {
    await page.goto("/app/truecrop/");
    await page.setInputFiles("input[type=\"file\"]", BLANK);
    await page.waitForSelector("#imageCanvas", { state: "visible" });
    await expect(page.locator("#undoButton")).toBeVisible();
    await expect(page.locator("#redoButton")).toBeVisible();
  });

  test("keyboard shortcut Ctrl+Z triggers undo without breaking the app", async ({ page }) => {
    await openBlankImage(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    // With an empty undo stack this is a no-op; the app must stay usable.
    await expect(page.locator("#imageCanvas")).toBeVisible();
  });

  test("exports a PNG containing the expected crop", async ({ page }) => {
    await openBlankImage(page);
    await drawSelection(page);

    const expected = await expectedOutputDims(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await page.click("#cropButton");
        await page.click("#dlConfirm");
      })(),
    ]);

    expect(download.suggestedFilename()).toBe("blank-cropped.png");

    mkdirSync(OUT_DIR, { recursive: true });
    const savedPath = path.join(OUT_DIR, "crop-png-export.png");
    await download.saveAs(savedPath);
    const buf = readFileSync(savedPath);

    // 1) The file is a valid PNG.
    const dims = pngDimensions(buf);
    expect(dims, "exported file is not a valid PNG").not.toBeNull();

    // 2) The crop dimensions match exactly what the app reported.
    expect(dims.width).toBe(expected.width);
    expect(dims.height).toBe(expected.height);
  });

  test("exports a JPEG containing the expected crop", async ({ page }) => {
    await openBlankImage(page);
    await page.selectOption("#format", "image/jpeg");
    await drawSelection(page);

    const expected = await expectedOutputDims(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await page.click("#cropButton");
        await page.click("#dlConfirm");
      })(),
    ]);

    expect(download.suggestedFilename()).toBe("blank-cropped.jpg");

    mkdirSync(OUT_DIR, { recursive: true });
    const savedPath = path.join(OUT_DIR, "crop-jpeg-export.jpg");
    await download.saveAs(savedPath);
    const buf = readFileSync(savedPath);

    // 1) The file is a valid JPEG (SOI marker + decodable).
    expect(isJpeg(buf), "exported file is not a valid JPEG").toBe(true);
    const dims = await decodeInBrowser(page, buf, "image/jpeg");

    // 2) The crop dimensions match exactly what the app reported.
    expect(dims.width).toBe(expected.width);
    expect(dims.height).toBe(expected.height);
  });

  test("WebP export (or documented PNG fallback) contains the expected crop", async ({ page, browserName }) => {
    await openBlankImage(page);
    await page.selectOption("#format", "image/webp");
    await drawSelection(page);

    const expected = await expectedOutputDims(page);

    if (browserName === "firefox") {
      // Firefox limitation (Playwright's Juggler): image/webp blob downloads
      // never surface as `download` events (PNG/JPEG do), and letting the
      // browser run its WebP blob download can even close the tab. So on
      // Firefox we verify the export by capturing the blob the app hands to
      // URL.createObjectURL and blocking the download trigger — the captured
      // bytes are exactly what the download would have contained.
      await page.evaluate(() => {
        window.__cropCapture = null;
        const origCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          window.__cropCapture = { blob, filename: null };
          return origCreate(blob);
        };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download && this.href && this.href.startsWith("blob:")) {
            if (window.__cropCapture) window.__cropCapture.filename = this.download;
            return; // keep the tab alive; the download pipeline is broken for WebP blobs
          }
          return origClick.call(this);
        };
      });

      await page.click("#cropButton");
      await page.click("#dlConfirm");
      await page.waitForFunction(
        () => window.__cropCapture !== null,
        null,
        { timeout: 15_000 },
      );

      // Pull the exported bytes out of the page and decode them in-page.
      const exported = await page.evaluate(async () => {
        const { blob, filename } = window.__cropCapture;
        const buf = new Uint8Array(await blob.arrayBuffer());
        const b64 = (() => {
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          }
          return btoa(bin);
        })();
        const bmp = await createImageBitmap(blob);
        return { mime: blob.type, size: buf.length, base64: b64, filename, width: bmp.width, height: bmp.height };
      });

      // The app falls back to PNG when the browser cannot encode WebP.
      expect(["image/webp", "image/png"]).toContain(exported.mime);

      mkdirSync(OUT_DIR, { recursive: true });
      const savedPath = path.join(OUT_DIR, `crop-webp-export.${exported.mime === "image/webp" ? "webp" : "png"}`);
      writeFileSync(savedPath, Buffer.from(exported.base64, "base64"));
      const buf = readFileSync(savedPath);
      if (exported.mime === "image/webp") {
        expect(isWebp(buf), "exported blob is not a valid WebP").toBe(true);
      } else {
        expect(pngDimensions(buf), "exported blob is not a valid PNG").not.toBeNull();
      }
      expect(exported.filename?.endsWith(exported.mime === "image/webp" ? ".webp" : ".png")).toBe(true);

      // The crop dimensions match exactly what the app reported.
      expect(exported.width).toBe(expected.width);
      expect(exported.height).toBe(expected.height);
      return;
    }

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await page.click("#cropButton");
        await page.click("#dlConfirm");
      })(),
    ]);

    // The app falls back to PNG when the browser cannot encode WebP.
    const fname = download.suggestedFilename();
    const ext = fname.split(".").pop();
    expect(["webp", "png"]).toContain(ext);

    mkdirSync(OUT_DIR, { recursive: true });
    const savedPath = path.join(OUT_DIR, `crop-webp-export.${ext}`);
    await download.saveAs(savedPath);
    const buf = readFileSync(savedPath);

    if (ext === "webp") {
      expect(isWebp(buf), "exported file is not a valid WebP").toBe(true);
    }

    const mime = ext === "webp" ? "image/webp" : "image/png";
    const dims = await decodeInBrowser(page, buf, mime);

    expect(dims.width).toBe(expected.width);
    expect(dims.height).toBe(expected.height);
  });
});
