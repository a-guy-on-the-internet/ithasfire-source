import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heic-to so the test never touches the real (browser-only) library.
// The mock lets each test control the conversion outcome.
const heicToMock = vi.fn();
vi.mock("heic-to", () => ({
  heicTo: (...args: unknown[]) => heicToMock(...args),
}));

import { prepareImageForUpload } from "./prepare-image-upload";

describe("prepareImageForUpload", () => {
  beforeEach(() => {
    heicToMock.mockReset();
  });

  it("returns a non-HEIC file unchanged without invoking heic-to", async () => {
    const png = new File([new Uint8Array([1, 2, 3])], "pic.png", {
      type: "image/png",
    });

    const result = await prepareImageForUpload(png);

    expect(result).toBe(png);
    expect(heicToMock).not.toHaveBeenCalled();
  });

  it("converts an image/heic file to a JPEG File with a .jpg name", async () => {
    heicToMock.mockResolvedValue(
      new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" }),
    );
    const heic = new File([new Uint8Array([1])], "IMG_1234.HEIC", {
      type: "image/heic",
    });

    const result = await prepareImageForUpload(heic);

    expect(result).not.toBe(heic);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("IMG_1234.jpg");
    expect(heicToMock).toHaveBeenCalledWith({
      blob: heic,
      type: "image/jpeg",
      quality: 0.9,
    });
  });

  it("detects a HEIC by extension when file.type is empty", async () => {
    heicToMock.mockResolvedValue(
      new Blob([new Uint8Array([7])], { type: "image/jpeg" }),
    );
    // Some browsers report an empty type for HEIC.
    const heic = new File([new Uint8Array([1])], "photo.HEIC", { type: "" });

    const result = await prepareImageForUpload(heic);

    expect(heicToMock).toHaveBeenCalledOnce();
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("photo.jpg");
  });

  it("detects a .heif extension", async () => {
    heicToMock.mockResolvedValue(
      new Blob([new Uint8Array([2])], { type: "image/jpeg" }),
    );
    const heif = new File([new Uint8Array([1])], "burst.heif", {
      type: "image/heif",
    });

    const result = await prepareImageForUpload(heif);

    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("burst.jpg");
  });

  it("appends .jpg when the HEIC filename has no extension", async () => {
    heicToMock.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
    );
    const heic = new File([new Uint8Array([1])], "no-extension", {
      type: "image/heic",
    });

    const result = await prepareImageForUpload(heic);

    expect(result.name).toBe("no-extension.jpg");
  });

  it("throws heic_conversion_failed (preserving cause) when conversion rejects", async () => {
    const underlying = new Error("libheif: unsupported format");
    heicToMock.mockRejectedValue(underlying);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const heic = new File([new Uint8Array([1])], "broken.heic", {
      type: "image/heic",
    });

    await expect(prepareImageForUpload(heic)).rejects.toMatchObject({
      message: "heic_conversion_failed",
      cause: underlying,
    });
  });
});
