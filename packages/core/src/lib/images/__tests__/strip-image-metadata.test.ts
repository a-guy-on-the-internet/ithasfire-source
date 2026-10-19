import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { readImageDimensions } from "../image-dimensions";
import {
  ImageMetadataStripError,
  MAX_IMAGE_STRUCTURES,
  MAX_REMOVED_LABELS,
  stripImageMetadata,
} from "../strip-image-metadata";
import {
  EOI,
  GIF_TRAILER,
  PNG_SIGNATURE,
  SECRET,
  SOI,
  cleanJpeg,
  adobeApp14,
  cleanPng,
  exifApp1,
  exifTiff,
  gifApplication,
  gifComment,
  gifGraphicControl,
  gifHeader,
  gifImage,
  gifNetscapeLoop,
  iccApp2,
  idat,
  iend,
  ihdr,
  jfifApp0,
  jpegImageData,
  sof,
  jpegSegment,
  phoneJpeg,
  pngChunk,
  riff,
  vp8,
  vp8x,
  webpChunk,
} from "./image-fixtures";

const has = (haystack: Buffer, needle: string | Buffer): boolean =>
  haystack.includes(typeof needle === "string" ? Buffer.from(needle, "latin1") : needle);

/** Every sentinel the phone fixtures plant, plus the GPS IFD's tag bytes. */
function expectNoSecrets(out: Buffer): void {
  for (const secret of Object.values(SECRET)) {
    expect(has(out, secret), `found ${secret}`).toBe(false);
  }
}

/** The EXIF APP1 segments in a JPEG (walks markers up to SOS). */
function jpegExifSegments(b: Buffer): Buffer[] {
  const found: Buffer[] = [];
  let at = 2;
  while (at < b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    if (marker === 0xda) break;
    const len = b.readUInt16BE(at + 2);
    const seg = b.subarray(at, at + 2 + len);
    if (marker === 0xe1 && seg.subarray(4, 10).toString("latin1") === "Exif\0\0") {
      found.push(seg);
    }
    at += 2 + len;
  }
  return found;
}

/** Tags in IFD0 of a big- or little-endian TIFF block. */
function ifd0Tags(tiff: Buffer): Array<{ tag: number; value: number }> {
  const le = tiff.subarray(0, 2).toString("latin1") === "II";
  const r16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const r32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = r32(4);
  const count = r16(ifd);
  const tags: Array<{ tag: number; value: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const e = ifd + 2 + i * 12;
    tags.push({ tag: r16(e), value: r16(e + 8) });
  }
  // No IFD1 (and so no thumbnail).
  expect(r32(ifd + 2 + count * 12)).toBe(0);
  return tags;
}

