// TrueMetadata — view and remove image metadata, entirely in the browser.
// EXIF/TIFF, XMP, PNG and WebP parsing.
// Metadata removal uses byte-level container surgery wherever possible.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const toast = (message, options) => window.TrueHide.toast(message, options);

  const TEXT = new TextDecoder("utf-8");

  /* =============================================================
     HELPERS
     ============================================================= */

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  let fieldSeq = 0;

  function addField(fields, key, value, category) {
    const str =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);

    if (!str || str === "null") return;

    fields.push({
      id: ++fieldSeq,
      key,
      value: str,
      category,
    });
  }

  /* =============================================================
     TIFF / EXIF READER
     ============================================================= */

  function makeTiffReader(view, endianness) {
    const le = endianness === 1;

    return {
      u16(off) {
        return view.getUint16(off, le);
      },
      u32(off) {
        return view.getUint32(off, le);
      },
      i32(off) {
        return view.getInt32(off, le);
      },
      f32(off) {
        return view.getFloat32(off, le);
      },
      f64(off) {
        return view.getFloat64(off, le);
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
    if (offset < 0 || offset + 8 > u8.length) return null;

    const little = u8[offset] === 0x49 && u8[offset + 1] === 0x49;

    const big = u8[offset] === 0x4d && u8[offset + 1] === 0x4d;

    if (!little && !big) return null;

    const endianness = little ? 1 : -1;

    const view = new DataView(
      u8.buffer,
      u8.byteOffset + offset,
      u8.length - offset,
    );

    if (view.getUint16(2, little) !== 42) return null;

    return { view, endianness };
  }

  function readIfd(view, endianness, ifdOffset) {
    const r = makeTiffReader(view, endianness);
    const entries = new Map();

    if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) {
      return { entries, next: 0 };
    }

    const count = r.u16(ifdOffset);

    if (count > 200 || ifdOffset + 2 + count * 12 + 4 > view.byteLength) {
      return { entries, next: 0 };
    }

    const sizes = {
      1: 1,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      6: 1,
      7: 1,
      8: 2,
      9: 4,
      10: 8,
      11: 4,
      12: 8,
    };

    for (let i = 0; i < count; i++) {
      const p = ifdOffset + 2 + i * 12;

      const tag = r.u16(p);
      const type = r.u16(p + 2);
      const countV = r.u32(p + 4);
      const size = sizes[type];

      if (!size || countV > 4096) continue;

      const total = size * countV;

      const off = total <= 4 ? p + 8 : r.u32(p + 8);

      if (off < 0 || off + total > view.byteLength) {
        continue;
      }

      let value;

      if (type === 2) {
        value = r.ascii(off, total);
      } else if (type === 5 || type === 10) {
        const vals = [];

        for (let k = 0; k < countV; k++) {
          const n = type === 10 ? r.i32(off + k * 8) : r.u32(off + k * 8);

          const d =
            type === 10 ? r.i32(off + k * 8 + 4) : r.u32(off + k * 8 + 4);

          vals.push(d === 0 ? null : { n, d });
        }

        value = countV === 1 ? vals[0] : vals;
      } else if (type === 11) {
        const vals = [];

        for (let k = 0; k < countV; k++) {
          vals.push(r.f32(off + k * 4));
        }

        value = countV === 1 ? vals[0] : vals;
      } else if (type === 12) {
        const vals = [];

        for (let k = 0; k < countV; k++) {
          vals.push(r.f64(off + k * 8));
        }

        value = countV === 1 ? vals[0] : vals;
      } else if (type === 3 || type === 8) {
        const vals = [];

        for (let k = 0; k < countV; k++) {
          let v = r.u16(off + k * 2);

          if (type === 8 && v > 32767) {
            v -= 65536;
          }

          vals.push(v);
        }

        value = countV === 1 ? vals[0] : vals;
      } else if (type === 4 || type === 9) {
        const vals = [];

        for (let k = 0; k < countV; k++) {
          vals.push(type === 9 ? r.i32(off + k * 4) : r.u32(off + k * 4));
        }

        value = countV === 1 ? vals[0] : vals;
      } else if (type === 1 || type === 6) {
        const vals = [];

        for (let k = 0; k < countV; k++) {
          vals.push(r.bytes(off + k, 1)[0]);
        }

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

  /* =============================================================
     EXIF FIELD FORMATTING
     ============================================================= */

  const CATEGORIES = [
    "general",
    "camera",
    "location",
    "dates",
    "software",
    "other",
  ];

  const CAT_LABELS = {
    general: "General",
    camera: "Camera",
    location: "Location",
    dates: "Dates",
    software: "Software",
    other: "Other",
  };

  const ORIENTATIONS = {
    1: "Normal",
    2: "Mirrored horizontally",
    3: "Rotated 180°",
    4: "Mirrored vertically",
    5: "Transposed",
    6: "Rotated 90° CW",
    7: "Transposed",
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
    3: "Tungsten",
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

  function rationalText(v) {
    if (v === null || v === undefined) return "—";

    if (typeof v === "object") {
      if (Array.isArray(v)) {
        return v.map(rationalText).join(", ");
      }

      if (!v.d) return "—";

      if (v.d === 1) return String(v.n);

      const num = v.n / v.d;

      if (Number.isInteger(num)) return String(num);

      return num.toFixed(3).replace(/\.?0+$/, "");
    }

    return String(v);
  }

  function flashText(v) {
    if (typeof v !== "number") return String(v);
    if (v === 0) return "Flash did not fire";
    if (v & 1) return "Fired";
    return "No flash function";
  }

  function exposureValueText(v) {
    if (v === null || v === undefined) return null;

    if (typeof v === "object") {
      if (!v.d) return null;
      return v.n / v.d;
    }

    return typeof v === "number" ? v : null;
  }

  function shutterFromEv(ev) {
    const s = Math.pow(2, -ev);

    if (s >= 1) {
      return s.toFixed(1) + " s";
    }

    return "1/" + Math.round(1 / s) + " s";
  }

  function apertureFromEv(ev) {
    return "f/" + (Math.pow(2, ev / 2) * 10).toFixed(1);
  }

  function coordsFromRationals(vals, ref) {
    if (!Array.isArray(vals) || vals.length < 3) return null;

    const [d, m, s] = vals;

    if (!d || !m || !s || !d.d || !m.d || !s.d) {
      return null;
    }

    let deg = d.n / d.d + m.n / m.d / 60 + s.n / s.d / 3600;

    if (ref === "S" || ref === "W") deg = -deg;

    return deg;
  }

  function dmsText(vals, ref) {
    if (!Array.isArray(vals) || vals.length < 3) return "";

    const [d, m, s] = vals;

    if (!d || !m || !d.d || !m.d) return "";

    const sec = s && s.d ? (s.n / s.d).toFixed(2) : "0";

    return (
      Math.trunc(d.n / d.d) +
      "° " +
      Math.trunc(m.n / m.d) +
      "' " +
      sec +
      '" ' +
      ref
    );
  }

  function exifEntriesToFields(entries, ifdName, fields) {
    const t = (tag) => entries.get(tag);

    function put(tag, label, category, formatter) {
      const e = entries.get(tag);
      if (!e) return;

      let v = e.value;

      if (formatter) {
        v = formatter(v, e);
      }

      addField(fields, label, v, category);
    }

    if (ifdName === "ifd0") {
      put(0x0103, "Compression", "general");
      put(0x010e, "Image description", "general");
      put(0x010f, "Camera make", "camera");
      put(0x0110, "Camera model", "camera");

      put(
        0x0112,
        "Orientation",
        "general",
        (v) => ORIENTATIONS[v] || String(v),
      );

      put(0x0131, "Software", "software");
      put(0x0132, "Date & time", "dates");
      put(0x013b, "Artist", "other");
      put(0x8298, "Copyright", "other");
    }

    if (ifdName === "exif") {
      put(
        0x0003,
        "Exposure program",
        "camera",
        (v) => PROGRAMS[v] || String(v),
      );

      put(0x0004, "F-number", "camera", (v) => "f/" + rationalText(v));

      put(0x0005, "ISO", "camera");
      put(0x0082, "Sensitivity type", "camera");
      put(0x0083, "ISO", "camera");
      put(0x8827, "ISO", "camera");

      put(0x9003, "Date & time original", "dates");
      put(0x9004, "Date & time digitized", "dates");

      put(0x9201, "Shutter speed", "camera", (v) => {
        const ev = exposureValueText(v);
        return ev === null ? "—" : shutterFromEv(ev);
      });

      put(0x9202, "Aperture value", "camera", (v) => {
        const ev = exposureValueText(v);
        return ev === null ? "—" : apertureFromEv(ev);
      });

      put(0x9204, "Exposure bias", "camera", (v) => {
        const ev = exposureValueText(v);
        return ev === null ? "—" : ev + " EV";
      });

      put(0x9205, "Subject distance", "camera", (v) => rationalText(v) + " m");

      put(0x9207, "Metering mode", "camera", (v) => METERING[v] || String(v));

      put(
        0x9208,
        "Light source",
        "camera",
        (v) => LIGHT_SOURCES[v] || String(v),
      );

      put(0x9209, "Flash", "camera", flashText);

      put(0x920a, "Focal length", "camera", (v) => rationalText(v) + " mm");

      put(0x9286, "User comment", "other");

      put(0xa001, "Color space", "general", (v) =>
        v === 1 ? "sRGB" : "Uncalibrated",
      );

      put(0xa002, "Pixel width", "general", (v) => v + " px");
      put(0xa003, "Pixel height", "general", (v) => v + " px");
      put(0xa20e, "Focal plane X resolution", "camera");
      put(0xa20f, "Focal plane Y resolution", "camera");
    }

    if (ifdName === "gps") {
      const lat = t(0x0002);
      const lon = t(0x0004);

      const latRef = t(0x0001);
      const lonRef = t(0x0003);

      if (lat && lat.value) {
        const ref = latRef ? String(latRef.value).trim() : "N";

        const deg = coordsFromRationals(lat.value, ref);

        if (deg !== null) {
          addField(
            fields,
            "GPS latitude",
            Math.abs(deg).toFixed(5) + "° (" + dmsText(lat.value, ref) + ")",
            "location",
          );
        }
      }

      if (lon && lon.value) {
        const ref = lonRef ? String(lonRef.value).trim() : "E";

        const deg = coordsFromRationals(lon.value, ref);

        if (deg !== null) {
          addField(
            fields,
            "GPS longitude",
            Math.abs(deg).toFixed(5) + "° (" + dmsText(lon.value, ref) + ")",
            "location",
          );
        }
      }

      put(0x0006, "GPS altitude", "location", (v) => {
        const altitude = rationalText(v);
        const ref = t(0x0005);

        return (
          altitude +
          (ref && String(ref.value) === "1" ? " m (below sea level)" : " m")
        );
      });

      put(0x000a, "GPS date stamp", "dates");

      put(0x0007, "GPS time stamp", "dates", (v) => {
        if (!Array.isArray(v) || v.length < 3) return null;

        if (!v[0] || !v[1] || !v[2]) return null;

        const h = v[0].n / v[0].d;
        const m = v[1].n / v[1].d;
        const s = v[2].n / v[2].d;

        return (
          h + ":" + String(Math.trunc(m)).padStart(2, "0") + ":" + s.toFixed(1)
        );
      });

      put(0x000c, "GPS satellites", "location");
      put(0x000d, "GPS measurement", "location");
    }

    if (ifdName === "interoperability") {
      put(0x0001, "Interoperability index", "other");
    }
  }

  function parseExifBlock(u8, offset) {
    const fields = [];

    if (offset < 0 || offset + 8 > u8.length) {
      return fields;
    }

    const hasPrefix =
      u8[offset] === 0x45 &&
      u8[offset + 1] === 0x78 &&
      u8[offset + 2] === 0x69 &&
      u8[offset + 3] === 0x66;

    const start = tiffStart(u8, offset + (hasPrefix ? 6 : 0));

    if (!start) return fields;

    const { view, endianness } = start;

    try {
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
        const gps = readIfd(view, endianness, gpsPtr.value);
        exifEntriesToFields(gps.entries, "gps", fields);
      }

      const ioPtr = ifd0.entries.get(0xa005);

      if (ioPtr && typeof ioPtr.value === "number") {
        const io = readIfd(view, endianness, ioPtr.value);
        exifEntriesToFields(io.entries, "interoperability", fields);
      }
    } catch (error) {
      console.warn("Malformed EXIF block:", error);
    }

    return fields;
  }

  /* =============================================================
     XMP
     ============================================================= */

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
      [
        /<xmp:CreatorTool[^>]*>([^<]*)<\/xmp:CreatorTool>/i,
        "Creator tool",
        "software",
      ],
      [
        /<pdf:Producer[^>]*>([^<]*)<\/pdf:Producer>/i,
        "PDF producer",
        "software",
      ],
      [/<xmp:CreateDate[^>]*>([^<]*)<\/xmp:CreateDate>/i, "Created", "dates"],
      [/<xmp:ModifyDate[^>]*>([^<]*)<\/xmp:ModifyDate>/i, "Modified", "dates"],
      [/<dc:title[\s\S]*?<rdf:li[^>]*>([^<]*)/i, "Title", "general"],
      [/<dc:creator[\s\S]*?<rdf:li[^>]*>([^<]*)/i, "Author", "other"],
      [/<exif:Make[^>]*>([^<]*)<\/exif:Make>/i, "Camera make", "camera"],
      [/<exif:Model[^>]*>([^<]*)<\/exif:Model>/i, "Camera model", "camera"],
      [
        /<exif:PixelXDimension[^>]*>([^<]*)<\/exif:PixelXDimension>/i,
        "Pixel width",
        "general",
      ],
      [
        /<exif:PixelYDimension[^>]*>([^<]*)<\/exif:PixelYDimension>/i,
        "Pixel height",
        "general",
      ],
      [
        /<xmpGP:GPSAltitude[^>]*>([^<]*)<\/xmpGP:GPSAltitude>/i,
        "GPS altitude",
        "location",
      ],
    ];

    let found = 0;

    for (const [pattern, label, category] of rules) {
      const match = xml.match(pattern);

      if (match && match[1]) {
        addField(fields, label, xmpEntity(match[1]), category);
        found++;
      }
    }

    for (const axis of ["Latitude", "Longitude"]) {
      const pattern = new RegExp(
        "<xmpGP:GPS" + axis + ">([\\s\\S]*?)</xmpGP:GPS" + axis + ">",
        "i",
      );

      const match = xml.match(pattern);

      if (!match) continue;

      const nums = match[1].match(/-?\d+(\.\d+)?/g);

      if (!nums || !nums.length) continue;

      let deg = 0;

      nums.slice(0, 3).forEach((v, i) => {
        deg += parseFloat(v) / Math.pow(60, i);
      });

      addField(fields, "XMP " + axis.toLowerCase(), deg.toFixed(5), "location");

      found++;
    }

    if (!found) {
      addField(fields, "XMP block", "(present, no recognized fields)", "other");
    }
  }

  /* =============================================================
     FORMAT DETECTION
     ============================================================= */

  function detectFormat(u8) {
    if (u8.length < 12) {
      return {
        format: "unknown",
        supported: false,
        label: "Unknown",
      };
    }

    if (u8[0] === 0xff && u8[1] === 0xd8) {
      return {
        format: "jpeg",
        supported: true,
        label: "JPEG",
      };
    }

    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
      return {
        format: "png",
        supported: true,
        label: "PNG",
      };
    }

    if (
      u8[0] === 0x52 &&
      u8[1] === 0x49 &&
      u8[2] === 0x46 &&
      u8[3] === 0x46 &&
      u8[8] === 0x57 &&
      u8[9] === 0x45 &&
      u8[10] === 0x42 &&
      u8[11] === 0x50
    ) {
      return {
        format: "webp",
        supported: true,
        label: "WebP",
      };
    }

    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
      return {
        format: "gif",
        supported: false,
        label: "GIF",
        note: "GIF metadata removal is not supported. Convert the image to JPEG, PNG or WebP first.",
      };
    }

    if (
      (u8[0] === 0x49 && u8[1] === 0x49) ||
      (u8[0] === 0x4d && u8[1] === 0x4d)
    ) {
      return {
        format: "tiff",
        supported: false,
        label: "TIFF",
        note: "TIFF metadata reading and removal are not implemented.",
      };
    }

    if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
      return {
        format: "ftyp",
        supported: false,
        label: "HEIC / AVIF",
        note: "HEIC and AVIF metadata removal is not supported.",
      };
    }

    if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) {
      return {
        format: "pdf",
        supported: false,
        label: "PDF",
        note: "Use TrueFlatten for PDF documents.",
      };
    }

    return {
      format: "unknown",
      supported: false,
      label: "Unrecognized format",
      note: "This file is not a supported JPEG, PNG or WebP image.",
    };
  }

  /* =============================================================
     JPEG READER
     ============================================================= */

  function jpegDimensions(u8) {
    let i = 2;

    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) {
        i++;
        continue;
      }

      while (i + 1 < u8.length && u8[i + 1] === 0xff) {
        i++;
      }

      const marker = u8[i + 1];

      if (
        marker === 0xd8 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        i += 2;
        continue;
      }

      if (i + 3 >= u8.length) break;

      const len = (u8[i + 2] << 8) | u8[i + 3];

      if (len < 2 || i + 2 + len > u8.length) break;

      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          width: (u8[i + 7] << 8) | u8[i + 8],
          height: (u8[i + 5] << 8) | u8[i + 6],
        };
      }

      if (marker === 0xda || marker === 0xd9) break;

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
      if (u8[i] !== 0xff) {
        i++;
        continue;
      }

      while (i + 1 < n && u8[i + 1] === 0xff) {
        i++;
      }

      const marker = u8[i + 1];

      if (i + 3 >= n) break;

      const len = (u8[i + 2] << 8) | u8[i + 3];

      if (len < 2) break;

      const body = i + 4;
      const end = i + 2 + len;

      if (end > n) break;

      if (marker === 0xe1) {
        if (
          u8[body] === 0x45 &&
          u8[body + 1] === 0x78 &&
          u8[body + 2] === 0x69 &&
          u8[body + 3] === 0x66
        ) {
          fields.push(...parseExifBlock(u8, body));
        } else {
          const header = TEXT.decode(
            u8.subarray(body, Math.min(body + 35, end)),
          );

          if (header.startsWith("http://ns.adobe.com/xap/1.0/")) {
            const xmlStart = body + 29;
            const xml = TEXT.decode(u8.subarray(xmlStart, end));
            parseXmp(xml, fields);
          } else {
            warnings.push("Unrecognized JPEG APP1 metadata block.");
            addField(fields, "JPEG APP1 metadata", "(present)", "other");
          }
        }
      } else if (marker === 0xed) {
        addField(
          fields,
          "IPTC / Photoshop metadata",
          "(present, " + len + " bytes)",
          "other",
        );
        warnings.push("IPTC / Photoshop metadata present.");
      } else if (marker === 0xfe) {
        const comment = TEXT.decode(u8.subarray(body, end))
          .replace(/\0/g, "")
          .trim();

        if (comment) {
          addField(fields, "Comment", comment, "other");
        }
      } else if (marker === 0xe2) {
        const header = TEXT.decode(u8.subarray(body, Math.min(body + 12, end)));

        if (header.startsWith("ICC_PROFILE")) {
          warnings.push(
            "ICC color profile present (preserved for color accuracy).",
          );
        }
      } else if (marker >= 0xe3 && marker <= 0xec) {
        warnings.push("Private JPEG APP" + (marker - 0xe0) + " block present.");

        addField(
          fields,
          "Private JPEG APP block",
          "APP" + (marker - 0xe0) + " (" + len + " bytes)",
          "other",
        );
      } else if (marker >= 0xef && marker <= 0xf5) {
        warnings.push("Private JPEG metadata block present.");

        addField(fields, "Private JPEG metadata", "(present)", "other");
      }

      if (marker === 0xda) break;

      i = end;
    }

    return { fields, warnings };
  }

  /* =============================================================
     PNG READER
     ============================================================= */

  const PNG_KEEP_TYPES = [
    "IHDR",
    "PLTE",
    "bKGD",
    "tRNS",
    "gAMA",
    "cHRM",
    "sRGB",
    "iCCP",
    "IDAT",
    "IEND",
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

    let width = 0;
    let height = 0;

    let i = 8;
    let foundEnd = false;

    const n = u8.length;

    const keywordInfo = (kw) => PNG_KEYWORDS[kw.toLowerCase()] || [kw, "other"];

    while (i + 12 <= n) {
      const len =
        ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>>
        0;

      const type = String.fromCharCode(
        u8[i + 4],
        u8[i + 5],
        u8[i + 6],
        u8[i + 7],
      );

      const body = i + 8;
      const end = body + len;

      if (end + 4 > n) {
        warnings.push("Truncated PNG chunk.");
        break;
      }

      if (type === "IHDR") {
        if (len !== 13) {
          warnings.push("Invalid PNG header.");
          break;
        }

        const dv = new DataView(u8.buffer, u8.byteOffset + body, 13);

        width = dv.getUint32(0);
        height = dv.getUint32(4);
      } else if (type === "eXIf") {
        fields.push(...parseExifBlock(u8, body));

        if (!fields.length) {
          addField(fields, "PNG EXIF block", "(present)", "other");
        }
      } else if (type === "tEXt") {
        const data = u8.subarray(body, end);

        let nul = 0;

        while (nul < data.length && data[nul] !== 0) {
          nul++;
        }

        const keyword = TEXT.decode(data.subarray(0, nul));
        const value = TEXT.decode(
          data.subarray(Math.min(nul + 1, data.length)),
        ).replace(/\0/g, "");

        const [label, category] = keywordInfo(keyword);

        if (value) {
          addField(fields, "PNG " + label, value, category);
        }
      } else if (type === "iTXt") {
        const data = u8.subarray(body, end);

        let p = 0;

        while (p < data.length && data[p] !== 0) {
          p++;
        }

        if (p >= data.length) {
          warnings.push("Malformed PNG iTXt chunk.");
        } else {
          const keyword = TEXT.decode(data.subarray(0, p));

          p++;

          if (p + 2 > data.length) {
            warnings.push("Malformed PNG iTXt chunk.");
          } else {
            const compressionFlag = data[p++];
            p++; // Compression method

            let langEnd = p;

            while (langEnd < data.length && data[langEnd] !== 0) {
              langEnd++;
            }

            p = langEnd + 1;

            let translatedEnd = p;

            while (translatedEnd < data.length && data[translatedEnd] !== 0) {
              translatedEnd++;
            }

            p = translatedEnd + 1;

            if (p > data.length) {
              warnings.push("Malformed PNG iTXt chunk.");
            } else if (compressionFlag === 1) {
              warnings.push(
                "Compressed PNG iTXt metadata present (" + keyword + ").",
              );

              addField(
                fields,
                "PNG compressed text",
                keyword + " (compressed)",
                "other",
              );
            } else if (compressionFlag === 0) {
              const value = TEXT.decode(data.subarray(p));

              const [label, category] = keywordInfo(keyword);

              if (value) {
                addField(fields, "PNG " + label, value, category);
              }
            } else {
              warnings.push("Unknown PNG iTXt compression flag.");
            }
          }
        }
      } else if (type === "zTXt") {
        const data = u8.subarray(body, end);

        let nul = 0;

        while (nul < data.length && data[nul] !== 0) {
          nul++;
        }

        const keyword = TEXT.decode(data.subarray(0, nul));

        warnings.push(
          "Compressed PNG text metadata present (" + keyword + ").",
        );

        addField(
          fields,
          "PNG compressed text",
          keyword + " (compressed)",
          "other",
        );
      } else if (type === "tIME") {
        addField(fields, "PNG modification time", "(present)", "dates");
      } else if (type === "IEND") {
        foundEnd = true;
        break;
      } else if (!PNG_KEEP_TYPES.includes(type)) {
        warnings.push("PNG chunk '" + type + "' present.");
      }

      i = end + 4;
    }

    if (!foundEnd) {
      warnings.push("PNG end marker missing or invalid.");
    }

    return {
      fields,
      warnings,
      width,
      height,
    };
  }

  /* =============================================================
     WEBP READER
     ============================================================= */

  function readU32LE(u8, i) {
    return (
      (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0
    );
  }

  function parseWebP(u8) {
    const fields = [];
    const warnings = [];

    let width = 0;
    let height = 0;

    const riffSize = readU32LE(u8, 4);
    const limit = Math.min(u8.length, riffSize + 8);

    let i = 12;

    while (i + 8 <= limit) {
      const id = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);

      const len = readU32LE(u8, i + 4);
      const body = i + 8;
      const end = body + len;

      if (end > limit) {
        warnings.push("Truncated WebP chunk.");
        break;
      }

      if (id === "VP8X" && len >= 10) {
        width = (u8[body + 4] | (u8[body + 5] << 8) | (u8[body + 6] << 16)) + 1;

        height =
          (u8[body + 7] | (u8[body + 8] << 8) | (u8[body + 9] << 16)) + 1;
      } else if (id === "VP8L" && len >= 5) {
        if (u8[body] === 0x2f) {
          const bits =
            (u8[body + 1] |
              (u8[body + 2] << 8) |
              (u8[body + 3] << 16) |
              (u8[body + 4] << 24)) >>>
            0;

          width = (bits & 0x3fff) + 1;
          height = ((bits >>> 14) & 0x3fff) + 1;
        }
      } else if (id === "VP8 " && len >= 10) {
        const keyFrame = (u8[body] & 1) === 0;

        if (
          keyFrame &&
          u8[body + 3] === 0x9d &&
          u8[body + 4] === 0x01 &&
          u8[body + 5] === 0x2a
        ) {
          width = (u8[body + 6] | (u8[body + 7] << 8)) & 0x3fff;

          height = (u8[body + 8] | (u8[body + 9] << 8)) & 0x3fff;
        }
      } else if (id === "EXIF") {
        const exif = parseExifBlock(u8, body);

        if (exif.length) {
          fields.push(...exif);
        } else {
          addField(fields, "WebP EXIF block", "(present)", "other");
        }
      } else if (id === "XMP " || id === "XXMP") {
        parseXmp(TEXT.decode(u8.subarray(body, end)), fields);
      } else if (id === "ICCP") {
        warnings.push(
          "ICC color profile present (preserved for color accuracy).",
        );
      } else if (
        !["VP8X", "VP8L", "VP8 ", "ALPH", "ANIM", "ANMF"].includes(id)
      ) {
        warnings.push("Unknown WebP chunk '" + id + "' present.");
      }

      i = end + (len & 1);
    }

    return {
      fields,
      warnings,
      width,
      height,
    };
  }

  /* =============================================================
     TOP-LEVEL METADATA READER
     ============================================================= */

  const DIMENSION_KEYS = new Set([
    "Width",
    "Height",
    "Pixel width",
    "Pixel height",
  ]);

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

    let parsed;

    if (fmt.format === "jpeg") {
      parsed = parseJpeg(u8);

      const dims = jpegDimensions(u8);

      if (dims) {
        result.width = dims.width;
        result.height = dims.height;
      }
    } else if (fmt.format === "png") {
      parsed = parsePng(u8);
    } else if (fmt.format === "webp") {
      parsed = parseWebP(u8);
    }

    if (parsed) {
      result.fields = parsed.fields;
      result.warnings = parsed.warnings;

      result.width ||= parsed.width;
      result.height ||= parsed.height;
    }

    if (result.width) {
      result.fields.unshift(
        {
          id: ++fieldSeq,
          key: "Width",
          value: result.width + " px",
          category: "general",
        },
        {
          id: ++fieldSeq,
          key: "Height",
          value: result.height + " px",
          category: "general",
        },
      );
    }

    return result;
  }

  /* =============================================================
     METADATA REMOVAL
     ============================================================= */

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);

    const out = new Uint8Array(length);

    let offset = 0;

    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }

    return out;
  }

  /* ---------- JPEG ---------- */

  function stripJpeg(u8) {
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) {
      return null;
    }

    const parts = [u8.subarray(0, 2)];

    // Keep JFIF, ICC and Adobe color information.
    // Remove EXIF, XMP, IPTC, private APP blocks and comments.
    const shouldDrop = (marker) =>
      marker === 0xe1 ||
      marker === 0xfe ||
      (marker >= 0xe3 && marker <= 0xed) ||
      (marker >= 0xef && marker <= 0xf5);

    let i = 2;
    let foundEnd = false;

    while (i < u8.length) {
      if (u8[i] !== 0xff) return null;

      const markerStart = i;

      while (i < u8.length && u8[i] === 0xff) {
        i++;
      }

      if (i >= u8.length) return null;

      const marker = u8[i];

      if (marker === 0xd9) {
        parts.push(u8.subarray(markerStart, i + 1));
        foundEnd = true;
        break;
      }

      if (
        marker === 0xd8 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        parts.push(u8.subarray(markerStart, i + 1));
        i++;
        continue;
      }

      if (i + 2 >= u8.length) return null;

      const len = (u8[i + 1] << 8) | u8[i + 2];

      if (len < 2) return null;

      const end = i + 1 + len;

      if (end > u8.length) return null;

      if (!shouldDrop(marker)) {
        parts.push(u8.subarray(markerStart, end));
      }

      i = end;

      if (marker === 0xda) {
        // Scan data can contain multiple scans and markers.
        // Preserve entropy data while continuing to inspect
        // markers between scans.

        while (i < u8.length) {
          if (u8[i] !== 0xff) {
            i++;
            continue;
          }

          const scanMarkerStart = i;

          let j = i + 1;

          while (j < u8.length && u8[j] === 0xff) {
            j++;
          }

          if (j >= u8.length) return null;

          const code = u8[j];

          // Stuffed bytes and restart markers belong to scan data.
          if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
            i = j + 1;
            continue;
          }

          parts.push(
            u8.subarray(
              scanMarkerStart === i ? i : scanMarkerStart,
              scanMarkerStart,
            ),
          );

          // The marker is handled by the outer loop.
          break;
        }

        if (i >= u8.length) return null;

        // The scan data begins where the previous SOS ended.
        // Find the marker that terminated this scan.
        const scanStart = end;
        const markerPosition = i;

        if (markerPosition < scanStart) return null;

        // The bytes between the SOS header and terminating
        // marker have not yet been added.
        // Reconstructing them is handled by the scan helper below.
      }
    }

    if (!foundEnd) return null;

    const output = concatBytes(parts);

    if (
      output.length < 4 ||
      output[0] !== 0xff ||
      output[1] !== 0xd8 ||
      output[output.length - 2] !== 0xff ||
      output[output.length - 1] !== 0xd9
    ) {
      return null;
    }

    return output;
  }

  /* ---------- PNG ---------- */

  function stripPng(u8) {
    if (
      u8.length < 33 ||
      u8[0] !== 0x89 ||
      u8[1] !== 0x50 ||
      u8[2] !== 0x4e ||
      u8[3] !== 0x47
    ) {
      return null;
    }

    const parts = [u8.subarray(0, 8)];

    let i = 8;
    let foundHeader = false;
    let foundEnd = false;

    while (i + 12 <= u8.length) {
      const len =
        ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>>
        0;

      const type = String.fromCharCode(
        u8[i + 4],
        u8[i + 5],
        u8[i + 6],
        u8[i + 7],
      );

      const end = i + 8 + len + 4;

      if (end > u8.length) return null;

      if (type === "IHDR") {
        if (len !== 13 || foundHeader) return null;
        foundHeader = true;
      }

      // Unknown critical chunks may be necessary for decoding.
      // Use canvas fallback instead of silently corrupting them.
      const isCritical = type[0] >= "A" && type[0] <= "Z";

      if (isCritical && !PNG_KEEP_TYPES.includes(type)) {
        return null;
      }

      if (PNG_KEEP_TYPES.includes(type)) {
        parts.push(u8.subarray(i, end));
      }

      i = end;

      if (type === "IEND") {
        foundEnd = true;
        break;
      }
    }

    if (!foundHeader || !foundEnd) return null;

    return concatBytes(parts);
  }

  /* ---------- WebP ---------- */

  function stripWebP(u8) {
    if (
      u8.length < 20 ||
      u8[0] !== 0x52 ||
      u8[1] !== 0x49 ||
      u8[2] !== 0x46 ||
      u8[3] !== 0x46 ||
      u8[8] !== 0x57 ||
      u8[9] !== 0x45 ||
      u8[10] !== 0x42 ||
      u8[11] !== 0x50
    ) {
      return null;
    }

    const parts = [u8.subarray(0, 12)];

    const riffSize = readU32LE(u8, 4);
    const limit = Math.min(u8.length, riffSize + 8);

    let i = 12;
    let hasImage = false;

    while (i + 8 <= limit) {
      const id = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);

      const len = readU32LE(u8, i + 4);

      const body = i + 8;
      const end = body + len;
      const paddedEnd = end + (len & 1);

      if (paddedEnd > limit) return null;

      const keep = [
        "VP8X",
        "VP8 ",
        "VP8L",
        "ALPH",
        "ANIM",
        "ANMF",
        "ICCP",
      ].includes(id);

      if (id === "VP8 " || id === "VP8L") {
        hasImage = true;
      }

      if (keep) {
        const chunk = u8.slice(i, paddedEnd);

        // Clear the EXIF and XMP feature flags in VP8X.
        if (id === "VP8X" && len >= 10) {
          chunk[8] &= ~0x0c;
        }

        parts.push(chunk);
      }

      i = paddedEnd;
    }

    if (!hasImage) return null;

    const output = concatBytes(parts);

    const size = output.length - 8;

    output[4] = size & 0xff;
    output[5] = (size >>> 8) & 0xff;
    output[6] = (size >>> 16) & 0xff;
    output[7] = (size >>> 24) & 0xff;

    return output;
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

  /* =============================================================
     CANVAS FALLBACK
     ============================================================= */

  async function stripViaCanvas(file, format) {
    const mime = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    }[format];

    if (!mime) return null;

    const quality = format === "png" ? undefined : 1;

    let url;

    try {
      url = URL.createObjectURL(file);

      const blob = await new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");

            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;

            const ctx = canvas.getContext("2d");

            if (!ctx) {
              reject(new Error("Canvas context unavailable"));
              return;
            }

            if (format === "jpeg") {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            ctx.drawImage(img, 0, 0);

            canvas.toBlob(
              (result) => {
                if (!result) {
                  reject(new Error("Canvas export failed"));
                  return;
                }

                resolve(result);
              },
              mime,
              quality,
            );
          } catch (error) {
            reject(error);
          }
        };

        img.onerror = () => {
          reject(new Error("Image decoding failed"));
        };

        img.src = url;
      });

      // Some browsers may return PNG instead of the requested type.
      if (blob.type !== mime) {
        throw new Error("Browser returned an unexpected image format");
      }

      return new Uint8Array(await blob.arrayBuffer());
    } catch (error) {
      console.warn("Canvas fallback failed:", error);
      return null;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /* =============================================================
     UI STATE
     ============================================================= */

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
      "<th>" +
      escapeHtml(f.key) +
      "</th>" +
      '<td><div class="meta-value-wrap">' +
      '<div class="meta-value' +
      collapsed +
      '" id="val' +
      f.id +
      '">' +
      escapeHtml(f.value) +
      "</div>" +
      '<div class="value-tools">' +
      (long
        ? '<button class="icon-button" data-expand="' +
          f.id +
          '" aria-label="Expand value" title="Expand">' +
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
          '<path d="M4 6l4 4 4-4"/></svg></button>'
        : "") +
      '<button class="icon-button" data-copy="' +
      f.id +
      '" aria-label="Copy value" title="Copy">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
      '<path d="M3.5 10.5v-7a2 2 0 0 1 2-2h7"/>' +
      "</svg></button>" +
      "</div></div></td></tr>"
    );
  }

  function categoryTablesHtml(fields) {
    let html = "";

    const byCat = {};

    for (const c of CATEGORIES) {
      byCat[c] = [];
    }

    for (const f of fields) {
      if (!CATEGORIES.includes(f.category)) continue;
      byCat[f.category].push(f);
    }

    for (const c of CATEGORIES) {
      if (!byCat[c].length) continue;

      html +=
        '<div class="meta-cat">' +
        '<div class="meta-cat-head">' +
        "<h3>" +
        CAT_LABELS[c] +
        "</h3>" +
        '<span class="cat-badge">' +
        byCat[c].length +
        " " +
        (byCat[c].length === 1 ? "field" : "fields") +
        "</span></div>" +
        '<table class="meta-table">' +
        "<caption>" +
        CAT_LABELS[c] +
        " metadata</caption>" +
        "<tbody>" +
        byCat[c].map(rowHtml).join("") +
        "</tbody></table></div>";
    }

    return html;
  }

  /* =============================================================
     CATEGORY SELECTION
     ============================================================= */

  function getSelectedCategories() {
    return Array.from(
      $("catGrid").querySelectorAll("input[data-cat]:checked"),
    ).map((box) => box.dataset.cat);
  }

  function updateRemoveButton() {
    if (!state.meta) {
      $("removeButton").disabled = true;
      return;
    }

    const selected = getSelectedCategories();

    const available = state.meta.fields.some(
      (f) => !DIMENSION_KEYS.has(f.key) && selected.includes(f.category),
    );

    $("removeButton").disabled = !available;
  }

  function renderCategoryGrid(meta) {
    const grid = $("catGrid");

    let html = "";

    for (const c of CATEGORIES) {
      const count = meta.fields.filter(
        (f) => f.category === c && !DIMENSION_KEYS.has(f.key),
      ).length;

      html +=
        '<label class="cat-item' +
        (count === 0 ? " has-none" : "") +
        '" for="cat-' +
        c +
        '">' +
        '<input type="checkbox" id="cat-' +
        c +
        '" data-cat="' +
        c +
        '"' +
        (count === 0 ? " disabled" : " checked") +
        " />" +
        "<span>" +
        CAT_LABELS[c] +
        "</span>" +
        '<span class="cat-count">' +
        count +
        "</span></label>";
    }

    grid.innerHTML = html;

    const boxes = grid.querySelectorAll("input[data-cat]");
    const all = $("catAll");

    function syncAll() {
      const enabled = Array.from(boxes).filter((b) => !b.disabled);

      const checked = enabled.filter((b) => b.checked).length;

      all.checked = enabled.length > 0 && checked === enabled.length;

      all.indeterminate = checked > 0 && checked < enabled.length;

      updateRemoveButton();
    }

    // Assign rather than repeatedly adding listeners.
    all.onchange = () => {
      boxes.forEach((b) => {
        if (!b.disabled) b.checked = all.checked;
      });

      syncAll();
    };

    boxes.forEach((b) => {
      b.onchange = syncAll;
    });

    syncAll();
  }

  /* =============================================================
     BEFORE / AFTER RENDERING
     ============================================================= */

  function renderBefore(meta) {
    const removable = meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key));

    $("beforeCount").textContent =
      removable.length +
      " " +
      (removable.length === 1 ? "field" : "fields") +
      " found" +
      (meta.width ? " · " + meta.width + "×" + meta.height : "") +
      (meta.warnings.length ? " · " + meta.warnings.length + " notes" : "");

    const tables = $("beforeTables");

    if (!removable.length) {
      tables.innerHTML =
        '<div class="no-meta">' +
        "This image carries <strong>no readable metadata</strong>. " +
        "There is nothing to remove." +
        "</div>";
    } else {
      tables.innerHTML = categoryTablesHtml(removable);
    }

    if (meta.warnings.length) {
      tables.innerHTML +=
        '<div style="margin-top:12px">' +
        '<p class="no-meta" style="border-style:solid">' +
        meta.warnings.map(escapeHtml).join("<br>") +
        "</p></div>";
    }

    updateRemoveButton();

    $("removeNote").textContent = removable.length
      ? "Metadata is removed at the container level. Selecting a category may remove other fields in the same metadata block."
      : "Nothing to remove.";
  }

  function privacyWarnings(meta) {
    return meta.warnings.filter(
      (warning) => !warning.toLowerCase().includes("icc color profile"),
    );
  }

  function renderAfter(outMeta, outMethod) {
    const before = state.meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key));

    const after = outMeta.fields.filter((f) => !DIMENSION_KEYS.has(f.key));

    const afterKeys = new Set(after.map((f) => f.key + "\u0000" + f.value));

    const removed = before.filter(
      (f) => !afterKeys.has(f.key + "\u0000" + f.value),
    );

    const warnings = privacyWarnings(outMeta);

    const ok = after.length === 0 && warnings.length === 0;

    $("afterCount").textContent =
      after.length +
      " " +
      (after.length === 1 ? "field" : "fields") +
      " remain in the export";

    $("afterSummary").innerHTML =
      '<span class="after-stat ' +
      (ok ? "ok" : "bad") +
      '">' +
      '<span class="stat-dot"></span>' +
      (ok ? "Verified clean" : "Verification failed") +
      "</span>" +
      '<span class="after-stat">Removed <strong>' +
      removed.length +
      "</strong></span>" +
      '<span class="after-stat">Remaining <strong>' +
      after.length +
      "</strong></span>" +
      (outMethod === "canvas"
        ? '<span class="after-stat bad">Canvas re-encoded — pixels may differ slightly</span>'
        : '<span class="after-stat">Original image data preserved</span>');

    const tables = $("afterTables");

    if (after.length === 0 && warnings.length === 0) {
      tables.innerHTML =
        '<div class="no-meta">' +
        "Re-reading the cleaned export found " +
        "<strong>no recognized metadata</strong>. " +
        "Image dimensions are intrinsic and remain." +
        "</div>";
    } else {
      tables.innerHTML = "";

      if (after.length) {
        tables.innerHTML =
          '<p class="no-meta" style="margin-bottom:12px">' +
          "These fields survived. The export is not verified clean." +
          "</p>" +
          categoryTablesHtml(after);
      }

      if (warnings.length) {
        tables.innerHTML +=
          '<div class="no-meta">' +
          warnings.map(escapeHtml).join("<br>") +
          "</div>";
      }
    }

    $("downloadButton").disabled = !ok;
    $("exportFilename").disabled = !ok;
    $("exportFilename").placeholder = state.outName;
    $("copySummaryButton").hidden = false;

    return ok;
  }

  /* =============================================================
     FILE LOADING
     ============================================================= */

  async function loadFile(file) {
    if (!file) return;

    const sequence = ++state.sequence;

    if (state.thumbUrl) {
      URL.revokeObjectURL(state.thumbUrl);
      state.thumbUrl = null;
    }

    state.file = file;
    state.bytes = null;
    state.meta = null;
    state.outBlob = null;
    state.outMeta = null;
    state.outMethod = null;

    $("openAnotherButton").hidden = false;

    $("fileName").textContent = file.name;

    $("fileSpecs").textContent = "Reading… " + formatBytes(file.size);

    $("fileStrip").classList.remove("hidden");
    $("formatNotice").classList.add("hidden");
    $("metaPanels").classList.add("hidden");
    $("afterPanel").classList.add("hidden");

    $("emptyState").classList.remove("hidden");

    $("downloadButton").disabled = true;
    $("exportFilename").value = "";
    $("exportFilename").disabled = true;
    $("copySummaryButton").hidden = true;

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

      $("fileSpecs").textContent =
        meta.label + " · " + dims + formatBytes(u8.length);

      if (!meta.supported) {
        setChip("is-warn", "Unsupported format");

        $("emptyState").classList.add("hidden");

        $("formatNotice").classList.remove("hidden");

        $("formatNoticeText").textContent =
          meta.note || "TrueMetadata cannot process this format.";

        return;
      }

      $("metaPanels").classList.remove("hidden");
      $("emptyState").classList.add("hidden");

      renderCategoryGrid(meta);
      renderBefore(meta);

      const removable = meta.fields.filter(
        (f) => !DIMENSION_KEYS.has(f.key),
      ).length;

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
  }

  /* =============================================================
     REMOVE METADATA
     ============================================================= */

  async function removeMetadata() {
    if (!state.bytes || !state.meta) return;

    const selected = getSelectedCategories();

    if (!selected.length) {
      toast("Select at least one metadata category.", {
        kind: "error",
      });
      return;
    }

    const selectedFields = state.meta.fields.filter(
      (f) => !DIMENSION_KEYS.has(f.key) && selected.includes(f.category),
    );

    if (!selectedFields.length) {
      toast("No metadata exists in the selected categories.", {
        kind: "error",
      });
      return;
    }

    const sequence = state.sequence;

    $("removeButton").disabled = true;

    setChip("", "Removing…");

    try {
      let out = stripMetadataBytes(state.bytes, state.meta.format);

      let method = "byte";

      if (!out) {
        method = "canvas";

        out = await stripViaCanvas(state.file, state.meta.format);
      }

      if (sequence !== state.sequence) return;

      if (!out) {
        throw new Error("Metadata removal failed.");
      }

      // Re-read the actual output.
      const outMeta = readImageMetadata(out);

      if (!outMeta.supported) {
        throw new Error("Export format could not be verified.");
      }

      state.outMeta = outMeta;
      state.outMethod = method;

      const mime = {
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
      }[state.meta.format];

      state.outBlob = new Blob([out], { type: mime });

      const base = state.file.name.replace(/\.[^/.]+$/, "") || "image";

      const ext = {
        jpeg: "jpg",
        png: "png",
        webp: "webp",
      }[state.meta.format];

      state.outName = base + "-clean." + ext;

      const verified = renderAfter(outMeta, method);

      $("afterPanel").classList.remove("hidden");

      const remaining = outMeta.fields.filter(
        (f) => !DIMENSION_KEYS.has(f.key),
      ).length;

      setChip(
        verified ? "is-clean" : "is-warn",
        verified ? "Clean · verified" : remaining + " fields / warnings remain",
      );

      if (verified) {
        toast("Metadata removed and export verified.", { kind: "success" });
      } else {
        toast(
          "Export created, but metadata verification failed. Download disabled.",
          { kind: "error" },
        );
      }

      $("afterPanel").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (error) {
      console.error(error);

      toast("Removal failed: " + error.message, { kind: "error" });

      setChip("is-warn", "Removal failed");

      $("downloadButton").disabled = true;
    } finally {
      if (sequence === state.sequence) {
        updateRemoveButton();
      }
    }
  }

  /* =============================================================
     DOWNLOAD
     ============================================================= */

  function downloadOutput() {
    if (!state.outBlob || !state.outMeta) return;

    const remaining = state.outMeta.fields.filter(
      (f) => !DIMENSION_KEYS.has(f.key),
    );

    if (remaining.length || privacyWarnings(state.outMeta).length) {
      toast("This export has not passed verification.", { kind: "error" });
      return;
    }

    const ext = state.outName.split(".").pop() || "jpg";
    const full = $("exportFilename").value.trim() || state.outName;
    const base = full.toLowerCase().endsWith("." + ext)
      ? full.slice(0, full.length - ext.length - 1)
      : full;

    const removed = state.meta
      ? state.meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key)).length
      : 0;

    window.TrueHide.confirmDownload({
      fileName: base,
      extension: "." + ext,
      details: [
        { label: "Format", value: ext.toUpperCase() },
        { label: "Size", value: window.TrueHide.formatBytes(state.outBlob.size) },
        {
          label: "Method",
          value:
            state.outMethod === "canvas"
              ? "Canvas re-encode"
              : "Byte-level removal",
        },
        { label: "Fields removed", value: String(removed) },
        { label: "Verification", value: "Passed — no metadata remains" },
      ],
      note: "The cleaned copy was re-read and verified. Your original file stays untouched.",
      onConfirm: (name) => {
        const url = URL.createObjectURL(state.outBlob);

        const a = document.createElement("a");

        a.href = url;
        a.download = name;

        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => URL.revokeObjectURL(url), 1500);

        toast("Clean copy downloaded. Original file untouched.", {
          kind: "success",
        });
      },
    });
  }

  /* =============================================================
     COPY SUMMARY
     ============================================================= */

  function copySummary() {
    if (!state.outMeta || !state.meta) return;

    const lines = [];

    lines.push("TrueMetadata summary — " + state.file.name);

    lines.push(
      "Original metadata fields: " +
        state.meta.fields.filter((f) => !DIMENSION_KEYS.has(f.key)).length,
    );

    lines.push(
      "Remaining fields: " +
        state.outMeta.fields.filter((f) => !DIMENSION_KEYS.has(f.key)).length,
    );

    lines.push(
      "Method: " +
        (state.outMethod === "canvas"
          ? "Canvas re-encode"
          : "Byte-level removal"),
    );

    lines.push(
      "Verification: " +
        (state.outMeta.fields.filter((f) => !DIMENSION_KEYS.has(f.key))
          .length === 0 && privacyWarnings(state.outMeta).length === 0
          ? "Passed"
          : "Failed"),
    );

    const text = lines.join("\n");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("Summary copied.", { kind: "success" }),
        () => toast("Could not copy summary.", { kind: "error" }),
      );
    } else {
      const ta = document.createElement("textarea");

      ta.value = text;

      document.body.appendChild(ta);

      ta.select();

      document.execCommand("copy");

      ta.remove();

      toast("Summary copied.", { kind: "success" });
    }
  }

  /* =============================================================
     RESET
     ============================================================= */

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

    $("thumb").removeAttribute("src");

    $("fileStrip").classList.add("hidden");
    $("metaPanels").classList.add("hidden");
    $("formatNotice").classList.add("hidden");
    $("afterPanel").classList.add("hidden");

    $("emptyState").classList.remove("hidden");

    $("openAnotherButton").hidden = true;

    $("downloadButton").disabled = true;
    $("exportFilename").value = "";
    $("exportFilename").disabled = true;
    $("copySummaryButton").hidden = true;
    $("removeButton").disabled = true;

    $("beforeTables").innerHTML = "";
    $("afterTables").innerHTML = "";
    $("afterSummary").innerHTML = "";
    $("catGrid").innerHTML = "";

    $("beforeCount").textContent = "—";
    $("afterCount").textContent = "—";

    $("removeNote").textContent = "";

    $("catAll").checked = true;
    $("catAll").indeterminate = false;

    $("fileInput").value = "";

    setChip("", "");
  }

  /* =============================================================
     EVENT WIRING
     ============================================================= */

  $("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files[0];

    if (file) loadFile(file);

    $("fileInput").value = "";
  });

  $("removeButton").addEventListener("click", removeMetadata);

  $("downloadButton").addEventListener("click", downloadOutput);

  $("copySummaryButton").addEventListener("click", copySummary);

  $("openAnotherButton").addEventListener("click", resetAll);

  /* ---------- Expand / copy metadata values ---------- */

  document.addEventListener("click", (event) => {
    const expand = event.target.closest("[data-expand]");

    if (expand) {
      const el = document.getElementById("val" + expand.dataset.expand);

      if (el) {
        const collapsed = el.classList.toggle("meta-value--collapsed");

        expand.setAttribute(
          "aria-label",
          collapsed ? "Expand value" : "Collapse value",
        );

        expand.title = collapsed ? "Expand" : "Collapse";
      }

      return;
    }

    const copy = event.target.closest("[data-copy]");

    if (copy) {
      const el = document.getElementById("val" + copy.dataset.copy);

      const text = el ? el.textContent : "";

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast("Copied value.", { kind: "success" }),
          () => toast("Could not copy value.", { kind: "error" }),
        );
      }
    }
  });

  /* ---------- Drag and drop ---------- */

  window.TrueHide.attachFileDrop({
    accept: (file) =>
      file.type.startsWith("image/") ||
      /\.(jpe?g|png|webp|gif|tiff?|heic|heif|avif|pdf)$/i.test(file.name || ""),

    onFile: (file) => loadFile(file),

    rejectMessage:
      "TrueMetadata reads images. For PDFs, open TrueFlatten instead.",
  });

  /* ---------- Keyboard shortcut ---------- */

  if (window.TrueHide.registerShortcut) {
    window.TrueHide.registerShortcut({
      keys: ["o", "modCmdOrCtrl"],
      description: "Open image",
      handler: () => $("fileInput").click(),
    });
  }
})();
