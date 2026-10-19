import { describe, it, expect } from "vitest";

import {
  EVENT_IMAGE_UPLOAD_TYPES,
  EVENT_IMAGE_UPLOAD_ACCEPT,
  validateImageUploadType,
} from "./event-image-upload";

const makeFile = (name: string, type: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type });

describe("validateImageUploadType", () => {
  // SVG was removed from every surface: Azure AI Content Safety cannot analyze
  // it, so an SVG hero failed closed to a FLAGGED moderation record that
  // nothing could clear. The client mirror must refuse it too, so a file picked
  // via "All Files" fails here rather than at the presign.
  it("rejects SVG", () => {
    const svg = makeFile("logo.svg", "image/svg+xml");
    expect(validateImageUploadType(svg, EVENT_IMAGE_UPLOAD_TYPES)).toEqual({
      ok: false,
      error: "invalid_image_type",
    });
  });

  it("allows every raster type on the allowlist", () => {
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ]) {
      const file = makeFile(`pic.${type.split("/")[1]}`, type);
      expect(validateImageUploadType(file, EVENT_IMAGE_UPLOAD_TYPES).ok).toBe(
        true,
      );
    }
  });

  it("rejects TIFF (and other off-allowlist types)", () => {
    const tiff = makeFile("scan.tiff", "image/tiff");
    expect(validateImageUploadType(tiff, EVENT_IMAGE_UPLOAD_TYPES)).toEqual({
      ok: false,
      error: "invalid_image_type",
    });
  });

  it("rejects files with an empty MIME type", () => {
    const unknown = makeFile("mystery", "");
    expect(validateImageUploadType(unknown).ok).toBe(false);
  });

  it("is case-insensitive on the file's reported MIME", () => {
    const shouty = makeFile("pic.png", "IMAGE/PNG");
    expect(validateImageUploadType(shouty, EVENT_IMAGE_UPLOAD_TYPES).ok).toBe(
      true,
    );
  });

  it("defaults to the event allowlist, which refuses SVG", () => {
    expect(
      validateImageUploadType(makeFile("logo.svg", "image/svg+xml")).ok,
    ).toBe(false);
    expect(validateImageUploadType(makeFile("pic.png", "image/png")).ok).toBe(
      true,
    );
  });
});

describe("accept strings", () => {
  it("excludes SVG in both MIME and extension form, and keeps HEIC", () => {
    expect(EVENT_IMAGE_UPLOAD_ACCEPT).not.toContain("svg");
    expect(EVENT_IMAGE_UPLOAD_ACCEPT).toContain(".heic");
  });

  it("never uses the wide-open image/* wildcard", () => {
    expect(EVENT_IMAGE_UPLOAD_ACCEPT).not.toContain("image/*");
  });
});