describe("stripImageMetadata — JPEG", () => {
  it("drops EXIF/GPS, XMP, IPTC, COM, MPF and the appended secondary image", () => {
    const { file, imageData } = phoneJpeg();
    const { bytes, removed } = stripImageMetadata(file, "image/jpeg");

    expectNoSecrets(bytes);
    expect(removed).toEqual(
      expect.arrayContaining([
        "APP1:Exif",
        "APP2:MPF",
        "APP1:XMP",
        "APP1:XMP-extension",
        "APP13:Photoshop",
        "COM",
        expect.stringMatching(/^trailing data/),
      ]),
    );
    // No orientation in the source → no EXIF at all in the output.
    expect(jpegExifSegments(bytes)).toHaveLength(0);
    // SOI, JFIF, ICC, Adobe, then the image data byte for byte, ending at the
    // primary image's EOI.
    expect(bytes).toEqual(
      Buffer.concat([
        SOI,
        jfifApp0(),
        iccApp2(),
        adobeApp14(),
        imageData,
      ]),
    );
    expect(bytes.subarray(-2)).toEqual(EOI);
  });

  it("keeps orientation 6 as the ONLY EXIF tag, right after SOI/APP0", () => {
    const { file, imageData } = phoneJpeg({ orientation: 6 });
    const { bytes } = stripImageMetadata(file, "image/jpeg");

    expectNoSecrets(bytes);
    const exif = jpegExifSegments(bytes);
    expect(exif).toHaveLength(1);
    expect(ifd0Tags(exif[0]!.subarray(10))).toEqual([{ tag: 0x0112, value: 6 }]);
    // Order: SOI, JFIF APP0 (it was the first kept segment), then the EXIF.
    expect(bytes.subarray(0, 2)).toEqual(SOI);
    expect(bytes.subarray(2, 2 + jfifApp0().length)).toEqual(jfifApp0());
    expect(bytes.subarray(2 + jfifApp0().length, 2 + jfifApp0().length + 4)).toEqual(
      Buffer.from([0xff, 0xe1, 0x00, 34]),
    );
    expect(bytes.subarray(-imageData.length)).toEqual(imageData);
    // The dimension reader still swaps width/height for the quarter turn.
    expect(readImageDimensions(bytes)).toEqual({ width: 480, height: 640 });
  });

  it("drops orientation 1 entirely (it is the default)", () => {
    const file = Buffer.concat([SOI, exifApp1(1), jpegImageData()]);
    const { bytes } = stripImageMetadata(file, "image/jpeg");
    expect(bytes).toEqual(Buffer.concat([SOI, jpegImageData()]));
  });

  it("handles a progressive JPEG: several scans with tables between them", () => {
    const { file, imageData } = phoneJpeg({ orientation: 8, progressive: true });
    const { bytes } = stripImageMetadata(file, "image/jpeg");

    expectNoSecrets(bytes);
    expect(bytes.subarray(-imageData.length)).toEqual(imageData);
    expect(ifd0Tags(jpegExifSegments(bytes)[0]!.subarray(10))).toEqual([
      { tag: 0x0112, value: 8 },
    ]);
  });

  it("does not mistake stuffed 0xFF or restart markers in scan data for the end", () => {
    // scanData() carries FF 00 and FF D0; an EOI-looking pair inside a
    // segment payload must not end anything either.
    const file = Buffer.concat([
      SOI,
      jpegSegment(0xfe, Buffer.from([0xff, 0xd9, 0xff, 0xd8])),
      jpegImageData(),
      Buffer.from("junk"),
    ]);
    const { bytes } = stripImageMetadata(file, "image/jpeg");
    expect(bytes).toEqual(Buffer.concat([SOI, jpegImageData()]));
  });

  it("removes a JFIF embedded thumbnail", () => {
    const file = Buffer.concat([SOI, jfifApp0({ w: 2, h: 2 }), jpegImageData()]);
    const { bytes, removed } = stripImageMetadata(file, "image/jpeg");
    expect(removed).toEqual(["APP0:JFIF-thumbnail"]);
    expect(bytes).toEqual(Buffer.concat([SOI, jfifApp0(), jpegImageData()]));
  });

  it("returns a clean file unchanged", () => {
    const file = cleanJpeg();
    const { bytes, removed } = stripImageMetadata(file, "image/jpeg");
    expect(removed).toEqual([]);
    expect(bytes).toEqual(file);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["garbage", Buffer.from("definitely not a jpeg")],
    ["no EOI", Buffer.concat([SOI, jpegImageData()]).subarray(0, -2)],
    ["cut mid-segment", Buffer.concat([SOI, exifApp1(6)]).subarray(0, 20)],
    ["cut mid-scan", Buffer.concat([SOI, jpegImageData()]).subarray(0, -6)],
    ["EOI before image data", Buffer.concat([SOI, jfifApp0(), EOI])],
    ["segment length below 2", Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), EOI])],
    ["restart marker outside scan data", Buffer.concat([SOI, Buffer.from([0xff, 0xd0]), jpegImageData()])],
    ["junk with no further marker", Buffer.concat([SOI, Buffer.from("junk")])],
  ])("throws on a malformed JPEG (%s)", (_label, file) => {
    expect(() => stripImageMetadata(file, "image/jpeg")).toThrow(ImageMetadataStripError);
  });

  it("throws when the bytes do not match the declared type", () => {
    expect(() => stripImageMetadata(cleanPng(), "image/jpeg")).toThrow(
      ImageMetadataStripError,
    );
    expect(() => stripImageMetadata(cleanJpeg(), "image/png")).toThrow(
      ImageMetadataStripError,
    );
  });

  it("throws on an unsupported content type", () => {
    expect(() => stripImageMetadata(cleanJpeg(), "image/svg+xml")).toThrow(
      /unsupported content type/,
    );
  });

  it("accepts content-type parameters and case", () => {
    expect(stripImageMetadata(cleanJpeg(), "Image/JPEG; charset=binary").removed).toEqual(
      [],
    );
  });
});

