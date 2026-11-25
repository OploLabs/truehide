const $ = (id) => document.getElementById(id);

const imageInput = $("imageInput");
const imageCanvas = $("imageCanvas");
const imageContext = imageCanvas.getContext("2d", {
  willReadFrequently: true,
});

const selectionCanvas = $("selectionCanvas");
const selectionContext = selectionCanvas.getContext("2d");

const paintCanvas = document.createElement("canvas");
const paintContext = paintCanvas.getContext("2d", {
  willReadFrequently: true,
});

let originalImageData = null;
let imageLoaded = false;
let selection = null;

let dragStart = null;
let dragCurrent = null;
let cropMode = null;
let resizeHandle = null;
let selectionBeforeDrag = null;

let undoStack = [];
let currentObjectURL = null;
let loadSequence = 0;

let isPainting = false;
let paintLastPoint = null;
let paintUndoSaved = false;
let activePointerId = null;

let dragDepth = 0;

const MIN_SELECTION = 2;

// ========================================
// STATUS AND CONTROLS
// ========================================

function setStatus(message) {
  $("status").textContent = message;
}

function setControls(enabled) {
  $("resetButton").disabled = !enabled;
  $("clearSelection").disabled = !enabled;
  $("downloadButton").disabled = !enabled;
  $("undoButton").disabled = !enabled || undoStack.length === 0;

  $("applyButton").disabled =
    !enabled || !selection || $("effect").value === "paint";
}

function clearInteraction() {
  dragStart = null;
  dragCurrent = null;
  cropMode = null;
  resizeHandle = null;
  selectionBeforeDrag = null;
}

function clearPaintMask() {
  paintContext.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
}

// ========================================
// IMAGE LOADING
// ========================================

function loadImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("Please select a valid image.");
    return;
  }

  const sequence = ++loadSequence;

  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }

  const objectURL = URL.createObjectURL(file);
  currentObjectURL = objectURL;

  const image = new Image();

  image.onload = () => {
    if (sequence !== loadSequence) {
      URL.revokeObjectURL(objectURL);
      return;
    }

    try {
      imageCanvas.width = image.naturalWidth;
      imageCanvas.height = image.naturalHeight;

      imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);

      imageContext.drawImage(image, 0, 0);

      originalImageData = imageContext.getImageData(
        0,
        0,
        imageCanvas.width,
        imageCanvas.height,
      );

      selectionCanvas.width = imageCanvas.width;
      selectionCanvas.height = imageCanvas.height;

      paintCanvas.width = imageCanvas.width;
      paintCanvas.height = imageCanvas.height;

      clearPaintMask();

      selection = null;
      undoStack = [];

      clearInteraction();

      imageLoaded = true;

      $("emptyState").classList.add("hidden");
      $("stage").classList.remove("hidden");

      $("imageDimensions").textContent =
        `${imageCanvas.width.toLocaleString()} × ${imageCanvas.height.toLocaleString()} px`;

      drawSelection();

      setStatus("Image loaded");
      setControls(true);
    } catch (error) {
      console.error(error);
      alert("This image could not be processed. Try a smaller image.");
      imageLoaded = false;
    } finally {
      URL.revokeObjectURL(objectURL);

      if (currentObjectURL === objectURL) {
        currentObjectURL = null;
      }
    }
  };

  image.onerror = () => {
    if (sequence !== loadSequence) return;

    URL.revokeObjectURL(objectURL);

    if (currentObjectURL === objectURL) {
      currentObjectURL = null;
    }

    alert("Could not load this image.");
  };

  image.src = objectURL;
}

// ========================================
// POINTER POSITION
// ========================================

function getPointerPosition(event) {
  const rect = selectionCanvas.getBoundingClientRect();

  return {
    x: Math.max(
      0,
      Math.min(
        imageCanvas.width,
        ((event.clientX - rect.left) * imageCanvas.width) / rect.width,
      ),
    ),

    y: Math.max(
      0,
      Math.min(
        imageCanvas.height,
        ((event.clientY - rect.top) * imageCanvas.height) / rect.height,
      ),
    ),
  };
}

// ========================================
// RECTANGLE SELECTION
// ========================================

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);

  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.ceil(right) - Math.floor(x),
    height: Math.ceil(bottom) - Math.floor(y),
  };
}

