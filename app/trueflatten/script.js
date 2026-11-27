pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const toast = (message, options) => window.TrueHide.toast(message, options);

const pdfInput = $("pdfInput");
const pdfCanvas = $("pdfCanvas");
const ctx = pdfCanvas.getContext("2d");
const redactionLayer = $("redactionLayer");
const selectionPreview = $("selectionPreview");
const pdfViewer = $("pdfViewer");
const emptyState = $("emptyState");
const pageCount = $("pageCount");

let pdfDocument = null;
let currentPage = 1;
let rendering = false;
let renderPending = false;
let pageRedactions = new Map();
let activePopover = null;
let dragStart = null;
let dragCurrent = null;
let originalPdfName = "trueflatten";

// Undo / redo stacks: each entry = { page, redactionsRemoved }
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 50;

function getRedactions(page = currentPage) {
  if (!pageRedactions.has(page)) {
    pageRedactions.set(page, []);
  }

  return pageRedactions.get(page);
}

function setEnabled(enabled) {
  $("previousPage").disabled = !enabled || currentPage <= 1;
  $("nextPage").disabled = !enabled || currentPage >= pdfDocument.numPages;
  $("clearPage").disabled = !enabled;
  $("flattenButton").disabled = !enabled;
}

async function loadPDF(file) {
  if (!file || file.type !== "application/pdf") {
    toast("Please select a PDF file.", { kind: "error" });
    return;
  }

  try {
    const data = await file.arrayBuffer();
    pdfDocument = await pdfjsLib.getDocument({ data }).promise;

    currentPage = 1;
    pageRedactions.clear();

    emptyState.classList.add("hidden");
    pdfViewer.classList.remove("hidden");

    originalPdfName =
      file.name.replace(/\.[^/.]+$/, "").replace(/[^\w-]+/g, "_") || "trueflatten";

    $("exportFilename").value = `${originalPdfName}-redacted.pdf`;

    setEnabled(true);
    await renderPage();
  } catch (error) {
    console.error(error);
    toast("Could not open this PDF.", { kind: "error" });
  }
}

async function renderPage() {
  if (!pdfDocument || rendering) {
    renderPending = true;
    return;
  }

  rendering = true;
  renderPending = false;

  try {
    const page = await pdfDocument.getPage(currentPage);
    const originalViewport = page.getViewport({ scale: 1 });

    const availableWidth = Math.max(280, $("documentArea").clientWidth - 50);

    const scale = Math.min(1.8, availableWidth / originalViewport.width);
    const viewport = page.getViewport({ scale });

    const outputScale = Math.min(window.devicePixelRatio || 1, 2);

    pdfCanvas.width = Math.round(viewport.width * outputScale);
    pdfCanvas.height = Math.round(viewport.height * outputScale);

    pdfCanvas.style.width = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;

    await page.render({
      canvasContext: ctx,
      viewport,
      transform:
        outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    }).promise;

    redactionLayer.style.width = `${viewport.width}px`;
    redactionLayer.style.height = `${viewport.height}px`;

    renderRedactions();

    pageCount.textContent = `Page ${currentPage} / ${pdfDocument.numPages}`;
    setEnabled(true);
  } catch (error) {
    console.error("PDF rendering failed:", error);
  } finally {
    rendering = false;

    if (renderPending) {
      renderPending = false;
      renderPage();
    }
  }
}

function renderRedactions() {
  redactionLayer.innerHTML = "";
  closePopover();

  for (const redaction of getRedactions()) {
    const element = document.createElement("div");
    element.className = "redaction";

    element.style.left = `${redaction.x * 100}%`;
    element.style.top = `${redaction.y * 100}%`;
    element.style.width = `${redaction.width * 100}%`;
    element.style.height = `${redaction.height * 100}%`;

    let moveStart = null;
    let moved = false;

    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();

      moveStart = getPointerPosition(event);
      moved = false;

      element.setPointerCapture(event.pointerId);
    });

    element.addEventListener("pointermove", (event) => {
      if (!moveStart) return;

      const position = getPointerPosition(event);
      const deltaX = position.x - moveStart.x;
      const deltaY = position.y - moveStart.y;

      if (!moved) {
        moved = true;
        closePopover();
      }

      const newX = Math.max(0, Math.min(1 - redaction.width, redaction.x + deltaX));
      const newY = Math.max(0, Math.min(1 - redaction.height, redaction.y + deltaY));

      redaction.x = newX;
      redaction.y = newY;
      moveStart = position;

      element.style.left = `${redaction.x * 100}%`;
      element.style.top = `${redaction.y * 100}%`;
    });

    element.addEventListener("pointerup", (event) => {
      if (!moveStart) return;

      const wasMoved = moved;
      moveStart = null;
      moved = false;

      if (!wasMoved) {
        showPopover(element, redaction);
      }
    });

    element.addEventListener("pointercancel", () => {
      moveStart = null;
      moved = false;
    });

    element.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    redactionLayer.appendChild(element);
  }
}

