import { describe, expect, it, vi } from "vitest";

import type { FileStorageHeadObjectOutput } from "@th/ports/file-storage";

import {
  UPLOAD_SIZE_EXCEEDED,
  verifyUploadedObjectSize,
} from "../verify-uploaded-object-size";

const KEY = "avatars/human/h1/2026-09-29/x.png";

function makeStorage(head: FileStorageHeadObjectOutput) {
  return {
    headObject: vi.fn(async () => head),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };
}

describe("verifyUploadedObjectSize (F11)", () => {
  it("returns exists:false without deleting when the object is missing", async () => {
    const storage = makeStorage({ exists: false });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).resolves.toEqual({ exists: false });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("accepts an object exactly at the declared size (metadata)", async () => {
    const storage = makeStorage({
      exists: true,
      size: 40,
      metadata: { "th-declared-bytes": "40" },
    });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).resolves.toEqual({
      exists: true,
      size: 40,
      // Passed through for callers that read other presign-time metadata.
      metadata: { "th-declared-bytes": "40" },
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("deletes and rejects an object larger than its declared metadata size", async () => {
    const storage = makeStorage({
      exists: true,
      size: 2048,
      metadata: { "th-declared-bytes": "1" },
    });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 5_000_000, context: "t" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: UPLOAD_SIZE_EXCEEDED,
      meta: { reason: UPLOAD_SIZE_EXCEEDED, maxBytes: 1 },
    });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("uses the smaller of metadata and an explicit declaredBytes", async () => {
    const meta = makeStorage({
      exists: true,
      size: 50,
      metadata: { "th-declared-bytes": "10" },
    });
    await expect(
      verifyUploadedObjectSize(
        { storage: meta },
        { key: KEY, maxBytes: 5_000, declaredBytes: 1000, context: "t" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(meta.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("an explicit declaredBytes tighter than metadata applies", async () => {
    const storage = makeStorage({
      exists: true,
      size: 50,
      metadata: { "th-declared-bytes": "1000" },
    });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 5_000, declaredBytes: 10n, context: "t" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("a client-restated size rejects but never deletes", async () => {
    const storage = makeStorage({ exists: true, size: 50 });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 100, untrustedDeclaredBytes: 10, context: "t" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: UPLOAD_SIZE_EXCEEDED,
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("the cap still deletes even when a client-restated size is given", async () => {
    const storage = makeStorage({ exists: true, size: 101 });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 100, untrustedDeclaredBytes: 500, context: "t" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("with no declaration, rejects only above the kind's max", async () => {
    const ok = makeStorage({ exists: true, size: 100 });
    await expect(
      verifyUploadedObjectSize(
        { storage: ok },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).resolves.toEqual({ exists: true, size: 100 });

    const big = makeStorage({ exists: true, size: 101 });
    await expect(
      verifyUploadedObjectSize(
        { storage: big },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(big.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("ignores garbage metadata and falls back to the max", async () => {
    const storage = makeStorage({
      exists: true,
      size: 90,
      metadata: { "th-declared-bytes": "-5" },
    });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).resolves.toEqual({
      exists: true,
      size: 90,
      metadata: { "th-declared-bytes": "-5" },
    });
  });

  it("fails closed when the store reports no size", async () => {
    const storage = makeStorage({ exists: true });
    await expect(
      verifyUploadedObjectSize(
        { storage },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: KEY });
  });

  it("still rejects, and reports, when deleting the oversize object fails", async () => {
    const storage = makeStorage({ exists: true, size: 500 });
    const boom = new Error("r2 down");
    storage.deleteObject.mockRejectedValueOnce(boom);
    const reportError = vi.fn();
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    } as any;

    await expect(
      verifyUploadedObjectSize(
        { storage, reportError, logger },
        { key: KEY, maxBytes: 100, context: "setAvatarFromUpload" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          area: "upload_size_verification",
          useCase: "setAvatarFromUpload",
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "upload.size_exceeded_delete_failed",
      expect.anything(),
    );
  });

  it("a throwing reporter does not change the rejection", async () => {
    const storage = makeStorage({ exists: true, size: 500 });
    storage.deleteObject.mockRejectedValueOnce(new Error("r2 down"));
    await expect(
      verifyUploadedObjectSize(
        {
          storage,
          reportError: () => {
            throw new Error("sentry down");
          },
        },
        { key: KEY, maxBytes: 100, context: "t" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: UPLOAD_SIZE_EXCEEDED,
    });
  });
});