describe("stripImageMetadata — PNG", () => {
  const text = (type: string, body: string) => pngChunk(type, Buffer.from(body, "latin1"));

  it("drops tEXt, zTXt, iTXt, tIME, eXIf and unknown chunks; keeps the image", () => {
    const file = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(640, 480),
      text("tEXt", `Comment\0${SECRET.png}`),
      text("iTXt", `XML:com.adobe.xmp\0\0\0\0\0${SECRET.xmp}`),
      text("zTXt", `Raw\0\0${SECRET.png}`),
      pngChunk("eXIf", exifTiff()),
      pngChunk("tIME", Buffer.alloc(7)),
      text("prVt", SECRET.png),
      pngChunk("sRGB", Buffer.from([0])),
      pngChunk("pHYs", Buffer.alloc(9)),
      idat(),
      iend(),
      Buffer.from("trailing"),
    ]);
    const { bytes, removed } = stripImageMetadata(file, "image/png");

    expectNoSecrets(bytes);
    expect(removed).toEqual([
      "PNG:tEXt",
      "PNG:iTXt",
      "PNG:zTXt",
      "PNG:eXIf",
      "PNG:tIME",
      "PNG:prVt",
      "trailing data (8 bytes)",
    ]);
    expect(bytes).toEqual(
      Buffer.concat([
        PNG_SIGNATURE,
        ihdr(640, 480),
        pngChunk("sRGB", Buffer.from([0])),
        pngChunk("pHYs", Buffer.alloc(9)),
        idat(),
        iend(),
      ]),
    );
  });

  it("replaces eXIf with an orientation-only eXIf carrying a correct CRC", () => {
    const file = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(10, 20),
      pngChunk("eXIf", exifTiff({ orientation: 6 })),
      idat(),
      iend(),
    ]);
    const { bytes } = stripImageMetadata(file, "image/png");

    expectNoSecrets(bytes);
    const at = PNG_SIGNATURE.length + ihdr(10, 20).length;
    const length = bytes.readUInt32BE(at);
    expect(bytes.subarray(at + 4, at + 8).toString("latin1")).toBe("eXIf");
    const data = bytes.subarray(at + 8, at + 8 + length);
    expect(ifd0Tags(data)).toEqual([{ tag: 0x0112, value: 6 }]);
    expect(bytes.readUInt32BE(at + 8 + length)).toBe(
      crc32(bytes.subarray(at + 4, at + 8 + length)),
    );
  });

  it("returns a clean file unchanged", () => {
    const file = cleanPng();
    expect(stripImageMetadata(file, "image/png")).toEqual({
      bytes: file,
      removed: [],
      removedCount: 0,
    });
  });

  it.each([
    ["bad signature", Buffer.from("not a png at all")],
    ["no IEND", Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), idat()])],
    ["IHDR not first", Buffer.concat([PNG_SIGNATURE, idat(), ihdr(1, 1), iend()])],
    ["no IDAT", Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), iend()])],
    ["chunk past end", Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), idat()]).subarray(0, -3)],
    [
      "huge length",
      Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("IDAT")]),
    ],
    ["binary chunk type", Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), Buffer.from([0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0])])],
  ])("throws on a malformed PNG (%s)", (_label, file) => {
    expect(() => stripImageMetadata(file, "image/png")).toThrow(ImageMetadataStripError);
  });
});