function constrainRect(rect) {
  const x = Math.max(0, Math.min(rect.x, imageCanvas.width));
  const y = Math.max(0, Math.min(rect.y, imageCanvas.height));

  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.width, imageCanvas.width - x)),
    height: Math.max(0, Math.min(rect.height, imageCanvas.height - y)),
  };
}

function getHandleSize() {
  return Math.max(
    8,
    Math.min(22, Math.min(imageCanvas.width, imageCanvas.height) * 0.018),
  );
}

function getHitThreshold() {
  return Math.max(12, Math.min(imageCanvas.width, imageCanvas.height) * 0.015);
}

function getHitInfo(position) {
  if (!selection) return null;

  const r = selection;
  const p = getHitThreshold();

  const left = r.x;
  const right = r.x + r.width;
  const top = r.y;
  const bottom = r.y + r.height;

  const nearX = (x) => Math.abs(position.x - x) <= p;
  const nearY = (y) => Math.abs(position.y - y) <= p;

  const insideY = position.y >= top - p && position.y <= bottom + p;

  const insideX = position.x >= left - p && position.x <= right + p;

  if (nearX(left) && nearY(top)) return "nw";
  if (nearX(right) && nearY(top)) return "ne";
  if (nearX(left) && nearY(bottom)) return "sw";
  if (nearX(right) && nearY(bottom)) return "se";

  if (insideY && nearX(left)) return "w";
  if (insideY && nearX(right)) return "e";

  if (insideX && nearY(top)) return "n";
  if (insideX && nearY(bottom)) return "s";

  if (
    position.x >= left &&
    position.x <= right &&
    position.y >= top &&
    position.y <= bottom
  ) {
    return "move";
  }

  return null;
}

function getCursor(mode) {
  const cursors = {
    nw: "nw-resize",
    ne: "ne-resize",
    sw: "sw-resize",
    se: "se-resize",
    n: "n-resize",
    s: "s-resize",
    e: "e-resize",
    w: "w-resize",
    move: "move",
    new: "crosshair",
  };

  return cursors[mode] || "crosshair";
}

function resizeRect(start, point, handle) {
  const left = start.x;
  const top = start.y;
  const right = start.x + start.width;
  const bottom = start.y + start.height;

  const min = MIN_SELECTION;

  let x1 = left;
  let y1 = top;
  let x2 = right;
  let y2 = bottom;

  if (handle.includes("w")) {
    x1 = Math.max(0, Math.min(point.x, right - min));
  }

  if (handle.includes("e")) {
    x2 = Math.min(imageCanvas.width, Math.max(point.x, left + min));
  }

  if (handle.includes("n")) {
    y1 = Math.max(0, Math.min(point.y, bottom - min));
  }

  if (handle.includes("s")) {
    y2 = Math.min(imageCanvas.height, Math.max(point.y, top + min));
  }

  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.max(min, Math.round(x2 - x1)),
    height: Math.max(min, Math.round(y2 - y1)),
  };
}

function getDisplayedSelection() {
  if (!dragStart || !dragCurrent) return selection;

  if (cropMode === "new") {
    return normalizeRect(dragStart, dragCurrent);
  }

  if (cropMode === "move") {
    const dx = dragCurrent.x - dragStart.x;
    const dy = dragCurrent.y - dragStart.y;

    return constrainRect({
      x: selectionBeforeDrag.x + dx,
      y: selectionBeforeDrag.y + dy,
      width: selectionBeforeDrag.width,
      height: selectionBeforeDrag.height,
    });
  }

  if (cropMode === "resize") {
    return resizeRect(selectionBeforeDrag, dragCurrent, resizeHandle);
  }

  return selection;
}

// ========================================
// SELECTION DRAWING
// ========================================

function drawHandles(rect) {
  const radius = getHandleSize() / 2;

  const positions = [
    [rect.x, rect.y],
    [rect.x + rect.width / 2, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height / 2],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x + rect.width / 2, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
    [rect.x, rect.y + rect.height / 2],
  ];

  selectionContext.fillStyle = "#ffffff";
  selectionContext.strokeStyle = "#4e80f6";
  selectionContext.lineWidth = Math.max(2, imageCanvas.width / 700);

  for (const [x, y] of positions) {
    selectionContext.beginPath();
    selectionContext.arc(x, y, radius, 0, Math.PI * 2);
    selectionContext.fill();
    selectionContext.stroke();
  }
}

