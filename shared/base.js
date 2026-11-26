/* TrueHide — shared base behavior.
   Theme, navigation, toasts, drag & drop. Loaded on every page. */

(function () {
  "use strict";

  /* ---------------- Theme ---------------- */

  const root = document.documentElement;
  const THEME_KEY = "truehide-theme";

  function storedTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === "dark" || value === "light" ? value : null;
    } catch {
      return null;
    }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#101216" : "#f4f5f8");
  }

  const initial =
    storedTheme() ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");
  applyTheme(initial);

  const themeToggle = document.getElementById("themeToggle");

  function updateThemeIcon() {
    if (!themeToggle) return;
    const dark = root.dataset.theme === "dark";
    themeToggle.querySelector("svg").outerHTML = dark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>';
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage unavailable; theme still applies for this session */
      }
      updateThemeIcon();
    });
    updateThemeIcon();
  }

  /* ---------------- Island navigation ---------------- */

  const island = document.getElementById("island");
  const islandToggle = document.getElementById("islandToggle");

  if (island && islandToggle) {
    function closeMenu() {
      island.classList.remove("open");
      islandToggle.setAttribute("aria-expanded", "false");
    }

    islandToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = island.classList.toggle("open");
      islandToggle.setAttribute("aria-expanded", String(open));
    });

    island.addEventListener("click", (event) => {
      if (event.target.closest(".island-menu a")) closeMenu();
    });

    document.addEventListener("click", (event) => {
      if (!island.contains(event.target)) closeMenu();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) closeMenu();
    });
  }

  /* ---------------- Toasts ---------------- */

  let stack = null;

  function getStack() {
    if (stack) return stack;
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
    return stack;
  }

  function toast(message, options) {
    const opts = options || {};
    const el = document.createElement("div");
    el.className = "toast " + (opts.kind || "info");
    el.textContent = message;
    getStack().appendChild(el);

    while (stack.children.length > 3) {
      stack.removeChild(stack.firstChild);
    }

    requestAnimationFrame(() => el.classList.add("visible"));

    const duration = opts.duration || 2800;

    setTimeout(() => {
      el.classList.remove("visible");
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  /* ---------------- Shared file drop ----------------
     attachFileDrop({ accept, onFile, rejectMessage })
     accept(file) -> boolean; onFile(file) runs on drop.
     Requires a <div class="drop-overlay" id="dropOverlay"> in the page. */

  function attachFileDrop(config) {
    const overlay = document.getElementById("dropOverlay");
    if (!overlay) return;

    let depth = 0;

    const hasFiles = (event) =>
      Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes("Files");

    document.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      overlay.classList.add("visible");
    });

    document.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.classList.remove("visible");
    });

    document.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      overlay.classList.remove("visible");

      const files = Array.from(event.dataTransfer.files);
      const file = files.find((f) => config.accept(f));

      if (file) {
        config.onFile(file);
      } else if (files.length) {
        toast(config.rejectMessage || "Unsupported file type.", { kind: "error" });
      }
    });
  }

  window.TrueHide = {
    toast,
    attachFileDrop,
  };

  /* ---------------- Shared footer ----------------
     The footer markup lives in shared/footer.html (single source of truth).
     It is fetched and injected into the [data-shared-footer] placeholder,
     with internal links prefixed for this page's depth. */

  const isAppPage = document.baseURI.includes("/app/");
  const rootPrefix = isAppPage ? "../../" : "./";

  function injectFooter(html) {
    const placeholder = document.querySelector("[data-shared-footer]");
    if (!placeholder) return;

    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const footer = template.content.querySelector("footer");
    if (!footer) return;

    // Prefix internal links so they resolve from this page's depth.
    footer.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href || /^(?:https?:|\/\/|mailto:|tel:)/i.test(href)) return;

      if (href[0] === "#") {
        // Page-local anchors stay on this page; on app pages the #privacy
        // anchor lives on the homepage.
        anchor.setAttribute("href", (isAppPage ? "../../" : "") + href);
      } else {
        anchor.setAttribute("href", rootPrefix + href);
      }
    });

    // Keep the copyright year current.
    const year = footer.querySelector("#year");
    if (year) year.textContent = String(new Date().getFullYear());

    placeholder.replaceWith(footer);
  }

  if (document.querySelector("[data-shared-footer]")) {
    fetch(rootPrefix + "shared/footer.html")
      .then((response) => {
        if (!response.ok) throw new Error(response.status);
        return response.text();
      })
      .then(injectFooter)
      .catch(() => {
        // Fetch unavailable (e.g. opened via file://, where the browser
        // blocks it): keep a minimal footer so the page is not left bare.
        injectFooter(
          '<footer class="site-footer site-footer--full"><div class="footer-col"><span class="footer-brand"><span class="brand-icon" aria-hidden="true"></span><strong>TrueHide</strong></span><p>Free, private file tools. Everything is processed locally in your browser — no uploads, no accounts.</p></div><div class="footer-col footer-col--meta"><span>© <span id="year"></span> TrueHide</span><span class="footer-plain">Private by design.</span></div></footer>',
        );
      });
  }

  if ("serviceWorker" in navigator && !location.protocol.startsWith("file:")) {
    const swPath = document.baseURI.includes("/app/") ? "../../sw.js" : "sw.js";
    navigator.serviceWorker.register(swPath).catch(() => {
      /* offline support unavailable; the site still works online */
    });
  }
})();
