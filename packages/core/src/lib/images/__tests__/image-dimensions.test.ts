import { describe, expect, it } from "vitest";

import {
  IMAGE_DIMENSIONS_PREFIX_BYTES,
  readImageDimensions,
} from "../image-dimensions";

// ─── Hand-built headers ─────────────────────────────────────────────────────

const bytes = (...parts: Array<number[] | Buffer>): Buffer =>
  Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function riff(fourcc: string, chunk: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(12 + chunk.length, 4);
  head.write("WEBP", 8, "ascii");
  head.write(fourcc, 12, "ascii");
  head.writeUInt32LE(chunk.length, 16);
  return Buffer.concat([head, chunk]);
}

function webpVp8(width: number, height: number): Buffer {
  const c = Buffer.alloc(10);
  // frame tag (3 bytes, contents irrelevant here), start code 9D 01 2A
  c[3] = 0x9d;
  c[4] = 0x01;
  c[5] = 0x2a;
  // top two bits are the scale hint and must be ignored
  c.writeUInt16LE(width | 0x4000, 6);
  c.writeUInt16LE(height | 0x8000, 8);
  return riff("VP8 ", c);
}

function webpVp8l(width: number, height: number): Buffer {
  const c = Buffer.alloc(5);
  c[0] = 0x2f;
  c.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return riff("VP8L", c);
}

function webpVp8x(width: number, height: number): Buffer {
  const c = Buffer.alloc(10);
  c.writeUIntLE(width - 1, 4, 3);
  c.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", c);
}

/** A JPEG marker segment: FF <marker> <u16 length incl. itself> <payload>. */
function segment(marker: number, payload: Buffer | number[]): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(p.length + 2, 2);
  return Buffer.concat([head, p]);
}

function sof(marker: number, width: number, height: number): Buffer {
  const p = Buffer.alloc(6);
  p[0] = 8; // precision
  p.writeUInt16BE(height, 1);
  p.writeUInt16BE(width, 3);
  p[5] = 0; // component count (not read)
  return segment(marker, p);
}

/** APP1 "Exif\0\0" + TIFF with a single IFD0 entry: Orientation (SHORT). */
function exifApp1(orientation: number, endian: "II" | "MM" = "II"): Buffer {
  const le = endian === "II";
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(endian, 0, "ascii");
  const w16 = (v: number, at: number) =>
    le ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at);
  const w32 = (v: number, at: number) =>
    le ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at);
  w16(42, 2);
  w32(8, 4); // IFD0 offset
  w16(1, 8); // entry count
  w16(0x0112, 10); // tag: Orientation
  w16(3, 12); // type: SHORT
  w32(1, 14); // count
  w16(orientation, 18); // value (left-justified in the 4-byte field)
  return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]));
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "binary"));
const DQT = segment(0xdb, Buffer.alloc(65));
const DHT = segment(0xc4, Buffer.alloc(20)); // in the C0-CF range, NOT a SOF
const SOS = segment(0xda, Buffer.alloc(10));

