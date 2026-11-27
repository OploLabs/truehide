import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers: build metadata-tagged images in-memory (no new fixtures needed).
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Little-endian TIFF with IFD0 (Model, Software, ExifIFD pointer) and an
// Exif sub-IFD carrying ISO — built in-page by canvasJpeg(page, true).

// Render a small JPEG via canvas inside the page and return it base64-encoded.
async function canvasJpeg(page, tagged) {
  const b64 = await page.evaluate(async (withTags) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#3f6fd8";
    ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = "#e9c1c8";
    ctx.fillRect(8, 8, 20, 20);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (!withTags) {
      let s = "";
      for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    }
    // Splice APP1 EXIF + COM after SOI (FFD8).
    const tiff = new Uint8Array(89);
    const model = new TextEncoder().encode("TestCam1\0");
    const software = new TextEncoder().encode("TrueHideTest\0");
    tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const dv = new DataView(tiff.buffer);
    dv.setUint16(8, 3, true);
    let p = 10;
    const entry = (tag, type, count, val) => {
      dv.setUint16(p, tag, true);
      dv.setUint16(p + 2, type, true);
      dv.setUint32(p + 4, count, true);
      dv.setUint32(p + 8, val, true);
      p += 12;
    };
    entry(0x0110, 2, model.length, 50);
    entry(0x0131, 2, software.length, 58);
    entry(0x8769, 4, 1, 71);
    dv.setUint32(p, 0, true);
    tiff.set(model, 50);
    tiff.set(software, 58);
    dv.setUint16(71, 1, true);
    dv.setUint16(73, 0x8827, true);
    dv.setUint16(75, 3, true);
    dv.setUint32(77, 1, true);
    dv.setUint16(81, 400, true);
    dv.setUint32(85, 0, true);

    const seg = (marker, payload) => {
      const out = new Uint8Array(4 + payload.length);
      out[0] = 0xff;
      out[1] = marker;
      out[2] = ((payload.length + 2) >> 8) & 0xff;
      out[3] = (payload.length + 2) & 0xff;
      out.set(payload, 4);
      return out;
    };
    const exifPayload = new Uint8Array(6 + tiff.length);
    exifPayload.set(new TextEncoder().encode("Exif\0\0"), 0);
    exifPayload.set(tiff, 6);
    const com = new TextEncoder().encode("secret-comment");
    const parts = [buf.subarray(0, 2), seg(0xe1, exifPayload), seg(0xfe, com), buf.subarray(2)];
    let total = 0;
    for (const pt of parts) total += pt.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const pt of parts) { out.set(pt, o); o += pt.length; }
    let s = "";
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  }, tagged);
  return Buffer.from(b64, "base64");
}

