/**
 * Removes metadata from an uploaded image without re-encoding it.
 *
 * Why: uploads are served byte-for-byte from a public bucket, so a phone
 * photo's EXIF GPS block (where an organiser lives), camera serial, XMP edit
 * history and IPTC captions were all public. This walks the container format
 * and copies across only a WHITELIST of structures; everything else is
 * dropped. Pixel data is never touched: the kept segments/chunks are copied
 * byte for byte.
 *
 * Covers the four types an event image upload accepts (`image/jpeg`,
 * `image/png`, `image/gif`, `image/webp`; see `request-event-image-upload.ts`):
 *
 *   - JPEG: keeps APP0 `JFIF` (its embedded thumbnail removed), APP2
 *     `ICC_PROFILE`, APP14 `Adobe` (cut to its 12-byte payload) and every
 *     non-APP marker segment (tables, frame and scan headers, entropy-coded
 *     data) except the reserved JPGn markers. Junk bytes between segments are
 *     skipped, never copied. Drops APP1 (EXIF, XMP,
 *     extended XMP), APP2 `MPF`, APP13 (Photoshop/IPTC), COM and every other
 *     APPn. Stops at the EOI that ends the primary image: phones append MPF
 *     secondary images after it, each with its own EXIF/GPS.
 *   - PNG: keeps the critical chunks plus colour/animation chunks; drops
 *     text, time, eXIf and anything unknown. Stops after IEND.
 *   - WebP: keeps the bitstream, alpha, animation and ICC chunks (and inside
 *     each ANMF frame only ALPH/VP8/VP8L); drops EXIF, XMP and anything
 *     unknown, then fixes the VP8X flags and RIFF size.
 *   - GIF: keeps the screen, colour tables, images, graphic-control
 *     extensions and the NETSCAPE/ANIMEXTS loop extension; drops comments,
 *     plain-text extensions and every other application extension (XMP lives
 *     in one).
 *
 * EXIF orientation is the one tag carried over: browsers rotate by it
 * (`image-orientation: from-image`), so dropping it would turn every
 * portrait phone photo on its side. When the original says something other
 * than 1, a minimal EXIF block holding ONLY that tag is written back.
 *
 * Throws {@link ImageMetadataStripError} for bytes it cannot walk to the end,
 * or whose format does not match `contentType`. Every length read is bounds
 * checked and every loop advances, so malformed input throws rather than
 * looping or reading out of range. A file with nothing to remove comes back
 * as the same bytes.
 *
 * MEMORY IS BOUNDED BY DESIGN. The input is attacker-supplied (an authed
 * upload of up to 25 MB), and the output is assembled from views into it, one
 * per kept structure. Without a bound, a file of 12 million two-byte JPEG
 * markers (or empty DHT segments, empty GIF extensions, empty WebP chunks)
 * makes 12 million view objects and takes the API process past 1 GB. So every
 * walker counts the structures it visits and throws past
 * {@link MAX_IMAGE_STRUCTURES}; kept structures are pushed as views, never
 * copied, except the few that are rewritten; and the `removed` list keeps
 * only its first {@link MAX_REMOVED_LABELS} labels plus a total count.
 */

import { readExifOrientation } from "./image-dimensions";

export class ImageMetadataStripError extends Error {
  override readonly name = "ImageMetadataStripError";
  /** Short machine-readable cause, for logs. */
  readonly reason: string;

  constructor(reason: string) {
    super(`Cannot strip image metadata: ${reason}`);
    this.reason = reason;
  }
}

export const isImageMetadataStripError = (
  err: unknown,
): err is ImageMetadataStripError => err instanceof ImageMetadataStripError;

/**
 * Most structures (segments, chunks, blocks, plus any junk-byte resyncs) one
 * file may contain. Real files are nowhere near it: a progressive JPEG has a
 * few dozen segments, a big PNG a few thousand IDAT chunks, an animated GIF
 * two blocks per frame. It exists to bound memory (module header).
 */
