// Oversize PDF fixture generator
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("test/fixtures");

// Create a huge PDF: 50000pt x 50000pt
const width = 50000;
const height = 50000;

const content = "BT /F1 100 Tf 100 25000 Td (LARGE-PDF-FIXTURE) Tj ET";
const contentStream = "<</Length " + Buffer.byteLength(content) + ">>\nstream\n" + content + "\nendstream";

const objects = [
  "%PDF-1.4\n",
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + width + " " + height + "] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>",
  contentStream,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let pdf = "";
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += (i + 1) + " 0 obj\n" + objects[i] + "\nendobj\n";
}
const xrefPos = Buffer.byteLength(pdf);
pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
for (const off of offsets) {
  pdf += String(off).padStart(10, "0") + " 00000 n \n";
}
pdf += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n";

fs.writeFileSync(path.join(dir, "oversize.pdf"), Buffer.from(pdf, "latin1"));
console.log("oversize.pdf: " + Buffer.byteLength(pdf) + " bytes");
console.log("Page dimensions: " + width + "pt x " + height + "pt");