function updateDimensions(rect = selection) {
  if (!rect || rect.width < 1 || rect.height < 1) {
    $("dimensions").textContent = "No selection";
    $("applyButton").disabled = true;
    return;
  }

  $("dimensions").textContent =
    `${Math.round(rect.width).toLocaleString()} × ${Math.round(rect.height).toLocaleString()} px`;

  $("applyButton").disabled = !imageLoaded || $("effect").value === "paint";
}

function drawSelection() {
  selectionContext.clearRect(
    0,
    0,
    selectionCanvas.width,
    selectionCanvas.height,
  );

  if (!imageLoaded) return;

  if ($("effect").value === "paint") {
    drawPaintPreview();
    updateDimensions(null);
    return;
  }

  const rect = getDisplayedSelection();

  if (!rect || rect.width < 1 || rect.height < 1) {
    updateDimensions(null);
    return;
  }

  selectionContext.fillStyle = "rgba(0,0,0,0.55)";

  selectionContext.fillRect(
    0,
    0,
    selectionCanvas.width,
    selectionCanvas.height,
  );

  selectionContext.clearRect(rect.x, rect.y, rect.width, rect.height);

  selectionContext.strokeStyle = "#ffffff";
  selectionContext.lineWidth = Math.max(2, imageCanvas.width / 800);

  selectionContext.setLineDash([
    Math.max(5, imageCanvas.width / 180),
    Math.max(4, imageCanvas.width / 250),
  ]);

  selectionContext.strokeRect(rect.x, rect.y, rect.width, rect.height);

  selectionContext.setLineDash([]);

  drawHandles(rect);
  updateDimensions(rect);
}

// ========================================
// PAINT MODE
// ========================================

function getBrushSize() {
  return Number($("brushSize").value);
}

function drawPaintPreview() {
  selectionContext.clearRect(
    0,
    0,
    selectionCanvas.width,
    selectionCanvas.height,
  );

  selectionContext.save();

  selectionContext.globalAlpha = 0.42;
  selectionContext.drawImage(paintCanvas, 0, 0);

  selectionContext.restore();
}

function paintLine(from, to) {
  const radius = getBrushSize() / 2;

  paintContext.save();

  paintContext.globalCompositeOperation = "source-over";
  paintContext.strokeStyle = "#ffffff";
  paintContext.fillStyle = "#ffffff";
  paintContext.lineWidth = radius * 2;
  paintContext.lineCap = "round";
  paintContext.lineJoin = "round";

  paintContext.beginPath();
  paintContext.moveTo(from.x, from.y);
  paintContext.lineTo(to.x, to.y);
  paintContext.stroke();

  paintContext.beginPath();
  paintContext.arc(to.x, to.y, radius, 0, Math.PI * 2);
  paintContext.fill();

  paintContext.restore();
}

function startPainting(event) {
  if (!imageLoaded) return;
  if ($("effect").value !== "paint") return;
  if (event.button !== 0) return;

  event.preventDefault();

  if (isPainting) return;

  saveUndo();

  paintUndoSaved = true;
  isPainting = true;
  activePointerId = event.pointerId;

  paintLastPoint = getPointerPosition(event);

  selectionCanvas.setPointerCapture(event.pointerId);

  paintLine(paintLastPoint, paintLastPoint);

  drawPaintPreview();
  setStatus("Painting...");
}

function continuePainting(event) {
  if (!isPainting) return;
  if (event.pointerId !== activePointerId) return;

  event.preventDefault();

  const point = getPointerPosition(event);

  paintLine(paintLastPoint, point);

  paintLastPoint = point;

  drawPaintPreview();
}

function stopPainting() {
  if (!isPainting) return;

  isPainting = false;
  paintLastPoint = null;
  activePointerId = null;

  applyPaintEffect();

  paintUndoSaved = false;

  drawSelection();
  setControls(true);

  setStatus("Paint effect applied");
}