export const MAX_IMAGE_STRUCTURES = 65_536;

/** How many `removed` labels are kept; the rest are only counted. */
export const MAX_REMOVED_LABELS = 20;

export type StripImageMetadataResult = {
  /** The stripped file (the input bytes, unchanged, when nothing was removed). */
  bytes: Buffer;
  /**
   * What was dropped, e.g. `APP1:Exif`, `PNG:tEXt`: the first
   * {@link MAX_REMOVED_LABELS} only. Empty for a clean file.
   */
  removed: string[];
  /** How many structures were dropped in total. */
  removedCount: number;
};

export function stripImageMetadata(
  bytes: Uint8Array,
  contentType: string,
): StripImageMetadataResult {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  let built: Built;
  switch (type) {
    case "image/jpeg":
    case "image/jpg":
      built = stripJpeg(bytes);
      break;
    case "image/png":
      built = stripPng(bytes);
      break;
    case "image/webp":
      built = stripWebp(bytes);
      break;
    case "image/gif":
      built = stripGif(bytes);
      break;
    default:
      throw new ImageMetadataStripError(
        `unsupported content type "${type || "(none)"}"`,
      );
  }

  const { removed, removedCount } = built.tally;
  if (removedCount === 0) {
    return { bytes: asBuffer(bytes), removed: [], removedCount: 0 };
  }
  return { bytes: Buffer.concat(built.parts), removed, removedCount };
}

/**
 * Per-file bookkeeping: what was dropped (bounded) and how many structures
 * were walked (capped).
 */
class Tally {
  readonly removed: string[] = [];
  removedCount = 0;
  private structures = 0;

  drop(label: string): void {
    this.removedCount += 1;
    if (this.removed.length < MAX_REMOVED_LABELS) this.removed.push(label);
  }

  /** Call once per structure visited; throws past the cap. */
  step(): void {
    this.structures += 1;
    if (this.structures > MAX_IMAGE_STRUCTURES) fail("too many segments");
  }
}

type Built = { parts: Uint8Array[]; tally: Tally };

function fail(reason: string): never {
  throw new ImageMetadataStripError(reason);
}

const asBuffer = (b: Uint8Array): Buffer =>
  Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);

// ─────────────────────────────────────────────────────────────────────────────
// Byte readers (bounds-checked: undefined when out of range)
// ─────────────────────────────────────────────────────────────────────────────

const u8 = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at < b.length ? b[at] : undefined;

const u16be = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at + 2 <= b.length ? (b[at]! << 8) | b[at + 1]! : undefined;

const u32be = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at + 4 <= b.length
    ? b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)
    : undefined;

const u32le = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at + 4 <= b.length
    ? b[at + 3]! * 0x1000000 + ((b[at + 2]! << 16) | (b[at + 1]! << 8) | b[at]!)
    : undefined;

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (at < 0 || at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

/** Four bytes as a printable fourcc, or undefined when out of range / binary. */
const fourcc = (b: Uint8Array, at: number): string | undefined => {
  if (at < 0 || at + 4 > b.length) return undefined;
  let s = "";
  for (let i = 0; i < 4; i += 1) {
    const c = b[at + i]!;
    if (c < 0x20 || c > 0x7e) return undefined;
    s += String.fromCharCode(c);
  }
  return s;
};

const trailing = (bytes: number): string => `trailing data (${bytes} bytes)`;

// ─────────────────────────────────────────────────────────────────────────────
// Orientation-only EXIF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orientation from a TIFF/EXIF payload bounded by [start, end). Accepts the
 * `Exif\0\0` prefix some writers put in PNG `eXIf` / WebP `EXIF` chunks.
 */
function readPayloadOrientation(
  b: Uint8Array,
  start: number,
  end: number,
): number | undefined {
  const tiff = ascii(b, start, "Exif\0\0") ? start + 6 : start;
  return readExifOrientation(b, tiff, Math.min(end, b.length));
}

/**
 * A big-endian TIFF block holding IFD0 with the single Orientation tag and
 * nothing else: no other tags, no IFD1, no thumbnail. 26 bytes.
 */
function orientationTiff(orientation: number): Buffer {
  const t = Buffer.alloc(26);
  t.write("MM", 0, "ascii");
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4); // IFD0 offset
  t.writeUInt16BE(1, 8); // one entry
  t.writeUInt16BE(0x0112, 10); // Orientation
  t.writeUInt16BE(3, 12); // SHORT
  t.writeUInt32BE(1, 14); // count
  t.writeUInt16BE(orientation, 18); // value, left-justified in the 4-byte field
  t.writeUInt32BE(0, 22); // no next IFD
  return t;
}

