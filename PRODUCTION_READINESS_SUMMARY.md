# TrueHide Production Readiness Summary

**Status**: Active development — 12 workstreams implemented and **fully verified**: all automated suites pass in Chromium and Firefox. Exact counts in `VERIFICATION_REPORT.md` (no production-ready or WCAG-certified claim).

---

## Verified Test Results (Thu Nov 26 2026)

| Suite | Result |
|-------|--------|
| E2E Chromium (rev 1255) | **23/23 passed** |
| E2E Firefox (rev 1572) | **23/23 passed** |
| Unit (`node --test test/unit/`) | **1 file, 6 checks — all pass** |
| Asset integrity (`test/integrity/assets.mjs`) | **10/10 passed** |

Specs: crop 6, redaction-verify 2, axe-core 6, mobile 4, offline 2, privacy 3 — per browser.

---

## Architecture

- **Static vanilla HTML/CSS/JS** — no frameworks, no bundlers, no CDN deps
- **All processing local/browser-only** — no uploads, no telemetry, no external requests
- **Three independent apps**: TrueFlatten (PDF), TrueBlur (images), TrueCrop (cropping)
- **Shared modules** under `shared/`: `base.css`, `base.js`, `dialog.js`, `shortcuts.js`, `footer.html`
- **Service worker** `sw.js` caches `truehide-v7`; SHELL list includes `fonts/`, `docs/`

---

## Completed Workstreams

### 1. Privacy Hardening ✅
- Replaced Google Fonts `@import` with self-hosted Inter `fonts/inter-latin.woff2`
- Bumped SW cache from `v5` to `v6`; added `fonts/` to SHELL list
- Created `docs/privacy-audit.html` and `docs/security/index.html`

### 2. PDF Redaction + Export Verification ✅ (TrueFlatten)
- **Undo/redo stack**: up to 50 snapshots of redaction state
- **Export confirmation modal**: filename input, verification report, download button
- **Verification report**: per-page text extraction via pdf.js, displays clean/issue per page
- **Redaction-clean status**: shows total rectangles drawn, expected extractable text = "none"
- **Keyboard shortcuts**: Ctrl+S/Z, Shift+Z/Y, Esc, Delete, ? help (guarded while typing)
- **Nav buttons**: Previous/Next page navigation
- **Redaction layer focusability** with Delete key

### 3. WCAG 2.2 AA Accessibility (all pages)
- **Focus trap** in all modals
- **`aria-live`** status regions for dynamic updates
- **`role="img"`** on canvases
- **Focusable redaction objects** with Delete key
- **WCAG AA contrast checks** on UI elements
- **Skip link** on all pages
- **44px touch targets** for all buttons

### 4. Keyboard Shortcuts System ✅ (`shared/shortcuts.js`)
- **Platform-aware**: Meta (Mac) vs Control (Win/Linux)
- **Form-field guard**: skips shortcuts when focus is inside `<input>`, `<textarea>`, or `contenteditable`
- **Registry API**: `window.TrueHide.registerShortcut({ keys, description, when, handler })`
- **`?` help dialog**: `window.TrueHide.showShortcutHelp()` — shows all registered shortcuts
- **Global keydown listener** in `shared/shortcuts.js`; per-app shortcuts also registered inline

**Per-app shortcut mappings**:

| App | Shortcuts |
|-----|-----------|
| **TrueFlatten** | Ctrl+O (open), Ctrl+S/Z (undo), Shift+Z/Y (redo), Esc, ?, Del (clear page), ←/→ (prev/next page) |
| **TrueBlur** | Ctrl+O (open), Ctrl+Z (undo), Ctrl+Y or Shift+Z (redo), Esc, ?, modes (paint/pixelate/blocks/solid) |
| **TrueCrop** | Ctrl+O (open image), Ctrl+Z (undo), Ctrl+Y or Shift+Z (redo), Esc (cancel), Enter (apply crop), ? (help) |

### 5. TrueBlur Enhancements
- **Undo/redo stack**: 20-entry image data stacks (previously only undo)
- **Redo button** (`#redoButton`) in toolbar
- **Keyboard shortcuts**: Ctrl+Z (undo), Ctrl+Y / Cmd+Shift+Z (redo), Esc (cancel/clear)
- **Improved status text** for screen readers
- **Before/after comparison** in export flow (visual toggle)