// Big-endian (MM) TIFF with an IFD0 and an Exif sub-IFD carrying ISO.
// Real cameras (Sony, Canon, Nikon) write big-endian EXIF; this guards the
// byte-order path that a little-endian-only fixture would never exercise.
async function canvasJpegBigEndian(page, tagged) {
  const b64 = await page.evaluate(async (withTags) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#3f6fd8";
    ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = "#e9c1c8";
    ctx.fillRect(8, 8, 20, 20);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (!withTags) {
      let s = "";
      for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    }
    // Splice APP1 EXIF + COM after SOI (FFD8) with big-endian TIFF.
    const tiff = new Uint8Array(89);
    const model = new TextEncoder().encode("BigCam2\0");
    const software = new TextEncoder().encode("TrueHideTest\0");
    tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]); // MM, big-endian
    const dv = new DataView(tiff.buffer);
    dv.setUint16(8, 3, false);
    let p = 10;
    const entry = (tag, type, count, val) => {
      dv.setUint16(p, tag, false);
      dv.setUint16(p + 2, type, false);
      dv.setUint32(p + 4, count, false);
      dv.setUint32(p + 8, val, false);
      p += 12;
    };
    entry(0x0110, 2, model.length, 50);
    entry(0x0131, 2, software.length, 58);
    entry(0x8769, 4, 1, 71);
    dv.setUint32(p, 0, false);
    tiff.set(model, 50);
    tiff.set(software, 58);
    dv.setUint16(71, 1, false);
    dv.setUint16(73, 0x8827, false);
    dv.setUint16(75, 3, false);
    dv.setUint32(77, 1, false);
    dv.setUint16(81, 400, false);
    dv.setUint32(85, 0, false);

    const seg = (marker, payload) => {
      const out = new Uint8Array(4 + payload.length);
      out[0] = 0xff;
      out[1] = marker;
      out[2] = ((payload.length + 2) >> 8) & 0xff;
      out[3] = (payload.length + 2) & 0xff;
      out.set(payload, 4);
      return out;
    };
    const exifPayload = new Uint8Array(6 + tiff.length);
    exifPayload.set(new TextEncoder().encode("Exif\0\0"), 0);
    exifPayload.set(tiff, 6);
    const com = new TextEncoder().encode("secret-comment");
    const parts = [buf.subarray(0, 2), seg(0xe1, exifPayload), seg(0xfe, com), buf.subarray(2)];
    let total = 0;
    for (const pt of parts) total += pt.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const pt of parts) { out.set(pt, o); o += pt.length; }
    let s = "";
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  }, tagged);
  return Buffer.from(b64, "base64");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("TrueMetadata — viewer and verified removal", () => {
  test("JPEG with EXIF: fields shown, removal verified, download is clean", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    const jpeg = await canvasJpeg(page, true);
    await page.setInputFiles('input[type="file"]', {
      name: "photo.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(page.locator("#fileName")).toHaveText("photo.jpg");
    await expect(page.locator("#beforeCount")).toContainText("fields found");
    await expect(page.locator("#beforeTables")).toContainText("TestCam1");
    await expect(page.locator("#beforeTables")).toContainText("400");
    await expect(page.locator("#removeButton")).toBeEnabled();

    await page.click("#removeButton");

    await expect(page.locator("#afterPanel")).toBeVisible();
    await expect(page.locator("#afterSummary")).toContainText("Verified clean");
    await expect(page.locator("#statusChipText")).toHaveText("Clean · verified");

    const downloadPromise = page.waitForEvent("download");
    await page.click("#downloadButton");
    await page.click("#dlConfirm");
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("photo-clean.jpg");

    const outPath = path.join(os.tmpdir(), "truehide-meta-" + Date.now() + ".jpg");
    await download.saveAs(outPath);
    const out = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);

    // Byte-level assertions on the exported file.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    const text = out.toString("latin1");
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("TestCam1");
    expect(text).not.toContain("TrueHideTest");
    expect(text).not.toContain("secret-comment");
    // Pixel data must survive (JFIF APP0 header kept, scan present).
    expect(text).toContain("JFIF");
  });

  test("JPEG with big-endian (MM) EXIF: fields shown and removal verified", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    const jpeg = await canvasJpegBigEndian(page, true);
    await page.setInputFiles('input[type="file"]', {
      name: "camera.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(page.locator("#fileName")).toHaveText("camera.jpg");
    await expect(page.locator("#beforeCount")).toContainText("fields found");
    await expect(page.locator("#beforeTables")).toContainText("BigCam2");
    await expect(page.locator("#beforeTables")).toContainText("400");
    await expect(page.locator("#removeButton")).toBeEnabled();

    await page.click("#removeButton");

    await expect(page.locator("#afterPanel")).toBeVisible();
    await expect(page.locator("#afterSummary")).toContainText("Verified clean");
    await expect(page.locator("#statusChipText")).toHaveText("Clean · verified");

    const downloadPromise = page.waitForEvent("download");
    await page.click("#downloadButton");
    await page.click("#dlConfirm");
    const download = await downloadPromise;
    const outPath = path.join(os.tmpdir(), "truehide-meta-" + Date.now() + ".jpg");
    await download.saveAs(outPath);
    const out = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);

    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    const text = out.toString("latin1");
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("BigCam2");
    expect(text).toContain("JFIF");
  });

  test("already-clean JPEG reports no metadata and cannot be 'removed'", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    const jpeg = await canvasJpeg(page, false);
    await page.setInputFiles('input[type="file"]', {
      name: "plain.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(page.locator("#statusChipText")).toHaveText("No metadata found");
    await expect(page.locator("#removeButton")).toBeDisabled();
    await expect(page.locator("#beforeTables")).toContainText("no readable metadata");
  });

  test("PNG with a tEXt chunk is stripped and dimensions stay", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    const pngB64 = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 24;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#74aa9c";
      ctx.fillRect(0, 0, 32, 24);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    });
    const png = Buffer.from(pngB64, "base64");
    const text = Buffer.concat([Buffer.from("Software\0", "binary"), Buffer.from("EvilEditor 1.0", "binary")]);
    const tagged = Buffer.concat([png.subarray(0, 33), chunk("tEXt", text), png.subarray(33)]);

    await page.setInputFiles('input[type="file"]', {
      name: "shot.png",
      mimeType: "image/png",
      buffer: tagged,
    });

    await expect(page.locator("#beforeTables")).toContainText("EvilEditor 1.0");
    await page.click("#removeButton");
    await expect(page.locator("#afterSummary")).toContainText("Verified clean");
    await expect(page.locator("#fileSpecs")).toContainText("32×24");

    const downloadPromise = page.waitForEvent("download");
    await page.click("#downloadButton");
    await page.click("#dlConfirm");
    const download = await downloadPromise;
    const outPath = path.join(os.tmpdir(), "truehide-meta-" + Date.now() + ".png");
    await download.saveAs(outPath);
    const out = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);

    expect(out.toString("latin1")).not.toContain("EvilEditor");
    expect(out.toString("latin1")).not.toContain("tEXt");
    expect(out.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  test("unsupported files are clearly refused, never pretended clean", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    await page.setInputFiles('input[type="file"]', {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("just some notes, not an image"),
    });

    await expect(page.locator("#formatNotice")).toBeVisible();
    await expect(page.locator("#statusChipText")).toHaveText("Unsupported format");
    await expect(page.locator("#metaPanels")).toBeHidden();
    await expect(page.locator("#downloadButton")).toBeHidden();
  });
});
