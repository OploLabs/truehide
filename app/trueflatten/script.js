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
let pdfLoadingTask = null;
let currentRenderTask = null;
let currentPage = 1;
let rendering = false;
let renderPending = false;
let renderGeneration = 0;
let pageRedactions = new Map();
let activePopover = null;
let dragStart = null;
let dragCurrent = null;
let originalPdfName = "trueflatten";

// Undo / redo stacks: each entry is a full redaction snapshot
// ({ page, redactions }) so any redaction change can be reversed.
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 50;

/**
 * Release the currently loaded PDF completely: cancel the in-flight render,
 * destroy the document proxy and its loading task (which frees the parsed
 * document data), and reset all document-bound state. Called before every
 * new load so a replaced document does not linger in memory.
 */
function destroyPDF() {
  renderGeneration++; // any in-flight render of the old document gives up

  try {
    if (currentRenderTask) {
      currentRenderTask.cancel();
      currentRenderTask = null;
    }
  } catch (_) {
    // render task already finished
  }

  try {
    if (pdfDocument) {
      pdfDocument.destroy();
    }
  } catch (_) {
    // document already destroyed
  }

  pdfDocument = null;
  pdfLoadingTask = null;
  currentPage = 1;
  pageRedactions.clear();
  undoStack = [];
  redoStack = [];
}

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

// --- Undo / redo ---------------------------------------------------------

/** Deep snapshot of the redaction state (which page is shown + all rects). */
function snapshotRedactions() {
  const redactions = {};
  for (const [page, list] of pageRedactions) {
    redactions[page] = list.map((r) => ({ ...r }));
  }
  return { page: currentPage, redactions };
}

/** Remember the current state so it can be undone. */
function recordRedactionState() {
  undoStack.push(snapshotRedactions());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0; // a new change invalidates the redo history
}

/** Push a specific (pre-move) snapshot onto the undo stack. */
function commitUndoSnapshot(snapshot) {
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function applyRedactionSnapshot(snapshot) {
  const pageChanged = snapshot.page !== currentPage;
  currentPage = snapshot.page;
  pageRedactions.clear();
  for (const [page, list] of Object.entries(snapshot.redactions)) {
    pageRedactions.set(Number(page), list.map((r) => ({ ...r })));
  }
  if (pageChanged) {
    renderPage(); // redraws the page and its redactions
  } else {
    renderRedactions();
  }
}

function undoRedaction() {
  if (!pdfDocument || !undoStack.length) return;
  redoStack.push(snapshotRedactions());
  if (redoStack.length > UNDO_LIMIT) redoStack.shift();
  applyRedactionSnapshot(undoStack.pop());
}

function redoRedaction() {
  if (!pdfDocument || !redoStack.length) return;
  undoStack.push(snapshotRedactions());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  applyRedactionSnapshot(redoStack.pop());
}

async function loadPDF(file) {
  if (!file || file.type !== "application/pdf") {
    toast("Please select a PDF file.", { kind: "error" });
    return;
  }

  // Release the previous document before loading a new one.
  destroyPDF();

  try {
    const data = await file.arrayBuffer();
    pdfLoadingTask = pdfjsLib.getDocument({ data });
    pdfDocument = await pdfLoadingTask.promise;

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
    destroyPDF();
    // The previous document (if any) was already released above; return
    // the viewer to its empty state.
    emptyState.classList.remove("hidden");
    pdfViewer.classList.add("hidden");
    pageCount.textContent = "Page — / —";
    redactionLayer.innerHTML = "";
    setEnabled(false);
  }
}

async function renderPage() {
  const generation = renderGeneration;

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

    currentRenderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform:
        outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    });
    try {
      await currentRenderTask.promise;
    } finally {
      currentRenderTask = null;
    }

    // If a newer load/render superseded this one, drop the stale frame.
    if (generation !== renderGeneration) return;

    redactionLayer.style.width = `${viewport.width}px`;
    redactionLayer.style.height = `${viewport.height}px`;

    renderRedactions();

    pageCount.textContent = `Page ${currentPage} / ${pdfDocument.numPages}`;
    setEnabled(true);
  } catch (error) {
    // An aborted render or a superseded generation means the document was
    // replaced or closed — nothing to report.
    const superseded =
      generation !== renderGeneration ||
      error instanceof pdfjsLib.AbortException;
    if (!superseded) {
      console.error("PDF rendering failed:", error);
    }
  } finally {
    rendering = false;

    if (renderPending && generation === renderGeneration) {
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
    let moveSnapshot = null; // pre-move state, committed to undo on first move

    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();

      moveStart = getPointerPosition(event);
      moved = false;
      moveSnapshot = snapshotRedactions();

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
        commitUndoSnapshot(moveSnapshot); // record the pre-move state once
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
      recordRedactionState(); // remember the state before the deletion
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
    recordRedactionState(); // remember the state before this new redaction
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
  if (!pdfDocument || currentPage <= 1) return;
  currentPage--;
  await renderPage();
});

$("nextPage").addEventListener("click", async () => {
  if (!pdfDocument || currentPage >= pdfDocument.numPages) return;
  currentPage++;
  await renderPage();
});

$("clearPage").addEventListener("click", () => {
  if (getRedactions().length === 0) return;
  recordRedactionState(); // remember the state before clearing
  pageRedactions.set(currentPage, []);
  renderRedactions();
});

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function flattenPDF() {
  if (!pdfDocument) return;

  let totalRects = 0;
  for (let p = 1; p <= pdfDocument.numPages; p++) {
    const arr = pageRedactions.get(p);
    if (arr) totalRects += arr.length;
  }

  const full = $("exportFilename").value.trim() || `${originalPdfName}.pdf`;
  const base = full.toLowerCase().endsWith(".pdf") ? full.slice(0, -4) : full;

  // Confirm through the shared download dialog: editable file name, summary
  // rows and a live progress cell while the pages are rasterized.
  const overlay = window.TrueHide.confirmDownload({
    fileName: base,
    extension: ".pdf",
    confirmLabel: "Flatten & Download",
    busyLabel: "Flattening…",
    details: [
      { label: "Pages", value: String(pdfDocument.numPages) },
      {
        label: "Redaction rectangles",
        value: totalRects ? String(totalRects) : "None",
      },
      { label: "Progress", value: `0 / ${pdfDocument.numPages}`, id: "verifProgress" },
    ],
    note: "Every page will be rasterized at 2× and the original selectable text will be permanently replaced by black rectangles. The exported PDF carries jsPDF producer metadata. Your file on disk is never modified.",
    onConfirm: async (fname) => {
      const progressEl = overlay.querySelector("#verifProgress");

      const { jsPDF } = window.jspdf;
      let output = null;

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

        if (progressEl)
          progressEl.textContent = `${pageNumber} / ${pdfDocument.numPages}`;
      }

      output.save(fname);
      toast(`PDF downloaded as ${fname}.`, { kind: "success" });
    },
  });
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

// Keyboard-only undo / redo for redaction changes (shared shortcut system).
window.TrueHide.registerShortcut({
  keys: ["z", "modCmdOrCtrl"],
  description: "Undo redaction change",
  when: () => Boolean(pdfDocument),
  handler: undoRedaction,
});
window.TrueHide.registerShortcut({
  keys: ["y", "modCmdOrCtrl"],
  description: "Redo redaction change",
  when: () => Boolean(pdfDocument),
  handler: redoRedaction,
});