const keepsOrientation = (o: number | undefined): o is number =>
  o !== undefined && o !== 1;

// ─────────────────────────────────────────────────────────────────────────────
// JPEG
// ─────────────────────────────────────────────────────────────────────────────

/** SOF0–SOF15 minus DHT (C4), JPG (C8) and DAC (CC). */
const isSofMarker = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/** RST0–RST7 and TEM: markers with no length field. */
const isStandaloneMarker = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/**
 * JPG0–JPG13 (F0–FD), reserved for extensions, except F7 (SOF55) and F8 (LSE),
 * which JPEG-LS uses. Dropped outside scan data: nothing a browser decodes
 * needs them, and they are a place to hide bytes.
 */
const isReservedJpgMarker = (marker: number): boolean =>
  marker >= 0xf0 && marker <= 0xfd && marker !== 0xf7 && marker !== 0xf8;

/**
 * RES (02–BF): reserved by the standard, never written by an encoder. They
 * carry a length field like any other segment, so they are skipped whole.
 */
const isReservedMarker = (marker: number): boolean =>
  marker >= 0x02 && marker <= 0xbf;

/** Whether an APPn segment is on the whitelist, and its label when it is not. */
function classifyApp(
  b: Uint8Array,
  marker: number,
  payload: number,
): { keep: true } | { keep: false; label: string } {
  const n = marker - 0xe0;
  switch (marker) {
    case 0xe0:
      if (ascii(b, payload, "JFIF\0")) return { keep: true };
      if (ascii(b, payload, "JFXX\0")) return { keep: false, label: "APP0:JFXX" };
      return { keep: false, label: "APP0" };
    case 0xe1:
      if (ascii(b, payload, "Exif\0")) return { keep: false, label: "APP1:Exif" };
      if (ascii(b, payload, "http://ns.adobe.com/xap/1.0/\0")) {
        return { keep: false, label: "APP1:XMP" };
      }
      if (ascii(b, payload, "http://ns.adobe.com/xmp/extension/\0")) {
        return { keep: false, label: "APP1:XMP-extension" };
      }
      return { keep: false, label: "APP1" };
    case 0xe2:
      if (ascii(b, payload, "ICC_PROFILE\0")) return { keep: true };
      if (ascii(b, payload, "MPF\0")) return { keep: false, label: "APP2:MPF" };
      return { keep: false, label: "APP2" };
    case 0xed:
      if (ascii(b, payload, "Photoshop 3.0\0")) {
        return { keep: false, label: "APP13:Photoshop" };
      }
      return { keep: false, label: "APP13" };
    case 0xee:
      // Truncated to its fixed 12-byte payload by the caller.
      if (ascii(b, payload, "Adobe")) return { keep: true };
      return { keep: false, label: "APP14" };
    default:
      return { keep: false, label: `APP${n}` };
  }
}

/** JFIF APP0 payload size with no thumbnail: id(5) version(2) units(1) density(4) thumb(2). */
const JFIF_PAYLOAD_NO_THUMB = 14;

/**
 * The JFIF segment with its optional embedded thumbnail removed (an
 * uncropped preview can leak what the crop hid), or null when it has none.
 * The caller has checked the payload is at least {@link JFIF_PAYLOAD_NO_THUMB}.
 */
