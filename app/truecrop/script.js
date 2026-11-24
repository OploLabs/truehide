"use strict";

/* ========================================
   ELEMENTS
======================================== */

const $ = (id) => document.getElementById(id);

const imageInput = $("imageInput");
const imageCanvas = $("imageCanvas");
const imageContext = imageCanvas.getContext("2d");

const selectionCanvas = $("selectionCanvas");
const selectionContext = selectionCanvas.getContext("2d");

const stage = $("stage");
const emptyState = $("emptyState");
const dropOverlay = $("dropOverlay");
const toastElement = $("toast");

const dimensionsElement = $("dimensions");
const outputDimensionsElement = $("outputDimensions");
const sourceDimensionsElement = $("sourceDimensions");

const resetButton = $("resetButton");
const clearButton = $("clearButton");
const cropButton = $("cropButton");

const formatSelect = $("format");

/* ========================================
   STATE
======================================== */

let originalImage = null;
let originalFileName = "image";

let imageLoaded = false;
let selection = null;
let previewSelection = null;

let interaction = null;
let pointerId = null;

let toastTimeout = null;
let dragDepth = 0;

/* ========================================
   UTILITIES
======================================== */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneRect(rect) {
  return rect ? { ...rect } : null;
}

function normalizeRect(a, b) {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x, b.x);
  const y2 = Math.max(a.y, b.y);

  return {
    x: Math.floor(x1),
    y: Math.floor(y1),
    width: Math.ceil(x2) - Math.floor(x1),
    height: Math.ceil(y2) - Math.floor(y1),
  };
}

function constrainRect(rect) {
  const x = clamp(rect.x, 0, imageCanvas.width);
  const y = clamp(rect.y, 0, imageCanvas.height);

  return {
    x,
    y,
    width: clamp(rect.width, 0, imageCanvas.width - x),
    height: clamp(rect.height, 0, imageCanvas.height - y),
  };
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add("visible");

  clearTimeout(toastTimeout);

  toastTimeout = setTimeout(() => {
    toastElement.classList.remove("visible");
  }, 2600);
}

function setControls(enabled) {
  resetButton.disabled = !enabled;
  clearButton.disabled = !enabled;
  cropButton.disabled = !enabled || !selection;
}

function updateDimensions(rect = selection) {
  if (!rect || rect.width < 1 || rect.height < 1) {
    dimensionsElement.textContent = "No selection";
    outputDimensionsElement.textContent = "—";
    cropButton.disabled = true;
    return;
  }

  const width = Math.round(rect.width);
  const height = Math.round(rect.height);

  dimensionsElement.textContent = `${width.toLocaleString()} × ${height.toLocaleString()} px`;

  outputDimensionsElement.textContent = `${width.toLocaleString()} × ${height.toLocaleString()} px`;

  cropButton.disabled = false;
}

/* ========================================
   IMAGE LOADING
======================================== */

function loadImage(file) {
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showToast("Please select a valid image.");
    return;
  }

  const url = URL.createObjectURL(file);
  const image = new Image();

  image.onload = () => {
    try {
      originalImage = image;

      originalFileName =
        file.name.replace(/\.[^/.]+$/, "").replace(/[^\w-]+/g, "_") || "image";

      imageCanvas.width = image.naturalWidth;
      imageCanvas.height = image.naturalHeight;

      selectionCanvas.width = image.naturalWidth;
      selectionCanvas.height = image.naturalHeight;

      imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);

      imageContext.drawImage(image, 0, 0);

      imageLoaded = true;
      selection = null;
      previewSelection = null;

      clearInteraction();

      emptyState.classList.add("hidden");
      stage.classList.remove("hidden");

      sourceDimensionsElement.textContent = `${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()}`;

      setControls(true);
      drawSelection();

      imageInput.value = "";

      showToast("Image loaded successfully.");
    } catch (error) {
      console.error(error);
      showToast("Could not process this image.");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  image.onerror = () => {
    URL.revokeObjectURL(url);
    showToast("Could not load this image.");
  };

  image.src = url;
}

/* ========================================
   POINTER COORDINATES
======================================== */

function pointerPosition(event) {
  const rect = selectionCanvas.getBoundingClientRect();

  if (!rect.width || !rect.height) {
    return { x: 0, y: 0 };
  }

  return {
    x: clamp(
      ((event.clientX - rect.left) / rect.width) * imageCanvas.width,
      0,
      imageCanvas.width,
    ),

    y: clamp(
      ((event.clientY - rect.top) / rect.height) * imageCanvas.height,
      0,
      imageCanvas.height,
    ),
  };
}

