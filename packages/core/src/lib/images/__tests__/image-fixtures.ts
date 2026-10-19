/**
 * Hand-built image files for the metadata-stripper tests (and the use-case
 * tests that need bytes the stripper accepts). Each builder writes a small,
 * structurally valid file byte by byte; the pixel payloads are opaque filler,
 * which is all a container walker looks at.
 *
 * Sentinel strings (`SECRET-…`) sit inside every metadata block so a test can
 * assert they are gone from the output with a plain byte search.
 */
import { crc32 } from "node:zlib";

export const SECRET = {
  make: "SECRET-MAKE",
  xmp: "SECRET-XMP",
  iptc: "SECRET-IPTC",
  comment: "SECRET-COMMENT",
  mpf: "SECRET-MPF",
  png: "SECRET-PNG-TEXT",
  gif: "SECRET-GIF",
} as const;

const u16be = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

// ─────────────────────────────────────────────────────────────────────────────
// EXIF (TIFF) block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A little-endian TIFF block: IFD0 with Make, Orientation (when given) and a
 * GPS IFD pointer; the GPS IFD holds GPSLatitudeRef + GPSLatitude.
 */
export function exifTiff(opts: { orientation?: number } = {}): Buffer {
  const make = Buffer.from(`${SECRET.make}\0`, "ascii");
  const entries: Array<{ tag: number; type: number; count: number; value: Buffer }> = [];
  // Offsets: header 8, IFD0 (2 + n*12 + 4), then data.
  const ifd0Count = opts.orientation !== undefined ? 3 : 2;
  const ifd0End = 8 + 2 + ifd0Count * 12 + 4;
  const makeOffset = ifd0End;
  const gpsIfdOffset = makeOffset + make.length + (make.length & 1);
  const gpsIfdEnd = gpsIfdOffset + 2 + 2 * 12 + 4;
  const latOffset = gpsIfdEnd;

  const inline = (n: number, width: 2 | 4): Buffer => {
    const v = Buffer.alloc(4);
    if (width === 2) v.writeUInt16LE(n);
    else v.writeUInt32LE(n);
    return v;
  };
  entries.push({ tag: 0x010f, type: 2, count: make.length, value: inline(makeOffset, 4) });
  if (opts.orientation !== undefined) {
    entries.push({ tag: 0x0112, type: 3, count: 1, value: inline(opts.orientation, 2) });
  }
  entries.push({ tag: 0x8825, type: 4, count: 1, value: inline(gpsIfdOffset, 4) });

  const ifd = (list: typeof entries): Buffer => {
    const out = Buffer.alloc(2 + list.length * 12 + 4);
    out.writeUInt16LE(list.length, 0);
    list.forEach((e, i) => {
      const at = 2 + i * 12;
      out.writeUInt16LE(e.tag, at);
      out.writeUInt16LE(e.type, at + 2);
      out.writeUInt32LE(e.count, at + 4);
      e.value.copy(out, at + 8);
    });
    return out;
  };

  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const gps = ifd([
    { tag: 0x0001, type: 2, count: 2, value: Buffer.from([0x4e, 0, 0, 0]) }, // "N"
    { tag: 0x0002, type: 5, count: 3, value: inline(latOffset, 4) },
  ]);
  const lat = Buffer.alloc(24);
  [12, 1, 34, 1, 5600, 100].forEach((v, i) => lat.writeUInt32LE(v, i * 4));

  return Buffer.concat([
    header,
    ifd(entries),
    make,
    Buffer.alloc(make.length & 1),
    gps,
    lat,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// JPEG
// ─────────────────────────────────────────────────────────────────────────────

export const jpegSegment = (marker: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);

export const SOI = Buffer.from([0xff, 0xd8]);
export const EOI = Buffer.from([0xff, 0xd9]);

export const jfifApp0 = (thumb?: { w: number; h: number }): Buffer => {
  const p = Buffer.alloc(14);
  p.write("JFIF\0", 0, "ascii");
  p[5] = 1;
  p[6] = 2;
  p[7] = 1;
  p.writeUInt16BE(72, 8);
  p.writeUInt16BE(72, 10);
  if (!thumb) return jpegSegment(0xe0, p);
  p[12] = thumb.w;
  p[13] = thumb.h;
  return jpegSegment(0xe0, Buffer.concat([p, Buffer.alloc(3 * thumb.w * thumb.h, 0xaa)]));
};

export const exifApp1 = (orientation?: number): Buffer =>
  jpegSegment(
    0xe1,
    Buffer.concat([Buffer.from("Exif\0\0", "ascii"), exifTiff({ orientation })]),
  );

export const xmpApp1 = (): Buffer =>
  jpegSegment(
    0xe1,
    Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${SECRET.xmp}</x:xmpmeta>`, "ascii"),
  );

export const xmpExtensionApp1 = (): Buffer =>
  jpegSegment(
    0xe1,
    Buffer.from(`http://ns.adobe.com/xmp/extension/\0${"0".repeat(32)}${SECRET.xmp}`, "ascii"),
  );

export const iptcApp13 = (): Buffer =>
  jpegSegment(0xed, Buffer.from(`Photoshop 3.0\x008BIM${SECRET.iptc}`, "ascii"));

export const iccApp2 = (): Buffer =>
  jpegSegment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01fake-icc-profile", "latin1"));

export const mpfApp2 = (): Buffer =>
  jpegSegment(0xe2, Buffer.from(`MPF\0${SECRET.mpf}`, "ascii"));

export const adobeApp14 = (): Buffer =>
  jpegSegment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"));

export const comSegment = (): Buffer =>
  jpegSegment(0xfe, Buffer.from(SECRET.comment, "ascii"));

/** SOFn: precision 8, height, width, one component. */
export const sof = (marker: number, width: number, height: number): Buffer => {
  const p = Buffer.alloc(9);
  p[0] = 8;
  p.writeUInt16BE(height, 1);
  p.writeUInt16BE(width, 3);
  p[5] = 1;
  p[6] = 1;
  p[7] = 0x11;
  p[8] = 0;
  return jpegSegment(marker, p);
};

export const dqt = (): Buffer =>
  jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));

export const dht = (seed = 0): Buffer =>
  jpegSegment(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.from([seed])]));

