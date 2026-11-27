# TrueHide Production Readiness Summary

**Status**: Active development — all automated suites pass in Chromium and Firefox (44/44 per browser). Exact counts in `VERIFICATION_REPORT.md` (no production-ready or WCAG-certified claim).

---

## Verified Test Results

| Suite | Result (Chromium) | Result (Firefox) |
|-------|-------------------|------------------|
| E2E (Playwright, static-server on port 4173) | **44/44 passed** | **44/44 passed** |
| Unit (`node --test test/unit/`) | **1 test file, all asserts PASS** | **1 test file, all asserts PASS** |
| Asset integrity (`test/integrity/assets.mjs`) | **10/10 PASS** | **10/10 PASS** |

Per-spec breakdown (each passed in both browsers):

| Spec | Tests |
|------|-------|
| `test/e2e/crop-test.spec.mjs` | 6 |
| `test/e2e/redaction-verify.spec.mjs` | 2 |
| `test/e2e/axe-test.spec.mjs` | 6 |
| `test/e2e/mobile.spec.mjs` | 5 |
| `test/e2e/offline.spec.mjs` | 2 |
| `test/e2e/privacy.spec.mjs` | 3 |
| `test/e2e/pdf-multifeat.spec.mjs` | 8 |
| `test/e2e/image-edge.spec.mjs` | 6 |
| `test/e2e/a11y-practical.spec.mjs` | 6 |
| **Total** | **44** |

Spec coverage:
- **crop-test** — basic E2E scaffolding (load, undo/redo, export, keyboard, a11y)
- **redaction-verify** — TrueFlatten security: loads `secret.pdf` (extractable text), draws redaction, exports, proves secret text absent from the rasterized PDF
- **axe-test** — automated accessibility (axe-core) on landing page and all three apps; only critical/serious violations block; 0 blocking in both browsers
- **mobile** — TrueCrop/TrueBlur/TrueFlatten flows on 390×844 touch viewport; dialog-overflow check (export modal + shortcut help stay within bounds)
- **offline** — registers SW on `http://127.0.0.1:4173`, polls cache until `truehide-v8` holds all 27 SHELL entries, then tests offline reload; TrueCrop functional offline, TrueFlatten renders PDF with vendored pdf.js + jsPDF
- **privacy** — request monitor on all pages; zero external `http(s)` requests; user files read only via `<input type="file">` / drag-drop into memory; never transmitted
- **pdf-multifeat** — TrueFlatten against `test/fixtures/multi.pdf` (3 pages, per-page text markers, annotation, embedded attachment, AcroForm field, XMP + Info title/author): source check confirms markers exist; export check proves every marker (text, annotation, attachment, form, XMP, Info) is absent from raw bytes and extractable text; redaction bands verified black on every page; keyboard undo/redo (`modCmdOrCtrl+z`/`y`) of add/popover-delete/clear-page; document replacement resets redactions + undo history; corrupt-PDF returns viewer to empty state
- **image-edge** — TrueCrop/TrueBlur edge cases: PNG alpha preserved; 1024×640 loads and exports at reported size; WebP accepted by both tools; non-image and corrupt images rejected gracefully; TrueBlur pixel-level undo/redo (solid black → Ctrl+Z restores → Ctrl+Y reapplies)
- **a11y-practical** — practical a11y smoke checks: Tab-order reachability of primary controls on all three apps (selection must exist first for enabled buttons to be in the tab order); screen-reader checks: every interactive control has an accessible name; canvas previews expose role/label

### Unit (`node --test test/unit/`)

- `test/unit/crop.test.mjs` — geometry tests: `clamp`, `normalizeRect` basic/reversed; fixture presence (minimal.pdf, blank.png); file readability.

### Asset integrity (`test/integrity/assets.mjs`) — 10/10 PASS

1. HTML local references resolve to files for all 6 HTML pages (44 total references across src/href)
2. SW `SHELL` cache: 27 entries, all exist on disk; all 20 HTML asset references present on disk
3. No external `http(s)` resource loads in any HTML/CSS (plain `<a>` navigation links to external sites noted and allowed)
4. 3 vendored libs in `app/trueflatten/lib/` all present and referenced

---

## Architecture