function cancelPainting() {
  if (!isPainting) return;

  isPainting = false;
  paintLastPoint = null;
  activePointerId = null;
  paintUndoSaved = false;

  clearPaintMask();

  // Remove the unused undo entry from the canceled stroke.
  if (undoStack.length) {
    undoStack.pop();
  }

  drawSelection();
  setControls(true);

  setStatus("Paint cancelled");
}

function applyPaintEffect() {
  const mask = paintContext.getImageData(
    0,
    0,
    paintCanvas.width,
    paintCanvas.height,
  );

  const image = imageContext.getImageData(
    0,
    0,
    imageCanvas.width,
    imageCanvas.height,
  );

  const source = new Uint8ClampedArray(image.data);
  const pixels = image.data;

  const paintEffect = $("paintEffect").value;
  const blockSize = Number($("blockSize").value);
  const variation = Number($("variation").value) / 100;

  if (paintEffect === "solid") {
    for (let i = 0; i < mask.data.length; i += 4) {
      if (mask.data[i + 3] === 0) continue;

      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
      pixels[i + 3] = 255;
    }
  } else {
    let row = 0;

    while (row < imageCanvas.height) {
      const blockHeight = Math.min(
        paintEffect === "blocks"
          ? randomInt(
              Math.max(2, Math.round(blockSize * (1 - variation))),
              Math.max(2, Math.round(blockSize * (1 + variation))),
            )
          : blockSize,
        imageCanvas.height - row,
      );

      let column = 0;

      while (column < imageCanvas.width) {
        const blockWidth = Math.min(
          paintEffect === "blocks"
            ? randomInt(
                Math.max(2, Math.round(blockSize * (1 - variation))),
                Math.max(2, Math.round(blockSize * (1 + variation))),
              )
            : blockSize,
          imageCanvas.width - column,
        );

        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        let selected = false;

        for (let py = row; py < row + blockHeight; py++) {
          for (let px = column; px < column + blockWidth; px++) {
            const i = (py * imageCanvas.width + px) * 4;

            if (mask.data[i + 3] > 0) {
              selected = true;
            }

            r += source[i];
            g += source[i + 1];
            b += source[i + 2];

            count++;
          }
        }

        if (selected && count > 0) {
          const color = [
            Math.round(r / count),
            Math.round(g / count),
            Math.round(b / count),
          ];

          for (let py = row; py < row + blockHeight; py++) {
            for (let px = column; px < column + blockWidth; px++) {
              const i = (py * imageCanvas.width + px) * 4;

              if (mask.data[i + 3] === 0) continue;

              pixels[i] = color[0];
              pixels[i + 1] = color[1];
              pixels[i + 2] = color[2];
              pixels[i + 3] = 255;
            }
          }
        }

        column += blockWidth;
      }

      row += blockHeight;
    }
  }

  imageContext.putImageData(image, 0, 0);

  clearPaintMask();

  const names = {
    pixelate: "Painted pixelation applied",
    blocks: "Painted randomized blocks applied",
    solid: "Painted black redaction applied",
  };

  setStatus(names[paintEffect] || "Paint effect applied");
}

// ========================================
// SELECTION INTERACTION
// ========================================

selectionCanvas.addEventListener("pointerdown", (event) => {
  if (!imageLoaded || event.button !== 0) return;

  if ($("effect").value === "paint") {
    startPainting(event);
    return;
  }

  const point = getPointerPosition(event);
  const hit = getHitInfo(point);

  selectionBeforeDrag = selection ? { ...selection } : null;

  dragCurrent = point;

  if (hit === "move") {
    cropMode = "move";
    dragStart = point;
  } else if (hit) {
    cropMode = "resize";
    resizeHandle = hit;
    dragStart = point;
  } else {
    cropMode = "new";
    dragStart = point;
    selection = null;
    selectionBeforeDrag = null;
  }

  selectionCanvas.setPointerCapture(event.pointerId);

  selectionCanvas.style.cursor = getCursor(
    hit === "move" ? "move" : hit || "new",
  );

  drawSelection();
});

selectionCanvas.addEventListener("pointermove", (event) => {
  if (isPainting) {
    continuePainting(event);
    return;
  }

  const point = getPointerPosition(event);

  if (!dragStart) {
    selectionCanvas.style.cursor = getCursor(getHitInfo(point) || "new");

    return;
  }

  dragCurrent = point;
  drawSelection();
});

