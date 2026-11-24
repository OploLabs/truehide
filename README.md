# TrueHide [![Privacy-first tools for documents and images.](https://img.shields.io/badge/Privacy-first%20tools-%F0%9F%9B%A1%EF%B8%8F?color=green)](https://github.com/shawn/truehide)

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
- **Offline-ready** — works without an internet connection once loaded.
- **Open-source** — audit the code yourself.
- **PWA-enabled** — installable on desktop and mobile.

---

## Getting started

Just open [`index.html`](./index.html) in any modern browser (Chrome, Firefox, Edge, Safari). No build step, no dependencies to install.

Alternatively, serve it locally:

```bash
npx serve .
# or
python -m http.server 8080
```

Then visit `http://localhost:8080`.

### GitHub Pages

A CI workflow deploys the full site automatically on push to `main`:
`.github/workflows/deploy.yml` → GitHub Pages

---

## Stack

- **Vanilla HTML / CSS / JavaScript** — no frameworks
- **[pdf.js](https://mozilla.github.io/pdf.js/)** + **[jsPDF](https://parall.ax/products/jspdf)** for TrueFlatten
- **Canvas API** for TrueBlur and TrueCrop
- **Service worker** with cache-first strategy for offline use
- GitHub Actions for automatic deployment
- **PWA** with installable icons

---

## Privacy notes

TrueBlur's _Pixelate_ and _Blocks_ modes are visual obfuscation — they don't guarantee irreversible redaction on their own. For sensitive information, use **Solid black redaction** instead. TrueFlatten converts pages to images before flattening, which is the most reliable way to remove metadata and selectable text.

Always inspect your downloaded output before sharing.

---

## License

MIT — do whatever you want with it.
