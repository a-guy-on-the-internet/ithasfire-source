import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  type FileStorageDeleteObjectOutput,
  type FileStorageGetObjectUrlOutput,
  type FileStorageHeadObjectOutput,
  type FileStorageListObjectsOutput,
  type FileStorageMoveObjectOutput,
  type FileStoragePort,
  type FileStoragePresignPutObjectOutput,
  type FileStoragePutObjectOutput,
} from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { SeatGlyph } from "@th/ports/place-layouts";

import { PlaceLayoutBlobStorage } from "../place-layout-blob-storage";

const sampleGlyphs: SeatGlyph[] = [
  {
    seatId: "seat-1",
    sectionId: "section-1",
    label: "A1",
    position: { x: 0, y: 0 },
    radius: 1,
  },
  {
    seatId: "seat-2",
    sectionId: "section-1",
    label: "A2",
    position: { x: 10, y: 5 },
    width: 2,
    height: 3,
    rotationDeg: 15,
  },
];

class InMemoryFileStorage implements FileStoragePort {
  public readonly objects = new Map<
    string,
    { content: Buffer; metadata?: Record<string, string> }
  >();

  async putObject(
    input: Parameters<FileStoragePort["putObject"]>[0],
  ): Promise<FileStoragePutObjectOutput> {
    const buffer = await toBuffer(input.content);
    this.objects.set(input.key, {
      content: buffer,
      metadata: input.options.metadata,
    });
    return {
      url: `https://storage.test/${input.key}`,
      etag: "etag",
      size: buffer.length,
    } satisfies FileStoragePutObjectOutput;
  }

  async getObjectUrl(): Promise<FileStorageGetObjectUrlOutput> {
    throw new Error("not implemented");
  }

  async presignPutObject(): Promise<FileStoragePresignPutObjectOutput> {
    throw new Error("not implemented");
  }

  async moveObject(): Promise<FileStorageMoveObjectOutput> {
    throw new Error("not implemented");
  }

  async deleteObject(
    input: Parameters<FileStoragePort["deleteObject"]>[0],
  ): Promise<FileStorageDeleteObjectOutput> {
    this.objects.delete(input.key);
    return { ok: true } as const;
  }

  async headObject(
    input: Parameters<FileStoragePort["headObject"]>[0],
  ): Promise<FileStorageHeadObjectOutput> {
    return { exists: this.objects.has(input.key) };
  }

  async getObject(): Promise<
    Awaited<ReturnType<FileStoragePort["getObject"]>>
  > {
    throw new Error("not implemented");
  }

  async listObjects(
    input: Parameters<FileStoragePort["listObjects"]>[0],
  ): Promise<FileStorageListObjectsOutput> {
    const keys = Array.from(this.objects.keys())
      .filter((key) => key.startsWith(input.prefix))
      .map((key) => ({ key }));

    return {
      keys,
    } as FileStorageListObjectsOutput;
  }
}

const toBuffer = async (content: Buffer | Readable): Promise<Buffer> => {
  if (Buffer.isBuffer(content)) {
    return content;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const createLogger = (): LoggerPort => {
  const log = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const child = vi.fn();
  const withTime = vi.fn();

  const logger: LoggerPort = {
    log: log as unknown as LoggerPort["log"],
    info: info as unknown as LoggerPort["info"],
    warn: warn as unknown as LoggerPort["warn"],
    error: error as unknown as LoggerPort["error"],
    child: child as unknown as LoggerPort["child"],
    withTime: withTime as unknown as LoggerPort["withTime"],
  };

  child.mockReturnValue(logger);
  withTime.mockImplementation(async (_name, fn) => fn());

  return logger;
};

describe("PlaceLayoutBlobStorage", () => {
  it("stores glyph snapshot and returns checksum", async () => {
    const storage = new InMemoryFileStorage();
    const adapter = new PlaceLayoutBlobStorage({ storage });

    const result = await adapter.putForPlace({
      placeId: "place-123",
      glyphs: sampleGlyphs,
    });

    const expectedKey = `place-layouts/place-123/${result.checksum}.json`;
    expect(storage.objects.has(expectedKey)).toBe(true);

    const saved = storage.objects.get(expectedKey);
    expect(saved).toBeDefined();
    const payload = JSON.parse(saved!.content.toString("utf-8"));
    expect(payload).toMatchObject({
      placeId: "place-123",
      checksum: result.checksum,
      seatCount: sampleGlyphs.length,
      schemaVersion: "1",
    });
    expect(Array.isArray(payload.glyphs)).toBe(true);
  });

  it("prunes obsolete snapshots when replacing", async () => {
    const storage = new InMemoryFileStorage();
    storage.objects.set("place-layouts/place-123/old.json", {
      content: Buffer.from("{}"),
    });

    const adapter = new PlaceLayoutBlobStorage({ storage });
    const result = await adapter.putForPlace({
      placeId: "place-123",
      glyphs: sampleGlyphs,
    });

    const keys = Array.from(storage.objects.keys());
    expect(keys).toEqual([`place-layouts/place-123/${result.checksum}.json`]);
  });

  it("warns when checksum hint mismatches computed checksum", async () => {
    const storage = new InMemoryFileStorage();
    const logger = createLogger();
    const adapter = new PlaceLayoutBlobStorage({ storage, logger });

    await adapter.putForPlace({
      placeId: "place-123",
      glyphs: sampleGlyphs,
      checksumHint: "deadbeef",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "place_layout_blob_checksum_mismatch",
      expect.objectContaining({
        placeId: "place-123",
        checksumHint: "deadbeef",
      }),
    );
  });

  it("deletes all snapshots for a place", async () => {
    const storage = new InMemoryFileStorage();
    storage.objects.set("place-layouts/place-123/one.json", {
      content: Buffer.from("{}"),
    });
    storage.objects.set("place-layouts/place-123/two.json", {
      content: Buffer.from("{}"),
    });
    storage.objects.set("place-layouts/other/three.json", {
      content: Buffer.from("{}"),
    });

    const adapter = new PlaceLayoutBlobStorage({ storage });
    await adapter.deleteForPlace("place-123");

    expect(storage.objects.has("place-layouts/place-123/one.json")).toBe(false);
    expect(storage.objects.has("place-layouts/place-123/two.json")).toBe(false);
    expect(storage.objects.has("place-layouts/other/three.json")).toBe(true);
  });
});
