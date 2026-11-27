import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SECRET = path.resolve("test/fixtures/secret.pdf");
const OUT_DIR = path.resolve("test/tmp");

/** Strings that must be extractable in the source and ABSENT in the export. */
const SECRETS = ["12345-6789", "CONFIDENTIAL", "000-12-3456", "1979-04-22"];

/**
 * Redaction rectangle in normalized page coordinates (top-left origin).
 * secret.pdf's text lines sit at y ≈ 0.12–0.19 (from top) and x ≈ 0.12–0.75,
 * so this rectangle fully covers every line.
 */
const RECT = { x1: 0.1, y1: 0.05, x2: 0.95, y2: 0.35 };

test.describe("TrueFlatten — PDF redaction verification", () => {
  test.setTimeout(180_000);

  test("secret text IS extractable from the source PDF", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    const text = await page.evaluate(async () => {
      const buf = await (await fetch("/test/fixtures/secret.pdf")).arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let all = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        all += tc.items.map((it) => it.str).join(" ") + "\n";
      }
      return all;
    });
    for (const s of SECRETS) {
      expect(text, `expected source PDF to contain "${s}"`).toContain(s);
    }
  });

  test("flattened export: no extractable secret text + redaction visible", async ({ page }) => {
    await page.goto("/app/trueflatten/");
    await page.setInputFiles("input[type=\"file\"]", SECRET);
    await expect(page.locator("#pdfCanvas")).toBeVisible();
    await expect(page.locator("#flattenButton")).toBeEnabled();

    // 1) Draw a redaction over the text block (move BEFORE down — pointerdown
    //    fires where the mouse was last moved).
    // Keep the entire drag path inside the viewport: Firefox mangles pointer
    // coordinates outside the visible area (events clamp to garbage values),
    // which silently drops the pointerup and creates no redaction. Pinning
    // the canvas top to the viewport top makes the drag fully on-screen.
    await page.evaluate(() => {
      const c = document.getElementById("pdfCanvas");
      const top = c.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - 20));
    });
    const box = await page.locator("#pdfCanvas").boundingBox();
    const sx = box.x + box.width * RECT.x1;
    const sy = box.y + box.height * RECT.y1;
    const ex = box.x + box.width * RECT.x2;
    const ey = box.y + box.height * RECT.y2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 });
    await page.mouse.move(ex, ey, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator("#redactionLayer .redaction")).toHaveCount(1);

    // 2) Two-step export: the confirmation modal must be confirmed.
    await page.click("#flattenButton");
    await expect(page.locator(".truehide-modal-overlay")).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      page.click("#flattenConfirm"),
    ]);
    expect(download.suggestedFilename()).toBe("secret-redacted.pdf");

    // 3) Raw bytes: valid PDF produced by jsPDF, no plaintext secrets inside.
    mkdirSync(OUT_DIR, { recursive: true });
    const exportPath = path.join(OUT_DIR, "redacted-export.pdf");
    await download.saveAs(exportPath);
    const raw = readFileSync(exportPath);
    expect(raw.subarray(0, 5).toString()).toBe("%PDF-");
    expect(raw.toString("latin1")).toContain("jsPDF");
    for (const s of SECRETS) {
      expect(raw.toString("latin1"), `plaintext secret "${s}" in export`).not.toContain(s);
    }

    // 4) Strong check: re-open the ACTUALLY DOWNLOADED file in-page with pdf.js,
    //    extract every text item, and render the page to verify the redaction.
    const b64 = raw.toString("base64");
    const check = await page.evaluate(async (b64Str) => {
      const bin = atob(b64Str);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        text += tc.items.map((it) => it.str).join(" ") + "\n";
      }

      // Render page 1 and sample the region covered by the redaction.
      const page1 = await pdf.getPage(1);
      const viewport = page1.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page1.render({ canvasContext: ctx, viewport }).promise;

      const x0 = Math.floor(canvas.width * 0.25);
      const x1 = Math.floor(canvas.width * 0.75);
      const y0 = Math.floor(canvas.height * 0.13);
      const y1 = Math.floor(canvas.height * 0.2);
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
      }
      return {
        numPages: pdf.numPages,
        text,
        darkRatio: dark / (d.length / 4),
      };
    }, b64);

    // No extractable text in the rasterized export, and no leaked secrets.
    for (const s of SECRETS) {
      expect(check.text, `extractable "${s}" in exported PDF`).not.toContain(s);
    }
    expect(
      check.text.trim().length,
      "rasterized export should contain no selectable text layer",
    ).toBeLessThan(5);

    // The redaction band renders black in the exported document itself.
    expect(
      check.darkRatio,
      "redaction region should be black in the exported PDF",
    ).toBeGreaterThan(0.8);
  });
});
