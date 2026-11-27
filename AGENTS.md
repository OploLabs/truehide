# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

TrueHide is a privacy-first, fully static web app (PWA) for redacting and
transforming documents and images. All processing happens in the browser:
no backend, no build step in the apps, no runtime frameworks. The apps are
plain HTML / CSS / JavaScript only. A dev-only root `package.json` exists
strictly for test tooling (Playwright E2E, `node:test` unit tests, integrity
checks) and is not a runtime dependency.

## Non-negotiable invariants

- **No network requests for user data.** Never add upload endpoints,
  telemetry, analytics, or any code path that sends file contents off-device.
- **No CDN dependencies.** All third-party libraries are vendored locally
  (see `app/trueflatten/lib/`). If a new library is needed, add it as a
  local file.
- **No external resource requests.** All assets load locally; the Inter
  typeface is a local `.woff2` (`fonts/`) loaded via `@font-face` in
  `shared/base.css` and degrades silently to system fonts when missing.
  Do not add external requests, CDNs, or new fonts.
- **Originals are never modified.** Tools work on in-memory copies and hand
  back a downloaded export.
- **Dev-only tooling exception.** A `package.json` at the repository root is
  permitted for development tools only (Playwright E2E, node:test unit tests).
  It must not be published, must not add runtime dependencies to the apps, and
  must declare `"type": "module"` with scripts scoped to `"dev"` (e.g. `"test"`,
  `"test:unit"`, `"test:e2e"`). The static apps (`index.html`, `app/*/`) remain
  framework-/bundler-/CDN-free and run without `package.json` at runtime.

## Project layout

```
index.html / styles.css / script.js   Landing page (hero, tool cards, install prompt)
manifest.json                          PWA manifest (SVG icons in icons/)
sw.js                                  Service worker, cache-first
fonts/                                 Local web fonts (Inter woff2)
docs/                                  Privacy audit + security posture pages
shared/
  base.css                             Design system: CSS custom properties on
                                       :root and [data-theme="dark"], shared components
  base.js                              Theme toggle, island nav, toasts, file drop,
                                       shared footer injection, service worker registration
  dialog.js                            Shared modal/dialog primitives (focus trap, Escape)
  shortcuts.js                         Keyboard-shortcut registry + shortcut-help dialog
  footer.html                          Canonical footer — the single source of truth;
                                       fetched & injected at runtime by base.js on every page
test/                                  Dev-only test tooling: unit, E2E, integrity, fixtures
app/
  trueflatten/  index.html, script.js, style.css, lib/{pdf.min.js, pdf.worker.min.js, jspdf.umd.min.js}
  trueblur/     index.html, script.js, style.css
  truecrop/     index.html, script.js, style.css
```

Tool facts:

- TrueFlatten: pdf.js 3.11.174 + jsPDF 2.5.1 (vendored, `app/trueflatten/lib/`).
  Rasterizes pages, so redactions are irreversible.
- TrueBlur: Canvas-based. Modes: pixelate, blocks, solid black (irreversible),
  paint. Pixelate/Blocks are visual obfuscation only.
- TrueCrop: Canvas crop; exports PNG, JPEG, WebP.

## Conventions

- **JS style:** plain `<script defer>` files, IIFE + `"use strict"`, no ES
  modules, no TypeScript, no bundler. Shared API on `window.TrueHide`:
  - `toast(message, { kind, duration })`
  - `attachFileDrop({ accept, onFile, rejectMessage })` — requires
    `<div class="drop-overlay" id="dropOverlay">` in the page.
- **CSS:** use the design tokens from `shared/base.css` (colors, spacing
  `--sp-*`, radii, shadows); do not hardcode colors. Theme is set via
  `data-theme` on `<html>`; persisted in `localStorage["truehide-theme"]`,
  defaults to `prefers-color-scheme`. Handle the theme in `shared/base.js`
  only.
- **Page depth:** app pages reference shared assets with `../../` prefixes
  (`../../shared/base.css`, `../../manifest.json`, `../../icons/...`).
- **Shared footer:** `shared/footer.html` is the single source of truth for
  the footer — pages never carry their own copy. Each page holds an empty
  `<footer class="site-footer site-footer--full" data-shared-footer></footer>`
  placeholder; `shared/base.js` fetches the file at runtime and injects it,
  prefixing internal links for the page's depth (homepage: `./`, app pages:
  `../../`). Internal links in the shared file are written relative to the
  site root (e.g. `app/trueblur/`, `#privacy`) — never hardcode page-relative
  paths there. If the fetch is unavailable (e.g. `file://`), a minimal
  fallback footer is injected instead.
- **Nav sync:** the island nav header is also duplicated per page; mark the
  current page's link with `class="active"`.
- **Service worker:** `sw.js` maintains a `SHELL` cache list; the cache name
  is `truehide-v8` (bump the version when the shell changes). Registration
  happens in `shared/base.js` and is skipped on `file://`.

## Running and testing

```bash
npx serve .
# or
python -m http.server 8080
```

Pages: `/`, `/app/trueflatten/`, `/app/trueblur/`, `/app/truecrop/`.

Test tooling (dev-only, run from the repo root after `npm install`):

```bash
npm run test:unit       # node --test unit tests (test/unit/)
npm run test:integrity  # asset/SHELL/privacy invariant checks (test/integrity/)
npm run test:e2e        # Playwright E2E (Chromium + Firefox, test/e2e/)
npm test                # unit + e2e + integrity in sequence
```

The service worker and PWA features require an `http(s)` origin, not
`file://`. E2E runs spin up a static server on port 4173 automatically
(`test/e2e/static-server.mjs`). There is no linter or type checker.

## Deployment status

`.github/workflows/ci.yml` runs the unit + integrity checks and the Playwright
E2E suite (Chromium and Firefox) on a dev-only Node.js LTS (24) with
`npx playwright install --with-deps`. The public repository is
`github.com/OploLabs/truehide`. There is no deploy workflow; the static site
can be hosted anywhere (GH Pages, etc.).

## Git

Short imperative commit messages, e.g. `Fix TrueBlur settings`,
`Add FalsePixel (Beta)`.

## Don't

- Don't introduce frameworks, build tools, or CDN `<script>` tags into the
  apps; the root `package.json` must stay dev-only test tooling with no
  runtime dependencies, and app code stays plain scripts (no ES modules).
- Don't add telemetry, logging services, or external fonts beyond what
  exists.
- Don't send user file data anywhere.
- Don't rename the vendored libs in `app/trueflatten/lib/` without updating
  the references in `app/trueflatten/index.html` and `sw.js`.