function jfifWithoutThumbnail(
  b: Uint8Array,
  markerStart: number,
  payload: number,
  end: number,
): Buffer | null {
  const xThumb = b[payload + 12]!;
  const yThumb = b[payload + 13]!;
  if (xThumb === 0 && yThumb === 0 && end - payload === JFIF_PAYLOAD_NO_THUMB) {
    return null;
  }
  const seg = Buffer.from(b.subarray(markerStart, payload + JFIF_PAYLOAD_NO_THUMB));
  seg.writeUInt16BE(2 + JFIF_PAYLOAD_NO_THUMB, 2);
  seg[4 + 12] = 0;
  seg[4 + 13] = 0;
  return seg;
}

/** APP14 Adobe payload: "Adobe"(5) version(2) flags0(2) flags1(2) transform(1). */
const ADOBE_PAYLOAD = 12;

/** The Adobe segment cut to its fixed payload, or null when it already is. */
function adobeWithoutExtra(
  b: Uint8Array,
  markerStart: number,
  payload: number,
  end: number,
): Buffer | null {
  if (end - payload === ADOBE_PAYLOAD) return null;
  const seg = Buffer.from(b.subarray(markerStart, payload + ADOBE_PAYLOAD));
  seg.writeUInt16BE(2 + ADOBE_PAYLOAD, 2);
  return seg;
}

function orientationApp1(orientation: number): Buffer {
  const tiff = orientationTiff(orientation);
  const head = Buffer.alloc(4 + 6);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(2 + 6 + tiff.length, 2);
  head.write("Exif\0\0", 4, "ascii");
  return Buffer.concat([head, tiff]);
}

/**
 * Index of the marker that ends the entropy-coded data starting at `start`.
 * Inside scan data `FF 00` is a stuffed 0xFF and `FF D0`–`FF D7` are restart
 * markers; any other `FF xx` (after optional `FF` fill bytes) ends the scan.
 */
function findScanEnd(b: Uint8Array, start: number): number {
  let i = start;
  for (;;) {
    const ff = b.indexOf(0xff, i);
    if (ff === -1) fail("truncated scan data (no EOI)");
    let j = ff + 1;
    while (j < b.length && b[j] === 0xff) j += 1;
    if (j >= b.length) fail("truncated scan data (no EOI)");
    const next = b[j]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      i = j + 1;
      continue;
    }
    return ff;
  }
}