function jpeg(...middle: Buffer[]): Buffer {
  return bytes(SOI, ...middle, SOS, Buffer.alloc(32), EOI);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("readImageDimensions", () => {
  it("PNG: reads IHDR", () => {
    expect(readImageDimensions(png(1200, 1800))).toEqual({
      width: 1200,
      height: 1800,
    });
  });

  it("GIF: reads the logical screen", () => {
    expect(readImageDimensions(gif(320, 240))).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("WebP: VP8 (lossy), ignoring the scale bits", () => {
    expect(readImageDimensions(webpVp8(1024, 768))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("WebP: VP8L (lossless)", () => {
    expect(readImageDimensions(webpVp8l(400, 600))).toEqual({
      width: 400,
      height: 600,
    });
    expect(readImageDimensions(webpVp8l(16384, 16384))).toEqual({
      width: 16384,
      height: 16384,
    });
  });

  it("WebP: VP8X (extended) canvas size", () => {
    expect(readImageDimensions(webpVp8x(3000, 4000))).toEqual({
      width: 3000,
      height: 4000,
    });
  });

  describe("JPEG", () => {
    it("walks past APP0/DQT/DHT to SOF0", () => {
      expect(readImageDimensions(jpeg(JFIF, DQT, DHT, sof(0xc0, 800, 600)))).toEqual(
        { width: 800, height: 600 },
      );
    });

    it("reads a progressive frame (SOF2)", () => {
      expect(readImageDimensions(jpeg(JFIF, sof(0xc2, 1080, 1350)))).toEqual({
        width: 1080,
        height: 1350,
      });
    });

    it("does not mistake DHT (C4), JPG (C8) or DAC (CC) for a frame header", () => {
      // Each of these carries bytes that WOULD parse as a 1x1 frame.
      const fake = (m: number) => segment(m, [8, 0, 1, 0, 1, 0]);
      expect(
        readImageDimensions(
          jpeg(fake(0xc4), fake(0xc8), fake(0xcc), sof(0xc0, 640, 480)),
        ),
      ).toEqual({ width: 640, height: 480 });
    });

    it("skips 0xFF fill bytes before a marker", () => {
      const filled = bytes(SOI, [0xff, 0xff, 0xff], JFIF, sof(0xc0, 50, 70));
      expect(readImageDimensions(filled)).toEqual({ width: 50, height: 70 });
    });

    it("EXIF orientation 6 (rotate 90 CW) swaps width and height", () => {
      // Stored 4032x3024 landscape; a phone held upright. Browsers show it
      // 3024 wide by 4032 tall.
      expect(
        readImageDimensions(jpeg(exifApp1(6), sof(0xc0, 4032, 3024))),
      ).toEqual({ width: 3024, height: 4032 });
    });

    it("EXIF orientation 6 in big-endian (MM) TIFF swaps too", () => {
      expect(
        readImageDimensions(jpeg(exifApp1(6, "MM"), sof(0xc0, 4032, 3024))),
      ).toEqual({ width: 3024, height: 4032 });
    });

    it.each([5, 7, 8])("EXIF orientation %i swaps", (o) => {
      expect(readImageDimensions(jpeg(exifApp1(o), sof(0xc0, 200, 100)))).toEqual(
        { width: 100, height: 200 },
      );
    });

    it.each([1, 2, 3, 4])("EXIF orientation %i keeps the stored shape", (o) => {
      expect(readImageDimensions(jpeg(exifApp1(o), sof(0xc0, 200, 100)))).toEqual(
        { width: 200, height: 100 },
      );
    });

    it("an out-of-range orientation is ignored, not trusted", () => {
      expect(readImageDimensions(jpeg(exifApp1(9), sof(0xc0, 200, 100)))).toEqual(
        { width: 200, height: 100 },
      );
    });

    it("finds a SOF behind ~200 KB of ICC/APP2 segments", () => {
      const icc = Array.from({ length: 3 }, () =>
        segment(0xe2, Buffer.alloc(65_000)),
      );
      const file = jpeg(JFIF, ...icc, sof(0xc0, 2000, 3000));
      expect(file.length).toBeGreaterThan(195_000);
      expect(file.length).toBeLessThan(IMAGE_DIMENSIONS_PREFIX_BYTES);
      expect(
        readImageDimensions(file.subarray(0, IMAGE_DIMENSIONS_PREFIX_BYTES)),
      ).toEqual({ width: 2000, height: 3000 });
    });

    it("truncated before the SOF → null", () => {
      const file = jpeg(JFIF, DQT, sof(0xc0, 800, 600));
      const sofAt = 2 + JFIF.length + DQT.length;
      expect(readImageDimensions(file.subarray(0, sofAt))).toBeNull();
      // Cut INSIDE the SOF segment, after its length but before the width.
      expect(readImageDimensions(file.subarray(0, sofAt + 6))).toBeNull();
    });

    it("start-of-scan with no frame header → null", () => {
      expect(readImageDimensions(bytes(SOI, JFIF, SOS, EOI))).toBeNull();
    });

    it("a zero height (defined later by DNL) → null", () => {
      expect(readImageDimensions(jpeg(sof(0xc0, 800, 0)))).toBeNull();
    });

    it("lost marker sync → null", () => {
      expect(readImageDimensions(bytes(SOI, [0x12, 0x34, 0x56]))).toBeNull();
    });

    it("a segment length below 2 → null (no infinite loop)", () => {
      expect(readImageDimensions(bytes(SOI, [0xff, 0xe0, 0x00, 0x01]))).toBeNull();
    });

    it("a truncated EXIF block does not throw and leaves orientation alone", () => {
      const app1 = exifApp1(6);
      // Claim the full length but cut the IFD short, then a real SOF.
      const broken = segment(0xe1, app1.subarray(4, 4 + 12));
      expect(readImageDimensions(jpeg(broken, sof(0xc0, 200, 100)))).toEqual({
        width: 200,
        height: 100,
      });
    });
  });

  describe("returns null, never throws", () => {
    it.each([
      ["empty", Buffer.alloc(0)],
      ["garbage", Buffer.from("definitely not an image")],
      ["PNG signature only", png(10, 10).subarray(0, 8)],
      ["PNG cut inside IHDR", png(10, 10).subarray(0, 20)],
      ["GIF cut short", gif(10, 10).subarray(0, 8)],
      ["RIFF that is not WEBP", Buffer.from("RIFF\0\0\0\0WAVEfmt ")],
      ["WebP VP8 cut short", webpVp8(10, 10).subarray(0, 27)],
      ["WebP VP8 bad start code", (() => {
        const b = webpVp8(10, 10);
        b[23] = 0;
        return b;
      })()],
      ["WebP VP8L bad signature", (() => {
        const b = webpVp8l(10, 10);
        b[20] = 0;
        return b;
      })()],
      ["WebP VP8X cut short", webpVp8x(10, 10).subarray(0, 28)],
      ["SOI only", Buffer.from(SOI)],
      ["PNG with a zero width", png(0, 10)],
    ])("%s", (_name, input) => {
      expect(readImageDimensions(input)).toBeNull();
    });

    it("accepts a plain Uint8Array, not just a Buffer", () => {
      expect(readImageDimensions(new Uint8Array(gif(7, 9)))).toEqual({
        width: 7,
        height: 9,
      });
    });

    it("respects a subarray's byteOffset", () => {
      const padded = Buffer.concat([Buffer.alloc(5, 0xaa), gif(7, 9)]);
      expect(readImageDimensions(padded.subarray(5))).toEqual({
        width: 7,
        height: 9,
      });
    });
  });
});