selectionCanvas.addEventListener("pointerup", (event) => {
  if (isPainting) {
    if (event.pointerId === activePointerId) {
      stopPainting();
    }

    return;
  }

  if (!dragStart) return;

  dragCurrent = getPointerPosition(event);

  const result = getDisplayedSelection();

  if (
    result &&
    result.width >= MIN_SELECTION &&
    result.height >= MIN_SELECTION
  ) {
    selection = constrainRect(result);
  } else if (cropMode === "new") {
    selection = null;
  }

  clearInteraction();

  selectionCanvas.style.cursor = "crosshair";

  drawSelection();
  setControls(true);
});

selectionCanvas.addEventListener("pointercancel", () => {
  if (isPainting) {
    cancelPainting();
    return;
  }

  clearInteraction();
  drawSelection();
});

selectionCanvas.addEventListener("lostpointercapture", () => {
  if (isPainting) {
    cancelPainting();
    return;
  }

  if (dragStart) {
    clearInteraction();
    drawSelection();
  }
});

// ========================================
// UNDO
// ========================================

function saveUndo() {
  if (!imageLoaded) return;

  undoStack.push(
    imageContext.getImageData(0, 0, imageCanvas.width, imageCanvas.height),
  );

  if (undoStack.length > 20) {
    undoStack.shift();
  }

  $("undoButton").disabled = false;
}

function undo() {
  if (!undoStack.length || !imageLoaded) return;

  const previous = undoStack.pop();

  imageContext.putImageData(previous, 0, 0);

  clearPaintMask();

  $("undoButton").disabled = undoStack.length === 0;

  drawSelection();

  setStatus("Last effect undone");
  setControls(true);
}