function stripJpeg(b: Uint8Array): Built {
  if (u8(b, 0) !== 0xff || u8(b, 1) !== 0xd8) fail("not a JPEG (no SOI)");

  // SOI, then a JFIF APP0 if it comes first; the orientation-only EXIF goes
  // right after these, ahead of everything else.
  const head: Uint8Array[] = [b.subarray(0, 2)];
  const body: Uint8Array[] = [];
  const tally = new Tally();
  let orientation: number | undefined;
  let sawExif = false;
  let sawFrame = false;
  let sawScan = false;
  let at = 2;

  for (;;) {
    tally.step();
    if (at >= b.length) fail("truncated (no EOI)");
    if (b[at] !== 0xff) {
      // Junk between segments (some camera firmware writes it). Skip to the
      // next 0xFF; the skipped bytes are never copied.
      const next = b.indexOf(0xff, at);
      if (next === -1) fail("truncated (no EOI)");
      tally.drop(`junk (${next - at} bytes)`);
      at = next;
      continue;
    }
    // Any number of 0xFF fill bytes may precede a marker.
    while (b[at] === 0xff) at += 1;
    const marker = u8(b, at);
    if (marker === undefined) fail("truncated (no EOI)");
    const markerStart = at - 1;
    at += 1;

    if (marker === 0x00) {
      // A stuffed byte outside scan data is junk too.
      tally.drop("junk (2 bytes)");
      continue;
    }
    if (marker === 0xd8) fail("nested SOI");
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan) fail("EOI before any image data");
      body.push(b.subarray(markerStart, at));
      if (at < b.length) tally.drop(trailing(b.length - at));
      break;
    }
    // Restart markers are only valid INSIDE scan data (findScanEnd consumes
    // those); one out here is malformed, and a file of nothing else is the
    // memory attack the structure cap exists for.
    if (isStandaloneMarker(marker!)) fail("standalone marker outside scan data");

    const length = u16be(b, at);
    if (length === undefined || length < 2) fail("bad segment length");
    const payload = at + 2;
    const end = at + length!;
    if (end > b.length) fail("segment runs past end of file");
    const segment = b.subarray(markerStart, end);
    at = end;

    if (marker! >= 0xe0 && marker! <= 0xef) {
      const app = classifyApp(b, marker!, payload);
      if (app.keep && marker === 0xe0 && end - payload < JFIF_PAYLOAD_NO_THUMB) {
        // A JFIF header too short to be one: drop it, decoders do not need it.
        tally.drop("APP0:JFIF-malformed");
        continue;
      }
      if (app.keep && marker === 0xee && end - payload < ADOBE_PAYLOAD) {
        tally.drop("APP14:Adobe-malformed");
        continue;
      }
      if (app.keep) {
        let kept: Uint8Array = segment;
        if (marker === 0xe0) {
          const trimmed = jfifWithoutThumbnail(b, markerStart, payload, end);
          if (trimmed) {
            tally.drop("APP0:JFIF-thumbnail");
            kept = trimmed;
          }
        }
        if (marker === 0xee) {
          const trimmed = adobeWithoutExtra(b, markerStart, payload, end);
          if (trimmed) {
            tally.drop("APP14:Adobe-extra");
            kept = trimmed;
          }
        }
        (marker === 0xe0 && body.length === 0 ? head : body).push(kept);
        continue;
      }
      tally.drop(app.label);
      if (marker === 0xe1 && !sawExif && ascii(b, payload, "Exif\0\0")) {
        sawExif = true;
        orientation = readExifOrientation(b, payload + 6, end);
      }
      continue;
    }
    if (marker === 0xfe) {
      tally.drop("COM");
      continue;
    }
    if (isReservedJpgMarker(marker!)) {
      tally.drop(`JPG${marker! - 0xf0}`);
      continue;
    }
    if (isReservedMarker(marker!)) {
      tally.drop(`RES:0x${marker!.toString(16).padStart(2, "0")}`);
      continue;
    }

    if (isSofMarker(marker!)) sawFrame = true;
    body.push(segment);

    if (marker === 0xda) {
      if (!sawFrame) fail("scan before frame header");
      sawScan = true;
      const scanEnd = findScanEnd(b, at);
      body.push(b.subarray(at, scanEnd));
      at = scanEnd;
    }
  }

  const exif = keepsOrientation(orientation) ? [orientationApp1(orientation)] : [];
  return { parts: [...head, ...exif, ...body], tally };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PNG_KEEP: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

const isPngChunkType = (type: string): boolean => /^[A-Za-z]{4}$/.test(type);

function stripPng(b: Uint8Array): Built {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) {
    fail("not a PNG (bad signature)");
  }

  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const tally = new Tally();
  let sawIdat = false;
  let emittedExif = false;
  let first = true;
  let at = 8;

  for (;;) {
    tally.step();
    if (at >= b.length) fail("truncated (no IEND)");
    const length = u32be(b, at);
    const type = fourcc(b, at + 4);
    if (length === undefined || type === undefined) fail("truncated chunk header");
    if (!isPngChunkType(type!)) fail("bad chunk type");
    if (length! > 0x7fffffff) fail("chunk length out of range");
    const dataStart = at + 8;
    const dataEnd = dataStart + length!;
    const end = dataEnd + 4; // CRC
    if (end > b.length) fail(`${type} chunk runs past end of file`);
    if (first && type !== "IHDR") fail("first chunk is not IHDR");
    first = false;
    const chunk = b.subarray(at, end);
    at = end;

    if (type === "IEND") {
      if (!sawIdat) fail("IEND before any IDAT");
      parts.push(chunk);
      if (at < b.length) tally.drop(trailing(b.length - at));
      break;
    }
    if (type === "IDAT") sawIdat = true;
    if (PNG_KEEP.has(type!)) {
      parts.push(chunk);
      continue;
    }

    tally.drop(`PNG:${type}`);
    if (type === "eXIf" && !emittedExif) {
      const orientation = readPayloadOrientation(b, dataStart, dataEnd);
      if (keepsOrientation(orientation)) {
        emittedExif = true;
        // Same position as the original, so a decoder that honoured it
        // (eXIf before the first IDAT) still does, and one that did not still
        // does not.
        parts.push(pngChunk("eXIf", orientationTiff(orientation)));
      }
    }
  }

  return { parts, tally };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP
