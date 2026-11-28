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

// JPEG structural segment builders for the scan-data regression tests.
// A segment is FF <marker> <len BE> <payload>; len includes the two
// length bytes. Entropy-coded scan data is NOT a segment — raw bytes
// follow the SOS header and are appended as-is, never wrapped.
function seg(marker, payload) {
  if (payload == null || payload.length === undefined) {
    throw new Error("seg() called without a payload");
  }
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(payload.length + 2, 2);
  payload.copy(out, 4);
  return out;
}

// Synthetic scan data: a fill byte with 0xFF 0x00 byte-stuffing and
// RST restart markers patched in at the given positions.
function scanWithStuffing(length, fill, patches) {
  const buf = Buffer.alloc(length, fill);
  for (const [idx, code] of patches) {
    buf[idx] = 0xff;
    buf[idx + 1] = code;
  }
  return buf;
}

const JFIF = Buffer.from([0, 0, 0x4a, 0x46, 0x49, 0x46, 0, 0, 1, 1, 0, 0, 0, 0]);

const DQT_PAYLOAD = (() => {
  const p = Buffer.alloc(65);
  p[0] = 0x00;
  p.fill(0x10, 1);
  return p;
})();

// 48×64, 3-component SOF payload (identical layout for SOF0/SOF2).
const SOF = Buffer.from([
  0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01,
  0x03, 0x11, 0x01,
]);

const DHT_PAYLOAD = (() => {
  const p = Buffer.alloc(0x74);
  p[0] = 0x00;
  for (let i = 0; i < 16; i++) p[1 + i] = 1;
  for (let i = 17; i < 33; i++) p[i] = 0x01;
  return p;
})();

const SOS1 = Buffer.from([0x03, 0x01, 0x00, 0x00, 0x01, 0x05, 0x3f, 0x00]);
const SOS2 = Buffer.from([0x03, 0x01, 0x00, 0x00, 0x02, 0x11, 0x3f, 0x00]);

// Real little-endian EXIF APP1 block: IFD0 with camera make and model.
// Produces two recognized metadata fields ("Camera make", "Camera model").
function makeExifApp1() {
  const make = Buffer.from("TESTCAM\0", "latin1");
  const model = Buffer.from("TESTLAP\0", "latin1");
  const tiff = Buffer.alloc(8 + 2 + 24 + 4 + make.length + model.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
  tiff.writeUInt16LE(2, 8); // two IFD0 entries
  const e1 = 10;
  tiff.writeUInt16LE(0x010f, e1); // Make
  tiff.writeUInt16LE(2, e1 + 2); // ASCII
  tiff.writeUInt32LE(8, e1 + 4);
  tiff.writeUInt32LE(38, e1 + 8);
  const e2 = 22;
  tiff.writeUInt16LE(0x0110, e2); // Model
  tiff.writeUInt16LE(2, e2 + 2);
  tiff.writeUInt32LE(8, e2 + 4);
  tiff.writeUInt32LE(46, e2 + 8);
  tiff.writeUInt32LE(0, 34); // no next IFD
  tiff.set(make, 38);
  tiff.set(model, 46);
  const payload = Buffer.alloc(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0); // "Exif\0\0"
  payload.set(tiff, 6);
  return payload;
}

// APP1 XMP block; the dc:creator field is recognized by the parser.
const XMP_APP1 = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\u003Cx:xmpmeta\u003E\u003Cdc:creator xmlns:dc="http://purl.org/dc/elements/1.1/"\u003E\u003Crdf:Seq\u003E\u003Crdf:li\u003ESECRET-XMP\u003C/rdf:li\u003E\u003C/rdf:Seq\u003E\u003C/dc:creator\u003E\u003C/x:xmpmeta\u003E',
  "utf8",
);