// ========================================
// IMAGE PROCESSING
// ========================================

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function processImage() {
  if (!imageLoaded || !selection) return;
  if ($("effect").value === "paint") return;

  const x = Math.max(0, Math.floor(selection.x));
  const y = Math.max(0, Math.floor(selection.y));

  const right = Math.min(
    imageCanvas.width,
    Math.ceil(selection.x + selection.width),
  );

  const bottom = Math.min(
    imageCanvas.height,
    Math.ceil(selection.y + selection.height),
  );

  const width = right - x;
  const height = bottom - y;

  if (width <= 0 || height <= 0) return;

  const effect = $("effect").value;

  saveUndo();

  if (effect === "solid") {
    imageContext.save();

    imageContext.globalCompositeOperation = "source-over";
    imageContext.fillStyle = "#000000";
    imageContext.fillRect(x, y, width, height);

    imageContext.restore();

    setStatus("Solid black redaction applied");

    drawSelection();
    setControls(true);

    return;
  }

  if (effect === "falsepixel") {
    const pixelSize = Math.max(2, Number($("falsepixelPixelSize").value) || 12);
    const gradientSections = Math.max(
      1,
      Number($("falsepixelGradientSections").value) || 10,
    );

    const imageData = imageContext.getImageData(
      0,
      0,
      imageCanvas.width,
      imageCanvas.height,
    );

    const pixels = imageData.data;
    const source = new Uint8ClampedArray(pixels);

    // Store average RGB values for each diagonal gradient section.
    const sectionColors = Array.from({ length: gradientSections }, () => ({
      r: 0,
      g: 0,
      b: 0,
      count: 0,
    }));

    // Calculate the average RGB color of each diagonal section.
    for (let py = y; py < bottom; py++) {
      for (let px = x; px < right; px++) {
        const normalizedX = (px - x + 0.5) / width;
        const normalizedY = (py - y + 0.5) / height;

        const gradientPosition = (normalizedX + normalizedY) / 2;

        const section = Math.min(
          gradientSections - 1,
          Math.floor(gradientPosition * gradientSections),
        );

        const index = (py * imageCanvas.width + px) * 4;
        const color = sectionColors[section];

        color.r += source[index];
        color.g += source[index + 1];
        color.b += source[index + 2];
        color.count++;
      }
    }

    // Calculate average RGB values.
    for (const color of sectionColors) {
      if (color.count > 0) {
        color.r /= color.count;
        color.g /= color.count;
        color.b /= color.count;
      }
    }

    // Fill empty sections using the nearest populated section.
    for (let s = 0; s < gradientSections; s++) {
      if (sectionColors[s].count > 0) continue;

      let nearest = -1;
      let nearestDistance = Infinity;

      for (let j = 0; j < gradientSections; j++) {
        if (sectionColors[j].count === 0) continue;

        const distance = Math.abs(s - j);

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = j;
        }
      }

      if (nearest !== -1) {
        sectionColors[s].r = sectionColors[nearest].r;
        sectionColors[s].g = sectionColors[nearest].g;
        sectionColors[s].b = sectionColors[nearest].b;
      }
    }

    // Deterministic random variation.
    let seed =
      ((width * 73856093) ^ (height * 19349663) ^ (x * 83492791) ^ y) >>> 0;

    function randomVariation() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296) * 2 - 1;
    }

    // Generate the pixelated diagonal gradient.
    for (let by = y; by < bottom; by += pixelSize) {
      const blockHeight = Math.min(pixelSize, bottom - by);

      for (let bx = x; bx < right; bx += pixelSize) {
        const blockWidth = Math.min(pixelSize, right - bx);

        const centerX = (bx - x + blockWidth / 2) / width;
        const centerY = (by - y + blockHeight / 2) / height;

        const gradientPosition = (centerX + centerY) / 2;

        const section = Math.min(
          gradientSections - 1,
          Math.floor(gradientPosition * gradientSections),
        );

        const color = sectionColors[section];

        // Subtle variation applied equally to RGB channels.
        const variation = randomVariation() * 7;

        const r = Math.round(Math.max(0, Math.min(255, color.r + variation)));

        const g = Math.round(Math.max(0, Math.min(255, color.g + variation)));

        const b = Math.round(Math.max(0, Math.min(255, color.b + variation)));

        // Completely replace the original pixels.
        for (let py = by; py < by + blockHeight; py++) {
          for (let px = bx; px < bx + blockWidth; px++) {
            const index = (py * imageCanvas.width + px) * 4;

            pixels[index] = r;
            pixels[index + 1] = g;
            pixels[index + 2] = b;
            pixels[index + 3] = 255;
          }
        }
      }
    }

    imageContext.putImageData(imageData, 0, 0);

    setStatus("FalsePixel redaction applied");

    drawSelection();
    setControls(true);

    return;
  }
  const blockSize = Number($("blockSize").value);
  const variation =
    effect === "blocks" ? Number($("variation").value) / 100 : 0;

  const imageData = imageContext.getImageData(
    0,
    0,
    imageCanvas.width,
    imageCanvas.height,
  );

  const pixels = imageData.data;
  const source = new Uint8ClampedArray(pixels);

  for (let by = y; by < bottom; ) {
    const bh = Math.min(
      Math.max(
        2,
        Math.round(blockSize * (1 + (Math.random() * 2 - 1) * variation)),
      ),
      bottom - by,
    );

    for (let bx = x; bx < right; ) {
      const bw = Math.min(
        Math.max(
          2,
          Math.round(blockSize * (1 + (Math.random() * 2 - 1) * variation)),
        ),
        right - bx,
      );

      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let py = by; py < by + bh; py++) {
        for (let px = bx; px < bx + bw; px++) {
          const i = (py * imageCanvas.width + px) * 4;

          r += source[i];
          g += source[i + 1];
          b += source[i + 2];

          count++;
        }
      }

      const color = [
        Math.round(r / count),
        Math.round(g / count),
        Math.round(b / count),
      ];

      for (let py = by; py < by + bh; py++) {
        for (let px = bx; px < bx + bw; px++) {
          const i = (py * imageCanvas.width + px) * 4;

          pixels[i] = color[0];
          pixels[i + 1] = color[1];
          pixels[i + 2] = color[2];
          pixels[i + 3] = 255;
        }
      }

      bx += bw;
    }

    by += bh;
  }

  imageContext.putImageData(imageData, 0, 0);

  setStatus(
    effect === "pixelate" ? "Pixelation applied" : "Randomized blocks applied",
  );

  drawSelection();
  setControls(true);
}

// ========================================
// IMAGE CONTROLS
// ========================================

function resetImage() {
  if (!originalImageData) return;

  imageContext.putImageData(originalImageData, 0, 0);

  selection = null;
  undoStack = [];

  clearInteraction();
  clearPaintMask();

  drawSelection();

  setStatus("Image restored");
  setControls(true);
}

