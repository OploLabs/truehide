import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const MULTI = path.resolve("test/fixtures/multi.pdf");
const SECRET = path.resolve("test/fixtures/secret.pdf");
const CORRUPT = path.resolve("test/fixtures/corrupt.pdf");
const OUT_DIR = path.resolve("test/tmp");

/** Per-page secret text (must exist in the source, be absent from exports). */
const PAGE_TEXTS = {
  1: "MULTI-P1-SECRET-ALPHA",
  2: "MULTI-P2-SECRET-BRAVO",
  3: "MULTI-P3-SECRET-CHARLIE",
};

/**
 * Structural markers: annotations, embedded files, AcroForm values, XMP and
 * Info metadata. A true redaction (rasterization) export must drop all of
 * these — they exist in the source and must NOT survive in the export.
 */
const STRUCTURAL_MARKERS = [
  "ANNOT-TEXT-MARKER-77",
  "EMBEDDED-ATTACHMENT-MARKER-2026",
  "FORM-VALUE-MARKER-31337",
  "XMP-TITLE-MARKER-99",
  "INFO-TITLE-MARKER-555",
];

const ALL_MARKERS = [...Object.values(PAGE_TEXTS), ...STRUCTURAL_MARKERS];

/**
 * multi.pdf's text lines start at 72pt/792pt ≈ 0.09 from the top, two lines
 * of 28pt. This rectangle covers every page's text block.
 */
const RECT = { x1: 0.08, y1: 0.05, x2: 0.95, y2: 0.35 };

/** Scroll the PDF canvas near the top of the viewport (drag coordinate fix). */
async function scrollCanvasToTop(page) {
  await page.evaluate(() => {
    const c = document.getElementById("pdfCanvas");
    const top = c.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 20));
  });
}

/** Drag one redaction rectangle over the currently rendered page. */
async function dragRedaction(page, rect = RECT) {
  await scrollCanvasToTop(page);
  const box = await page.locator("#pdfCanvas").boundingBox();
  const sx = box.x + box.width * rect.x1;
  const sy = box.y + box.height * rect.y1;
  const ex = box.x + box.width * rect.x2;
  const ey = box.y + box.height * rect.y2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 });
  await page.mouse.move(ex, ey, { steps: 4 });
  await page.mouse.up();
}

/** Open the export modal and confirm the flatten+download. */
async function flattenDownload(page) {
  await page.click("#flattenButton");
  await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.click("#dlConfirm"),
  ]);
  return download;
}

/**
 * Re-open the exported bytes in-page with pdf.js: page count, extracted text,
 * and darkness of the redaction band on a given page.
 */
async function inspectExport(page, raw, band) {
  const b64 = raw.toString("base64");
  return page.evaluate(
    async (args) => {
      const { b64Str, band } = args;
      const bin = atob(b64Str);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        text += tc.items.map((it) => it.str).join(" ") + "\n";
      }

      const pageObj = await pdf.getPage(band.page);
      const viewport = pageObj.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pageObj.render({ canvasContext: ctx, viewport }).promise;

      const x0 = Math.floor(canvas.width * band.x0);
      const x1 = Math.floor(canvas.width * band.x1);
      const y0 = Math.floor(canvas.height * band.y0);
      const y1 = Math.floor(canvas.height * band.y1);
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
      }
      return { numPages: pdf.numPages, text, darkRatio: dark / (d.length / 4) };
    },
    { b64Str: b64, band },
  );
}

