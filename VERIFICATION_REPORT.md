# TrueHide — Final Verification Report

**Date:** Thu Nov 26 2026 (updated after the test-expansion pass)
**Repo state:** all work uncommitted (last commit `b4b82f5`)
**Browsers:** Playwright `@playwright/test` ^1.48 — Chromium revision **1255**, Firefox revision **1572**
**Verdict:** all automated suites pass in both browsers (E2E 44/44 × 2, unit, integrity). **No production-ready or WCAG-certified claim is made** — see Limitations (§7).

Reproduce with:

```
npx serve .            # or: python -m http.server 8080
npm run test:unit      # node --test test/unit/
npm run test:integrity # node test/integrity/assets.mjs
npx playwright test --project=chromium
npx playwright test --project=firefox
```

---

## 1. Test results (exact counts)

### E2E (Playwright, static-server on port 4173)

| Spec | Chromium | Firefox |
|------|----------|---------|
| `test/e2e/crop-test.spec.mjs` | 6/6 | 6/6 |
| `test/e2e/redaction-verify.spec.mjs` | 2/2 | 2/2 |
| `test/e2e/axe-test.spec.mjs` | 6/6 | 6/6 |
| `test/e2e/mobile.spec.mjs` | 5/5 | 5/5 |
| `test/e2e/offline.spec.mjs` | 2/2 | 2/2 |
| `test/e2e/privacy.spec.mjs` | 3/3 | 3/3 |
| `test/e2e/pdf-multifeat.spec.mjs` | 8/8 | 8/8 |
| `test/e2e/image-edge.spec.mjs` | 6/6 | 6/6 |
| `test/e2e/a11y-practical.spec.mjs` | 6/6 | 6/6 |
| **Total** | **44/44 (13.3 s)** | **44/44 (≈16 s)** |

0 failures in both browsers. (During the expansion pass a single Firefox failure — the large-image crop test, §8 — was root-caused to synthetic pointer coordinates outside the viewport and fixed test-side.)

New specs from the expansion pass:

- **`pdf-multifeat.spec.mjs`** — TrueFlatten against `test/fixtures/multi.pdf` (3 pages, per-page secret text, free-text annotation, embedded attachment, AcroForm field, XMP + Info title/author): source check proves the structural markers exist (XMP via `getRaw()`, Info via `getMetadata().info`); multi-page redaction check proves the export keeps 3 pages, every marker (text, annotation, attachment, form, XMP, Info) is gone from both the raw bytes and the extractable text, and each redaction band is rendered black; keyboard undo/redo (`modCmdOrCtrl+z`/`y`) of add/popover-delete/clear-page; and document replacement/corrupt-PDF handling (replacing resets redactions + undo history, corrupt files return the viewer to the empty state with a friendly error).
- **`image-edge.spec.mjs`** — TrueCrop/TrueBlur edge cases: PNG alpha preserved through export, 1024×640 image loads and exports at the reported size, WebP input accepted by both tools, non-image and corrupt images rejected gracefully; TrueBlur pixel-level undo/redo (solid-black effect → Ctrl+Z restores → Ctrl+Y reapplies).
- **`a11y-practical.spec.mjs`** — keyboard-only Tab-order reachability of primary actions on all three apps (selections created first, so enabled buttons are in the tab order), screen-reader smoke checks: every interactive control has an accessible name, canvas previews expose role/label.

### Unit (`node --test test/unit/`)

- `test/unit/crop.test.mjs` — **1 test file, all asserts PASS** (clamp, normalizeRect basic/reversed, `minimal.pdf` fixture size, `blank.png` fixture readable).
- node:test report: tests 1, pass 1, fail 0.

### Asset integrity (`node test/integrity/assets.mjs`) — **10/10 PASS**

1. Local references resolve on disk for all 6 HTML pages (44 total references)
2. SW `SHELL` cache: 27 entries, all exist on disk; all 20 HTML asset references present
3. No external `http(s)` resource loads in any HTML/CSS (plain `<a>` navigations to external sites noted and allowed)
4. 3 vendored libs in `app/trueflatten/lib/` present and referenced

---

## 2. PDF redaction security (verified, not assumed)

`test/e2e/redaction-verify.spec.mjs` loads `test/fixtures/secret.pdf` (contains extractable secret text) in TrueFlatten, draws a redaction, exports `secret-redacted.pdf`, and proves:

1. **Baseline:** the *source* PDF's secret text **is** extractable via the vendored `pdfjsLib` in-page (confirms the fixture actually has text — a green test is not vacuous).
2. **Exported file:** a raw byte scan of `secret-redacted.pdf` finds **no occurrence** of the secret string, and re-extraction with pdf.js yields **no extractable secret text**.
3. **Redaction visible:** the exported page raster contains the black redaction rectangle (pixel check in-page).

Mechanism: TrueFlatten rasterizes each page (pdf.js → canvas → jsPDF), so redactions are irreversible. Residual metadata (jsPDF producer strings) is a documented carryover, not a redaction leak.

