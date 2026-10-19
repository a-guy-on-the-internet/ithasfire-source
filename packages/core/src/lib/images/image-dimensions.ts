/**
 * Reads an image's pixel size from its header bytes, without decoding it.
 *
 * Covers the four types an event image upload accepts (`image/jpeg`,
 * `image/png`, `image/gif`, `image/webp`; see `request-event-image-upload.ts`).
 * The result is the size a BROWSER displays: for a JPEG whose EXIF orientation
 * is 5–8 (rotated a quarter turn) width and height are swapped, because
 * browsers apply `image-orientation: from-image` by default. That is the shape
 * the `<img width height>` attributes must describe for the reserved box to
 * match the loaded image.
 *
 * Works on a PREFIX of the file: callers read the first
 * {@link IMAGE_DIMENSIONS_PREFIX_BYTES} rather than a whole 25 MB upload.
 * Returns `null` for anything unrecognised, malformed or cut short (a JPEG
 * whose SOF lies past the prefix, say). Never throws.
 *
 * Known gaps, all of which only cost a layout shift (the browser falls back to
 * the loaded image's own ratio, so the final render is unaffected):
 *   - EXIF orientation is read for JPEG only, not for a WebP `EXIF` chunk or a
 *     PNG `eXIf` chunk.
 *   - An animated GIF reports its logical screen, which is what browsers size
 *     it by anyway.
 */

/** How much of the file the dimension read fetches. Large EXIF/ICC blocks
 *  can push a JPEG's SOF past 64 KB, so 256 KB leaves room. */
export const IMAGE_DIMENSIONS_PREFIX_BYTES = 256 * 1024;

export type ImageDimensions = { width: number; height: number };

/** `event_images.width/height` are Postgres `INTEGER`. */
const MAX_DIMENSION = 2_147_483_647;

export function readImageDimensions(
  bytes: Uint8Array,
): ImageDimensions | null {
  try {
    const raw =
      readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes);
    if (!raw) return null;
    const { width, height } = raw;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION
    ) {
      return null;
    }
    return { width, height };
  } catch {
    // Every read below is bounds-checked; this is the backstop for the
    // "never throws" contract, not an expected path.
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Byte readers (bounds-checked: undefined when out of range)
// ─────────────────────────────────────────────────────────────────────────────

const u8 = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at < b.length ? b[at] : undefined;

const u16be = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at + 2 <= b.length ? (b[at]! << 8) | b[at + 1]! : undefined;

const u16le = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at + 2 <= b.length ? b[at]! | (b[at + 1]! << 8) : undefined;

const u24le = (b: Uint8Array, at: number): number | undefined =>
  at >= 0 && at + 3 <= b.length
    ? b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
    : undefined;

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

// ─────────────────────────────────────────────────────────────────────────────
// PNG: the IHDR chunk is always first, at a fixed offset.
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(b: Uint8Array): ImageDimensions | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  if (!ascii(b, 12, "IHDR")) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width === undefined || height === undefined) return null;
  return { width, height };
}

// ─────────────────────────────────────────────────────────────────────────────
// GIF: the logical screen descriptor follows the 6-byte signature.
// ─────────────────────────────────────────────────────────────────────────────