describe("stripImageMetadata — WebP", () => {
  const ICC = 0x20;
  const EXIF = 0x08;
  const XMP = 0x04;

  it("drops EXIF and XMP, clears their VP8X flags and fixes the RIFF size", () => {
    const file = riff([
      vp8x(ICC | EXIF | XMP, 640, 480),
      webpChunk("ICCP", Buffer.from("fake-icc")),
      vp8(640, 480),
      webpChunk("EXIF", exifTiff()),
      webpChunk("XMP ", Buffer.from(`<x:xmpmeta>${SECRET.xmp}</x:xmpmeta>`)),
      webpChunk("ZZZZ", Buffer.from(SECRET.png)),
    ]);
    const { bytes, removed } = stripImageMetadata(file, "image/webp");

    expectNoSecrets(bytes);
    expect(removed).toEqual(["WebP:EXIF", "WebP:XMP", "WebP:ZZZZ"]);
    const expected = riff([
      vp8x(ICC, 640, 480),
      webpChunk("ICCP", Buffer.from("fake-icc")),
      vp8(640, 480),
    ]);
    expect(bytes).toEqual(expected);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(readImageDimensions(bytes)).toEqual({ width: 640, height: 480 });
  });

  it("keeps an orientation-only EXIF chunk and its flag when orientation ≠ 1", () => {
    const file = riff([
      vp8x(EXIF | XMP, 64, 48),
      vp8(64, 48),
      webpChunk("EXIF", Buffer.concat([Buffer.from("Exif\0\0"), exifTiff({ orientation: 3 })])),
      webpChunk("XMP ", Buffer.from(SECRET.xmp)),
    ]);
    const { bytes } = stripImageMetadata(file, "image/webp");

    expectNoSecrets(bytes);
    expect(bytes[20]).toBe(EXIF); // VP8X flags: EXIF kept, XMP cleared
    const exifAt = bytes.indexOf(Buffer.from("EXIF"));
    const size = bytes.readUInt32LE(exifAt + 4);
    expect(ifd0Tags(bytes.subarray(exifAt + 8, exifAt + 8 + size))).toEqual([
      { tag: 0x0112, value: 3 },
    ]);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  });

  it("returns a clean simple-format file unchanged", () => {
    const file = riff([vp8(32, 32)]);
    expect(stripImageMetadata(file, "image/webp")).toEqual({
      bytes: file,
      removed: [],
      removedCount: 0,
    });
  });

  it.each([
    ["bad header", Buffer.from("RIFX....WEBP")],
    ["RIFF size past end", riff([vp8(1, 1)]).subarray(0, -4)],
    ["chunk past RIFF end", (() => {
      const f = riff([vp8(1, 1)]);
      f.writeUInt32LE(9999, 16);
      return f;
    })()],
    ["no image chunk", riff([vp8x(0, 1, 1)])],
    ["unknown first chunk", riff([webpChunk("EXIF", exifTiff()), vp8(1, 1)])],
  ])("throws on a malformed WebP (%s)", (_label, file) => {
    expect(() => stripImageMetadata(file, "image/webp")).toThrow(ImageMetadataStripError);
  });
});

describe("stripImageMetadata — GIF", () => {
  it("drops comments and the XMP application extension; keeps the loop", () => {
    const xmp = gifApplication("XMP DataXMP", Buffer.from(SECRET.xmp));
    const file = Buffer.concat([
      gifHeader(),
      gifNetscapeLoop(),
      gifComment(),
      gifGraphicControl(),
      gifImage(),
      xmp,
      gifApplication("OTHERAPP1.0", Buffer.from("x")),
      gifGraphicControl(),
      gifImage(),
      GIF_TRAILER,
      Buffer.from("tail"),
    ]);
    const { bytes, removed } = stripImageMetadata(file, "image/gif");

    expectNoSecrets(bytes);
    expect(removed).toEqual([
      "GIF:comment",
      "GIF:application:XMP DataXMP",
      "GIF:application:OTHERAPP1.0",
      "trailing data (4 bytes)",
    ]);
    expect(bytes).toEqual(
      Buffer.concat([
        gifHeader(),
        gifNetscapeLoop(),
        gifGraphicControl(),
        gifImage(),
        gifGraphicControl(),
        gifImage(),
        GIF_TRAILER,
      ]),
    );
  });

  it("returns a clean file unchanged", () => {
    const file = Buffer.concat([gifHeader(), gifImage(), GIF_TRAILER]);
    expect(stripImageMetadata(file, "image/gif")).toEqual({
      bytes: file,
      removed: [],
      removedCount: 0,
    });
  });

  it.each([
    ["bad signature", Buffer.from("GIF90a")],
    ["no trailer", Buffer.concat([gifHeader(), gifImage()])],
    ["cut sub-block", Buffer.concat([gifHeader(), gifImage()]).subarray(0, -3)],
    ["unknown block", Buffer.concat([gifHeader(), Buffer.from([0x99]), GIF_TRAILER])],
    ["trailer before image", Buffer.concat([gifHeader(), GIF_TRAILER])],
    ["colour table past end", gifHeader().subarray(0, 15)],
  ])("throws on a malformed GIF (%s)", (_label, file) => {
    expect(() => stripImageMetadata(file, "image/gif")).toThrow(ImageMetadataStripError);
  });
});