const COM_SECRET = Buffer.from("SECRET-COMMENT", "latin1");

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

  // ------- JPEG scan-data integrity regression tests -------

  test("progressive JPEG (multi-SOS) with XMP between scans", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    // Progressive JPEG: EXIF, JFIF, DQT, SOF2, DHT, first SOS scan
    // (with byte stuffing and a restart marker), an APP1 XMP block
    // placed between the two SOS scans, the second scan, then EOI.
    const scan1 = scanWithStuffing(180, 0x55, [[10, 0x00], [50, 0xd2]]);
    const scan2 = Buffer.from([0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb]);

    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe1, makeExifApp1()),
      seg(0xfe, COM_SECRET),
      seg(0xe0, JFIF),
      seg(0xdb, DQT_PAYLOAD),
      seg(0xc2, SOF),
      seg(0xcc, DHT_PAYLOAD),
      seg(0xda, SOS1),
      scan1,
      seg(0xe1, XMP_APP1),
      seg(0xda, SOS2),
      scan2,
      Buffer.from([0xff, 0xd9]),
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: "prog-marker-test.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    // The parser must read the EXIF fields as well as the XMP block that
    // sits between the two SOS scans.
    await expect(page.locator("#beforeCount")).toContainText("4 fields found");
    await expect(page.locator("#beforeTables")).toContainText("TESTCAM");
    await expect(page.locator("#beforeTables")).toContainText("SECRET-COMMENT");
    await expect(page.locator("#beforeTables")).toContainText("SECRET-XMP");
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

    // Output is a valid JPEG: SOI/EOI intact, EXIF/COM/XMP stripped,
    // JFIF kept, and both scans (with stuffed bytes and restart
    // markers) survive the byte-level removal.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
    const t = out.toString("latin1");
    expect(t).not.toContain("Exif");
    expect(t).not.toContain("TESTCAM");
    expect(t).not.toContain("SECRET-COMMENT");
    expect(t).not.toContain("SECRET-XMP");
    expect(t).toContain("JFIF");
    expect(out.includes(scan1)).toBe(true);
    expect(out.includes(scan2)).toBe(true);
  });

  test("progressive JPEG (multi-SOS) byte-stuffing and restart markers", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    // Two-SOS progressive JPEG whose first scan carries multiple
    // stuffed bytes (0xFF 0x00) and restart markers (RST1, RST7);
    // the inter-scan segments are DQT/SOF2/DHT.
    const scan1 = scanWithStuffing(
      200,
      0x30,
      [[40, 0x00], [80, 0xd1], [120, 0x00], [160, 0xd7]],
    );
    const scan2 = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]);

    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe1, makeExifApp1()),
      seg(0xe0, JFIF),
      seg(0xdb, DQT_PAYLOAD),
      seg(0xc2, SOF),
      seg(0xcc, DHT_PAYLOAD),
      seg(0xda, SOS1),
      scan1,
      seg(0xdb, DQT_PAYLOAD),
      seg(0xc2, SOF),
      seg(0xcc, DHT_PAYLOAD),
      seg(0xda, SOS2),
      scan2,
      Buffer.from([0xff, 0xd9]),
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: "rst-test.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(page.locator("#beforeCount")).toContainText("2 fields found");
    await expect(page.locator("#beforeTables")).toContainText("TESTCAM");
    await expect(page.locator("#removeButton")).toBeEnabled();

    await page.click("#removeButton");

    await expect(page.locator("#afterPanel")).toBeVisible();
    await expect(page.locator("#afterSummary")).toContainText("Verified clean");

    const downloadPromise = page.waitForEvent("download");
    await page.click("#downloadButton");
    await page.click("#dlConfirm");
    const download = await downloadPromise;
    const outPath = path.join(os.tmpdir(), "truehide-meta-" + Date.now() + ".jpg");
    await download.saveAs(outPath);
    const out = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);

    // Output is a valid JPEG: SOI/EOI intact, EXIF dropped, JFIF kept,
    // and both scans (including stuffed 0xFF 0x00 pairs and RST
    // restart markers) survive byte-level removal.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
    const t = out.toString("latin1");
    expect(t).not.toContain("Exif");
    expect(t).not.toContain("TESTCAM");
    expect(t).toContain("JFIF");
    expect(out.includes(scan1)).toBe(true);
    expect(out.includes(scan2)).toBe(true);
  });

  test("baseline JPEG with byte-stuffed scan data and restart markers", async ({ page }) => {
    await page.goto("/app/truemetadata/");

    // Baseline single-scan JPEG: real EXIF, JFIF, a comment, DQT, SOF0,
    // one SOS, and a scan whose entropy-coded data contains byte
    // stuffing (0xFF 0x00) and restart markers (RST0, RST3).
    const scan = Buffer.from([
      0xff, 0x00, 0xff, 0xd0, 0x11, 0x22, 0x33, 0x44, 0x55,
      0xff, 0x00, 0xff, 0xd3, 0x66, 0x77, 0x88, 0x99,
    ]);

    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe1, makeExifApp1()),
      seg(0xe0, JFIF),
      seg(0xfe, COM_SECRET),
      seg(0xdb, DQT_PAYLOAD),
      seg(0xc0, SOF),
      seg(0xda, SOS1),
      scan,
      Buffer.from([0xff, 0xd9]),
    ]);

    await page.setInputFiles('input[type="file"]', {
      name: "stuffed-scan.jpg",
      mimeType: "image/jpeg",
      buffer: jpeg,
    });

    await expect(page.locator("#beforeCount")).toContainText("3 fields found");
    await expect(page.locator("#beforeTables")).toContainText("TESTCAM");
    await expect(page.locator("#beforeTables")).toContainText("SECRET-COMMENT");
    await expect(page.locator("#removeButton")).toBeEnabled();

    await page.click("#removeButton");

    await expect(page.locator("#afterPanel")).toBeVisible();
    await expect(page.locator("#afterSummary")).toContainText("Verified clean");

    const downloadPromise = page.waitForEvent("download");
    await page.click("#downloadButton");
    await page.click("#dlConfirm");
    const download = await downloadPromise;
    const outPath = path.join(os.tmpdir(), "truehide-meta-" + Date.now() + ".jpg");
    await download.saveAs(outPath);
    const out = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);

    // Output is a valid JPEG: SOI/EOI intact, EXIF and comment dropped,
    // JFIF kept, and the scan data (stuffed bytes + restart markers)
    // preserved by the byte-level removal.
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
    const t = out.toString("latin1");
    expect(t).not.toContain("Exif");
    expect(t).not.toContain("TESTCAM");
    expect(t).not.toContain("SECRET-COMMENT");
    expect(t).toContain("JFIF");
    expect(out.includes(scan)).toBe(true);
  });
});