// ─────────────────────────────────────────────────────────────────────────────

const WEBP_KEEP: ReadonlySet<string> = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ANMF",
  "ICCP",
]);

const WEBP_IMAGE_CHUNKS: ReadonlySet<string> = new Set(["VP8 ", "VP8L", "ANMF"]);

/** What an ANMF frame may carry after its 16-byte frame header. */
const WEBP_FRAME_KEEP: ReadonlySet<string> = new Set(["ALPH", "VP8 ", "VP8L"]);
const ANMF_HEADER = 16;

/** VP8X flag bits (first byte of the chunk payload). */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

const ZERO_PAD = Buffer.alloc(1);

/** A NEW chunk: header, data and the pad byte an odd size needs. */
function webpChunk(type: string, data: Uint8Array): Buffer {
  const pad = data.length & 1;
  const chunk = Buffer.alloc(8 + data.length + pad);
  chunk.write(type, 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  chunk.set(data, 8);
  return chunk;
}

type WebpChunkRef = {
  type: string;
  /** Offset of the chunk header. */
  at: number;
  dataStart: number;
  dataEnd: number;
  /** Offset just past the chunk (and its pad byte, when present). */
  next: number;
};

/** Reads the chunk header at `at`, bounded by `end`. */
function readWebpChunk(b: Uint8Array, at: number, end: number): WebpChunkRef {
  const type = fourcc(b, at);
  const size = u32le(b, at + 4);
  if (type === undefined || size === undefined || at + 8 > end) {
    fail("truncated chunk header");
  }
  const dataStart = at + 8;
  const dataEnd = dataStart + size!;
  if (dataEnd > end) fail(`${type} chunk runs past its container`);
  // Odd sizes are followed by one pad byte (a writer that left it off the
  // last chunk is tolerated).
  return { type: type!, at, dataStart, dataEnd, next: Math.min(dataEnd + (size! & 1), end) };
}

/**
 * Views for a kept chunk, copied from the input: the chunk itself plus its pad
 * byte, or a shared zero pad when the input left it off.
 */
function keptWebpChunk(b: Uint8Array, c: WebpChunkRef): Uint8Array[] {
  const odd = (c.dataEnd - c.dataStart) & 1;
  if (!odd || c.next > c.dataEnd) return [b.subarray(c.at, c.next)];
  return [b.subarray(c.at, c.dataEnd), ZERO_PAD];
}

/**
 * An ANMF frame with only its frame header and ALPH/VP8/VP8L sub-chunks kept.
 * Returns views when nothing was dropped, else one rebuilt chunk.
 */
function stripAnmf(b: Uint8Array, c: WebpChunkRef, tally: Tally): Uint8Array[] {
  if (c.dataEnd - c.dataStart < ANMF_HEADER) fail("ANMF chunk too short");
  const kept: Uint8Array[] = [];
  let dropped = false;
  let sawFrameImage = false;
  let at = c.dataStart + ANMF_HEADER;
  while (at < c.dataEnd) {
    tally.step();
    const sub = readWebpChunk(b, at, c.dataEnd);
    at = sub.next;
    if (WEBP_FRAME_KEEP.has(sub.type)) {
      if (sub.type !== "ALPH") sawFrameImage = true;
      kept.push(...keptWebpChunk(b, sub));
      continue;
    }
    dropped = true;
    tally.drop(`WebP:ANMF:${sub.type.trim()}`);
  }
  if (!sawFrameImage) fail("ANMF frame without image data");
  if (!dropped) return keptWebpChunk(b, c);
  const data = Buffer.concat([b.subarray(c.dataStart, c.dataStart + ANMF_HEADER), ...kept]);
  return [webpChunk("ANMF", data)];
}

function stripWebp(b: Uint8Array): Built {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) fail("not a WebP (bad RIFF header)");
  const riffSize = u32le(b, 4);
  if (riffSize === undefined) fail("truncated RIFF header");
  const riffEnd = 8 + riffSize!;
  if (riffEnd > b.length) fail("RIFF size runs past end of file");

  const chunks: Uint8Array[] = [];
  const tally = new Tally();
  let vp8x: Buffer | null = null;
  let emittedExif = false;
  let sawImage = false;
  let at = 12;

  while (at < riffEnd) {
    tally.step();
    const c = readWebpChunk(b, at, riffEnd);
    if (at === 12 && c.type !== "VP8 " && c.type !== "VP8L" && c.type !== "VP8X") {
      fail("first chunk is not VP8/VP8L/VP8X");
    }
    at = c.next;

    if (WEBP_KEEP.has(c.type)) {
      if (WEBP_IMAGE_CHUNKS.has(c.type)) sawImage = true;
      if (c.type === "VP8X") {
        if (c.dataEnd - c.dataStart < 10) fail("VP8X chunk too short");
        if (vp8x) fail("second VP8X chunk");
        // The one chunk that is rewritten (its flags), so the one copy.
        vp8x = webpChunk("VP8X", b.subarray(c.dataStart, c.dataEnd));
        chunks.push(vp8x);
      } else if (c.type === "ANMF") {
        chunks.push(...stripAnmf(b, c, tally));
      } else {
        chunks.push(...keptWebpChunk(b, c));
      }
      continue;
    }

    tally.drop(`WebP:${c.type.trim()}`);
    if (c.type === "EXIF" && vp8x && !emittedExif) {
      const orientation = readPayloadOrientation(b, c.dataStart, c.dataEnd);
      if (keepsOrientation(orientation)) {
        chunks.push(webpChunk("EXIF", orientationTiff(orientation)));
        emittedExif = true;
      }
    }
  }

  if (!sawImage) fail("no image data");
  if (riffEnd < b.length) tally.drop(trailing(b.length - riffEnd));

  if (vp8x) {
    const flags = vp8x[8]!;
    vp8x[8] = ((flags & ~VP8X_XMP) & ~VP8X_EXIF) | (emittedExif ? VP8X_EXIF : 0);
  }

  let bodyLength = 0;
  for (const c of chunks) bodyLength += c.length;
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + bodyLength, 4);
  header.write("WEBP", 8, "ascii");
  return { parts: [header, ...chunks], tally };
}

