// Static asset-integrity checks (dev-only, run via `npm run test:integrity`).
//
// 1. Every local src/href in HTML files resolves to an existing file.
// 2. Every file in the SW SHELL list exists; every HTML-referenced asset is in SHELL.
// 3. No HTML/CSS file references an external http(s) resource (privacy invariant).
// 4. Vendored lib filenames in app/trueflatten/lib/ match references in index.html.

import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Repo root = two levels up from this file (test/integrity/assets.mjs).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
let checks = 0;

function ok(label) {
  checks += 1;
  console.log(`  PASS ${label}`);
}

function fail(label, detail) {
  checks += 1;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Collect all .html files
// ---------------------------------------------------------------------------

async function findHtml(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "test" ||
        entry.name === "playwright-report" ||
        entry.name === "test-results" ||
        entry.name.startsWith(".")
      )
        continue;
      out.push(...(await findHtml(full)));
    } else if (entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

const htmlFiles = await findHtml(root);

// ---------------------------------------------------------------------------
// 1. Local src/href references resolve to files
// ---------------------------------------------------------------------------

console.log("\n[1] HTML local references resolve to files");

for (const file of htmlFiles) {
  const src = await readFile(file, "utf8");
  const refs = [];
  for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    refs.push(m[1]);
  }
  const rel = path.relative(root, file);
  // shared/footer.html is a runtime template: its internal links are written
  // root-relative and prefixed by base.js for the hosting page's depth.
  if (rel === "shared/footer.html" || rel.split(path.sep)[0] === "shared" && rel.endsWith("footer.html")) continue;
  let missing = 0;
  for (const ref of refs) {
    if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("#") || ref.startsWith("mailto:")) continue;
    const resolved = path.resolve(path.dirname(file), ref);
    if (!(await exists(resolved))) {
      missing += 1;
      fail(`${rel} → ${ref}`, "file not found");
    }
  }
  if (missing === 0) ok(`${rel}: ${refs.length} reference(s)`);
}

// ---------------------------------------------------------------------------
// 2. SW SHELL list: every entry exists, and HTML-referenced assets are listed
// ---------------------------------------------------------------------------

console.log("\n[2] Service worker SHELL cache");

const swSrc = await readFile(path.join(root, "sw.js"), "utf8");
const shellMatch = swSrc.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/);
if (!shellMatch) {
  fail("sw.js SHELL array", "not found");
} else {
  const shellEntries = [...shellMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  let missing = 0;
  for (const entry of shellEntries) {
    const p = entry.endsWith("/") ? path.join(root, entry) : path.join(root, entry);
    if (!(await exists(p))) {
      missing += 1;
      fail(`SHELL entry "${entry}"`, "file not found on disk");
    }
  }
  if (missing === 0) ok(`${shellEntries.length} SHELL entries all exist`);

  // Collect asset refs from HTML files (relative to root).
  // shared/footer.html holds root-relative template links (prefixed at
  // runtime) — skip it; its entries are the app directories themselves.
  const assetRefs = new Set();
  for (const file of htmlFiles) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "shared/footer.html") continue;
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const ref = m[1];
      if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("#") || ref.startsWith("mailto:")) continue;
      const resolved = path.resolve(path.dirname(file), ref);
      const relPath = path.relative(root, resolved).split(path.sep).join("/");
      assetRefs.add(relPath);
    }
  }

  const shellSet = new Set(shellEntries);
  const shellHasSlash = (p) => shellSet.has(p) || shellSet.has(p + "/") || shellSet.has("./" + p);
  let notInShell = 0;
  for (const ref of assetRefs) {
    // Skip test fixtures and docs pages that intentionally live outside the shell cache
    if (ref.startsWith("test/")) continue;
    if (!shellHasSlash(ref) && !(await exists(path.join(root, ref)))) {
      notInShell += 1;
      fail(`asset "${ref}"`, "referenced by HTML but not in SHELL and not on disk");
    }
  }
  if (notInShell === 0) ok(`all ${assetRefs.size} HTML asset references present on disk`);
}

