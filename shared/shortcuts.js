// Shared keyboard shortcut registry.
//
// Usage (in any app script):
//   window.TrueHide.registerShortcut({
//     keys: ["o", "modCmdOrCtrl"],     // "o" pressed with Cmd (Mac) or Ctrl (Win/Lin)
//     description: "Open file",
//     when: () => !isTypingInAnyField(), // optional guard; if falsy, shortcut is skipped
//     handler: () => { openFile(); },
//   });
//
//   window.TrueHide.registerShortcut({
//     keys: ["Z", "modCmdOrCtrl"],     // Undo
//     description: "Undo last action",
//     when: () => true,
//     handler: () => { undo(); },
//   });
//
//   window.TrueHide.registerShortcut({
//     keys: ["Z", "modCmdOrCtrl", "shift"], // Redo (Shift+Z/Cmd+Shift+Z)
//     description: "Redo undone action",
//     when: () => true,
//     handler: () => { redo(); },
//   });
//
// The system:
//   - Detects platform (macOS uses Meta/Command, Windows/Linux uses Control)
//   - Skips shortcuts when focus is inside <input>, <textarea>, or contenteditable
//   - Exposes window.TrueHide.showShortcutHelp() for a “?” reference dialog
//   - Registers a global keydown listener that checks the registry

(function () {
  "use strict";

  const UA = navigator.userAgent || "";
  const isMac = /Mac|iPad|iPhone/i.test(UA) && !/Edge/i.test(UA);
  const modName = isMac ? "Meta" : "Control"; // for accessibility tree
  const modifierKey = isMac ? "Meta" : "Control"; // the actual key name

  // The actual key that acts as the modifier (Cmd or Ctrl)
  const metaKey = isMac ? "Meta" : "Control";

  // -------------------------------------------------------------------------
  // Platform‑aware shortcut matching
  // -------------------------------------------------------------------------

  function isModifierKey(event, keyName) {
    // event[keyName] is true for Cmd/Meta on Mac, Ctrl on others
    if (keyName === "Meta") return event.metaKey;
    if (keyName === "Control") return event.ctrlKey;
    return false;
  }

  function isTypingInForm() {
    const el = document.activeElement;
    return (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable
    );
  }

  // -------------------------------------------------------------------------
  // Shortcut registry
  // -------------------------------------------------------------------------

  const registry = [];

  function registerShortcut({
    keys, // array of key strings, last entry may be "modCmdOrCtrl"
    description,
    when,
    handler,
  } = {}) {
    const normalized = {
      keys: Array.isArray(keys) ? keys : [keys],
      description,
      when: when || (() => true),
      handler,
    };
    registry.push(normalized);
  }

  function triggerShortcuts(event) {
    // First, if focus is inside a form field, skip ALL shortcuts
    if (isTypingInForm()) return;

    const key = event.key.toLowerCase();
    const pressedMeta = isModifierKey(event, "Meta");
    const pressedCtrl = isModifierKey(event, "Control");

    for (const entry of registry) {
      // Check if this entry matches the key + modifier combination
      const keyMatch = entry.keys.includes(key);
      const modMatch = entry.keys.some(
        (k) => k === "modCmdOrCtrl" && (pressedMeta || pressedCtrl)
      );

      if (keyMatch || modMatch) {
        // If the entry has a literal key besides the modifier, ensure it matches
        const literalKeys = entry.keys.filter(
          (k) => k !== "modCmdOrCtrl"
        );
        if (literalKeys.length > 0) {
          // The last key in the array is the "primary" key; the modifier is
          // always the second‑to‑last if modCmdOrCtrl is present.
          // Simpler: just check if the key pressed matches any of the literal keys.
          const hasMatchingLiteral = literalKeys.includes(key);
          if (!hasMatchingLiteral) continue; // not this shortcut
        }

        // Guard passed
        if (entry.when() === false) continue;

        // Prevent default browser behaviour for known shortcuts
        if (entry.preventDefault !== false) {
          // Only prevent if we aren't inside a text field (already checked)
          try { event.preventDefault(); } catch (e) {}
        }

        entry.handler(event);
        break; // only fire the first matching shortcut
      }
    }
  }

  // -------------------------------------------------------------------------
  // Help dialog
  // -------------------------------------------------------------------------

  function showShortcutHelp() {
    const entries = registry.map((e) => {
      const mod = isMac ? "⌘" : "Ctrl";
      const keys = e.keys
        .filter((k) => k !== "modCmdOrCtrl")
        .map((k) => (k === "Shift" ? "Shift" : k))
        .join(" + ");
      const fullKey = keys ? `${mod} + ${keys}` : mod;
      return { description: e.description, key: fullKey };
    });

    const items = entries.map(
      (e) => `<li><strong>${e.key}</strong> — ${e.description}</li>`
    ).join("");

    const modal = window.TrueHide.showModal({
      title: "Keyboard shortcuts",
      content: `
        <p>TrueHide supports the following shortcuts. These work anywhere on the page
        except when typing in a form field.</p>
        <ul>${items}</ul>
        <p>Press <kbd>Esc</kbd> or click outside to close this help.</p>
      `,
      buttons: [
        { label: "Close", kind: "default", onclick() { window.TrueHide.hideModal(); } },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Global keydown listener
  // -------------------------------------------------------------------------

  function init() {
    window.addEventListener("keydown", (event) => {
      // Let the modal system handle Esc (it already does in dialog.js);
      // but also allow global Esc to close the shortcut help if visible.
      // We'll just let the modal handle it.
      triggerShortcuts(event);
    });

    // Also expose showShortcutHelp on the global TrueHide API
    window.TrueHide.showShortcutHelp = showShortcutHelp;
  }

  init();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  window.TrueHide.registerShortcut = registerShortcut;
})();