// ─────────────────────────────────────────────────────────────────────────────
// GIF
// ─────────────────────────────────────────────────────────────────────────────

const GIF_KEEP_APPLICATIONS: ReadonlySet<string> = new Set([
  "NETSCAPE2.0",
  "ANIMEXTS1.0",
]);

/** Byte size of a colour table whose packed field is `packed`, or 0. */
const colorTableBytes = (packed: number): number =>
  packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;

/** Index just past the terminating zero-length sub-block starting at `at`. */
function skipSubBlocks(b: Uint8Array, at: number): number {
  for (;;) {
    const n = u8(b, at);
    if (n === undefined) fail("truncated data sub-blocks");
    at += 1;
    if (n === 0) return at;
    at += n!;
    if (at > b.length) fail("data sub-block runs past end of file");
  }
}

/** The 11-byte application identifier + auth code, printable, or "". */
function gifApplicationId(b: Uint8Array, blocks: number): string {
  if (u8(b, blocks) !== 11 || blocks + 12 > b.length) return "";
  let s = "";
  for (let i = blocks + 1; i < blocks + 12; i += 1) {
    const c = b[i]!;
    s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : "?";
  }
  return s;
}

/**
 * Keeps an extension up to the end of its first data sub-block
 * (`firstBlockEnd`), then a terminator. When the original ended right there
 * (the normal case) it is kept as one view; otherwise the extra sub-blocks are
 * dropped and counted.
 */