function showPopover(element, redaction) {
  closePopover();

  const popover = document.createElement("div");
  popover.className = "redaction-popover";

  const deleteButton = document.createElement("button");
  deleteButton.textContent = "Delete redaction";

  deleteButton.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();

    const redactions = getRedactions();
    const index = redactions.indexOf(redaction);

    if (index !== -1) {
      redactions.splice(index, 1);
    }

    closePopover();
    renderRedactions();
  });

  popover.appendChild(deleteButton);
  redactionLayer.appendChild(popover);

  const layerRect = redactionLayer.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const popoverWidth = 175;

  let left = elementRect.left - layerRect.left;

  if (left + popoverWidth > layerRect.width) {
    left = layerRect.width - popoverWidth;
  }

  left = Math.max(5, left);

  const top = Math.max(5, elementRect.top - layerRect.top - 47);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  activePopover = popover;
}

function closePopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

function getPointerPosition(event) {
  const rect = pdfCanvas.getBoundingClientRect();

  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

pdfCanvas.addEventListener("pointerdown", (event) => {
  if (!pdfDocument || event.button !== 0) return;

  closePopover();

  dragStart = getPointerPosition(event);
  dragCurrent = dragStart;

  pdfCanvas.setPointerCapture(event.pointerId);

  selectionPreview.style.display = "block";
  updateSelectionPreview();
});

pdfCanvas.addEventListener("pointermove", (event) => {
  if (!dragStart) return;

  dragCurrent = getPointerPosition(event);
  updateSelectionPreview();
});

pdfCanvas.addEventListener("pointerup", () => {
  if (!dragStart || !dragCurrent) return;

  const x = Math.min(dragStart.x, dragCurrent.x);
  const y = Math.min(dragStart.y, dragCurrent.y);
  const width = Math.abs(dragCurrent.x - dragStart.x);
  const height = Math.abs(dragCurrent.y - dragStart.y);

  selectionPreview.style.display = "none";

  if (width > 0.004 && height > 0.004) {
    getRedactions().push({ x, y, width, height });
    renderRedactions();
  }

  dragStart = null;
  dragCurrent = null;
});

pdfCanvas.addEventListener("pointercancel", () => {
  dragStart = null;
  dragCurrent = null;
  selectionPreview.style.display = "none";
});

function updateSelectionPreview() {
  if (!dragStart || !dragCurrent) return;

  const x = Math.min(dragStart.x, dragCurrent.x);
  const y = Math.min(dragStart.y, dragCurrent.y);
  const width = Math.abs(dragCurrent.x - dragStart.x);
  const height = Math.abs(dragCurrent.y - dragStart.y);

  selectionPreview.style.left = `${x * 100}%`;
  selectionPreview.style.top = `${y * 100}%`;
  selectionPreview.style.width = `${width * 100}%`;
  selectionPreview.style.height = `${height * 100}%`;
}

pdfInput.addEventListener("change", () => {
  loadPDF(pdfInput.files[0]);
});

$("previousPage").addEventListener("click", async () => {
  if (currentPage <= 1) return;
  currentPage--;
  await renderPage();
});

$("nextPage").addEventListener("click", async () => {
  if (currentPage >= pdfDocument.numPages) return;
  currentPage++;
  await renderPage();
});

$("clearPage").addEventListener("click", () => {
  pageRedactions.set(currentPage, []);
  renderRedactions();
});

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function flattenPDF() {
  if (!pdfDocument) return;

  // Snapshot current redaction state for undo
  const snapshot = {};
  for (let p = 1; p <= pdfDocument.numPages; p++) {
    snapshot[p] = pageRedactions.get(p) ? [...pageRedactions.get(p)] : [];
  }
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0; // new action clears redo

  const filename = $("exportFilename").value.trim() || `${originalPdfName}.pdf`;

  let totalRects = 0;
  for (let p = 1; p <= pdfDocument.numPages; p++) {
    const arr = pageRedactions.get(p);
    if (arr) totalRects += arr.length;
  }

  // Show export confirmation modal
  const overlay = window.TrueHide.showModal({
    title: "Export PDF",
    content: `
      <p>This will convert all pages into flattened images (rasterized at 2x scale). The original PDF's selectable text will be permanently removed and replaced by black rectangles. The exported PDF will carry jsPDF metadata (producer/creator).</p>
      <p><strong>File name:</strong> <input type="text" id="exportFilenameModal" value="${escapeHTML(filename)}" maxlength="120" aria-label="Export file name"></p>
      <p><strong>Verification:</strong> Each page is rendered as a bitmap at double scale, with black rectangles drawn on top. Any original selectable text is physically absent from the output. The progress below updates while the document is generated.</p>
      <ul>
        <li>Pages: <strong id="verifPages">0</strong> / <strong>${pdfDocument.numPages}</strong></li>
        <li>Redaction rectangles drawn: <strong>${totalRects}</strong></li>
        <li>Expected extractable text after export: <strong>none</strong></li>
      </ul>
    `,
    buttons: [
      { label: "Flatten & Download", kind: "primary", id: "flattenConfirm" },
      { label: "Cancel", kind: "default", id: "cancelButton" },
    ],
  });

  const filenameInput = overlay.querySelector("#exportFilenameModal");
  const cancelButton = overlay.querySelector("#cancelButton");
  const confirmButton = overlay.querySelector("#flattenConfirm");
  const verifPages = overlay.querySelector("#verifPages");

  // Generate the rasterized PDF, then trigger the download.
  async function downloadPDF() {
    if (!confirmButton || confirmButton.disabled) return;
    confirmButton.disabled = true;
    const originalLabel = confirmButton.textContent;
    confirmButton.textContent = "Flattening…";

    const fname =
      (filenameInput && filenameInput.value.trim()) ||
      `${originalPdfName}.pdf`;

    const { jsPDF } = window.jspdf;
    let output = null;

    try {
      for (
        let pageNumber = 1;
        pageNumber <= pdfDocument.numPages;
        pageNumber++
      ) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const pageContext = canvas.getContext("2d", { alpha: false });
        pageContext.fillStyle = "#ffffff";
        pageContext.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: pageContext,
          viewport,
        }).promise;

        for (const redaction of pageRedactions.get(pageNumber) || []) {
          pageContext.fillStyle = "#000000";
          pageContext.fillRect(
            redaction.x * canvas.width,
            redaction.y * canvas.height,
            redaction.width * canvas.width,
            redaction.height * canvas.height,
          );
        }

        const image = canvas.toDataURL("image/jpeg", 0.94);
        const width = viewport.width;
        const height = viewport.height;

        if (!output) {
          output = new jsPDF({
            orientation: width > height ? "landscape" : "portrait",
            unit: "pt",
            format: [width, height],
            compress: true,
          });
        } else {
          output.addPage(
            [width, height],
            width > height ? "landscape" : "portrait",
          );
        }

        output.addImage(image, "JPEG", 0, 0, width, height, undefined, "FAST");

        canvas.width = 1;
        canvas.height = 1;

        if (verifPages) verifPages.textContent = String(pageNumber);
      }

      window.TrueHide.hideModal();
      output.save(fname);
      toast(`PDF downloaded as ${fname}.`, { kind: "success" });
    } finally {
      // Re-enable the button if generation failed (modal stays open)
      confirmButton.disabled = false;
      confirmButton.textContent = originalLabel;
    }
  }

  if (cancelButton) {
    cancelButton.addEventListener("click", () => window.TrueHide.hideModal());
  }
  if (confirmButton) {
    confirmButton.addEventListener("click", downloadPDF);
  }
}

$("flattenButton").addEventListener("click", flattenPDF);

let resizeTimer;

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);

  resizeTimer = setTimeout(() => {
    if (pdfDocument) renderPage();
  }, 150);
});

window.TrueHide.attachFileDrop({
  accept: (file) =>
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf"),
  onFile: (file) => loadPDF(file),
  rejectMessage: "Please drop a PDF file.",
});