function clearSelection() {
  selection = null;

  clearInteraction();
  clearPaintMask();

  drawSelection();

  setStatus("Selection cleared");
  setControls(true);
}

function downloadImage() {
  if (!imageLoaded) return;

  imageCanvas.toBlob((blob) => {
    if (!blob) {
      alert("Could not create the image.");
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "trueblur.png";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus("Image downloaded");
  }, "image/png");
}

// ========================================
// SETTINGS
// ========================================

function updateEffectSettings() {
  const effect = $("effect").value;
  const paintEffect = $("paintEffect").value;

  const isPaint = effect === "paint";

  $("paintSettings").classList.toggle("hidden", !isPaint);

  const activeEffect = isPaint ? paintEffect : effect;

  $("blockSetting").classList.toggle("hidden", activeEffect === "solid");

  $("variationSetting").classList.toggle("hidden", activeEffect !== "blocks");

  $("falsepixelSetting").classList.toggle(
    "hidden",
    activeEffect !== "falsepixel",
  );

  $("brushSetting").classList.toggle("hidden", !isPaint);

  $("applyButton").disabled = !imageLoaded || !selection || isPaint;

  selectionCanvas.style.cursor = isPaint ? "crosshair" : "crosshair";

  drawSelection();
}

$("effect").addEventListener("change", () => {
  clearPaintMask();

  updateEffectSettings();

  setStatus(
    $("effect").value === "paint"
      ? "Paint mode selected"
      : "Selection mode selected",
  );
});

$("paintEffect").addEventListener("change", updateEffectSettings);

$("blockSize").addEventListener("input", (event) => {
  $("blockValue").textContent = `${event.target.value} px`;
});

$("variation").addEventListener("input", (event) => {
  $("variationValue").textContent = `${event.target.value}%`;
});

$("brushSize").addEventListener("input", (event) => {
  $("brushValue").textContent = `${event.target.value} px`;
});

$("falsepixelPixelSize").addEventListener("input", (event) => {
  $("falsepixelPixelSizeValue").textContent = `${event.target.value} px`;
});

$("falsepixelGradientSections").addEventListener("input", (event) => {
  // No value display needed, but could add one
});

// ========================================
// EVENTS
// ========================================

imageInput.addEventListener("change", () => {
  loadImage(imageInput.files[0]);
  imageInput.value = "";
});

$("applyButton").addEventListener("click", processImage);
$("resetButton").addEventListener("click", resetImage);
$("clearSelection").addEventListener("click", clearSelection);
$("downloadButton").addEventListener("click", downloadImage);
$("undoButton").addEventListener("click", undo);

document.addEventListener("keydown", (event) => {
  if (
    event.target.matches("input, select, textarea") ||
    event.target.isContentEditable
  ) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  }

  if (event.key === "Escape") {
    if (isPainting) {
      cancelPainting();
    } else {
      clearSelection();
    }
  }
});

// ========================================
// THEME
// ========================================

function initializeTheme() {
  const saved = localStorage.getItem("truehide-theme");

  if (saved) {
    document.documentElement.dataset.theme = saved;
  }

  $("themeToggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    const next = current === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = next;

    localStorage.setItem("truehide-theme", next);
  });
}

initializeTheme();

// ========================================
// DRAG AND DROP
// ========================================

const dropOverlay = $("dropOverlay");

document.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;

  event.preventDefault();

  dragDepth++;

  dropOverlay.classList.add("visible");
});

document.addEventListener("dragover", (event) => {
  if (event.dataTransfer.types.includes("Files")) {
    event.preventDefault();
  }
});

document.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;

  dragDepth = Math.max(0, dragDepth - 1);

  if (dragDepth === 0) {
    dropOverlay.classList.remove("visible");
  }
});

document.addEventListener("drop", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;

  event.preventDefault();

  dragDepth = 0;

  dropOverlay.classList.remove("visible");

  const file = event.dataTransfer.files[0];

  if (file) {
    loadImage(file);
  }
});

// ========================================
// CLEANUP
// ========================================

window.addEventListener("beforeunload", () => {
  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
  }
});

// ========================================
// INITIALIZATION
// ========================================

updateEffectSettings();
setControls(false);