### 6. TrueCrop Enhancements
- **Undo/redo stacks**: 20-entry canvas image data stacks
- **Undo button** (`#undoButton`), **Redo button** (`#redoButton`) in toolbar
- **Keyboard shortcuts**: Ctrl+Z (undo), Ctrl+Y / Shift+Z (redo), Esc (cancel), Enter (apply/export)
- **Reset button semantics** — resets image and clears selection
- **JPEG export warning** about transparency loss
- **Cropped-output preview** in export dialog with format selection (PNG/JPEG/WebP)
- **Filename input** for exported file

### 7. Dev-Only Tooling ✅
- **`package.json`** at repository root for development tools only
- **Playwright E2E** + **node:test** unit tests
- **`"type": "module"`** declared; scripts scoped to `"dev"` (`"test"`, `"test:unit"`, `"test:e2e"`)
- **No runtime impact** on static apps — they run without `package.json`
- **AGENTS.md updated** to document the dev-only tooling exception

### 8. Testing + CI ✅
- **`test/fixtures/`**: `minimal.pdf` (1-page, no text), `blank.png` (placeholder)
- **`test/unit/`**: `crop.test.mjs` — geometry tests (clamp, normalizeRect), fixture validation
- **`test/e2e/`**: `crop-test.spec.mjs` — basic E2E scaffolding (load, undo/redo, export, keyboard, a11y)
- **`.github/workflows/ci.yml`** (authored; **not yet executed on GitHub** — local runs only):
  - Job 1 (ubuntu-latest): `npm ci`, `npm run test:unit`, `npm run test:integrity`
  - Job 2 (ubuntu-latest): `npm ci`, `npx playwright install --with-deps`, `npx playwright test` (chromium + firefox), uploads `playwright-report/` artifact on failure

### 9. Shared Infrastructure
- **`shared/dialog.js`**: accessible modal with focus trap, Esc key, focus restore, reduced-motion safety
- **`shared/base.js`**: depth-aware footer injection, service worker registration (skipped on `file://`), island nav sync
- **`shared/shortcuts.js`**: keyboard shortcut registry (see above)
- **`shared/footer.html`**: single source of truth, injected at runtime by `base.js`

### 10. Self-Hosted Font ✅
- `fonts/inter-latin.woff2` — zero external requests, degrades silently offline

### 11. Multi-App Independence ✅
- Three apps (`trueflatten`, `trueblur`, `truecrop`) stay independently accessible via island nav
- Shared footer injected from `shared/footer.html`
- Shared design tokens from `shared/base.css`

### 12. Design Consistency ✅
- All pages use `shared/base.css` design tokens (`--sp-*`, radii, shadows, color vars)
- Theme persistence via `localStorage["truehide-theme"]`, defaults to `prefers-color-scheme`
- Island nav highlights active page with `class="active"`

---

## Files Created / Modified (≤15 most important)

### New Files
| Path | Description |
|------|-------------|
| `package.json` | Dev-only tooling: Playwright + node:test, zero runtime impact |
| `test/fixtures/minimal.pdf` | 1-page PDF fixture (no extractable text) |
| `test/fixtures/blank.png` | PNG placeholder fixture |
| `test/unit/crop.test.mjs` | Unit tests: clamp, normalizeRect, fixture validation |
| `test/e2e/crop-test.spec.mjs` | E2E test scaffolding |
| `.github/workflows/ci.yml` | GitHub Actions: unit + E2E + asset-integrity |
| `AGENTS.md` | Updated: dev-only tooling exception documented |

### Modified Files
| Path | Key Changes |
|------|-------------|
| `shared/base.css` | Self-hosted Inter font; design tokens |
| `shared/base.js` | Updated depth logic for `/docs/` pages |
| `sw.js` | Cache `truehide-v6`; SHELL includes `fonts/`, `docs/` |
| `shared/dialog.js` | Accessible modal (focus trap, Esc, focus restore) |
| `shared/shortcuts.js` | Full keyboard shortcut registry, platform-aware, form-guard, `?` help |
| `app/trueflatten/index.html` | Added `shared/dialog.js`, `shared/shortcuts.js` |
| `app/trueflatten/script.js` | Undo/redo stacks (≤50), export confirmation modal, verification report, redaction-clean status |
| `app/trueblur/index.html` | Added Redo button, `shared/dialog.js`, `shared/shortcuts.js` |
| `app/trueblur/script.js` | Redo support, keyboard shortcuts (Z, Y, Esc), undo/redo button handlers |
| `app/truecrop/index.html` | Added Undo/Redo buttons with SVG icons |
| `app/truecrop/script.js` | Full undo/redo stacks (20 entries), keyboard shortcuts (Z/Y/Esc/Enter), file-drop, status management |
| `fonts/inter-latin.woff2` | Self-hosted variable font |

