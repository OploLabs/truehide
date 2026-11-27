// Generates test/fixtures/secret.pdf — a 1-page PDF with extractable text.
// Used by E2E tests to verify TrueFlatten redaction is genuine:
// after export, the text must NOT be extractable from the flattened PDF.
// Dev-only tooling; not part of the static app.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const textLines = [
  "SECRET ACCOUNT NUMBER 12345-6789-CONFIDENTIAL",
  "Patient record: DOB 1979-04-22 SSN 000-12-3456",
  "This line must be gone after TrueFlatten redaction.",
];

// Content stream: one text line per Td/Tj.
let content = "BT\n/F1 18 Tf\n72 700 Td\n";
for (let i = 0; i < textLines.length; i++) {
  const line = textLines[i].replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  content += `(${line}) Tj\n0 -28 Td\n`;
}
content += "ET\n";

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
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
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

const target = path.join(outDir, "test", "fixtures", "secret.pdf");
writeFileSync(target, Buffer.from(pdf, "latin1"));
console.log(`wrote ${target} (${Buffer.byteLength(pdf)} bytes)`);
console.log("contains text:", textLines.join(" | "));
