// Dev-only fixture generator for the E2E suites.
//
//   node test/fixtures/make-fixtures.mjs
//
// (Re)generates the fixture files the tests depend on. The generated files
// are committed to the repo so CI does not need to run this script.
//
// Fixtures:
//   multi.pdf        3-page PDF with per-page secret text, a /Text note
//                    annotation, a /FileAttachment annotation with an
//                    embedded file, an AcroForm text field with a value,
//                    XMP metadata, and an /Info dictionary — each carrying
//                    a distinct marker string the tests assert ABSENT from
//                    TrueFlatten exports.
//   corrupt.pdf      A PDF header followed by garbage — pdf.js must reject it.
//   notes.txt        Plain text — image tools must reject it.
//   transparent.png  128×128 RGBA: left half opaque black, right half
//                    fully transparent (alpha 0).
//   large.png        1024×640 RGBA gradient (deflate-friendly).
//   corrupt.png      Truncated PNG — image decoding must fail gracefully.
//   sample.webp      96×96 WebP with four colored quadrants (generated via
//                    headless Chromium so the bytes are a real WebP file).
//
// No fixture contains real personal data; every "secret" is a marker.

import { writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PNG helpers (RGBA, 8-bit)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: a Buffer of width*height*4 bytes, row-major. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = 1 + width * 4; // filter byte (0) + row
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// multi.pdf
// ---------------------------------------------------------------------------

function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream(lines) {
  let content = "BT\n/F1 18 Tf\n72 700 Td\n";
  for (const line of lines) {
    content += `(${pdfEscape(line)}) Tj\n0 -28 Td\n`;
  }
  content += "ET\n";
  return content;
}

function streamObject(dict, data) {
  return `<< ${dict} /Length ${Buffer.byteLength(data)} >>\nstream\n${data}\nendstream`;
}

const XMP = `<?xpacket begin="wiki" id="W5M0m0rIc5x"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description>
      <dc:title><rdf:Alt><rdf:li xml:lang="en">XMP-TITLE-MARKER-99</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>XMP-AUTHOR-MARKER-99</rdf:li></rdf:Seq></dc:creator>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="wiki"?>`;

const objects = [
  // 1 catalog
  "<< /Type /Catalog /Pages 2 0 R /AcroForm 13 0 R /Metadata 15 0 R >>",
  // 2 pages
  "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>",
  // 3 page 1 (text note + file attachment annotations)
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 14 0 R >> >> /Contents 4 0 R /Annots [8 0 R 9 0 R] >>",
  // 4 page 1 content
  streamObject("", contentStream(["MULTI-P1-SECRET-ALPHA 111-222-333", "Second line of page one."])),
  // 5 page 2 (form field widget)
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 14 0 R >> >> /Contents 6 0 R /Annots [10 0 R] >>",
  // 6 page 2 content
  streamObject(
    "",
    contentStream(["MULTI-P2-SECRET-BRAVO 444-555-666"]),
  ),
  // 7 page 3
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 14 0 R >> >> /Contents 11 0 R >>",
  // 8 text note annotation
  "<< /Type /Annot /Subtype /Text /Rect [40 700 60 720] /Contents (ANNOT-TEXT-MARKER-77) /T (Audit) /C [1 0 0] >>",
  // 9 file attachment annotation
  "<< /Type /Annot /Subtype /FileAttachment /Rect [70 700 90 720] /T (secret-attachment.txt) /EF << /F 12 0 R >> >>",
  // 10 AcroForm text field (widget), with a value
  "<< /Type /Annot /Subtype /Widget /FT /Tx /T (F1) /V (FORM-VALUE-MARKER-31337) /DV (FORM-VALUE-MARKER-31337) /Rect [40 660 200 680] /P 5 0 R /F 4 /Parent 13 0 R >>",
  // 11 page 3 content
  streamObject(
    "",
    contentStream(["MULTI-P3-SECRET-CHARLIE 777-888-999"]),
  ),
  // 12 embedded file (attachment bytes)
  streamObject("/Type /EmbeddedFile", "EMBEDDED-ATTACHMENT-MARKER-2026\n"),
  // 13 AcroForm
  "<< /Fields [10 0 R] >>",
  // 14 font
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  // 15 XMP metadata
  streamObject("/Type /Metadata /Subtype /XML", XMP),
  // 16 document info dictionary
  "<< /Title (INFO-TITLE-MARKER-555) /Author (AUTHOR-MARKER-666) /Producer (TRUEHIDE-FIXTURE) >>",
];

let pdf = "%PDF-1.4\n";
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefPos = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  pdf += String(off).padStart(10, "0") + " 00000 n \n";
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 16 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

writeFileSync(path.join(dir, "multi.pdf"), Buffer.from(pdf, "latin1"));
console.log(`multi.pdf: ${Buffer.byteLength(pdf)} bytes`);

// ---------------------------------------------------------------------------
// corrupt.pdf / notes.txt
// ---------------------------------------------------------------------------

const corruptPdf =
  "%PDF-1.4\n% intentionally broken fixture — garbage after the header\n" +
  "â”åâ‚¬â€° garbage-garbage-garbage".repeat(8) + "\n%%EOF\n";
writeFileSync(path.join(dir, "corrupt.pdf"), Buffer.from(corruptPdf, "utf8"));
console.log("corrupt.pdf written");

writeFileSync(
  path.join(dir, "notes.txt"),
  "This is a plain text file, not an image.\nIt must be rejected by the image tools.\n",
);
console.log("notes.txt written");

// ---------------------------------------------------------------------------
// PNGs
// ---------------------------------------------------------------------------

// transparent.png — 128×128: left half opaque black, right half alpha 0.
{
  const w = 128;
  const h = 128;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = x < w / 2 ? 255 : 0;
    }
  }
  writeFileSync(path.join(dir, "transparent.png"), encodePng(w, h, rgba));
  console.log("transparent.png written (128×128 RGBA)");
}

