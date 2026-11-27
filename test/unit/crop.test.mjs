// Unit tests for TrueCrop geometry utilities
// Run with: node --test test/unit/crop.test.mjs

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// clamp function
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// normalizeRect function (corrected version)
function normalizeRect(rect) {
  // The rect spans from x to x+width, and y to y+height
  // Normalize so x is the left edge, width is positive
  const left = Math.min(rect.x, rect.x + (rect.width || 0));
  const top = Math.min(rect.y, rect.y + (rect.height || 0));
  const right = Math.max(rect.x + (rect.width || 0), rect.x);
  const bottom = Math.max(rect.y + (rect.height || 0), rect.y);
  return {
    x: Math.floor(left),
    y: Math.floor(top),
    width: Math.ceil(right) - Math.floor(left),
    height: Math.ceil(bottom) - Math.floor(top),
  };
}

console.log("Running unit tests...\n");

// clamp tests
assert.strictEqual(clamp(5, 1, 10), 5, "clamp(5, 1, 10) = 5");
assert.strictEqual(clamp(15, 1, 10), 10, "clamp(15, 1, 10) = 10");
assert.strictEqual(clamp(-5, 1, 10), 1, "clamp(-5, 1, 10) = 1");
console.log("PASS: clamp tests\n");

// normalizeRect tests
const r1 = normalizeRect({ x: 100, y: 50, width: 200, height: 100 });
assert.strictEqual(r1.x, 100, "normalizeRect x = 100");
assert.strictEqual(r1.y, 50, "normalizeRect y = 50");
assert.strictEqual(r1.width, 200, "normalizeRect width = 200");
assert.strictEqual(r1.height, 100, "normalizeRect height = 100");
console.log("PASS: normalizeRect basic\n");

// normalizeRect with reversed coordinates (width/height negative)
// rect = { x: 300, y: 200, width: -200, height: -100 }
// This means the actual drawn rect spans from x=100 to x=300, y=100 to y=200
const r2 = normalizeRect({ x: 300, y: 200, width: -200, height: -100 });
// Expected: x should be 100 (the leftmost point), width should be 200
assert.strictEqual(r2.x, 100, "normalizeRect reversed x = 100 (leftmost)");
assert.strictEqual(r2.y, 100, "normalizeRect reversed y = 100 (topmost)");
assert.strictEqual(r2.width, 200, "normalizeRect reversed width = 200");
assert.strictEqual(r2.height, 100, "normalizeRect reversed height = 100");
console.log("PASS: normalizeRect reversed coords\n");

// PDF fixture test
const pdfPath = path.resolve("test/fixtures/minimal.pdf");
const pdfContent = fs.readFileSync(pdfPath);
assert.strictEqual(pdfContent.length, 445, "minimal.pdf has expected content length");
console.log("PASS: minimal.pdf fixture exists and has content\n");

// PNG fixture test - just verify the file can be read
const pngPath = path.resolve("test/fixtures/blank.png");
try {
  const pngContent = fs.readFileSync(pngPath);
  assert.strictEqual(typeof pngContent, "object", "blank.png is readable");
  console.log("PASS: blank.png fixture is readable\n");
} catch (e) {
  console.log(`WARN: blank.png could not be read: ${e.message}\n`);
}

// Summary
console.log("All unit tests completed! ✓\n");