export const sos = (): Buffer => jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));

/**
 * Entropy-coded filler carrying a stuffed 0xFF (FF 00) and a restart marker
 * (FF D0): both must be read as scan data, not as the end of the scan.
 */
export const scanData = (tag = 0x11): Buffer =>
  Buffer.from([tag, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44, 0xff, 0x00, tag]);

/** The image itself: tables, frame, scan(s), EOI — what must survive byte for byte. */
export function jpegImageData(opts: {
  width?: number;
  height?: number;
  progressive?: boolean;
  tag?: number;
} = {}): Buffer {
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  if (opts.progressive) {
    return Buffer.concat([
      dqt(),
      sof(0xc2, width, height),
      dht(1),
      sos(),
      scanData(opts.tag),
      dht(2), // tables between scans
      sos(),
      scanData((opts.tag ?? 0x11) + 1),
      EOI,
    ]);
  }
  return Buffer.concat([
    dqt(),
    sof(0xc0, width, height),
    dht(),
    sos(),
    scanData(opts.tag),
    EOI,
  ]);
}

/** A bare JPEG: SOI + JFIF + image data. Nothing to strip. */
export const cleanJpeg = (opts: Parameters<typeof jpegImageData>[0] = {}): Buffer =>
  Buffer.concat([SOI, jfifApp0(), jpegImageData(opts)]);

/** A phone-style JPEG: every kind of metadata plus an MPF secondary image. */
export function phoneJpeg(opts: { orientation?: number; progressive?: boolean } = {}): {
  file: Buffer;
  imageData: Buffer;
} {
  const imageData = jpegImageData({ progressive: opts.progressive });
  const secondary = Buffer.concat([
    SOI,
    exifApp1(1),
    comSegment(),
    jpegImageData({ width: 64, height: 48, tag: 0x77 }),
  ]);
  const file = Buffer.concat([
    SOI,
    exifApp1(opts.orientation),
    jfifApp0(),
    mpfApp2(),
    xmpApp1(),
    xmpExtensionApp1(),
    iccApp2(),
    iptcApp13(),
    comSegment(),
    adobeApp14(),
    imageData,
    secondary,
  ]);
  return { file, imageData };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG
// ─────────────────────────────────────────────────────────────────────────────

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

export const ihdr = (width: number, height: number): Buffer => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; // bit depth
  d[9] = 2; // truecolour
  return pngChunk("IHDR", d);
};

export const idat = (): Buffer => pngChunk("IDAT", Buffer.from([0x78, 0x9c, 1, 2, 3, 4]));
export const iend = (): Buffer => pngChunk("IEND", Buffer.alloc(0));

export const cleanPng = (width = 640, height = 480): Buffer =>
  Buffer.concat([PNG_SIGNATURE, ihdr(width, height), pngChunk("sRGB", Buffer.from([0])), idat(), iend()]);

// ─────────────────────────────────────────────────────────────────────────────
// WebP
// ─────────────────────────────────────────────────────────────────────────────

export function webpChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

export function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "ascii");
  return Buffer.concat([head, body]);
}

export const vp8x = (flags: number, width: number, height: number): Buffer => {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(width - 1, 4, 3);
  d.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", d);
};

/** A VP8 keyframe header (start code 9D 01 2A + size) and filler; odd length. */
export const vp8 = (width: number, height: number): Buffer => {
  const d = Buffer.alloc(13, 0x5a);
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  d[3] = 0x9d;
  d[4] = 0x01;
  d[5] = 0x2a;
  d.writeUInt16LE(width, 6);
  d.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", d);
};

// ─────────────────────────────────────────────────────────────────────────────
// GIF
// ─────────────────────────────────────────────────────────────────────────────

/** Logical screen descriptor with a 2-entry global colour table. */
export const gifHeader = (width = 4, height = 3): Buffer => {
  const b = Buffer.alloc(13 + 6);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  b[10] = 0x80; // global colour table, 2 entries
  return b;
};

export const gifImage = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x2c, 0, 0, 0, 0, 4, 0, 3, 0, 0]),
    Buffer.from([2, 3, 0x84, 0x1d, 0x05, 0]), // LZW min code size, one sub-block, terminator
  ]);

export const gifGraphicControl = (): Buffer =>
  Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);

export const gifApplication = (id: string, data: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from(id, "ascii"),
    Buffer.from([data.length]),
    data,
    Buffer.from([0]),
  ]);

export const gifNetscapeLoop = (): Buffer =>
  gifApplication("NETSCAPE2.0", Buffer.from([1, 0, 0]));

export const gifComment = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x21, 0xfe, SECRET.gif.length]),
    Buffer.from(SECRET.gif, "ascii"),
    Buffer.from([0]),
  ]);

export const GIF_TRAILER = Buffer.from([0x3b]);