/*
 * Hit testing uses screen pixels rather than image pixels.
 * This keeps handles usable regardless of image resolution.
 */

function getHitInfo(event) {
  if (!selection) return null;

  const rect = selectionCanvas.getBoundingClientRect();

  const pos = pointerPosition(event);

  const scaleX = imageCanvas.width / rect.width;
  const scaleY = imageCanvas.height / rect.height;

  const thresholdX = 10 * scaleX;
  const thresholdY = 10 * scaleY;

  const left = selection.x;
  const top = selection.y;
  const right = left + selection.width;
  const bottom = top + selection.height;

  const nearLeft = Math.abs(pos.x - left) <= thresholdX;
  const nearRight = Math.abs(pos.x - right) <= thresholdX;
  const nearTop = Math.abs(pos.y - top) <= thresholdY;
  const nearBottom = Math.abs(pos.y - bottom) <= thresholdY;

  // Corners

  if (nearLeft && nearTop) {
    return { type: "nw", pos };
  }

  if (nearRight && nearTop) {
    return { type: "ne", pos };
  }

  if (nearLeft && nearBottom) {
    return { type: "sw", pos };
  }

  if (nearRight && nearBottom) {
    return { type: "se", pos };
  }

  // Edges

  const insideY = pos.y >= top - thresholdY && pos.y <= bottom + thresholdY;

  const insideX = pos.x >= left - thresholdX && pos.x <= right + thresholdX;

  if (nearLeft && insideY) return { type: "w", pos };
  if (nearRight && insideY) return { type: "e", pos };
  if (nearTop && insideX) return { type: "n", pos };
  if (nearBottom && insideX) return { type: "s", pos };

  // Interior

  if (pos.x > left && pos.x < right && pos.y > top && pos.y < bottom) {
    return { type: "move", pos };
  }

  return null;
}

/* ========================================
   CURSORS
======================================== */

function getCursor(mode) {
  const cursors = {
    nw: "nw-resize",
    n: "n-resize",
    ne: "ne-resize",
    e: "e-resize",
    se: "se-resize",
    s: "s-resize",
    sw: "sw-resize",
    w: "w-resize",
    move: "move",
    new: "crosshair",
  };

  return cursors[mode] || "crosshair";
}

function updateHoverCursor(event) {
  if (!imageLoaded || interaction) return;

  const hit = getHitInfo(event);

  selectionCanvas.style.cursor = getCursor(hit ? hit.type : "new");
}

/* ========================================
   SELECTION DRAWING
======================================== */

function drawHandles(rect) {
  const bounds = selectionCanvas.getBoundingClientRect();

  const scaleX = imageCanvas.width / bounds.width;
  const scaleY = imageCanvas.height / bounds.height;

  const radius = 4.5 * Math.max(scaleX, scaleY);

  const points = [
    [rect.x, rect.y],
    [rect.x + rect.width / 2, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height / 2],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x + rect.width / 2, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
    [rect.x, rect.y + rect.height / 2],
  ];

  for (const [x, y] of points) {
    selectionContext.beginPath();

    selectionContext.arc(x, y, radius, 0, Math.PI * 2);

    selectionContext.fillStyle = "#ffffff";
    selectionContext.fill();

    selectionContext.lineWidth = Math.max(scaleX, scaleY);
    selectionContext.strokeStyle = "#608cff";
    selectionContext.stroke();
  }
}

function drawSelection() {
  selectionContext.clearRect(
    0,
    0,
    selectionCanvas.width,
    selectionCanvas.height,
  );

  const rect = previewSelection || selection;

  if (!rect || rect.width < 1 || rect.height < 1) {
    updateDimensions(null);
    return;
  }

  // Darken the area outside the selection.

  selectionContext.fillStyle = "rgba(0, 0, 0, 0.53)";

  selectionContext.fillRect(
    0,
    0,
    selectionCanvas.width,
    selectionCanvas.height,
  );

  // Reveal selected area.

  selectionContext.clearRect(rect.x, rect.y, rect.width, rect.height);

  // Outer border.

  selectionContext.save();

  selectionContext.strokeStyle = "#ffffff";
  selectionContext.lineWidth = Math.max(1, imageCanvas.width / 1200);

  selectionContext.setLineDash([
    Math.max(3, imageCanvas.width / 350),
    Math.max(2, imageCanvas.width / 500),
  ]);

  selectionContext.strokeRect(rect.x, rect.y, rect.width, rect.height);

  selectionContext.restore();

  drawHandles(rect);

  updateDimensions(rect);
}

