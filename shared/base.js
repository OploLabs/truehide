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

  /* ---------------- Footer year ---------------- */

  const yearElement = document.getElementById("year");
  if (yearElement) yearElement.textContent = String(new Date().getFullYear());

  if ("serviceWorker" in navigator && !location.protocol.startsWith("file:")) {
    const swPath = document.baseURI.includes("/app/") ? "../../sw.js" : "sw.js";
    navigator.serviceWorker.register(swPath).catch(() => {
      /* offline support unavailable; the site still works online */
    });
  }
})();
