// Shared accessible modal dialog.
//
// Usage:
//   const overlay = window.TrueHide.showModal({
//     title: "Export PDF",
//     content: "<p>…</p>",                 // HTML string, or a DOM node to clone
//     buttons: [
//       { label: "Flatten & Download", kind: "primary", id: "flattenConfirm" },
//       { label: "Cancel", kind: "default", id: "cancelButton" },
//     ],
//   });
//   // Wire clicks on the returned overlay element:
//   overlay.querySelector("#flattenConfirm").addEventListener("click", doExport);
//   window.TrueHide.hideModal();            // close the most recently opened modal
//
// Behavior:
//   - role="dialog" + aria-modal="true", labelled/described by title + content
//   - focus is trapped (Tab/Shift+Tab cycle through modal controls)
//   - Esc or clicking the backdrop closes the modal
//   - focus returns to the element that had focus before the modal opened
//   - one modal at a time: opening a new one closes the previous one
//
// Note: string content is assigned to innerHTML as-is — callers are
// responsible for escaping any user-controlled fragments (see
// app/trueflatten/script.js, which escapes the file name before interpolating).

(function () {
  "use strict";

  let modalIdCounter = 0;
  let active = null; // { overlay, previouslyFocused, close }

  function focusableElements(container) {
    return [
      ...container.querySelectorAll("button:not([disabled])"),
      ...container.querySelectorAll('a[href]'),
      ...container.querySelectorAll("input:not([disabled])"),
      ...container.querySelectorAll("select:not([disabled])"),
      ...container.querySelectorAll("textarea:not([disabled])"),
      ...container.querySelectorAll('[tabindex]:not([tabindex="-1"])'),
    ];
  }

  function showModal({ title = " ", content, buttons = [] } = {}) {
    // One modal at a time
    if (active) active.close();

    const id = `truehide-modal-${++modalIdCounter}`;

    const overlay = document.createElement("div");
    overlay.id = `truehide-modal-overlay-${id}`;
    overlay.className = "truehide-modal-overlay";
    overlay.setAttribute("role", "presentation");
    overlay.tabIndex = -1;

    // Remember focused element before modal opens
    const previouslyFocused = document.activeElement;

    const modal = document.createElement("div");
    modal.id = `truehide-modal-dialog-${id}`;
    modal.className = "truehide-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", `truehide-modal-title-${id}`);
    modal.setAttribute("aria-describedby", `truehide-modal-content-${id}`);

    const titleEl = document.createElement("h2");
    titleEl.id = `truehide-modal-title-${id}`;
    titleEl.textContent = title;

    const contentEl = document.createElement("div");
    contentEl.id = `truehide-modal-content-${id}`;
    contentEl.className = "truehide-modal-content";
    if (typeof content === "string") {
      contentEl.innerHTML = content; // trusted HTML; caller escapes user data
    } else if (content && content instanceof Node) {
      contentEl.appendChild(content.cloneNode(true));
    }

    const buttonsEl = document.createElement("div");
    buttonsEl.className = "modal-buttons";

    for (const { label, kind = "default", id: buttonId, onclick } of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `button ${kind}`;
      if (buttonId) btn.id = buttonId;
      btn.textContent = label;
      if (onclick) btn.addEventListener("click", onclick);
      buttonsEl.appendChild(btn);
    }

    modal.appendChild(titleEl);
    modal.appendChild(contentEl);
    modal.appendChild(buttonsEl);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.setAttribute("data-truehide-modal", id);

    // Focus trap: Tab / Shift+Tab cycle, Esc closes
    const focusable = focusableElements(modal);

    function focusNext() {
      if (!focusable.length) return;
      const i = focusable.indexOf(document.activeElement);
      focusable[(i + 1) % focusable.length].focus();
    }

    function focusPrev() {
      if (!focusable.length) return;
      const i = focusable.indexOf(document.activeElement);
      focusable[(i - 1 + focusable.length) % focusable.length].focus();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) focusPrev();
        else focusNext();
      }
    }

    function handleBackdropClick(event) {
      if (event.target === overlay) close();
    }

    modal.addEventListener("keydown", handleKeyDown);
    overlay.addEventListener("click", handleBackdropClick);

    // Initial focus: the primary button, else the first focusable control
    modal.tabIndex = -1;
    const initial =
      modal.querySelector(".button.primary") || focusable[0] || modal;
    initial.focus();

    let record = null;

    function close() {
      if (!overlay.parentNode) return; // already closed
      modal.removeEventListener("keydown", handleKeyDown);
      overlay.removeEventListener("click", handleBackdropClick);
      document.body.removeAttribute("data-truehide-modal");

      // Restore focus to the trigger (if it is still in the document)
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }

      document.body.removeChild(overlay);
      if (active === record) active = null;
    }

    record = { overlay, close };
    active = record;

    // Return the overlay so callers can wire buttons into modal content
    return overlay;
  }

  function hideModal() {
    if (active) active.close();
  }

  window.TrueHide = window.TrueHide || {};
  window.TrueHide.showModal = showModal;
  window.TrueHide.hideModal = hideModal;
})();