test.describe("TrueFlatten — multi-page, annotations, forms, embedded files, metadata", () => {
  test.setTimeout(180_000);

  test("source multi.pdf exposes per-page text and structural markers", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    const check = await page.evaluate(async () => {
      const buf = await (await fetch("/test/fixtures/multi.pdf")).arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const textByPage = {};
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        textByPage[i] = tc.items.map((it) => it.str).join(" ");
      }
      const meta = await pdf.getMetadata();
      const xmp =
        typeof meta.metadata?.getRaw === "function" ? meta.metadata.getRaw() : meta.metadata || "";
      return {
        numPages: pdf.numPages,
        textByPage,
        info: meta.info || {},
        xmp,
      };
    });

    expect(check.numPages).toBe(3);
    for (const [pageNo, marker] of Object.entries(PAGE_TEXTS)) {
      expect(
        check.textByPage[Number(pageNo)],
        `page ${pageNo} should contain "${marker}"`,
      ).toContain(marker);
    }
    // Structural markers live in the raw file (annotations / forms / XMP / Info).
    const raw = readFileSync(MULTI).toString("latin1");
    for (const marker of STRUCTURAL_MARKERS) {
      expect(raw, `fixture should contain "${marker}"`).toContain(marker);
    }
    expect(check.xmp).toContain("XMP-TITLE-MARKER-99");
    expect(JSON.stringify(check.info)).toContain("INFO-TITLE-MARKER-555");
  });

  test("multi-page redactions: pages preserved, bands redacted, every marker gone from the export", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', MULTI);
    await expect(page.locator("#pdfCanvas")).toBeVisible();
    await expect(page.locator("#pageCount")).toHaveText("Page 1 / 3");

    // Redact the text band on all three pages.
    await dragRedaction(page);
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(1);

    await page.click("#nextPage");
    await expect(page.locator("#pageCount")).toHaveText("Page 2 / 3");
    await dragRedaction(page);
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(1);

    await page.click("#nextPage");
    await expect(page.locator("#pageCount")).toHaveText("Page 3 / 3");
    await dragRedaction(page);
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(1);

    const download = await flattenDownload(page);
    expect(download.suggestedFilename()).toBe("multi-redacted.pdf");

    mkdirSync(OUT_DIR, { recursive: true });
    const exportPath = path.join(OUT_DIR, "multi-redacted-export.pdf");
    await download.saveAs(exportPath);
    const raw = readFileSync(exportPath);

    // Raw bytes: valid jsPDF output, no marker survived in any form.
    expect(raw.subarray(0, 5).toString()).toBe("%PDF-");
    expect(raw.toString("latin1")).toContain("jsPDF");
    const rawText = raw.toString("latin1");
    for (const marker of ALL_MARKERS) {
      expect(rawText, `export bytes contain "${marker}"`).not.toContain(marker);
    }

    // Structural check on the actual downloaded file: 3 pages, no selectable
    // text, and each redaction band rendered black.
    for (const pageNo of [1, 2, 3]) {
      const check = await inspectExport(
        page,
        raw,
        { page: pageNo, x0: 0.25, x1: 0.75, y0: 0.13, y1: 0.2 },
      );
      expect(check.numPages, `export should keep 3 pages (band check p${pageNo})`).toBe(3);
      expect(
        check.text.trim().length,
        "rasterized export has no selectable text layer",
      ).toBeLessThan(5);
      for (const marker of ALL_MARKERS) {
        expect(check.text, `extractable "${marker}" on p${pageNo}`).not.toContain(marker);
      }
      expect(
        check.darkRatio,
        `redaction band on page ${pageNo} should be black`,
      ).toBeGreaterThan(0.8);
    }
  });
});

test.describe("TrueFlatten — undo / redo (keyboard)", () => {
  test.setTimeout(120_000);

  test("adding a redaction can be undone and redone with Ctrl+Z / Ctrl+Y", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();

    const layer = page.locator("#redactionLayer .redaction");

    await dragRedaction(page);
    await expect(layer).toHaveCount(1);

    await page.keyboard.press("Control+z");
    await expect(layer).toHaveCount(0);

    await page.keyboard.press("Control+y");
    await expect(layer).toHaveCount(1);

    await page.keyboard.press("Control+z");
    await expect(layer).toHaveCount(0);
  });

  test("deleting a redaction via the popover is undoable", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();

    const layer = page.locator("#redactionLayer .redaction");
    await dragRedaction(page);
    await expect(layer).toHaveCount(1);

    // Click the redaction to open its popover, then delete it.
    await layer.first().click();
    await page.click(".redaction-popover button", { timeout: 10_000 });
    await expect(layer).toHaveCount(0);

    await page.keyboard.press("Control+z");
    await expect(layer).toHaveCount(1);
  });

  test("clearing a page is undoable", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();

    const layer = page.locator("#redactionLayer .redaction");
    // Two non-overlapping rectangles: starting a second drag inside an
    // existing redaction moves it instead of adding a new one.
    await dragRedaction(page, { x1: 0.08, y1: 0.05, x2: 0.5, y2: 0.3 });
    await dragRedaction(page, { x1: 0.55, y1: 0.05, x2: 0.95, y2: 0.3 });
    await expect(layer).toHaveCount(2);

    await page.click("#clearPage");
    await expect(layer).toHaveCount(0);

    await page.keyboard.press("Control+z");
    await expect(layer).toHaveCount(2);
  });
});

test.describe("TrueFlatten — document replacement and error handling", () => {
  test.setTimeout(120_000);

  test("replacing a loaded document resets redaction and undo state", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();

    await dragRedaction(page);
    expect(await page.locator("#redactionLayer .redaction").count()).toBe(1);

    // Load a different document: the old one is destroyed and its state
    // (redactions + undo history) must not leak into the new document.
    await page.setInputFiles('input[type="file"]', MULTI);
    await expect(page.locator("#pageCount")).toHaveText("Page 1 / 3");
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(0);

    // Undo history is empty for the new document.
    await page.keyboard.press("Control+z");
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(0);

    expect(pageErrors, `unexpected page errors: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("replacing with a corrupt PDF returns the viewer to the empty state", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', SECRET);
    await expect(page.locator("#flattenButton")).toBeEnabled();

    await page.setInputFiles('input[type="file"]', CORRUPT);
    await expect(page.locator(".toast", { hasText: "Could not open this PDF" })).toBeVisible();
    await expect(page.locator("#emptyState")).toBeVisible();
    await expect(page.locator("#flattenButton")).toBeDisabled();
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(0);
  });

  test("corrupt PDF rejected with a friendly error", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles('input[type="file"]', CORRUPT);
    await expect(page.locator(".toast", { hasText: "Could not open this PDF" })).toBeVisible();
    await expect(page.locator("#emptyState")).toBeVisible();
    await expect(page.locator("#flattenButton")).toBeDisabled();
  });
});