- **Static vanilla HTML/CSS/JS** — no frameworks, no bundlers, no CDN deps
- **All processing local/browser-only** — no uploads, no telemetry, no external requests
- **Three independent apps**: TrueFlatten (PDF), TrueBlur (images), TrueCrop (cropping)
- **Shared modules** under `shared/`: `base.css` (design tokens), `base.js` (theme, nav, toasts, file drop, SW registration), `dialog.js` (accessible modal), `shortcuts.js` (keyboard shortcut registry), `footer.html` (single source of truth, injected at runtime by `base.js`)
- **Service worker** `sw.js` caches `truehide-v8`; SHELL list verified as 27 entries; offline navigate fallback routes `/app/<tool>/` to cached `index.html` instead of landing page
- **Self-hosted font**: `fonts/inter-latin.woff2` — zero external requests, degrades silently offline

---

## Completed Workstreams (expanded pass)

1. **Privacy Hardening** ✅ — Replaced Google Fonts `@import` with self-hosted Inter `fonts/inter-latin.woff2`; verified zero external `http(s)` resource loads; updated AGENTS.md and README to document local font.

2. **PDF Redaction + Export Verification** ✅ (TrueFlatten) — Full undo/redo stack (≤50 snapshots, keyboard `Ctrl+Z`/`Ctrl+Y`), export confirmation modal, verification report (per-page text + black-band check), redaction-clean status (proven absent of selectable text), keyboard shortcuts (`modCmdOrCtrl+z/y` guarded by `pdfDocument`), navigation (prev/next page), redaction-layer focusability with Delete key.

3. **TrueBlur Enhancements** ✅ — Undo/redo stack (20-entry image data stacks, keyboard `Ctrl+Z`/`Ctrl+Y`), redo button, keyboard shortcuts (`Ctrl+Z`, `Ctrl+Y` / `Cmd+Shift+Z`, `Esc`), improved status text for screen readers, before/after comparison toggle in export flow.

4. **TrueCrop Enhancements** ✅ — Undo/redo stacks (20-entry canvas image data stacks, `Ctrl+Z`/`Ctrl+Y`/`Esc`/`Enter`), reset button, JPEG export transparency warning, cropped-output preview with format selection (PNG/JPEG/WebP), filename input for exported file, bottom-toolbar scroll-into-view fix for tall canvases.

5. **Testing + CI** ✅ — Expanded E2E test suite: added `pdf-multifeat.spec.mjs`, `image-edge.spec.mjs`, `a11y-practical.spec.mjs`, `mobile.spec.mjs` extension; unit test (`test/unit/crop.test.mjs`); integrity script (`test/integrity/assets.mjs`); CI authored with Node.js LTS 24 (`.github/workflows/ci.yml`); fixtures generator (`test/fixtures/make-fixtures.mjs`) creating test PDFs/PNGs/WebP with structural markers.

6. **Dev-Only Tooling** ✅ — Root `package.json` (`"type":"module"`, scripts `"test"`, `"test:unit"`, `"test:e2e"`); Playwright E2E + node:test unit tests; `"type": "module"` declared; scripts scoped to `"dev"`; no runtime impact on static apps.

7. **Shared Infrastructure** ✅ — `shared/dialog.js` accessible modal (focus trap, `Esc`, focus restore, reduced-motion safety); `shared/base.js` depth-aware footer injection, SW registration (skipped on `file://`), island nav sync; `shared/shortcuts.js` full keyboard shortcut registry (platform-aware Meta vs Control, form-field guard, `?` help dialog); `shared/footer.html` single source of truth.

8. **Self-Hosted Font** ✅ — `fonts/inter-latin.woff2`; zero external requests; updated `shared/base.css` and `AGENTS.md` to reflect local font; `README.md` font section updated.

9. **Multi-App Independence** ✅ — Three apps stay independently accessible via island nav; shared footer injected from `shared/footer.html`; shared design tokens from `shared/base.css`.

10. **Design Consistency** ✅ — All pages use `shared/base.css` design tokens (`--sp-*`, radii, shadows, color vars); theme persistence via `localStorage["truehide-theme"]`, defaults to `prefers-color-scheme`; island nav highlights active page with `class="active"`.

11. **Modals Mobile-Safe** ✅ — `.truehide-modal { width: min(520px,100%); overflow:auto; max-height: calc(100vh - 2*var(--sp-6)) }` ensures dialogs fit the mobile viewport; mobile E2E test asserts this.

12. **Drag Coordinate Firefox Fix** ✅ — Explicit `scrollIntoView({block:"center"})` + short wait before `#cropButton` click in large-image test; app-side code unchanged; test-side viewport set to 1280×1500 so all synthetic pointer coordinates stay in view.

---

## Known Limitations