/* ========================================
   RESIZING
======================================== */

function resizeSelection(start, handle, pointer) {
  const left = start.x;
  const top = start.y;

  const right = start.x + start.width;
  const bottom = start.y + start.height;

  let x1 = left;
  let y1 = top;
  let x2 = right;
  let y2 = bottom;

  const minSize = 2;

  if (handle.includes("w")) {
    x1 = clamp(pointer.x, 0, right - minSize);
  }

  if (handle.includes("e")) {
    x2 = clamp(pointer.x, left + minSize, imageCanvas.width);
  }

  if (handle.includes("n")) {
    y1 = clamp(pointer.y, 0, bottom - minSize);
  }

  if (handle.includes("s")) {
    y2 = clamp(pointer.y, top + minSize, imageCanvas.height);
  }

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

function moveSelection(start, delta) {
  return {
    x: clamp(start.x + delta.x, 0, imageCanvas.width - start.width),

    y: clamp(start.y + delta.y, 0, imageCanvas.height - start.height),

    width: start.width,
    height: start.height,
  };
}

/* ========================================
   INTERACTION STATE
======================================== */

function clearInteraction() {
  interaction = null;
  previewSelection = null;
  pointerId = null;
}

function startInteraction(event) {
  if (!imageLoaded || event.button !== 0 || interaction) return;

  const pointer = pointerPosition(event);
  const hit = getHitInfo(event);

  const mode = hit ? hit.type : "new";

  interaction = {
    mode,
    start: pointer,
    original: cloneRect(selection),
  };

  pointerId = event.pointerId;

  if (mode === "new") {
    selection = null;
    previewSelection = {
      x: pointer.x,
      y: pointer.y,
      width: 0,
      height: 0,
    };
  } else {
    previewSelection = cloneRect(selection);
  }

  selectionCanvas.setPointerCapture(event.pointerId);

  selectionCanvas.style.cursor = getCursor(mode);

  selectionCanvas.classList.add("dragging");

  drawSelection();

  event.preventDefault();
}

function updateInteraction(event) {
  if (!interaction || event.pointerId !== pointerId) return;

  const pointer = pointerPosition(event);

  const { mode, start, original } = interaction;

  if (mode === "new") {
    previewSelection = constrainRect(normalizeRect(start, pointer));
  } else if (mode === "move" && original) {
    previewSelection = moveSelection(original, {
      x: pointer.x - start.x,
      y: pointer.y - start.y,
    });
  } else if (original) {
    previewSelection = resizeSelection(original, mode, pointer);
  }

  drawSelection();
}

function finishInteraction(event) {
  if (!interaction) return;
  if (event && event.pointerId !== pointerId) return;

  const finalSelection = cloneRect(previewSelection);

  if (
    finalSelection &&
    finalSelection.width >= 2 &&
    finalSelection.height >= 2
  ) {
    selection = constrainRect(finalSelection);
  } else if (interaction.mode === "new") {
    selection = null;
  }

  const capturedPointer = pointerId;

  clearInteraction();

  selectionCanvas.classList.remove("dragging");
  selectionCanvas.style.cursor = "crosshair";

  if (
    capturedPointer !== null &&
    selectionCanvas.hasPointerCapture(capturedPointer)
  ) {
    selectionCanvas.releasePointerCapture(capturedPointer);
  }

  drawSelection();
}

function cancelInteraction(event) {
  if (!interaction) return;

  selection = cloneRect(interaction.original);

  const capturedPointer = pointerId;

  clearInteraction();

  selectionCanvas.classList.remove("dragging");

  if (
    capturedPointer !== null &&
    selectionCanvas.hasPointerCapture(capturedPointer)
  ) {
    selectionCanvas.releasePointerCapture(capturedPointer);
  }

  drawSelection();
}

/* ========================================
   POINTER EVENTS
======================================== */

selectionCanvas.addEventListener("pointerdown", startInteraction);

selectionCanvas.addEventListener("pointermove", (event) => {
  if (interaction) {
    updateInteraction(event);
  } else {
    updateHoverCursor(event);
  }
});

selectionCanvas.addEventListener("pointerup", finishInteraction);

selectionCanvas.addEventListener("pointercancel", cancelInteraction);

selectionCanvas.addEventListener("lostpointercapture", () => {
  if (interaction) {
    selection = cloneRect(interaction.original);
    clearInteraction();
    drawSelection();
  }
});

/* ========================================
   SELECTION CONTROLS
======================================== */

function clearSelection() {
  if (!imageLoaded) return;

  selection = null;
  clearInteraction();

  selectionCanvas.style.cursor = "crosshair";

  drawSelection();

  showToast("Selection cleared.");
}

function resetImage() {
  if (!originalImage) return;

  imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);

  imageContext.drawImage(originalImage, 0, 0);

  clearSelection();

  showToast("Image reset.");
}