function keepFirstSubBlock(
  parts: Uint8Array[],
  tally: Tally,
  b: Uint8Array,
  start: number,
  firstBlockEnd: number,
  end: number,
  label: string,
): void {
  if (end === firstBlockEnd + 1) {
    parts.push(b.subarray(start, end));
    return;
  }
  parts.push(b.subarray(start, firstBlockEnd), ZERO_PAD);
  tally.drop(label);
}

function stripGif(b: Uint8Array): Built {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) fail("not a GIF (bad signature)");
  const packed = u8(b, 10);
  if (packed === undefined || b.length < 13) fail("truncated screen descriptor");
  let at = 13 + colorTableBytes(packed!);
  if (at > b.length) fail("global colour table runs past end of file");

  const parts: Uint8Array[] = [b.subarray(0, at)];
  const tally = new Tally();
  let sawImage = false;

  for (;;) {
    tally.step();
    const introducer = u8(b, at);
    if (introducer === undefined) fail("truncated (no trailer)");
    const start = at;

    if (introducer === 0x3b) {
      if (!sawImage) fail("trailer before any image");
      at += 1;
      parts.push(b.subarray(start, at));
      if (at < b.length) tally.drop(trailing(b.length - at));
      break;
    }

    if (introducer === 0x2c) {
      const imagePacked = u8(b, at + 9);
      if (imagePacked === undefined) fail("truncated image descriptor");
      at += 10 + colorTableBytes(imagePacked!);
      if (at + 1 > b.length) fail("truncated image data");
      at = skipSubBlocks(b, at + 1); // +1: LZW minimum code size
      parts.push(b.subarray(start, at));
      sawImage = true;
      continue;
    }

    if (introducer === 0x21) {
      const label = u8(b, at + 1);
      if (label === undefined) fail("truncated extension");
      const blocks = at + 2;
      at = skipSubBlocks(b, blocks);
      // Graphic control only. Plain-text extensions (0x01) are dropped: they
      // render text no browser draws, and they can carry anything.
      if (label === 0xf9) {
        // Exactly one 4-byte sub-block; anything after it is a hiding place.
        if (u8(b, blocks) !== 4) {
          tally.drop("GIF:graphic-control-malformed");
          continue;
        }
        keepFirstSubBlock(parts, tally, b, start, blocks + 5, at, "GIF:graphic-control-extra");
        continue;
      }
      if (label === 0xff) {
        const id = gifApplicationId(b, blocks);
        if (GIF_KEEP_APPLICATIONS.has(id)) {
          // The 11-byte identifier block, then the loop (3 bytes) or buffer
          // (5 bytes) sub-block. Nothing else in these is read by a decoder.
          const dataBlock = blocks + 12;
          const n = u8(b, dataBlock);
          if (n !== 3 && n !== 5) {
            tally.drop(`GIF:application:${id}-malformed`);
            continue;
          }
          keepFirstSubBlock(
            parts,
            tally,
            b,
            start,
            dataBlock + 1 + n,
            at,
            `GIF:application:${id}-extra`,
          );
          continue;
        }
        tally.drop(`GIF:application:${id || "?"}`);
        continue;
      }
      tally.drop(
        label === 0xfe
          ? "GIF:comment"
          : label === 0x01
            ? "GIF:plain-text"
            : `GIF:extension:0x${label!.toString(16)}`,
      );
      continue;
    }

    fail(`unexpected block 0x${introducer!.toString(16)} at ${at}`);
  }

  return { parts, tally };
}