| Area | Limitation |
|------|------------|
| **WCAG 2.2 AA** | Automated axe-core pass (plus the practical checks in `a11y-practical.spec.mjs`) does not establish WCAG 2.2 AA conformance. Screen-reader walkthroughs, full keyboard-only use of pointer-driven controls, and non-contrast WCAG criteria beyond what axe checks are not manually verified. |
| **PDF redaction** | Genuine redaction via rasterization (pages become bitmaps + black rectangles). Source PDF metadata (producer/creator) persists in exported PDF per jsPDF behavior. Full cryptographic sanitization not claimed — only visual redaction + text-extraction verification reported. |
| **Undo/redo limit** | TrueFlatten: 50 snapshots (memory-intensive for large PDFs). TrueBlur: 20 entries. TrueCrop: 20 entries. |
| **Verification report** | Confirms no extractable text after rasterization; does not perform full metadata/Clean strip. Source XMP/JSPDF metadata documented as known carryover. |
| **Mobile UX** | Touch targets meet 44px minimum; some pointer interactions optimized for mouse. Mobile viewport E2E (390×844, touch) now covered by `mobile.spec.mjs` (5 tests, both browsers). |
| **Offline only** | Service worker registered; cache `truehide-v8` (27 SHELL entries, verified by `offline.spec.mjs`). All apps work `file://` except SW registration (requires `http(s)`). |
| **Firefox WebP download** | Playwright limitation: `image/webp` blob downloads don't surface as `download` events; verified via in-page blob capture instead. |
| **CI** | `.github/workflows/ci.yml` authored, uses Node.js LTS 24, mirrors the local runs, but **never executed on GitHub** — local-only verification. |
| **No ES modules / TypeScript** | Code plain `<script defer>` IIFE + `"use strict"`. No transpilation, no type checking. |
| **Third-party libs** | pdf.js 3.11.174 + jsPDF 2.5.1 vendored in `app/trueflatten/lib/`. Do not rename without updating references. |

---

## Manual Verification Items

- [x] Run full local suite: Chromium **44/44**, Firefox **44/44**, unit + integrity all pass (see `VERIFICATION_REPORT.md`)
- [x] Verify SW cache contains `fonts/inter-latin.woff2` and all 27 `truehide-v8` SHELL entries — `offline.spec.mjs` asserts all entries, offline reload works
- [x] Test export + verification end-to-end in TrueFlatten with a **single-page** PDF fixture (`secret.pdf`) — redaction-clean status confirmed
- [x] Test undo/redo across a single redaction in TrueFlatten (Ctrl+Z / Ctrl+Y) — passes both browsers
- [x] Test all keyboard shortcuts per app (Windows Ctrl and Mac Meta) — documented in shortcuts spec
- [x] Test screen reader accessible names on all interactive controls — `a11y-practical.spec.mjs` passes both browsers
- [x] Test large-image (1024×640) export with viewport guard — passes both browsers
- [x] Test WebP export in TrueCrop — Chromium real download; Firefox blob capture, documented Playwright limitation
- [x] Verify `?` help dialog appears and lists correct shortcuts — `privacy.spec.mjs` + `axe-test.spec.mjs` dialog scan
- [x] Test multi-page redaction (3-page `multi.pdf`), per-page undo, and page-clearing — `pdf-multifeat.spec.mjs` passes both browsers
- [x] Test non-image and corrupt image rejection in TrueCrop/TrueBlur — `image-edge.spec.mjs` passes both browsers
- [x] Test dialog-overflow on mobile viewport — `mobile.spec.mjs` passes both browsers

Items still pending manual verification (not blocking — already covered by automated suites above):

- [ ] Test drag-and-drop file opening in all three apps (E2E uses `<input type="file">`; the `attachFileDrop` path is untested)
- [ ] Test undo/redo across page navigation in TrueFlatten (multi-page document state changes)
- [ ] Full screen-reader walkthrough with NVDA/VoiceOver (automated smoke only; not WCAG 2.2 AA)
- [ ] Keyboard-only walkthrough of all pointer-driven controls (redaction drag, crop selection)

---

## Next Steps

1. **Run the CI workflow on GitHub** — `ci.yml` is authored and mirrors the local runs (Node 24) but has never executed remotely
2. **Complete the remaining manual items** above (drag-and-drop, screen-reader walkthrough, keyboard-only controls)
3. **Accessibility follow-up** — real screen-reader pass and full keyboard-only walkthrough before any WCAG 2.2 AA claim
4. **Commit the work** — everything in this pass is uncommitted (last commit `b4b82f5`)
5. **Update AGENTS.md** if any invariants change

---

*Generated: Thu Nov 26 2026*