function readGif(b: Uint8Array): ImageDimensions | null {
  if (!ascii(b, 0, "GIF87a") && !ascii(b, 0, "GIF89a")) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  if (width === undefined || height === undefined) return null;
  return { width, height };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP: RIFF container; the first chunk is VP8 (lossy), VP8L (lossless) or
// VP8X (extended, carries the canvas size).
// ─────────────────────────────────────────────────────────────────────────────

function readWebp(b: Uint8Array): ImageDimensions | null {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  const data = 20; // after "RIFF" size "WEBP" fourcc chunk-size

  if (ascii(b, 12, "VP8 ")) {
    // 3-byte frame tag, then the keyframe start code 9D 01 2A.
    if (u8(b, data + 3) !== 0x9d) return null;
    if (u8(b, data + 4) !== 0x01) return null;
    if (u8(b, data + 5) !== 0x2a) return null;
    const w = u16le(b, data + 6);
    const h = u16le(b, data + 8);
    if (w === undefined || h === undefined) return null;
    // The top two bits are the upscaling hint, not size.
    return { width: w & 0x3fff, height: h & 0x3fff };
  }

  if (ascii(b, 12, "VP8L")) {
    if (u8(b, data) !== 0x2f) return null;
    const bits = u32le(b, data + 1);
    if (bits === undefined) return null;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  if (ascii(b, 12, "VP8X")) {
    const w = u24le(b, data + 4);
    const h = u24le(b, data + 7);
    if (w === undefined || h === undefined) return null;
    return { width: w + 1, height: h + 1 };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// JPEG: walk the marker segments to the first SOFn; read EXIF orientation from
// an APP1 segment met on the way.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SOF0–SOF15 minus the three markers in that range that are not frame headers:
 * C4 (DHT, Huffman tables), C8 (JPG, reserved) and CC (DAC, arithmetic coding).
 */
const isSofMarker = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/** Markers that stand alone with no length field. */
const isStandaloneMarker = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

function readJpeg(b: Uint8Array): ImageDimensions | null {
  if (u8(b, 0) !== 0xff || u8(b, 1) !== 0xd8) return null;

  let orientation = 1;
  let sawExif = false;
  let at = 2;

  while (at < b.length) {
    if (b[at] !== 0xff) return null; // lost sync: malformed
    // Any number of 0xFF fill bytes may precede a marker.
    while (b[at] === 0xff) at += 1;
    const marker = u8(b, at);
    if (marker === undefined) return null;
    at += 1;

    if (isStandaloneMarker(marker)) continue;
    // EOI or start-of-scan before any frame header: there is no size to read.
    if (marker === 0xd9 || marker === 0xda) return null;

    const length = u16be(b, at);
    if (length === undefined || length < 2) return null;
    const segmentStart = at + 2;
    const segmentEnd = at + length;

    if (isSofMarker(marker)) {
      // precision (1), height (2), width (2)
      if (length < 7) return null;
      const height = u16be(b, segmentStart + 1);
      const width = u16be(b, segmentStart + 3);
      if (width === undefined || height === undefined) return null;
      const quarterTurn = orientation >= 5 && orientation <= 8;
      return quarterTurn ? { width: height, height: width } : { width, height };
    }

    if (marker === 0xe1 && !sawExif && ascii(b, segmentStart, "Exif\0\0")) {
      sawExif = true;
      orientation =
        readExifOrientation(b, segmentStart + 6, Math.min(segmentEnd, b.length)) ??
        1;
    }

    at = segmentEnd;
  }

  return null; // ran out of bytes before a frame header
}

/**
 * Orientation (tag 0x0112) from IFD0 of the TIFF block starting at `tiff`,
 * bounded by `end`. Undefined when absent or unreadable. Also used by
 * `strip-image-metadata.ts`, which carries the orientation over when it drops
 * the rest of the EXIF block.
 */
export function readExifOrientation(
  b: Uint8Array,
  tiff: number,
  end: number,
): number | undefined {
  const view = b.subarray(tiff, end);
  let le: boolean;
  if (ascii(view, 0, "II")) le = true;
  else if (ascii(view, 0, "MM")) le = false;
  else return undefined;

  const r16 = (at: number) => (le ? u16le(view, at) : u16be(view, at));
  const r32 = (at: number) => (le ? u32le(view, at) : u32be(view, at));

  if (r16(2) !== 42) return undefined;
  const ifd0 = r32(4);
  if (ifd0 === undefined) return undefined;
  const count = r16(ifd0);
  if (count === undefined) return undefined;

  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    const tag = r16(entry);
    if (tag === undefined) return undefined;
    if (tag !== 0x0112) continue;
    const type = r16(entry + 2);
    if (type !== 3) return undefined; // SHORT
    const value = r16(entry + 8);
    if (value === undefined || value < 1 || value > 8) return undefined;
    return value;
  }
  return undefined;
}
