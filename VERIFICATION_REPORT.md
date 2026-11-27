# TrueHide — Final Verification Report

**Date:** Thu Nov 26 2026
**Repo state:** all work uncommitted (last commit `b4b82f5`)
**Browsers:** Playwright `@playwright/test` ^1.48 — Chromium revision **1255**, Firefox revision **1572**
**Verdict:** all automated suites pass in both browsers. **No production-ready or WCAG-certified claim is made** — see Limitations (§7).

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
| `test/e2e/mobile.spec.mjs` | 4/4 | 4/4 |
| `test/e2e/offline.spec.mjs` | 2/2 | 2/2 |
| `test/e2e/privacy.spec.mjs` | 3/3 | 3/3 |
| **Total** | **23/23 (5.8 s)** | **23/23** |

0 failures in both browsers. (An initial Firefox run was 20/23; all 3 failures were root-caused and fixed — see §5.)

### Unit (`node --test test/unit/`)

- `test/unit/crop.test.mjs` — **1 test file, 6 internal checks, all PASS** (clamp, normalizeRect basic, normalizeRect reversed, `minimal.pdf` fixture, `blank.png` fixture readable, fixtures-present).
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

- `test/e2e/offline.spec.mjs` registers the SW on `http://127.0.0.1:4173`, polls the in-page `caches` store until `truehide-v7` holds all **27** SHELL entries, then reloads with the network context **offline**:
  1. TrueCrop is served from cache and remains fully functional (image load → crop → export).
  2. TrueFlatten loads offline and renders a PDF with the vendored pdf.js + jsPDF (no network).
- `sw.js` offline-navigate fallback routes `/app/<tool>/` to the cached `index.html` instead of the landing page.

## 5. Accessibility

**Automated (axe-core, `test/e2e/axe-test.spec.mjs`, 6 tests):** landing page, all three app empty states, TrueFlatten export dialog, and the shortcut-help dialog are scanned with `node_modules/axe-core` injected via `addScriptTag`. Only **critical/serious** violations block. Result: **0 blocking violations, both browsers** (contrast failures were fixed in `shared/base.css` / `styles.css` tokens, not waived in tests).

**Mobile (automated, `test/e2e/mobile.spec.mjs`, 4 tests):** 390×844 touch viewport (`hasTouch: true`; `isMobile` intentionally avoided — unsupported in Firefox): TrueCrop and TrueBlur full flows, TrueFlatten load/redact/dialog, dialog + shortcut help on mobile. Pass in both browsers.

**Automated ≠ certified.** An axe pass does not establish WCAG 2.2 AA conformance. Not covered by automation and **not manually verified in this pass**: screen-reader navigation, keyboard-only walkthroughs, and non-contrast WCAG criteria beyond what axe checks. Contrast ratios of the fixed tokens were computed manually (light `--muted` 6.93:1, `--subtle` 5.49:1, `--accent` white-on 5.24:1, `--danger` white-on 4.84:1; dark `--subtle` 5.20:1).

## 6. Crop export validity (including the Firefox WebP case)

`test/e2e/crop-test.spec.mjs` exports a fixed selection from `blank.png` and proves the exported bytes are valid and the crop is correct:

- **PNG / JPEG:** real `download` event in both browsers; file saved, byte magic verified (`89 50 4E 47`, `FF D8`), and decode dimensions match the expected crop exactly.
- **Chromium WebP:** real download; valid `RIFF....WEBP` container; dimensions match.
- **Firefox WebP:** in-page blob capture. Documented Playwright (Firefox driver) limitation: `image/webp` blob-URL downloads never surface as `download` events on Firefox (PNG/JPEG do) and letting Firefox run its WebP blob-download pipeline can close the tab. The test therefore captures the blob the app hands to `URL.createObjectURL`, verifies the exact bytes that a download would have contained (`RIFF`/`WEBP` magic, mime `image/webp`, 176 B, decodes to the expected 39×39 crop), and records the saved file in `test/tmp/`. App code is unchanged — the export works; only Firefox's event plumbing differs.

## 7. Limitations & unverified items

| Item | Status |
|------|--------|
| **WCAG 2.2 AA** | Automated axe pass only — **no certification claim**; screen-reader and keyboard-only paths not manually verified |
| **CI workflow** (`.github/workflows/ci.yml`: ubuntu-latest, `npm ci`, `playwright install --with-deps`, unit + integrity job, E2E job, failure-artifact upload) | Authored and consistent with the local runs, but **never executed on GitHub** — local-only verification |
| **Firefox WebP download** | Blocked by browser/Playwright plumbing (§6); verified via blob capture instead of a real download event |
| **PDF metadata** | jsPDF producer/metadata carryover documented; full sanitization (e.g. XMP stripping) not implemented or claimed |
| **Undo limits** | TrueFlatten ≤50 snapshots; TrueBlur/TrueCrop 20 — memory-bounded, untested beyond E2E flows |
| **Production release** | No tag, no deploy (`.github/workflows/` had no CI until this pass); apps remain dev-branch state |

**No production-ready claim is made for this repository.** All *automated* checks listed above pass; the items in §7 are explicitly not yet verified.

## 8. Defects found and fixed during verification

App code:

- `app/trueblur/script.js` — `redoStack` was never declared (`let redoStack = [];` added); `saveUndo` threw `ReferenceError`, so the redo path was dead.
- `shared/base.css` / `styles.css` — contrast-token fixes (values in §5); `.demo-redacted` selector specificity fix (`.demo-lines i.demo-redacted`).
- `sw.js` — offline navigate fallback for `/app/<tool>/`; cache `truehide-v7`, 27 SHELL entries.
- `app/trueflatten/script.js` — `escapeHTML()` for redaction-report injection.

Test code:

- `redaction-verify.spec.mjs` + `privacy.spec.mjs` — scroll the canvas into view before dragging: at the 1280×720 viewport `#pdfCanvas` is 1356 px tall, so drag endpoints were outside the viewport; Firefox mangles off-viewport pointer coordinates and dropped the `pointerup` (0 redactions). Chromium tolerated the coordinates, which is why the failures were Firefox-only.
- `crop-test.spec.mjs` — Firefox WebP capture path (§6).

Throwaway diagnostics removed: `debug-firefox.spec.mjs`, `contrast-check.cjs`, earlier `sw-probe`/`debug-crop`/`debug-blur` specs. Final tree: 6 E2E specs, 1 unit file, 1 integrity script.