resetButton.addEventListener("click", resetImage);
clearButton.addEventListener("click", clearSelection);

/* ========================================
   CROP AND EXPORT
======================================== */

function cropImage() {
  if (!selection || !imageLoaded) {
    showToast("Create a selection first.");
    return;
  }

  const rect = {
    x: Math.round(selection.x),
    y: Math.round(selection.y),
    width: Math.round(selection.width),
    height: Math.round(selection.height),
  };

  if (rect.width < 1 || rect.height < 1) return;

  const outputCanvas = document.createElement("canvas");

  outputCanvas.width = rect.width;
  outputCanvas.height = rect.height;

  const outputContext = outputCanvas.getContext("2d");

  if (!outputContext) {
    showToast("Could not create the output image.");
    return;
  }

  const format = formatSelect.value;

  // JPEG does not support transparency.

  if (format === "image/jpeg") {
    outputContext.fillStyle = "#ffffff";

    outputContext.fillRect(0, 0, rect.width, rect.height);
  }

  outputContext.drawImage(
    imageCanvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );

  cropButton.disabled = true;
  cropButton.textContent = "Exporting...";

  outputCanvas.toBlob(
    (blob) => {
      cropButton.disabled = false;
      cropButton.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12m-5-5 5 5 5-5"></path>
          <path d="M5 17v4h14v-4"></path>
        </svg>
        Crop &amp; Download
      `;

      if (!blob) {
        showToast("Could not export the image.");
        return;
      }

      // Some browsers may fall back to PNG.

      const actualFormat = blob.type || format;

      const extensions = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
      };

      const extension = extensions[actualFormat] || "png";

      const filename = `${originalFileName}-cropped.${extension}`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = filename;

      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1000);

      showToast(`Exported ${rect.width} × ${rect.height} image.`);
    },
    format,
    format === "image/jpeg" ? 0.95 : undefined,
  );
}

cropButton.addEventListener("click", cropImage);

/* ========================================
   FILE INPUT
======================================== */

imageInput.addEventListener("change", () => {
  loadImage(imageInput.files?.[0]);
});

/* ========================================
   KEYBOARD SHORTCUTS
======================================== */

document.addEventListener("keydown", (event) => {
  const target = event.target;

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    imageInput.click();
  }

  if (event.key === "Escape") {
    if (interaction) {
      cancelInteraction();
    } else if (selection) {
      clearSelection();
    }
  }

  if (event.key === "Enter" && selection && !cropButton.disabled) {
    cropImage();
  }
});

/* ========================================
   THEME
======================================== */

function initializeTheme() {
  const savedTheme = localStorage.getItem("truehide-theme");

  if (savedTheme === "dark" || savedTheme === "light") {
    document.documentElement.dataset.theme = savedTheme;
  } else {
    document.documentElement.dataset.theme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches
      ? "dark"
      : "light";
  }

  $("themeToggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;

    const next = current === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = next;

    localStorage.setItem("truehide-theme", next);
  });
}

initializeTheme();

/* ========================================
   DRAG AND DROP
======================================== */

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

document.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;

  event.preventDefault();

  dragDepth++;

  dropOverlay.classList.add("visible");
});

document.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;

  event.preventDefault();

  event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;

  event.preventDefault();

  dragDepth = Math.max(0, dragDepth - 1);

  if (dragDepth === 0) {
    dropOverlay.classList.remove("visible");
  }
});

document.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;

  event.preventDefault();

  dragDepth = 0;

  dropOverlay.classList.remove("visible");

  const files = Array.from(event.dataTransfer.files);

  const file = files.find((item) => item.type.startsWith("image/"));

  if (!file) {
    showToast("No supported image found.");
    return;
  }

  loadImage(file);
});

/* ========================================
   INITIALIZATION
======================================== */

setControls(false);

sourceDimensionsElement.textContent = "—";

updateDimensions();
