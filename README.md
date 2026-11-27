# TrueHide [![Privacy-first tools for documents and images.](https://img.shields.io/badge/Privacy-first%20tools-%F0%9F%9B%A1%EF%B8%8F?color=green)](https://github.com/OploLabs/truehide)

Privacy-first tools for documents and images. Everything runs locally in your browser — no uploads, no accounts, no tracking.

---

## Tools

| Tool                              | What it does                                                                                                        | Best for                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [TrueFlatten](./app/trueflatten/) | Flatten PDFs and permanently burn redactions into every page by rasterizing.                                        | Documents that must not allow text extraction after redaction. |
| [TrueBlur](./app/trueblur/)       | Destructively transform selected image areas with randomized processing (pixelate, blocks, solid redaction, paint). | Obscuring faces, license plates, and sensitive visual details. |
| [TrueCrop](./app/truecrop/)       | Crop exactly what you select and download the result in PNG, JPEG, or WebP.                                         | Removing extra context from images before sharing.             |

---

## Why TrueHide?

Most online editors process your files on a remote server. TrueHide processes everything **locally** using Web APIs in your browser:

- **Zero network requests** for file data — your documents and images never leave your device.
- **No accounts or sign-ups** required.
- **Offline-ready** — a service worker caches the whole app; it works without an internet connection once loaded.
- **Open-source** — audit the code yourself.
- **PWA-enabled** — installable on desktop and mobile.

---

## Getting started

Just open [`index.html`](./index.html) in any modern browser (Chrome, Firefox, Edge, Safari). No build step, no dependencies to install.

Alternatively, serve it locally (recommended so the service worker and PWA features work):

```bash
npx serve .
# or
python -m http.server 8080
```

Then visit `http://localhost:8080`.

---

## Project structure

```
.
├── index.html            # Landing page (hero, tool cards, privacy explainer)
├── styles.css            # Landing-page styles
├── script.js             # Landing-page behavior (PWA install prompt)
├── manifest.json         # PWA manifest
├── sw.js                 # Service worker (cache-first, offline support)
├── icons/                # PWA / favicon icons (SVG)
├── fonts/                # Local web fonts (Inter, woff2) — no external fetches
├── shared/
│   ├── base.css          # Design system: CSS tokens, shared components, themes
│   ├── base.js           # Shared behavior: theme, island nav, toasts, file drop,
│   │                     # shared footer injection, service worker registration
│   ├── dialog.js         # Shared modal/dialog primitives
│   ├── shortcuts.js      # Shared keyboard-shortcut registration + help dialog
│   └── footer.html       # Canonical footer — fetched & injected at runtime by base.js
├── docs/                 # Privacy audit + security posture pages
├── test/                 # Dev-only test tooling (unit, E2E, integrity, fixtures)
└── app/
    ├── trueflatten/      # PDF redaction + flattening (pdf.js + jsPDF, vendored in lib/)
    ├── trueblur/         # Image redaction: pixelate, blocks, solid, paint
    └── truecrop/         # Image cropping, PNG/JPEG/WebP export
```

---

## Stack

- **Vanilla HTML / CSS / JavaScript** — no frameworks, no build step in the apps themselves. A dev-only root `package.json` exists solely for the test tooling (Playwright E2E, `node:test` unit tests, integrity checks); it ships no runtime dependencies and is not required to run the site.
- **[pdf.js 3.11.174](https://mozilla.github.io/pdf.js/)** + **[jsPDF 2.5.1](https://parall.ax/products/jspdf)** for TrueFlatten — vendored locally in `app/trueflatten/lib/`, no CDNs
- **Canvas API** for TrueBlur and TrueCrop
- **Service worker** with a cache-first strategy for offline use
- **PWA** with installable icons

---

## Privacy notes

TrueBlur's _Pixelate_ and _Blocks_ modes are visual obfuscation — they don't guarantee irreversible redaction on their own. For sensitive information, use **Solid black redaction** instead. TrueFlatten converts pages to images before flattening, which is the most reliable way to remove metadata and selectable text.

Always inspect your downloaded output before sharing.

All assets load from the local filesystem — there are **no external resource requests** at all. The Inter typeface is a local `.woff2` file loaded via `@font-face` (see `shared/base.css` and `fonts/`); it degrades silently to the system font stack if the file is missing. No file data, telemetry, or analytics are ever sent anywhere.

---

## License

MIT — do whatever you want with it.
