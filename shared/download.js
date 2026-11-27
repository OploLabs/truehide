// Shared download-confirmation dialog.
//
// Usage:
//   const overlay = window.TrueHide.confirmDownload({
//     fileName: "report",                  // base name pre-filled in the input
//     extension: ".pdf",                   // fixed suffix shown next to the input
//     details: [                           // summary rows shown to the user
//       { label: "Pages", value: "3" },
//       { label: "Size", value: window.TrueHide.formatBytes(bytes) },
//       { label: "Progress", value: "0 / 3", id: "dlProgress" }, // optional live cell
//     ],
//     note: "Your original file stays untouched.",
//     onConfirm: async (name) => {
//       // trigger the actual download here with `name`
//       // update a live cell via overlay.querySelector("#dlProgress")
//     },
//   });
//
// Behavior:
//   - Builds on TrueHide.showModal (shared/dialog.js): focus trap, Esc and
//     backdrop-click close, one modal at a time
//   - The file name is editable; Enter in the input confirms
//   - Invalid characters ( \ / : * ? " < > | ) are stripped and the
//     extension is appended when the user did not type it
//   - While onConfirm is pending, the buttons show a busy state and the
//     dialog stays open; if onConfirm throws, the buttons re-enable so the
//     user can retry (the dialog stays open)
//   - On success the dialog closes; the caller is responsible for toasts
//
// Also exposes:
//   window.TrueHide.formatBytes(n) -> "1.2 MB" (human-readable size)

(function () {
  "use strict";

  window.TrueHide = window.TrueHide || {};

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "0 B";
    if (n < 1024) return n + " B";
    const kb = n / 1024;
    if (kb < 1024) return (kb >= 100 ? String(Math.round(kb)) : kb.toFixed(1)) + " KB";
    const mb = kb / 1024;
    if (mb < 1024) return (mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)) + " MB";
    return (mb / 1024).toFixed(1) + " GB";
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  // Strip characters that are unsafe in a download file name and cap length.
  function cleanBase(name) {
    return String(name)
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function confirmDownload(config) {
    const {
      title = "Confirm download",
      fileName = "",
      extension = "",
      details = [],
      note = "",
      confirmLabel = "Download",
      busyLabel = "Preparing…",
      onConfirm,
    } = config || {};

    const defaultBase = cleanBase(fileName);
    const ext = extension && extension.charAt(0) === "." ? extension : "";

    let html =
      '<label class="dl-label" for="dlFilename">File name</label>' +
      '<div class="dl-filename"><input type="text" id="dlFilename" maxlength="120" aria-label="Download file name">';
    if (ext) html += '<span class="dl-ext" aria-hidden="true">' + esc(ext) + "</span>";
    html += "</div>";
    if (details.length) {
      html += '<dl class="dl-details">';
      for (const d of details) {
        html += '<div class="dl-row"><dt>' + esc(d.label) + "</dt>";
        html +=
          "<dd" + (d.id ? ' id="' + esc(d.id) + '"' : "") + ">" + esc(d.value) + "</dd></div>";
      }
      html += "</dl>";
    }
    if (note) html += '<p class="dl-note">' + esc(note) + "</p>";

    const content = document.createElement("div");
    content.innerHTML = html;

    const overlay = window.TrueHide.showModal({
      title,
      content,
      buttons: [
        { label: confirmLabel, kind: "primary", id: "dlConfirm" },
        { label: "Cancel", kind: "default", id: "dlCancel" },
      ],
    });

    const input = overlay.querySelector("#dlFilename");
    const confirmBtn = overlay.querySelector("#dlConfirm");
    const cancelBtn = overlay.querySelector("#dlCancel");

    // Set the value on the live element: showModal clones the content node,
    // and cloneNode does not carry over an input's .value property.
    input.value = defaultBase;
    input.focus();

    cancelBtn.addEventListener("click", () => window.TrueHide.hideModal());

    async function runConfirm() {
      if (confirmBtn.disabled) return;

      let name = cleanBase(input.value) || defaultBase || "download";
      if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;

      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      const originalLabel = confirmBtn.textContent;
      confirmBtn.textContent = busyLabel;
      const spinner = document.createElement("span");
      spinner.className = "button-progress";
      spinner.setAttribute("aria-hidden", "true");
      confirmBtn.appendChild(spinner);

      try {
        await Promise.resolve(onConfirm(name));
        window.TrueHide.hideModal();
      } catch (error) {
        // Generation failed: keep the dialog open so the user can retry.
        // Callers surface their own error toast.
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        confirmBtn.textContent = originalLabel;
        if (spinner.parentNode) spinner.remove();
      }
    }

    confirmBtn.addEventListener("click", runConfirm);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runConfirm();
      }
    });

    return overlay;
  }

  window.TrueHide.confirmDownload = confirmDownload;
  window.TrueHide.formatBytes = formatBytes;
})();
