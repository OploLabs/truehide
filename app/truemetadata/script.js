// TrueMetadata — view and remove image metadata, entirely in the browser.
//
// No libraries are used: EXIF/TIFF, XMP, PNG text chunks and WebP RIFF
// chunks are parsed from raw bytes. Removal is byte-level surgery on the
// original container, so pixel data is preserved bit-for-bit; a canvas
// re-encode is only used as a last-resort fallback for JPEG.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const toast = (message, options) =>
    window.TrueHide.toast(message, options);

  const TEXT = new TextDecoder("utf-8");

  /* =============================================================
     Small helpers
     ============================================================= */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => {
      return (
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c] || c
      );
    });
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  /* ---------- TIFF (EXIF) binary reader ---------- */

  // `view` over the TIFF bytes starting at the "II"/"MM" marker,
  // `endianness` as 1 (little) or -1 (big).
  function makeTiffReader(view, endianness) {
    return {
      u16(off) {
        return view.getUint16(off, endianness === 1);
      },
      u32(off) {
        return view.getUint32(off, endianness === 1);
      },
      i32(off) {
        return view.getInt32(off, endianness === 1);
      },
      bytes(off, len) {
        return new Uint8Array(view.buffer, view.byteOffset + off, len);
      },
      ascii(off, len) {
        const raw = this.bytes(off, len);
        let end = raw.length;
        while (end > 0 && raw[end - 1] === 0) end--;
        return TEXT.decode(raw.subarray(0, end)).trim();
      },
    };
  }

  function tiffStart(u8, offset) {
    // Returns { view, endianness } or null. offset points at II or MM.
    if (offset + 8 > u8.length) return null;
    const little = u8[offset] === 0x49 && u8[offset + 1] === 0x49;
    const big = u8[offset] === 0x4d && u8[offset + 1] === 0x4d;
    if (!little && !big) return null;
    const endianness = little ? 1 : -1;
    const view = new DataView(u8.buffer, u8.byteOffset + offset, u8.length - offset);
    const magic = view.getUint16(2, endianness === 1);
    if (magic !== 0x002a) return null;
    return { view, endianness };
  }

  // Reads one IFD at `ifdOffset` and follows pointer tags.
  // Returns Map<tag, { raw: <number|array|{n,d}> , size }>.
  function readIfd(view, endianness, ifdOffset) {
    const r = makeTiffReader(view, endianness);
    const entries = new Map();
    if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) return { entries, next: 0 };

    const count = r.u16(ifdOffset);
    if (count > 200) return { entries, next: 0 }; // corrupt

    for (let i = 0; i < count; i++) {
      const p = ifdOffset + 2 + i * 12;
      if (p + 12 > view.byteLength) break;

      const tag = r.u16(p);
      const type = r.u16(p + 2);
      const countV = r.u32(p + 4);

      const sizes = {
        1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4,
        12: 8, 16: 8,
      };
      const size = sizes[type];
      if (!size || countV < 0 || countV > 4096) continue;

      const total = size * countV;
      let off;
      if (total <= 4) {
        off = p + 8;
      } else {
        off = r.u32(p + 8);
      }
      if (off + total > view.byteLength) continue;

      let value;
      if (type === 2) {
        value = r.ascii(off, total);
      } else if (type === 5 || type === 10 || type === 11) {
        const vals = [];
        for (let k = 0; k < countV; k++) {
          const n = type === 10 ? r.i32(off + k * 8) : r.u32(off + k * 8);
          const d = type === 10 ? r.i32(off + k * 8 + 4) : r.u32(off + k * 8 + 4);
          vals.push(d === 0 ? null : { n, d });
        }
        value = vals;
      } else if (type === 3 || type === 8) {
        const vals = [];
        for (let k = 0; k < countV; k++) {
          let v = r.u16(off + k * 2);
          if (type === 8) v = v > 32767 ? v - 65536 : v;
          vals.push(v);
        }
        value = countV === 1 ? vals[0] : vals;
      } else if (type === 4 || type === 9) {
        const vals = [];
        for (let k = 0; k < countV; k++) {
          let v = type === 9 ? r.i32(off + k * 4) : r.u32(off + k * 4);
          vals.push(v);
        }
        value = countV === 1 ? vals[0] : vals;
      } else if (type === 1) {
        const vals = [];
        for (let k = 0; k < countV; k++) vals.push(r.bytes(off + k, 1)[0]);
        value = countV === 1 ? vals[0] : vals;
      } else if (type === 7) {
        value = r.bytes(off, total);
      } else {
        continue;
      }

      entries.set(tag, { value, type });
    }

    const next = r.u32(ifdOffset + 2 + count * 12);
    return { entries, next };
  }

  /* ---------- EXIF tag dictionaries ---------- */

  const CATEGORIES = ["general", "camera", "location", "dates", "software", "other"];

  const CAT_LABELS = {
    general: "General",
    camera: "Camera",
    location: "Location",
    dates: "Dates",
    software: "Software",
    other: "Other",
  };

  function rationalText(v) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "object") {
      if (v.d === 1) return String(v.n);
      const num = v.n / v.d;
      if (Math.abs(num - Math.round(num)) < 1e-9) return String(Math.round(num));
      return num.toFixed(3).replace(/\.?0+$/, "");
    }
    return String(v);
  }

  const ORIENTATIONS = {
    1: "Normal",
    2: "Mirrored horizontally",
    3: "Rotated 180°",
    4: "Mirrored vertically",
    5: "Transposed (mirrored, rotated 90°)",
    6: "Rotated 90° CW",
    7: "Transposed (mirrored, rotated 270°)",
    8: "Rotated 90° CCW",
  };

  const PROGRAMS = {
    0: "Not defined",
    1: "Manual",
    2: "Automatic",
    3: "Aperture priority",
    4: "Shutter priority",
    5: "Creative",
    6: "Action",
    7: "Portrait",
    8: "Landscape",
  };

  const METERING = {
    0: "Unknown",
    1: "Average",
    2: "Spot",
    3: "Weighted center",
    4: "Top-weighted",
  };

  const LIGHT_SOURCES = {
    0: "Unknown",
    1: "Daylight",
    2: "Fluorescent",
    3: "Tungsten (incandescent light)",
    4: "Flash",
    9: "Underwater daylight",
    10: "Underwater fluorescent",
    11: "Underwater tungsten",
    12: "Underwater flash",
    13: "Fine weather",
    14: "Cloudy sky",
    15: "Shade",
    16: "Lighted window",
    17: "Overcast daylight",
  };

  function flashText(v) {
    if (typeof v !== "number") return String(v);
    if (v === 0) return "Flash did not fire";
    if (v & 1) return "Fired";
    return "No flash function";
  }

  function exposureValueText(v) {
    // ShutterSpeedValue / ApertureValue are EVs: 2^-EV (shutter, s) / 2^(EV/2) (f).
    if (v === null || v === undefined) return "—";
    const num = typeof v === "object" ? v.n / v.d : v;
    if (typeof num !== "number" || !isFinite(num)) return String(v);
    return num;
  }

  function shutterFromEv(ev) {
    const s = Math.pow(2, -ev);
    if (s >= 1) return s.toFixed(s >= 10 ? 0 : 1) + " s";
    return "1/" + Math.round(1 / s) + " s";
  }

  function apertureFromEv(ev) {
    return "f/" + (Math.pow(2, ev / 2) * 10).toFixed(0) / 10;
  }

  function coordsFromRationals(vals, ref) {
    // vals: [{n,d} x3] degrees/minutes/seconds; ref: "N"/"S" or "E"/"W"
    if (!Array.isArray(vals) || vals.length < 3) return null;
    const [d, m, s] = vals;
    if (d === null || m === null || s === null) return null;
    let deg = d.n / d.d + m.n / m.d / 60 + s.n / s.d / 3600;
    if (ref === "S" || ref === "W") deg = -deg;
    return deg;
  }

  function dmsText(vals, ref) {
    const [d, m, s] = vals;
    if (!d || !m) return "";
    const sec = s ? (s.n / s.d).toFixed(2).replace(/\.0+$/, "") : "0";
    return (
      Math.trunc(d.n / d.d) + "° " +
      Math.trunc(m.n / m.d) + "' " +
      sec + '"' + " " + ref
    );
  }

  /* ---------- Generic field builder ---------- */

  let fieldSeq = 0;

  function addField(fields, key, value, category) {
    const str =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (!str || str === "null") return;
    fields.push({ id: ++fieldSeq, key, value: str, category });
  }

  // Decodes a single EXIF IFD entry into display fields.
  function exifEntriesToFields(entries, ifdName, fields) {
    const t = (tag, label, category) => entries.get(tag);

    function put(tag, label, category, formatter) {
      const e = entries.get(tag);
      if (!e) return;
      let v = e.value;
      if (formatter) v = formatter(v, e);
      addField(fields, label, v, category);
    }

    if (ifdName === "ifd0") {
      put(0x0103, "Compression", "general", (v) => (v === 6 ? "Baseline JPEG" : String(v)));
      put(0x010e, "Image description", "general");
      put(0x010f, "Camera make", "camera");
      put(0x0110, "Camera model", "camera");
      put(0x011a, "Orientation", "general", (v) => ORIENTATIONS[v] || String(v));
      put(0x0131, "Software", "software");
      put(0x0132, "Artist", "other");
      put(0x013d, "Date & time", "dates");
      put(0x013e, "Copyright", "other");
      put(0x829a, "Exposure time", "camera", (v) =>
        v !== null ? (v.n / v.d >= 1 ? (v.n / v.d).toFixed(2) + " s" : "1/" + v.n + " s") : v,
      );
      put(0x829d, "Aperture", "camera", (v) => (v !== null ? "f/" + rationalText(v) : v));
    }

    if (ifdName === "exif") {
      put(0x0003, "Exposure program", "camera", (v) => PROGRAMS[v] || String(v));
      put(0x0004, "F-number", "camera", (v) => "f/" + rationalText(v));
      put(0x0005, "ISO", "camera");
      put(0x0082, "Sensitivity type", "camera", (v) => (v === 1 ? "Standard (ISO)" : String(v)));
      put(0x0083, "ISO", "camera");
      put(0x9003, "Date & time original", "dates");
      put(0x9004, "Date & time digitized", "dates");
      put(0x9201, "Shutter speed", "camera", (v) => {
        const ev = exposureValueText(v);
        return typeof ev === "number" ? shutterFromEv(ev) : String(v);
      });
      put(0x9202, "Aperture value", "camera", (v) => {
        const ev = exposureValueText(v);
        return typeof ev === "number" ? apertureFromEv(ev) : String(v);
      });
      put(0x9204, "Exposure bias", "camera", (v) => {
        const ev = exposureValueText(v);
        return typeof ev === "number" ? ev + " EV" : String(v);
      });
      put(0x9205, "Subject distance", "camera", (v) => rationalText(v) + " m");
      put(0x9207, "Metering mode", "camera", (v) => METERING[v] || String(v));
      put(0x9208, "Light source", "camera", (v) => LIGHT_SOURCES[v] || String(v));
      put(0x9209, "Flash", "camera", flashText);
      put(0x920a, "Focal length", "camera", (v) => rationalText(v) + " mm");
      put(0x9286, "Focal length (35mm equiv.)", "camera", (v) => v + " mm");
      put(0xa001, "Color space", "general", (v) => (v === 1 ? "sRGB" : "Uncalibrated"));
      put(0xa003, "Focal length units", "camera");
      put(0xa20e, "Pixel width", "general", (v) => v + " px");
      put(0xa20f, "Pixel height", "general", (v) => v + " px");
      put(0x8827, "ISO", "camera");
      put(0x829a, "Exposure time", "camera", (v) =>
        v !== null ? "1/" + v.n + " s" : v,
      );
      put(0x829d, "Aperture", "camera", (v) => "f/" + rationalText(v));
    }

    if (ifdName === "gps") {
      const lat = t(0x000e), lon = t(0x000f);
      const latR = t(0x000e), lonR = t(0x0010);
      const latRef = t(0x000f), lonRef = t(0x0011);

      if (lat && lat.value) {
        const ref = latRef ? String(latRef.value).trim() : "N";
        const deg = coordsFromRationals(lat.value, ref);
        if (deg !== null) {
          addField(
            fields,
            "GPS latitude",
            "location",
            Math.abs(deg).toFixed(5) + "° (" + dmsText(lat.value, ref) + ")",
          );
        }
      }
      if (lonR && lonR.value) {
        const ref = lonRef ? String(lonRef.value).trim() : "E";
        const deg = coordsFromRationals(lonR.value, ref);
        if (deg !== null) {
          addField(
            fields,
            "GPS longitude",
            "location",
            Math.abs(deg).toFixed(5) + "° (" + dmsText(lonR.value, ref) + ")",
          );
        }
      }
      put(0x0006, "GPS altitude", "location", (v) => {
        const alt = rationalText(v);
        const ref = t(0x0007);
        const suffix = ref && String(ref.value) === "1" ? " m (below sea level)" : " m";
        return alt + suffix;
      });
      put(0x001d, "GPS date stamp", "dates");
      put(0x0011, "GPS time stamp", "dates", (v) => {
        if (!Array.isArray(v) || v.length < 3 || v[0] === null) return null;
        const h = v[0].n / v[0].d, m = v[1].n / v[1].d, s = v[2].n / v[2].d;
        return h + ":" + String(Math.trunc(m)).padStart(2, "0") + ":" + s.toFixed(1);
      });
      put(0x0012, "GPS satellites", "location");
      put(0x0013, "GPS measurement", "location");
    }

    if (ifdName === "interoperability") {
      put(0x0001, "Interoperability index", "other", (v) =>
        v === "R98" ? "R98 (EXIF version 2.2+)" : String(v),
      );
    }
  }

  /* ---------- EXIF block (JPEG / WebP) ---------- */

  function parseExifBlock(u8, offset) {
    // offset points at "Exif\x00\x00" (JPEG APP1 / WebP EXIF chunk) or
    // directly at the TIFF header; detect which.
    const fields = [];
    const hasPrefix =
      u8[offset] === 0x45 && u8[offset + 1] === 0x78 && u8[offset + 2] === 0x69;
    const start = tiffStart(u8, offset + (hasPrefix ? 6 : 0));
    if (!start) return fields;

    const { view, endianness } = start;
    const root = view.getUint32(4, endianness === 1);

    const ifd0 = readIfd(view, endianness, root);
    exifEntriesToFields(ifd0.entries, "ifd0", fields);

    const exifPtr = ifd0.entries.get(0x8769);
    if (exifPtr && typeof exifPtr.value === "number") {
      const ex = readIfd(view, endianness, exifPtr.value);
      exifEntriesToFields(ex.entries, "exif", fields);
    }

    const gpsPtr = ifd0.entries.get(0x8825);
    if (gpsPtr && typeof gpsPtr.value === "number") {
      const gp = readIfd(view, endianness, gpsPtr.value);
      exifEntriesToFields(gp.entries, "gps", fields);
    }

    const ioPtr = ifd0.entries.get(0xa005);
    if (ioPtr && typeof ioPtr.value === "number") {
      const io = readIfd(view, endianness, ioPtr.value);
      exifEntriesToFields(io.entries, "interoperability", fields);
    }

    return fields;
  }

  /* ---------- XMP ---------- */

  function xmpEntity(text) {
    return text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
  }

  function parseXmp(xml, fields) {
    const rules = [
      [/<xmp:CreatorTool[^>]*>([^<]*)<\/xmp:CreatorTool>/i, "Creator tool", "software"],
      [/<pdf:Producer[^>]*>([^<]*)<\/pdf:Producer>/i, "PDF producer", "software"],
      [/<xmp:CreateDate[^>]*>([^<]*)<\/xmp:CreateDate>/i, "Created", "dates"],
      [/<xmp:ModifyDate[^>]*>([^<]*)<\/xmp:ModifyDate>/i, "Modified", "dates"],
      [/<dc:title>(?:\s|<\/?)rdf:Alt[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]*)/i, "Title", "general"],
      [/<dc:creator>(?:\s|<\/?)rdf:Seq[^>]*>[\s\S]*?<rdf:li[^>]*>([^<]*)/i, "Author", "other"],
      [/<exif:Make[^>]*>([^<]*)<\/exif:Make>/i, "Camera make", "camera"],
      [/<exif:Model[^>]*>([^<]*)<\/exif:Model>/i, "Camera model", "camera"],
      [/<exif:PixelXDimension[^>]*>([^<]*)<\/exif:PixelXDimension>/i, "Pixel width", "general"],
      [/<exif:PixelYDimension[^>]*>([^<]*)<\/exif:PixelYDimension>/i, "Pixel height", "general"],
      [/<xmpGP:GPSLatitudeRef[^>]*>([^<]*)<\/xmpGP:GPSLatitudeRef>/i, "GPS latitude ref", "location"],
      [/<xmpGP:GPSLongitudeRef[^>]*>([^<]*)<\/xmpGP:GPSLongitudeRef>/i, "GPS longitude ref", "location"],
      [/<xmpGP:GPSAltitude[^>]*>([^<]*)<\/xmpGP:GPSAltitude>/i, "GPS altitude", "location"],
    ];

    for (const [pattern, label, category] of rules) {
      const m = xml.match(pattern);
      if (m && m[1]) addField(fields, label, xmpEntity(m[1]), category);
    }

    // XMP GPS coordinates, kept as separate decimal values.
    for (const axis of ["Latitude", "Longitude"]) {
      const m = xml.match(
        new RegExp("<xmpGP:GPS" + axis + ">([\\s\\S]*?)</xmpGP:GPS" + axis + ">", "i"),
      );
      if (!m) continue;
      const nums = m[1].match(/-?\d+(\.\d+)?/g);
      if (!nums || nums.length < 1) continue;
      const deg = nums.slice(0, 3).reduce((acc, v, i) => acc + parseFloat(v) / Math.pow(60, i), 0);
      addField(fields, "XMP " + axis.toLowerCase(), deg.toFixed(5), "location");
    }

    if (fields.length === 0) {
      addField(fields, "XMP block", "(present, no recognised fields)", "other");
    }
  }

  /* ---------- Format detection ---------- */

  function detectFormat(u8) {
    if (u8.length < 12) return { format: "unknown", supported: false, label: "Unknown" };

    if (u8[0] === 0xff && u8[1] === 0xd8) {
      return { format: "jpeg", supported: true, label: "JPEG" };
    }
    if (
      u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47
    ) {
      return { format: "png", supported: true, label: "PNG" };
    }
    if (
      u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50
    ) {
      return { format: "webp", supported: true, label: "WebP" };
    }
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
      return {
        format: "gif", supported: false, label: "GIF",
        note: "GIF has no standard metadata container. Remove it by converting to JPEG, PNG or WebP with another TrueHide tool.",
      };
    }
    if ((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4d && u8[1] === 0x4d)) {
      return {
        format: "tiff", supported: false, label: "TIFF",
        note: "TIFF metadata reading and removal are not implemented yet, so TrueMetadata won't pretend to clean one. Open TIFFs in another tool.",
      };
    }
    if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
      return {
        format: "ftyp", supported: false, label: "HEIC / AVIF",
        note: "HEIC and AVIF metadata (often richer than EXIF) are not supported yet. The file is shown for inspection only — it cannot be verified clean.",
      };
    }
    if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) {
      return {
        format: "pdf", supported: false, label: "PDF",
        note: "Documents aren't handled here. For PDFs use TrueFlatten, which rasterizes pages and drops the embedded metadata.",
      };
    }
    return {
      format: "unknown", supported: false, label: "Unrecognized format",
      note: "This file isn't a JPEG, PNG or WebP image, so TrueMetadata can't read or verify its metadata.",
    };
  }

  /* ---------- JPEG reader ---------- */

  function jpegDimensions(u8) {
    let i = 2;
    const n = u8.length;
    while (i + 9 < n) {
      if (u8[i] !== 0xff) { i++; continue; }
      while (i + 1 < n && u8[i + 1] === 0xff) i++;
      const m = u8[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: (u8[i + 7] << 8) | u8[i + 8], height: (u8[i + 5] << 8) | u8[i + 6] };
      }
      if (m === 0xda || m === 0xd9) break;
      i += 2 + len;
    }
    return null;
  }

  function parseJpeg(u8) {
    const fields = [];
    const warnings = [];
    let i = 2;
    const n = u8.length;

    while (i + 3 < n) {
      if (u8[i] !== 0xff) { i++; continue; }
      while (i + 1 < n && u8[i + 1] === 0xff) i++;
      const m = u8[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      const body = i + 4;
      const end = body + len;
      if (end > n) break;

      if (m === 0xe1) {
        if (u8[body] === 0x45 && u8[body + 1] === 0x78 && u8[body + 2] === 0x69) {
          fields.push(...parseExifBlock(u8, body));
        } else if (u8[body] === 0x4d && u8[body + 1] === 0x4d) {
          // IPTC
          addField(fields, "IPTC block", "(present, " + len + " bytes)", "other");
        } else if (
          u8[body] === 0x3c && (u8[body + 1] === 0x3f || u8[body + 1] === 0x78)
        ) {
          const xml = TEXT.decode(u8.subarray(body, end));
          parseXmp(xml, fields);
        }
      } else if (m === 0xfe) {
        const comment = TEXT.decode(u8.subarray(body, end)).replace(/\0/g, "").trim();
        if (comment) addField(fields, "Comment", comment, "other");
      } else if (m === 0xed) {
        warnings.push("Adobe APP13 block present (removed on export)");
      } else if (m === 0xec && len > 12 && u8[body] === 0x49 && u8[body + 3] === 0x43 && u8[body + 4] === 0x43) {
        warnings.push("ICC color profile present (kept — it only describes colors, not you)");
      } else if (m >= 0xf0 && m <= 0xf5) {
        warnings.push("Private APP" + (m - 0xdf) + " block present (removed on export)");
      }

      if (m === 0xda) break;
      i = end;
    }

    return { fields, warnings };
  }

  /* ---------- PNG reader ---------- */

  const PNG_KEEP_TYPES = [
    "IHDR", "PLTE", "bKGD", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "IDAT", "IEND",
  ];

  const PNG_KEYWORDS = {
    software: ["Software", "software"],
    title: ["Title", "general"],
    description: ["Description", "other"],
    comment: ["Comment", "other"],
    "creation time": ["Creation time", "dates"],
    copyright: ["Copyright", "other"],
    author: ["Author", "other"],
    keywords: ["Keywords", "other"],
    "date/time": ["Date & time", "dates"],
    source: ["Source", "other"],
  };

  function parsePng(u8) {
    const fields = [];
    const warnings = [];
    let width = 0, height = 0;
    let i = 8;
    const n = u8.length;

    const keywordInfo = (kw) => PNG_KEYWORDS[kw.toLowerCase()] || [kw, "other"];

    while (i + 8 <= n) {
      const len = ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
      const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      const body = i + 8;
      const end = body + len;
      if (end > n) break;

      if (type === "IHDR") {
        const dv = new DataView(u8.buffer, u8.byteOffset + body, 13);
        width = dv.getUint32(0);
        height = dv.getUint32(4);
      } else if (type === "tEXt") {
        const data = u8.subarray(body, end);
        let nul = 0;
        while (nul < data.length && data[nul] !== 0) nul++;
        const keyword = TEXT.decode(data.subarray(0, nul));
        const value = TEXT.decode(data.subarray(nul + 1)).replace(/\0/g, "");
        const [label, category] = keywordInfo(keyword);
        if (value) addField(fields, "PNG " + label, value, category);
      } else if (type === "iTXt") {
        const data = u8.subarray(body, end);
        let nul = 0;
        while (nul < data.length && data[nul] !== 0) nul++;
        const keyword = TEXT.decode(data.subarray(0, nul));
        let p = nul + 1;
        if (p < end && data[p] === 1) {
          warnings.push("Compressed iTXt text present (" + keyword + ") — removed on export");
        } else {
          p += 1; // compression method
          while (p < end && data[p] !== 0) p++;
          p += 1; // language tag
          let nul2 = p;
          while (nul2 < end && data[nul2] !== 0) nul2++;
          const value = TEXT.decode(u8.subarray(nul2 + 1, end));
          const [label, category] = keywordInfo(keyword);
          if (value) addField(fields, "PNG " + label, value, category);
        }
      } else if (type === "zTXt") {
        const data = u8.subarray(body, end);
        let nul = 0;
        while (nul < data.length && data[nul] !== 0) nul++;
        const keyword = TEXT.decode(data.subarray(0, nul));
        warnings.push("Compressed tEXt block present (" + keyword + ") — removed on export");
      } else if (type === "XP") {
        warnings.push("macOS extended-property chunk present — removed on export");
      } else if (!PNG_KEEP_TYPES.includes(type)) {
        warnings.push("Unrecognized chunk '" + type + "' — removed on export");
      }

      if (type === "IEND") break;
      i = end + 4; // skip CRC
    }

    return { fields, warnings, width, height };
  }

  /* ---------- WebP reader ---------- */

  function parseWebP(u8) {
    const fields = [];
    const warnings = [];
    let width = 0, height = 0;
    let i = 12;
    const n = u8.length;

    while (i + 8 <= n) {
      const id = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
      const len = (u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16) | (u8[i + 7] << 24)) >>> 0;
      const body = i + 8;
      const end = Math.min(body + len, n);

      if (id === "VP8X" && end > body + 9) {
        width = ((u8[body + 8] << 16) | (u8[body + 7] << 8) | u8[body + 6]) + 1;
        height = ((u8[body + 11] << 16) | (u8[body + 10] << 8) | u8[body + 9]) + 1;
      } else if (id === "VP8L" && end > body + 4) {
        const bits =
          u8[body] | (u8[body + 1] << 8) | (u8[body + 2] << 16) | (u8[body + 3] << 24);
        width = ((bits >> 1) & 0x3fff) + 1;
        height = (bits >> 15) + 1;
      } else if (id === "VP8" && end > body + 10) {
        const tag = u8[body];
        if (tag & 1) {
          width = ((u8[body + 7] << 8) | u8[body + 6]) & 0x3fff;
          height = ((u8[body + 9] << 8) | u8[body + 8]) & 0x3fff;
        }
      } else if (id === "EXIF" && end > body + 6) {
        fields.push(...parseExifBlock(u8, body));
      } else if ((id === "XMP" || id === "XXMP") && end > body) {
        const xml = TEXT.decode(u8.subarray(body, end));
        parseXmp(xml, fields);
      }

      i = end + 4;
    }

    return { fields, warnings, width, height };
  }

  /* ---------- Top-level reader ---------- */

  function readImageMetadata(u8) {
    const fmt = detectFormat(u8);
    const result = {
      format: fmt.format,
      supported: fmt.supported,
      label: fmt.label,
      note: fmt.note || "",
      fields: [],
      warnings: [],
      width: 0,
      height: 0,
    };

    if (!fmt.supported) return result;

    if (fmt.format === "jpeg") {
      const r = parseJpeg(u8);
      result.fields = r.fields;
      result.warnings = r.warnings;
      const dims = jpegDimensions(u8);
      if (dims) {
        result.width = dims.width;
        result.height = dims.height;
        result.fields.unshift(
          { id: ++fieldSeq, key: "Width", value: dims.width + " px", category: "general" },
          { id: ++fieldSeq, key: "Height", value: dims.height + " px", category: "general" },
        );
      }
    } else if (fmt.format === "png") {
      const r = parsePng(u8);
      result.fields = r.fields;
      result.warnings = r.warnings;
      result.width = r.width;
      result.height = r.height;
      if (r.width) {
        result.fields.unshift(
          { id: ++fieldSeq, key: "Width", value: r.width + " px", category: "general" },
          { id: ++fieldSeq, key: "Height", value: r.height + " px", category: "general" },
        );
      }
    } else if (fmt.format === "webp") {
      const r = parseWebP(u8);
      result.fields = r.fields;
      result.warnings = r.warnings;
      result.width = r.width;
      result.height = r.height;
      if (r.width) {
        result.fields.unshift(
          { id: ++fieldSeq, key: "Width", value: r.width + " px", category: "general" },
          { id: ++fieldSeq, key: "Height", value: r.height + " px", category: "general" },
        );
      }
    }

    return result;
  }

  /* =============================================================
     Removal — byte-level container surgery
     ============================================================= */

  // JPEG: drop APP1 (EXIF/XMP), APP3, APP16-21 and COM blocks.
  // Everything else (quantization tables, Huffman tables, scan data,
  // APP0 JFIF, APP2 ICC) is copied verbatim, so pixels are untouched.
  function stripJpeg(u8) {
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    const out = [0xff, 0xd8]; // SOI
    const n = u8.length;
    const DROP = new Set([0xe1, 0xe3, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xfe]);

    let i = 2;
    while (i + 2 < n) {
      if (u8[i] !== 0xff) { out.push(u8[i]); i++; continue; }
      while (i + 1 < n && u8[i + 1] === 0xff) i++;
      const m = u8[i + 1];

      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        out.push(0xff, m);
        i += 2;
        continue;
      }
      if (m === 0xd9) {
        out.push(0xff, 0xd9);
        break;
      }
      if (m === 0xda) {
        // SOS header plus the whole entropy-coded scan — copy to EOF.
        for (let k = i; k < n; k++) out.push(u8[k]);
        break;
      }

      const len = (u8[i + 2] << 8) | u8[i + 3];
      const segEnd = i + 2 + len;
      if (segEnd > n) return null; // truncated segment — fall back to canvas

      if (!DROP.has(m)) {
        for (let k = i; k < segEnd; k++) out.push(u8[k]);
      }
      i = segEnd;
    }

    if (out.length < 4) return null;
    return new Uint8Array(out);
  }

  // PNG: keep structural and color chunks, drop every text/property chunk.
  function stripPng(u8) {
    if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50) return null;
    const out = new Uint8Array(u8.length);
    out.set(u8.subarray(0, 8));
    let pos = 8;
    let write = 8;

    while (pos + 8 <= u8.length) {
      const len =
        ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0;
      const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
      const chunkEnd = pos + 8 + len + 4;
      if (chunkEnd > u8.length) return null;

      if (PNG_KEEP_TYPES.includes(type)) {
        out.set(u8.subarray(pos, pos + 8 + len + 4), write);
        write += 8 + len + 4;
      }
      pos = chunkEnd;
      if (type === "IEND") break;
    }

    return out.subarray(0, write);
  }

  // WebP: drop EXIF / XMP / XXMP RIFF chunks, keep the bitstream + alpha.
  function stripWebP(u8) {
    if (u8.length < 30 || u8[0] !== 0x52 || u8[1] !== 0x49) return null;
    const DROP = { EXIF: 1, XMP: 1, XXMP: 1 };
    const out = new Uint8Array(u8.length);
    out.set(u8.subarray(0, 8)); // RIFF + size (rewritten below)
    let write = 8;
    let total = 12;
    let i = 12;
    while (i + 8 <= u8.length) {
      const id = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
      const len =
        (u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16) | (u8[i + 7] << 24)) >>> 0;
      const end = i + 8 + len;
      if (end > u8.length) return null;

      if (!DROP[id]) {
        out.set(u8.subarray(i, end), write);
        write += end - i;
        total += 8 + len;
      }
      i = end;
    }

    // RIFF total size = 4 ("WEBP") + payload kept.
    out[4] = total & 0xff;
    out[5] = (total >> 8) & 0xff;
    out[6] = (total >> 16) & 0xff;
    out[7] = (total >> 24) & 0xff;

    return new Uint8Array(out);
  }

  function stripMetadataBytes(u8, format) {
    switch (format) {
      case "jpeg":
        return stripJpeg(u8);
      case "png":
        return stripPng(u8);
      case "webp":
        return stripWebP(u8);
      default:
        return null;
    }
  }

  // Last-resort fallback: decode pixels and re-encode. JPEG/WebP
  // re-encoding changes quality a little, so it's only used when the
  // byte-level strip failed on a malformed container.
  async function stripViaCanvas(file, format) {
    const mime = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[format];
    const quality = format === "png" ? undefined : 1.0;

    const blob = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (format === "jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => resolve(b), mime, quality);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => {
        resolve(null);
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    });

    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* =============================================================
     UI
     ============================================================= */

  const DIMENSION_KEYS = new Set(["Width", "Height", "Pixel width", "Pixel height"]);

  const state = {
    sequence: 0,
    file: null,
    bytes: null,
    meta: null,
    outBlob: null,
    outMeta: null,
    outMethod: null,
    outName: "",
    thumbUrl: null,
  };

  function setChip(kind, text) {
    const chip = $("statusChip");
    chip.classList.remove("has-meta", "is-clean", "is-warn");
    if (kind) chip.classList.add(kind);
    $("statusChipText").textContent = text;
  }

  function rowHtml(f) {
    const long = f.value.length > 80 || f.value.includes("\n");
    const collapsed = long ? " meta-value--collapsed" : "";
    return (
      "<tr>" +
      "<th>" + escapeHtml(f.key) + "</th>" +
      "<td><div class=\"meta-value-wrap\">" +
      "<div class=\"meta-value" + collapsed + "\" id=\"val" + f.id + "\">" + escapeHtml(f.value) + "</div>" +
      "<div class=\"value-tools\">" +
      (long
        ? '<button class="icon-button" data-expand="' + f.id + '" aria-label="Toggle value" title="Expand">' +
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg></button>'
        : "") +
      '<button class="icon-button" data-copy="' + f.id + '" aria-label="Copy value" title="Copy">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5v-7a2 2 0 0 1 2-2h7"/></svg></button>' +
      "</div></div></td></tr>"
    );
  }

  function categoryTablesHtml(fields) {
    let html = "";
    const byCat = {};
    for (const c of CATEGORIES) byCat[c] = [];
    for (const f of fields) byCat[f.category].push(f);

    for (const c of CATEGORIES) {
      if (byCat[c].length === 0) continue;
      html +=
        '<div class="meta-cat">' +
        '<div class="meta-cat-head"><h3>' + CAT_LABELS[c] + "</h3>" +
        '<span class="cat-badge">' + byCat[c].length + " " +
        (byCat[c].length === 1 ? "field" : "fields") + "</span></div>" +
        '<table class="meta-table"><caption>' + CAT_LABELS[c] + " metadata</caption>" +
        "<tbody>" + byCat[c].map(rowHtml).join("") + "</tbody></table>" +
        "</div>";
    }
    return html;
  }

  function renderCategoryGrid(meta) {
    const grid = $("catGrid");
    let html = "";
    for (const c of CATEGORIES) {
      const count = meta.fields.filter((f) => f.category === c).length;
      html +=
        '<label class="cat-item' + (count === 0 ? " has-none" : "") + '" for="cat-' + c + '">' +
        '<input type="checkbox" id="cat-' + c + '" data-cat="' + c + '" checked' +
        (count === 0 ? " disabled" : "") + ' />' +
        "<span>" + CAT_LABELS[c] + "</span>" +
        '<span class="cat-count">' + count + "</span></label>";
    }
    grid.innerHTML = html;

    const boxes = grid.querySelectorAll("input[data-cat]");
    const all = $("catAll");

    const syncAll = () => {
      const on = Array.from(boxes).filter((b) => b.checked).length;
      all.checked = on === boxes.length;
      all.indeterminate = on > 0 && on < boxes.length;
    };

    all.addEventListener("change", () => {
      boxes.forEach((b) => (b.checked = all.checked));
    });
    boxes.forEach((b) => b.addEventListener("change", syncAll));
    syncAll();
  }

  function renderBefore(meta) {
    const removable = meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key));

    $("beforeCount").textContent =
      removable.length +
      " " +
      (removable.length === 1 ? "field" : "fields") +
      " found" +
      (meta.width ? " · " + meta.width + "×" + meta.height : "") +
      (meta.warnings.length
        ? " · " + meta.warnings.length + " note" + (meta.warnings.length === 1 ? "" : "s")
        : "");

    const tables = $("beforeTables");
    if (removable.length === 0) {
      tables.innerHTML =
        '<div class="no-meta">This image carries <strong>no readable metadata</strong> — ' +
        "it is already clean. There is nothing to remove; you can share it as is.</div>";
    } else {
      tables.innerHTML = categoryTablesHtml(meta.fields);
    }

    if (meta.warnings.length) {
      tables.innerHTML +=
        '<div style="margin-top:12px"><p class="no-meta" style="border-style:solid">' +
        meta.warnings.map((w) => escapeHtml(w)).join("<br>") +
        "</p></div>";
    }

    const any = meta.fields.some((f) => !DIMENSION_KEYS.has(f.key));
    $("removeButton").disabled = !any;
    $("removeNote").textContent = any
      ? "Byte-level strip — pixels are preserved exactly; the file only gets smaller."
      : "Nothing to remove.";
  }

  function renderAfter(outMeta, outMethod) {
    const before = state.meta.fields;
    const after = outMeta.fields;

    const afterKeys = new Set(
      after.filter((f) => !DIMENSION_KEYS.has(f.key)).map((f) => f.key + "\u0000" + f.value),
    );
    const removed = before.filter(
      (f) => !DIMENSION_KEYS.has(f.key) && !afterKeys.has(f.key + "\u0000" + f.value),
    );
    const remaining = after.filter((f) => !DIMENSION_KEYS.has(f.key));

    $("afterCount").textContent =
      remaining.length +
      " " +
      (remaining.length === 1 ? "field" : "fields") +
      " remain in the export";

    const ok = remaining.length === 0;

    $("afterSummary").innerHTML =
      '<span class="after-stat ' + (ok ? "ok" : "bad") + '"><span class="stat-dot"></span>' +
      (ok ? "Verified clean" : "Metadata still present") + "</span>" +
      '<span class="after-stat">Removed <strong>' + removed.length + "</strong></span>" +
      '<span class="after-stat">Remaining <strong>' + remaining.length + "</strong></span>" +
      (outMethod === "canvas"
        ? '<span class="after-stat bad"><span class="stat-dot"></span>Re-encoded via canvas — quality may differ slightly</span>'
        : '<span class="after-stat"><span class="stat-dot"></span>Original pixels preserved</span>');

    const tables = $("afterTables");
    if (remaining.length === 0) {
      tables.innerHTML =
        '<div class="no-meta">Re-reading the cleaned export found <strong>no remaining metadata</strong>. ' +
        "Dimensions are intrinsic to the image and always stay.</div>";
    } else {
      tables.innerHTML =
        '<p class="no-meta" style="margin-bottom:12px">These fields survived — the export is <strong>not</strong> clean:</p>' +
        categoryTablesHtml(remaining);
    }

    $("downloadButton").disabled = false;
    $("copySummaryButton").hidden = false;
  }

  async function loadFile(file) {
    if (!file) return;
    const sequence = ++state.sequence;

    if (state.thumbUrl) {
      URL.revokeObjectURL(state.thumbUrl);
      state.thumbUrl = null;
    }

    state.file = file;
    state.outBlob = null;
    state.outMeta = null;
    state.outMethod = null;

    $("fileName").textContent = file.name;
    $("fileSpecs").textContent = "Reading… " + formatBytes(file.size);
    $("fileStrip").classList.remove("hidden");
    $("formatNotice").classList.add("hidden");
    $("afterPanel").classList.add("hidden");
    setChip("", "Reading metadata…");

    state.thumbUrl = URL.createObjectURL(file);
    $("thumb").src = state.thumbUrl;

    try {
      const u8 = new Uint8Array(await file.arrayBuffer());
      if (sequence !== state.sequence) return;
      state.bytes = u8;

      const meta = readImageMetadata(u8);
      if (sequence !== state.sequence) return;
      state.meta = meta;

      const dims = meta.width ? meta.width + "×" + meta.height + " · " : "";
      $("fileSpecs").textContent = meta.label + " · " + dims + formatBytes(u8.length);

      if (!meta.supported) {
        setChip("is-warn", "Unsupported format");
        $("emptyState").classList.add("hidden");
        $("metaPanels").classList.add("hidden");
        $("formatNotice").classList.remove("hidden");
        $("formatNoticeText").textContent =
          meta.note ||
          "TrueMetadata can reliably read and remove metadata for JPEG, PNG and WebP only.";
        return;
      }

      $("metaPanels").classList.remove("hidden");
      $("emptyState").classList.add("hidden");

      renderCategoryGrid(meta);
      renderBefore(meta);

      const removable = meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key)).length;
      setChip(
        removable ? "has-meta" : "is-clean",
        removable ? removable + " metadata fields" : "No metadata found",
      );
    } catch (error) {
      if (sequence !== state.sequence) return;
      console.error(error);
      toast("Could not read this file's metadata.", { kind: "error" });
      setChip("is-warn", "Read error");
    }

    $("openAnotherButton").hidden = false;
  }

  async function removeMetadata() {
    if (!state.bytes || !state.meta) return;

    $("removeButton").disabled = true;
    setChip("", "Removing…");

    try {
      let out = stripMetadataBytes(state.bytes, state.meta.format);
      let method = "byte";

      if (!out) {
        method = "canvas";
        out = await stripViaCanvas(state.file, state.meta.format);
      }

      if (!out) {
        toast("Removal failed — the container is malformed. Try a different file.", {
          kind: "error",
        });
        setChip("is-warn", "Removal failed");
        $("removeButton").disabled = false;
        return;
      }

      // Verify by re-reading the cleaned bytes with the same parser a
      // viewer would use — never assume what removal achieved.
      state.outMeta = readImageMetadata(out);
      state.outMethod = method;
      state.outBlob = new Blob([out], {
        type: { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[state.meta.format],
      });

      const base = state.file.name.replace(/\.[^/.]+$/, "") || "image";
      const ext = { jpeg: "jpg", png: "png", webp: "webp" }[state.meta.format];
      state.outName = base + "-clean." + ext;

      const removed = state.meta.fields.filter(
        (f) => !DIMENSION_KEYS.has(f.key),
      ).length;

      renderAfter(state.outMeta, method);
      $("afterPanel").classList.remove("hidden");

      const remaining = state.outMeta.fields.filter(
        (f) => !DIMENSION_KEYS.has(f.key),
      ).length;

      setChip(
        remaining === 0 ? "is-clean" : "is-warn",
        remaining === 0 ? "Clean · verified" : remaining + " fields remain",
      );

      toast(
        removed > 0
          ? "Removed " + removed + " metadata fields — export verified."
          : "No removable metadata was present.",
        { kind: "success" },
      );

      $("afterPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      console.error(error);
      toast("Removal failed unexpectedly.", { kind: "error" });
      setChip("is-warn", "Removal failed");
    } finally {
      $("removeButton").disabled = !state.meta.fields.some(
        (f) => !DIMENSION_KEYS.has(f.key),
      );
    }
  }

  function downloadOutput() {
    if (!state.outBlob) return;
    const url = URL.createObjectURL(state.outBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.outName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("Clean copy downloaded — the original is untouched.", { kind: "success" });
  }

  function copySummary() {
    if (!state.outMeta || !state.meta) return;
    const lines = [];
    lines.push("TrueMetadata summary — " + state.file.name);
    lines.push(
      "Removed " +
        state.meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key)).length +
        " fields:",
    );
    for (const f of state.meta.fields) {
      if (DIMENSION_KEYS.has(f.key)) continue;
      lines.push("  - " + f.key + ": " + f.value);
    }
    lines.push(
      "Remaining after strip: " +
        state.outMeta.fields.filter((f) => !DIMENSION_KEYS.has(f.key)).length,
    );
    lines.push(
      "Method: " +
        (state.outMethod === "canvas" ? "canvas re-encode" : "byte-level strip"),
    );

    const text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("Summary copied to clipboard.", { kind: "success" }),
        () => toast("Could not copy the summary.", { kind: "error" }),
      );
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Summary copied to clipboard.", { kind: "success" });
    }
  }

  function resetAll() {
    state.sequence++;
    state.file = null;
    state.bytes = null;
    state.meta = null;
    state.outBlob = null;
    state.outMeta = null;
    state.outMethod = null;
    state.outName = "";
    if (state.thumbUrl) {
      URL.revokeObjectURL(state.thumbUrl);
      state.thumbUrl = null;
    }

    $("fileStrip").classList.add("hidden");
    $("metaPanels").classList.add("hidden");
    $("formatNotice").classList.add("hidden");
    $("afterPanel").classList.add("hidden");
    $("emptyState").classList.remove("hidden");
    $("openAnotherButton").hidden = true;
    $("downloadButton").disabled = true;
    $("copySummaryButton").hidden = true;
    $("removeButton").disabled = true;
    $("beforeTables").innerHTML = "";
    $("afterTables").innerHTML = "";
    $("catGrid").innerHTML = "";
    setChip("", "");

    if ($("fileInput").files && $("fileInput").files.length) {
      $("fileInput").value = "";
    }
  }

  /* ---------- wiring ---------- */

  $("fileInput").addEventListener("change", () => {
    const f = $("fileInput").files[0];
    loadFile(f);
    $("fileInput").value = "";
  });

  $("removeButton").addEventListener("click", removeMetadata);
  $("downloadButton").addEventListener("click", downloadOutput);
  $("copySummaryButton").addEventListener("click", copySummary);
  $("openAnotherButton").addEventListener("click", resetAll);

  // Expand / copy, delegated over both tables.
  document.addEventListener("click", (event) => {
    const expand = event.target.closest("[data-expand]");
    if (expand) {
      const el = document.getElementById("val" + expand.dataset.expand);
      if (el) {
        const collapsed = el.classList.toggle("meta-value--collapsed");
        expand.setAttribute("aria-label", collapsed ? "Expand value" : "Collapse value");
      }
      return;
    }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const el = document.getElementById("val" + copy.dataset.copy);
      const text = el ? el.textContent : "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast("Copied to clipboard.", { kind: "success" }),
          () => toast("Could not copy.", { kind: "error" }),
        );
      }
    }
  });

  window.TrueHide.attachFileDrop({
    accept: (file) =>
      file.type.startsWith("image/") ||
      /\.(jpe?g|png|webp|gif|tiff?|heic|heif|avif|pdf)$/i.test(file.name || ""),
    onFile: (file) => loadFile(file),
    rejectMessage: "TrueMetadata reads images. For PDFs, open TrueFlatten instead.",
  });

  if (window.TrueHide.registerShortcut) {
    window.TrueHide.registerShortcut({
      keys: ["o", "modCmdOrCtrl"],
      description: "Open image",
      handler: () => $("fileInput").click(),
    });
  }
})();