describe("stripImageMetadata — hardening", () => {
  it("skips junk bytes between JPEG segments without copying them", () => {
    const file = Buffer.concat([
      SOI,
      Buffer.from("SECRET-JUNK"),
      jfifApp0(),
      Buffer.from([0xff, 0x00]), // a stuffed byte outside scan data is junk too
      jpegImageData(),
    ]);
    const { bytes, removed } = stripImageMetadata(file, "image/jpeg");
    expect(bytes).toEqual(Buffer.concat([SOI, jfifApp0(), jpegImageData()]));
    expect(has(bytes, "SECRET-JUNK")).toBe(false);
    expect(removed).toEqual(["junk (11 bytes)", "junk (2 bytes)"]);
  });

  it("drops reserved JPGn markers but keeps JPEG-LS F7", () => {
    const jpg0 = jpegSegment(0xf0, Buffer.from("hidden"));
    const sof55 = jpegSegment(0xf7, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
    const file = Buffer.concat([SOI, jpg0, sof55, jpegImageData()]);
    const { bytes, removed } = stripImageMetadata(file, "image/jpeg");
    expect(removed).toEqual(["JPG0"]);
    expect(bytes).toEqual(Buffer.concat([SOI, sof55, jpegImageData()]));
  });

  it("cuts APP14 Adobe to its 12-byte payload", () => {
    const long = jpegSegment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01EXTRA-BYTES", "latin1"));
    const { bytes, removed } = stripImageMetadata(
      Buffer.concat([SOI, long, jpegImageData()]),
      "image/jpeg",
    );
    expect(removed).toEqual(["APP14:Adobe-extra"]);
    expect(bytes).toEqual(Buffer.concat([SOI, adobeApp14(), jpegImageData()]));
  });

  it("drops GIF plain-text extensions", () => {
    const plainText = Buffer.concat([
      Buffer.from([0x21, 0x01, 12]),
      Buffer.alloc(12),
      Buffer.from([4]),
      Buffer.from("text"),
      Buffer.from([0]),
    ]);
    const file = Buffer.concat([gifHeader(), plainText, gifImage(), GIF_TRAILER]);
    const { bytes, removed } = stripImageMetadata(file, "image/gif");
    expect(removed).toEqual(["GIF:plain-text"]);
    expect(bytes).toEqual(Buffer.concat([gifHeader(), gifImage(), GIF_TRAILER]));
  });

  it("keeps only ALPH/VP8/VP8L inside a WebP ANMF frame", () => {
    const frameHeader = Buffer.alloc(16, 0x01);
    const anmf = (...subs: Buffer[]) => webpChunk("ANMF", Buffer.concat([frameHeader, ...subs]));
    const file = riff([
      vp8x(0x02, 32, 32),
      webpChunk("ANIM", Buffer.alloc(6)),
      anmf(vp8(32, 32), webpChunk("XMP ", Buffer.from(SECRET.xmp))),
      anmf(webpChunk("ALPH", Buffer.from([1, 2, 3])), vp8(32, 32)),
    ]);
    const { bytes, removed } = stripImageMetadata(file, "image/webp");
    expectNoSecrets(bytes);
    expect(removed).toEqual(["WebP:ANMF:XMP"]);
    expect(bytes).toEqual(
      riff([
        vp8x(0x02, 32, 32),
        webpChunk("ANIM", Buffer.alloc(6)),
        anmf(vp8(32, 32)),
        anmf(webpChunk("ALPH", Buffer.from([1, 2, 3])), vp8(32, 32)),
      ]),
    );
  });

  it("throws on an ANMF frame with no image", () => {
    const file = riff([vp8x(0x02, 8, 8), webpChunk("ANMF", Buffer.alloc(16))]);
    expect(() => stripImageMetadata(file, "image/webp")).toThrow(ImageMetadataStripError);
  });

  it("emits the WebP orientation chunk at most once", () => {
    const exif = webpChunk("EXIF", exifTiff({ orientation: 6 }));
    const { bytes } = stripImageMetadata(
      riff([vp8x(0x08, 8, 8), vp8(8, 8), exif, exif]),
      "image/webp",
    );
    expect(bytes.toString("latin1").split("EXIF").length - 1).toBe(1);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  });

  it("adds the pad byte a last odd-sized WebP chunk left off", () => {
    // vp8() is 13 bytes (odd); cut its pad, and drop an XMP before it.
    const body = Buffer.concat([vp8x(0x04, 8, 8), webpChunk("XMP ", Buffer.from("xx")), vp8(8, 8)]);
    const unpadded = body.subarray(0, -1);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(4 + unpadded.length, 4);
    head.write("WEBP", 8, "ascii");
    const { bytes } = stripImageMetadata(Buffer.concat([head, unpadded]), "image/webp");
    expect(bytes).toEqual(riff([vp8x(0, 8, 8), vp8(8, 8)]));
  });

  it("keeps the first labels and counts the rest", () => {
    const texts = Array.from({ length: 100 }, () =>
      pngChunk("tEXt", Buffer.from("k\0v", "latin1")),
    );
    const file = Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), ...texts, idat(), iend()]);
    const { removed, removedCount } = stripImageMetadata(file, "image/png");
    expect(removed).toHaveLength(MAX_REMOVED_LABELS);
    expect(removedCount).toBe(100);
  });

  it("drops reserved RES markers (02–BF) outside scan data", () => {
    const res02 = jpegSegment(0x02, Buffer.from("hidden-02"));
    const resBf = jpegSegment(0xbf, Buffer.from("hidden-bf"));
    const file = Buffer.concat([SOI, res02, jfifApp0(), resBf, jpegImageData()]);
    const { bytes, removed } = stripImageMetadata(file, "image/jpeg");
    expect(removed).toEqual(["RES:0x02", "RES:0xbf"]);
    expect(bytes).toEqual(Buffer.concat([SOI, jfifApp0(), jpegImageData()]));
    expect(has(bytes, "hidden")).toBe(false);
  });

  it("emits the PNG orientation eXIf at most once", () => {
    const exif = pngChunk("eXIf", exifTiff({ orientation: 6 }));
    const file = Buffer.concat([PNG_SIGNATURE, ihdr(1, 1), exif, exif, exif, idat(), iend()]);
    const { bytes, removedCount } = stripImageMetadata(file, "image/png");
    expect(removedCount).toBe(3);
    expect(bytes.toString("latin1").split("eXIf").length - 1).toBe(1);
  });

  it("cuts a GIF graphic-control extension to its one 4-byte sub-block", () => {
    const gce = Buffer.concat([
      Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0]),
      Buffer.from([6]),
      Buffer.from("HIDDEN"),
      Buffer.from([0]),
    ]);
    const file = Buffer.concat([gifHeader(), gce, gifImage(), GIF_TRAILER]);
    const { bytes, removed } = stripImageMetadata(file, "image/gif");
    expect(removed).toEqual(["GIF:graphic-control-extra"]);
    expect(bytes).toEqual(
      Buffer.concat([gifHeader(), gifGraphicControl(), gifImage(), GIF_TRAILER]),
    );
  });

  it("drops a GIF graphic-control extension whose first sub-block is not 4 bytes", () => {
    const gce = Buffer.from([0x21, 0xf9, 2, 0, 0, 0]);
    const file = Buffer.concat([gifHeader(), gce, gifImage(), GIF_TRAILER]);
    const { bytes, removed } = stripImageMetadata(file, "image/gif");
    expect(removed).toEqual(["GIF:graphic-control-malformed"]);
    expect(bytes).toEqual(Buffer.concat([gifHeader(), gifImage(), GIF_TRAILER]));
  });

  it("cuts NETSCAPE2.0 to its loop sub-block", () => {
    const loopPlus = Buffer.concat([
      Buffer.from([0x21, 0xff, 11]),
      Buffer.from("NETSCAPE2.0", "ascii"),
      Buffer.from([3, 1, 0, 0]),
      Buffer.from([6]),
      Buffer.from("HIDDEN"),
      Buffer.from([0]),
    ]);
    const file = Buffer.concat([gifHeader(), loopPlus, gifImage(), GIF_TRAILER]);
    const { bytes, removed } = stripImageMetadata(file, "image/gif");
    expect(removed).toEqual(["GIF:application:NETSCAPE2.0-extra"]);
    expect(bytes).toEqual(
      Buffer.concat([gifHeader(), gifNetscapeLoop(), gifImage(), GIF_TRAILER]),
    );
  });

  it("drops NETSCAPE2.0 whose first sub-block is neither loop nor buffer sized", () => {
    const odd = gifApplication("NETSCAPE2.0", Buffer.from("HIDDEN-PAYLOAD"));
    const file = Buffer.concat([gifHeader(), odd, gifImage(), GIF_TRAILER]);
    const { bytes, removed } = stripImageMetadata(file, "image/gif");
    expect(removed).toEqual(["GIF:application:NETSCAPE2.0-malformed"]);
    expect(bytes).toEqual(Buffer.concat([gifHeader(), gifImage(), GIF_TRAILER]));
  });

  // GIF visits one structure per GCE, plus the image and the trailer.
  const gcesFile = (n: number): Buffer => {
    const gces = Buffer.alloc(8 * n);
    for (let i = 0; i < n; i += 1) gifGraphicControl().copy(gces, i * 8);
    return Buffer.concat([gifHeader(), gces, gifImage(), GIF_TRAILER]);
  };

  it("accepts a file exactly at the structure cap", () => {
    const file = gcesFile(MAX_IMAGE_STRUCTURES - 2);
    expect(stripImageMetadata(file, "image/gif").removedCount).toBe(0);
  });

  it("refuses a file one structure over the cap", () => {
    const file = gcesFile(MAX_IMAGE_STRUCTURES - 1);
    expect(() => stripImageMetadata(file, "image/gif")).toThrow(/too many segments/);
  });

  // Security F1 (fix round 1): each of these, at 25 MB, used to take the
  // process past 1 GB — one view object (or Buffer) per tiny structure. The
  // structure cap now throws long before that.
  describe("memory-attack shapes throw instead of allocating per structure", () => {
    const N = MAX_IMAGE_STRUCTURES + 10;
    const repeat = (unit: Buffer, n: number): Buffer => {
      const out = Buffer.alloc(unit.length * n);
      for (let i = 0; i < n; i += 1) unit.copy(out, i * unit.length);
      return out;
    };

    it("JPEG: SOI + repeated RST markers", () => {
      const file = Buffer.concat([SOI, repeat(Buffer.from([0xff, 0xd0]), N)]);
      expect(() => stripImageMetadata(file, "image/jpeg")).toThrow(
        /standalone marker outside scan data/,
      );
    });

    it("JPEG: repeated empty DHT segments", () => {
      const file = Buffer.concat([
        SOI,
        sof(0xc0, 8, 8),
        repeat(Buffer.from([0xff, 0xc4, 0x00, 0x02]), N),
        EOI,
      ]);
      expect(() => stripImageMetadata(file, "image/jpeg")).toThrow(/too many segments/);
    });

    it("JPEG: junk resyncs count toward the cap", () => {
      const file = Buffer.concat([SOI, repeat(Buffer.from([0x00, 0xff, 0x00]), N)]);
      expect(() => stripImageMetadata(file, "image/jpeg")).toThrow(/too many segments/);
    });

    it("GIF: repeated empty graphic-control extensions", () => {
      const file = Buffer.concat([
        gifHeader(),
        repeat(gifGraphicControl(), N),
        gifImage(),
        GIF_TRAILER,
      ]);
      expect(() => stripImageMetadata(file, "image/gif")).toThrow(/too many segments/);
    });

    it("WebP: repeated empty ICCP chunks", () => {
      const file = riff([vp8x(0x20, 8, 8), repeat(webpChunk("ICCP", Buffer.alloc(0)), N), vp8(8, 8)]);
      expect(() => stripImageMetadata(file, "image/webp")).toThrow(/too many segments/);
    });

    it("WebP: repeated empty sub-chunks inside one ANMF", () => {
      const file = riff([
        vp8x(0x02, 8, 8),
        webpChunk("ANMF", Buffer.concat([Buffer.alloc(16), repeat(webpChunk("ZZZZ", Buffer.alloc(0)), N)])),
      ]);
      expect(() => stripImageMetadata(file, "image/webp")).toThrow(/too many segments/);
    });

    it("PNG: repeated empty ancillary chunks", () => {
      const file = Buffer.concat([
        PNG_SIGNATURE,
        ihdr(1, 1),
        repeat(pngChunk("sRGB", Buffer.alloc(0)), N),
        idat(),
        iend(),
      ]);
      expect(() => stripImageMetadata(file, "image/png")).toThrow(/too many segments/);
    });
  });
});