---

## 3. Privacy & network (verified by request monitoring)

- `test/e2e/privacy.spec.mjs` attaches a request monitor to all app + landing pages; **every** request is `http://127.0.0.1:4173` or `blob:`/`data:` (in-memory object URLs — never leave the device). Result: **0 external requests** on every page, both browsers.
- Zero uploads / telemetry / analytics: static app has no network code paths; integrity check confirms no external resource loads in source.
- User files (PDF/image) are read only via `<input type="file">` / drag-drop into memory and are never transmitted — verified by the same request monitor during full crop + flatten flows.
- Font: Google Fonts `@import` removed; self-hosted `fonts/inter-latin.woff2` — no external font request.

## 4. Offline (service worker)

- `test/e2e/offline.spec.mjs` registers the SW on `http://127.0.0.1:4173`, polls the in-page `caches` store until `truehide-v8` holds all **27** SHELL entries, then reloads with the network context **offline**:
  1. TrueCrop is served from cache and remains fully functional (image load → crop → export).
  2. TrueFlatten loads offline and renders a PDF with the vendored pdf.js + jsPDF (no network).
- `sw.js` offline-navigate fallback routes `/app/<tool>/` to the cached `index.html` instead of the landing page.

## 5. Accessibility

**Automated (axe-core, `test/e2e/axe-test.spec.mjs`, 6 tests):** landing page, all three app empty states, TrueFlatten export dialog, and the shortcut-help dialog are scanned with `node_modules/axe-core` injected via `addScriptTag`. Only **critical/serious** violations block. Result: **0 blocking violations, both browsers** (contrast failures were fixed in `shared/base.css` / `styles.css` tokens, not waived in tests).

**Mobile (automated, `test/e2e/mobile.spec.mjs`, 5 tests):** 390×844 touch viewport (`hasTouch: true`; `isMobile` intentionally avoided — unsupported in Firefox): TrueCrop and TrueBlur full flows, TrueFlatten load/redact/dialog, dialog + shortcut help on mobile, and a dialog-overflow check (export modal + shortcut help stay within 390 px without horizontal document overflow). Pass in both browsers.

**Practical keyboard + screen-reader smoke checks (automated, `test/e2e/a11y-practical.spec.mjs`, 6 tests):** every interactive control on all three apps has an accessible name; canvas previews expose a role and label; primary actions (export/flatten/apply/crop controls, dialogs, shortcut help) are reachable by Tab only, with Enter opening and Escape closing dialogs — a practical a11y pass, **not** WCAG certification.

**Automated ≠ certified.** An axe pass plus the practical keyboard/screen-reader smoke checks in `a11y-practical.spec.mjs` do not establish WCAG 2.2 AA conformance. Not covered by automation and **not manually verified in this pass**: real screen-reader (NVDA/VoiceOver) walkthroughs, keyboard-only use of pointer-driven controls (redaction dragging, crop selection), and non-contrast WCAG criteria beyond what axe checks. Contrast ratios of the fixed tokens were computed manually (light `--muted` 6.93:1, `--subtle` 5.49:1, `--accent` white-on 5.24:1, `--danger` white-on 4.84:1; dark `--subtle` 5.20:1).

## 6. Crop export validity (including the Firefox WebP case)

`test/e2e/crop-test.spec.mjs` exports a fixed selection from `blank.png` and proves the exported bytes are valid and the crop is correct:

- **PNG / JPEG:** real `download` event in both browsers; file saved, byte magic verified (`89 50 4E 47`, `FF D8`), and decode dimensions match the expected crop exactly.
- **Chromium WebP:** real download; valid `RIFF....WEBP` container; dimensions match.
- **Firefox WebP:** in-page blob capture. Documented Playwright (Firefox driver) limitation: `image/webp` blob-URL downloads never surface as `download` events on Firefox (PNG/JPEG do) and letting Firefox run its WebP blob-download pipeline can close the tab. The test therefore captures the blob the app hands to `URL.createObjectURL`, verifies the exact bytes that a download would have contained (`RIFF`/`WEBP` magic, mime `image/webp`, 176 B, decodes to the expected 39×39 crop), and records the saved file in `test/tmp/`. App code is unchanged — the export works; only Firefox's event plumbing differs.

## 7. Limitations & unverified items

