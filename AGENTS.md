# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

TrueHide is a privacy-first, fully static web app (PWA) for redacting and
transforming documents and images. All processing happens in the browser:
no backend, no build step, no frameworks, no `package.json`, no test
suite. Plain HTML / CSS / JavaScript only.

## Non-negotiable invariants

- **No network requests for user data.** Never add upload endpoints,
  telemetry, analytics, or any code path that sends file contents off-device.
- **No CDN dependencies.** All third-party libraries are vendored locally
  (see `app/trueflatten/lib/`). If a new library is needed, add it as a
  local file.
- **Known external request:** a Google Fonts `@import` (Inter) at the top of
  `shared/base.css`. It degrades silently offline. Do not add further
  external requests; ideally remove this one in a hardening pass.
- **Originals are never modified.** Tools work on in-memory copies and hand
  back a downloaded export.

## Project layout

```
index.html / styles.css / script.js   Landing page (hero, tool cards, install prompt)
manifest.json                          PWA manifest (SVG icons in icons/)
sw.js                                  Service worker, cache-first
shared/
  base.css                             Design system: CSS custom properties on
                                       :root and [data-theme="dark"], shared components
  base.js                              Theme toggle, island nav, toasts, file drop,
                                       footer year, service worker registration
  footer.html                          Canonical footer markup — INLINED into every
                                       page (homepage + 3 app pages), not fetched
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
- **Footer sync:** the footer in `shared/footer.html` is copied by hand into
  each of the 4 pages (homepage, trueflatten, trueblur, truecrop). When
  changing it, update all 4 and keep the relative links correct per depth.
- **Nav sync:** the island nav header is also duplicated per page; mark the
  current page's link with `class="active"`.
- **Service worker:** `sw.js` maintains a `SHELL` cache list; the cache name
  is `truehide-v4` (bump the version when the shell changes). Registration
  happens in `shared/base.js` and is skipped on `file://`.

## Running and testing

```bash
npx serve .
# or
python -m http.server 8080
```

Pages: `/`, `/app/trueflatten/`, `/app/trueblur/`, `/app/truecrop/`.

There is no test runner, linter, or type checker. Verify changes in the
browser. The service worker and PWA features require an `http(s)` origin, not
`file://`.

## Deployment status

`.github/workflows/` is currently empty — there is no CI/deploy workflow.
The public repository is `github.com/OploLabs/truehide`.

## Git

Short imperative commit messages, e.g. `Fix TrueBlur settings`,
`Add FalsePixel (Beta)`.

## Don't

- Don't introduce frameworks, build tools, `package.json`, ES modules, or
  CDN `<script>` tags.
- Don't add telemetry, logging services, or external fonts beyond what
  exists.
- Don't send user file data anywhere.
- Don't rename the vendored libs in `app/trueflatten/lib/` without updating
  the references in `app/trueflatten/index.html` and `sw.js`.