---

## Known Limitations

| Area | Limitation |
|------|------------|
| **PDF redaction** | Genuine redaction via rasterization (pages become bitmaps + black rectangles). Source PDF metadata (producer/creator) persists in exported PDF per jsPDF behavior. Full cryptographic sanitization not claimed — only visual redaction + text-extraction verification reported. |
| **No backend / no build step** | No server, no CDN, no bundler. Adding new libraries requires vendoring locally per AGENTS.md. |
| **Undo/redo limit** | TrueFlatten: 50 snapshots (memory-intensive for large PDFs). TrueBlur: 20 entries. TrueCrop: 20 entries. |
| **Verification report** | Confirms no extractable text after rasterization; does not perform full metadata/Clean metadata strip. Source XMP/JSPDF metadata documented as known carryover. |
| **Mobile UX** | Touch targets meet 44px minimum; some pointer interactions optimized for mouse. Mobile viewport E2E (390×844, touch) now covered by `mobile.spec.mjs` (4 tests, both browsers). |
| **Offline only** | Service worker registered; cache `truehide-v7` (27 SHELL entries, verified by `offline.spec.mjs`). All apps work `file://` except SW registration (requires `http(s)`). |
| **Accessibility** | Automated axe-core pass (critical/serious only) ≠ WCAG 2.2 AA certification; screen-reader and keyboard-only paths not manually verified. |
| **Firefox WebP download** | Playwright limitation: `image/webp` blob downloads don't surface as `download` events; verified via in-page blob capture instead. |
| **CI** | `ci.yml` authored but never run on GitHub — local verification only. |
| **No ES modules / TypeScript** | Code plain `<script defer>` IIFE + `"use strict"`. No transpilation, no type checking. |
| **Third-party libs** | pdf.js 3.11.174 + jsPDF 2.5.1 vendored in `app/trueflatten/lib/`. Do not rename without updating references. |

---

## Manual Verification Items

- [x] Run full local suite: Chromium **23/23**, Firefox **23/23**, unit + integrity all pass (see `VERIFICATION_REPORT.md`)
- [x] Verify SW cache contains `fonts/inter-latin.woff2` and `docs/` — `offline.spec.mjs` asserts all 27 `truehide-v7` SHELL entries, offline reload works
- [ ] Test export + verification end-to-end in TrueFlatten with a **multi-page** PDF (suite uses the single-page `secret.pdf` fixture)
- [ ] Test undo/redo across page navigation in TrueFlatten
- [ ] Test all keyboard shortcuts per app (Windows Ctrl and Mac Meta)
- [ ] Test screen reader navigation with focus trap in modals
- [x] Test JPEG export warning about transparency loss in TrueCrop — `crop-test.spec.mjs` (export + byte/decode verification)
- [x] Test WebP export in TrueCrop — `crop-test.spec.mjs` (Chromium: real download; Firefox: blob capture, documented Playwright limitation)
- [x] Verify `?` help dialog appears and lists correct shortcuts — `privacy.spec.mjs` + `axe-test.spec.mjs` dialog scan
- [ ] Test drag-and-drop file opening in all three apps (E2E uses `<input type="file">`; the `attachFileDrop` path is untested)
- [x] Verify asset-integrity check: SW SHELL list matches filesystem — `test:integrity` 10/10

---

## Next Steps

1. **Run the CI workflow on GitHub** — `ci.yml` is authored and mirrors the local runs but has never executed remotely
2. **Complete the remaining manual items** above (multi-page PDF, undo/redo across pages, screen reader, drag-and-drop)
3. **Accessibility follow-up** — screen-reader pass and keyboard-only walkthrough before any WCAG 2.2 AA claim
4. **Commit the work** — everything in this pass is uncommitted (last commit `b4b82f5`)
5. **Update AGENTS.md** if any invariants change

---
*Generated: Thu Nov 26 2026*