// large.png — 1024×640 smooth gradient (deflate-friendly, still a "large image").
{
  const w = 1024;
  const h = 640;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 255) / (w - 1);
      rgba[i + 1] = (y * 255) / (h - 1);
      rgba[i + 2] = (((x + y) * 255) / (w + h - 2)) | 0;
      rgba[i + 3] = 255;
    }
  }
  const png = encodePng(w, h, rgba);
  writeFileSync(path.join(dir, "large.png"), png);
  console.log(`large.png written (${w}×${h} RGBA, ${png.length} bytes)`);
}

// corrupt.png — structurally invalid PNG: complete chunk layout, but the IHDR
// declares color type 7 (invalid; valid values are 0,2,3,4,6), so real
// decoders reject it even though the byte stream is well-formed enough to
// fool casual "is it a PNG?" sniffers.
{
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(128, 0);
  ihdr.writeUInt32BE(128, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 7; // invalid color type
  const idat = zlib.deflateSync(Buffer.alloc(100));
  writeFileSync(
    path.join(dir, "corrupt.png"),
    Buffer.concat([
      signature,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  console.log("corrupt.png written (invalid IHDR color type)");
}

// ---------------------------------------------------------------------------
// sample.webp — via headless Chromium canvas → toBlob("image/webp")
// ---------------------------------------------------------------------------

async function makeWebp() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      "<canvas id='c' width='96' height='96' style='display:block'></canvas>",
    );
    const result = await page.evaluate(async () => {
      const canvas = document.getElementById("c");
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e23b3b";
      ctx.fillRect(0, 0, 48, 48);
      ctx.fillStyle = "#3be26f";
      ctx.fillRect(48, 0, 48, 48);
      ctx.fillStyle = "#3b6fe2";
      ctx.fillRect(0, 48, 48, 48);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(48, 48, 48, 48);
      const blob = await new Promise((res) =>
        canvas.toBlob((b) => res(b), "image/webp", 0.9),
      );
      if (!blob || blob.type !== "image/webp") {
        throw new Error(`canvas.toBlob produced ${blob ? blob.type : "null"}`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { base64: btoa(bin), size: bytes.length };
    });
    writeFileSync(
      path.join(dir, "sample.webp"),
      Buffer.from(result.base64, "base64"),
    );
    console.log(`sample.webp written (${result.size} bytes)`);
  } finally {
    await browser.close();
  }
}

try {
  await makeWebp();
} catch (error) {
  // The committed sample.webp is still usable; only warn about regeneration.
  console.warn(`sample.webp: could not regenerate (${error.message})`);
}