// ---------------------------------------------------------------------------
// 3. No external http(s) resource references in HTML/CSS
// ---------------------------------------------------------------------------

console.log("\n[3] No external http(s) resource loads (privacy invariant)");
console.log("    (plain <a> navigation links to external sites are allowed and noted)");

let externalLoads = 0;
let externalNavLinks = 0;
for (const file of htmlFiles) {
  const src = await readFile(file, "utf8");
  for (const m of src.matchAll(/<script[^>]*\ssrc\s*=\s*["'](https?:[^"']+)["']/g)) {
    externalLoads += 1;
    fail(`${path.relative(root, file)} external <script src>`, m[1]);
  }
  for (const m of src.matchAll(/<link[^>]*\srel\s*=\s*["'][^"']*["'][^>]*\shref\s*=\s*["'](https?:[^"']+)["']/g)) {
    externalLoads += 1;
    fail(`${path.relative(root, file)} external <link href>`, m[1]);
  }
  // Plain navigation anchors: allowed (user-initiated), counted only.
  for (const m of src.matchAll(/<a\s[^>]*\shref\s*=\s*["'](https?:[^"']+)["']/g)) {
    externalNavLinks += 1;
  }
}

const cssFiles = [path.join(root, "styles.css"), path.join(root, "shared", "base.css")];
for (const file of cssFiles) {
  if (!(await exists(file))) continue;
  const src = await readFile(file, "utf8");
  for (const m of src.matchAll(/@import\s+(?:url\()?\s*["'](https?:[^"'#)])/g)) {
    externalLoads += 1;
    fail(`${path.relative(root, file)} @import`, m[1]);
  }
  for (const m of src.matchAll(/url\(\s*["']?(https?:[^"'#)]*)["']?\s*\)/g)) {
    externalLoads += 1;
    fail(`${path.relative(root, file)} url()`, m[1]);
  }
}
if (externalLoads === 0) ok("no external resource loads in HTML/CSS");
if (externalNavLinks > 0) {
  console.log(`  NOTE ${externalNavLinks} external navigation <a> link(s) (user-initiated; no data sent):`);
  // list them
  for (const file of htmlFiles) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/<a\s[^>]*\shref\s*=\s*["'](https?:[^"']+)["']/g)) {
      console.log(`    ${path.relative(root, file)}: ${m[1]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Vendored lib filenames match index.html references
// ---------------------------------------------------------------------------

console.log("\n[4] Vendored libraries in app/trueflatten/lib");

const libDir = path.join(root, "app", "trueflatten", "lib");
const libFiles = (await readdir(libDir)).filter((f) => f.endsWith(".js"));
const flattenDir = path.join(root, "app", "trueflatten");
const flattenHtml = await readFile(path.join(flattenDir, "index.html"), "utf8");
// The pdf.js worker is wired up in script.js (GlobalWorkerOptions.workerSrc),
// so scan both the HTML and the app script for lib/ references.
const flattenScript = await readFile(path.join(flattenDir, "script.js"), "utf8");
const flattenAll = flattenHtml + "\n" + flattenScript;
let libMismatch = 0;
for (const lib of libFiles) {
  if (!flattenAll.includes(lib)) {
    libMismatch += 1;
    fail(`lib/${lib}`, "not referenced in app/trueflatten (index.html or script.js)");
  }
}
for (const m of flattenAll.matchAll(/["'](lib\/[^"']+)["']/g)) {
  const p = path.resolve(flattenDir, m[1]);
  if (!(await exists(p))) {
    libMismatch += 1;
    fail(`lib ref ${m[1]}`, "not found on disk");
  }
}
if (libMismatch === 0) ok(`${libFiles.length} vendored libs all referenced and present`);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : " — all good"}`);
process.exit(failures ? 1 : 0);