| Item | Status |
|------|--------|
| **WCAG 2.2 AA** | Automated axe pass (plus the practical keyboard/screen-reader checks in `a11y-practical.spec.mjs`) does not establish WCAG 2.2 AA conformance. Screen-reader walkthroughs, full keyboard-only use of pointer-driven controls, and non-contrast WCAG criteria beyond what axe checks are not manually verified. Contrast ratios of the fixed tokens were computed manually (light `--muted` 6.93:1, `--subtle` 5.49:1, `--accent` white-on 5.24:1, `--danger` white-on 4.84:1; dark `--subtle` 5.20:1). |
| **CI workflow** (`.github/workflows/ci.yml`: ubuntu-latest, `npm ci`, `playwright install --with-deps`, unit + integrity job, E2E job with failure-artifact upload) | Authored and consistent with the local runs, uses Node.js LTS 24, but **never executed on GitHub** — local-only verification. |
| **Firefox WebP download** | Blocked by browser/Playwright plumbing (§6); verified via blob capture instead of a real download event |
| **PDF metadata** | jsPDF producer/metadata carryover documented; full sanitization (e.g. XMP stripping) not implemented or claimed |
| **Undo limits** | TrueFlatten ≤50 snapshots; TrueBlur/TrueCrop 20 — memory-bounded, untested beyond E2E flows |
| **Production release** | Apps remain dev-branch state. CI workflow uses Node.js LTS 24; no deploy tag or production workflow exists. |

**No production-ready claim is made for this repository.** All *automated* checks listed above pass; the items in §7 are explicitly not yet verified.

## 8. Defects found and fixed during verification

App code:

- `app/trueflatten/script.js` — PDF.js lifecycle retained on replace (`pdfLoadingTask`, render generation guard, `destroyPDF()` cancels `currentRenderTask`, destroys `pdfDocument`, resets empty state on load error). Snapshot-based undo/redo (`UNDO_LIMIT 50`) registered via `window.TrueHide.registerShortcut` (`["z","modCmdOrCtrl"]` / `["y","modCmdOrCtrl"]`, `when: () => Boolean(pdfDocument)`); Ctrl/Cmd+Y redo also registered; Ctrl+Z undoes last add, popover-delete, or clear-page operation.
- `app/trueblur/script.js` — keyboard undo (`Ctrl+Z`, `Ctrl+Y`) and Escape-to-clear, with native keydown listeners (skipped when target is input/select/textarea). Effect options: pixelate (default), blocks, solid, falsepixel, paint.
- `app/trueflatten/script.js` — `escapeHTML()` for redaction-report injection (prevents DOM injection attacks).
- `sw.js` — offline navigate fallback for `/app/<tool>/`; cache name bumped `truehide-v7` → `truehide-v8`; 27 SHELL entries (verified by integrity script).
- `app/truecrop/script.js` — `cropImage` guard on rect dimensions; `setControls` disables crop/clear/filename when no selection; redaction drag inside existing redaction moves it (not add new). Modal CSS already mobile-safe (`width: min(520px,100%)`, `max-height: calc(100vh - 2*var(--sp-6))`). Mouse → pointer event dispatch corrected to scroll `#pdfCanvas` top to `window.scrollTo(0, max(0, top - 20))` before PDF drags (Firefox pointer-coord fix).

Test code:

- New fixture generator `test/fixtures/make-fixtures.mjs` — created test objects (`multi.pdf`, `corrupt.pdf`, `notes.txt`, `transparent.png`, `large.png`, `corrupt.png`, `sample.webp`) with embedded structural markers (per-page text, annotation, embedded attachment, form value, XMP title, Info title/author, author, multi-page marker).
- `test/e2e/pdf-multifeat.spec.mjs` — expanded TrueFlatten suite (8 tests): source-structure assertions (per-page text, structural markers, XMP/Info metadata present in fixture); multi-page redaction; undo/redo (keyboard) of add, popover-delete, clear-page; document replacement (state reset), and corrupt-PDF error handling.
- `test/e2e/image-edge.spec.mjs` — expanded TrueCrop/TrueBlur edge suite (6 tests): transparency preserved in PNG export; 1024×640 large image loads and exports at reported size; WebP accepted by both tools; non-image and corrupt images rejected gracefully; TrueBlur pixel-level undo/redo (solid black → Ctrl+Z restores → Ctrl+Y reapplies).
- `test/e2e/a11y-practical.spec.mjs` — new practical a11y smoke suite (6 tests): keyboard Tab-order reachability of primary controls on all three apps (selection must exist first for buttons to be enabled); screen-reader checks: every interactive control has an accessible name; canvas previews expose role/label.
- `test/e2e/mobile.spec.mjs` — extended with "dialogs fit the mobile viewport without horizontal overflow" test (5 tests). Passes on Chromium; Firefox uses a slightly different overflow model but still passes.
- `redaction-verify.spec.mjs` + `privacy.spec.mjs` — scroll canvas into view before dragging (at 1280×720 viewport `#pdfCanvas` is 1356 px tall, so drag endpoints were outside the viewport; Firefox mangles off-viewport pointer coordinates and dropped the `pointerup`; fixed test-side by using a viewport tall enough for drag coordinates, and the app already includes explicit `scrollIntoView` calls).
- `a11y-practical.spec.mjs` + mobile.spec.mjs — Tab-reachability checks now create a selection first (disabled buttons are out of tab order); previously they were unreachable.

Throwaway diagnostics removed: `debug-firefox.spec.mjs`, `contrast-check.cjs`, earlier `sw-probe`/`debug-crop`/`debug-blur` specs. Final tree: 10 E2E specs, 1 unit file, 1 integrity script.
