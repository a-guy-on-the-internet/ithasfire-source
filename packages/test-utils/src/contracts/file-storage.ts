import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  FILE_STORAGE_DEFAULT_LIST_LIMIT,
  FILE_STORAGE_MAX_LIST_LIMIT,
  FILE_STORAGE_PREFIX_MAX_LENGTH,
  FileStorageDeleteObjectInput,
  FileStorageDeleteObjectOutput,
  FileStorageError,
  FileStorageGetObjectInput,
  FileStorageGetObjectOutput,
  FileStorageGetObjectUrlInput,
  FileStorageGetObjectUrlOutput,
  FileStorageHeadObjectInput,
  FileStorageHeadObjectOutput,
  FileStorageListObjectsInput,
  FileStorageListObjectsOutput,
  FileStorageMoveObjectInput,
  FileStorageMoveObjectOutput,
  FileStoragePort,
  FileStoragePresignPutObjectInput,
  FileStoragePresignPutObjectOutput,
  FileStoragePutObjectInput,
  FileStoragePutObjectOutput,
  createFileStorageError,
  fileStorageDeleteObjectInputSchema,
  fileStorageGetObjectInputSchema,
  fileStorageGetObjectUrlInputSchema,
  fileStorageHeadObjectInputSchema,
  fileStorageListObjectsInputSchema,
  fileStorageMoveObjectInputSchema,
  fileStoragePutObjectInputSchema,
  fileStoragePresignPutObjectInputSchema,
  normalizeStorageKey,
} from "@th/ports/file-storage";

type StoredObject = {
  key: string;
  buffer: Buffer;
  public: boolean;
  contentType?: string;
  metadata?: Record<string, string>;
  etag: string;
  lastModified: Date;
};

type ParsedCursor = {
  offset: number;
};

const parseCursor = (cursor: string | undefined): ParsedCursor => {
  if (!cursor) {
    return { offset: 0 };
  }

  const offset = Number.parseInt(cursor, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    throw createFileStorageError("invalid_input", "cursor_invalid");
  }

  return { offset };
};

const bufferFrom = async (content: Buffer | Readable): Promise<Buffer> => {
  if (Buffer.isBuffer(content)) {
    return content;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

type ParseableSchema<T> = {
  parse(input: unknown): T;
};

const parseOrInvalid = <T>(schema: ParseableSchema<T>, input: unknown): T => {
  try {
    return schema.parse(input) as T;
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw createFileStorageError(
        "invalid_input",
        issue?.message ?? "invalid_input",
      );
    }
    throw error;
  }
};

export class InMemoryFileStorage implements FileStoragePort {
  private readonly store = new Map<string, StoredObject>();

  /**
   * Test-only helper for retrieving stored bytes.
   *
   * Not part of {@link FileStoragePort} and should only be used by unit tests.
   */
  getObjectBufferForTest(key: string): Buffer | undefined {
    const normalized = normalizeStorageKey(key);
    return this.store.get(normalized)?.buffer;
  }

  async putObject(
    input: FileStoragePutObjectInput,
  ): Promise<FileStoragePutObjectOutput> {
    const parsed = parseOrInvalid<FileStoragePutObjectInput>(
      fileStoragePutObjectInputSchema,
      input,
    );
    const buffer = await bufferFrom(parsed.content);
    const normalizedKey = parsed.key;
    const now = new Date();

    const etag = createHash("sha1").update(buffer).digest("hex");
    const stored: StoredObject = {
      key: normalizedKey,
      buffer,
      contentType: parsed.options.contentType,
      metadata: parsed.options.metadata,
      public: Boolean(parsed.options.public),
      etag,
      lastModified: now,
    };

    this.store.set(normalizedKey, stored);

    const urlBase = stored.public
      ? `https://storage.local/public/${normalizedKey}`
      : `https://storage.local/private/${normalizedKey}`;

    return {
      url: urlBase,
      etag,
      size: buffer.length,
    };
  }

  async getObjectUrl(
    input: FileStorageGetObjectUrlInput,
  ): Promise<FileStorageGetObjectUrlOutput> {
    const parsed = parseOrInvalid<FileStorageGetObjectUrlInput>(
      fileStorageGetObjectUrlInputSchema,
      input,
    );
    const normalizedKey = parsed.key;
    const existing = this.store.get(normalizedKey);
    if (!existing) {
      throw createFileStorageError("not_found", "object_not_found");
    }

    // A presigned-public upload may have stored the object without the public
    // metadata flag (the browser PUT dropped the header), but the caller knows
    // it is public. Honour the explicit option over the stored flag.
    if (!existing.public && parsed.options.public !== true) {
      const ttl = parsed.options.expiresSec;
      if (!ttl) {
        throw createFileStorageError(
          "invalid_input",
          "expires_required_for_private_object",
        );
      }
      const token = createHash("sha1")
        .update(`${normalizedKey}:${ttl}`)
        .digest("hex");
      return {
        url: `https://storage.local/private/${normalizedKey}?ttl=${ttl}&token=${token}`,
      };
    }

    return {
      url: `https://storage.local/public/${normalizedKey}`,
    };
  }

  async deleteObject(
    input: FileStorageDeleteObjectInput,
  ): Promise<FileStorageDeleteObjectOutput> {
    const parsed = parseOrInvalid<FileStorageDeleteObjectInput>(
      fileStorageDeleteObjectInputSchema,
      input,
    );
    this.store.delete(parsed.key);
    return { ok: true } as const;
  }

  async headObject(
    input: FileStorageHeadObjectInput,
  ): Promise<FileStorageHeadObjectOutput> {
    const parsed = parseOrInvalid<FileStorageHeadObjectInput>(
      fileStorageHeadObjectInputSchema,
      input,
    );
    const existing = this.store.get(parsed.key);
    if (!existing) {
      return { exists: false };
    }

    return {
      exists: true,
      size: existing.buffer.length,
      contentType: existing.contentType,
      etag: existing.etag,
      lastModified: new Date(existing.lastModified),
    };
  }

  async getObject(
    input: FileStorageGetObjectInput,
  ): Promise<FileStorageGetObjectOutput> {
    const parsed = parseOrInvalid<FileStorageGetObjectInput>(
      fileStorageGetObjectInputSchema,
      input,
    );
    const existing = this.store.get(parsed.key);
    if (!existing) {
      throw createFileStorageError("not_found", "object_not_found");
    }

    // Unsatisfiable, as S3/R2 answer it (416 → `invalid_input`).
    if (parsed.range && parsed.range.start >= existing.buffer.length) {
      throw createFileStorageError("invalid_input", "range_not_satisfiable");
    }
    // Range ends are inclusive (HTTP-style); `subarray` clamps past the end.
    const content = parsed.range
      ? existing.buffer.subarray(parsed.range.start, parsed.range.end + 1)
      : existing.buffer;

    return {
      content,
      contentType: existing.contentType,
      size: content.length,
    };
  }

  async listObjects(
    input: FileStorageListObjectsInput,
  ): Promise<FileStorageListObjectsOutput> {
    const parsed = parseOrInvalid<FileStorageListObjectsInput>(
      fileStorageListObjectsInputSchema,
      input,
    );
    const { offset } = parseCursor(parsed.cursor);

    const sortedKeys = [...this.store.values()]
      .filter((item) =>
        parsed.prefix ? item.key.startsWith(parsed.prefix) : true,
      )
      .map((item) => ({
        key: item.key,
        size: item.buffer.length,
        lastModified: new Date(item.lastModified),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    const page = sortedKeys.slice(offset, offset + parsed.limit);
    const nextCursor =
      offset + parsed.limit < sortedKeys.length
        ? String(offset + parsed.limit)
        : undefined;

    return {
      keys: page,
      nextCursor,
    };
  }

  async presignPutObject(
    input: FileStoragePresignPutObjectInput,
  ): Promise<FileStoragePresignPutObjectOutput> {
    const parsed = parseOrInvalid<FileStoragePresignPutObjectInput>(
      fileStoragePresignPutObjectInputSchema,
      input,
    );
    const normalizedKey = normalizeStorageKey(parsed.key);

    // We can't actually sign anything in-memory, so return a deterministic URL.
    // Callers can still “upload” by using `putObject` directly in tests.
    const token = createHash("sha1")
      .update(
        `${normalizedKey}:${parsed.contentType}:${parsed.sizeBytes}:${parsed.options.expiresSec ?? ""}:${
          parsed.public ?? ""
        }`,
      )
      .digest("hex");

    return {
      uploadUrl: `https://storage.local/presigned-put/${normalizedKey}?token=${token}`,
    };
  }

  async moveObject(
    input: FileStorageMoveObjectInput,
  ): Promise<FileStorageMoveObjectOutput> {
    const parsed = parseOrInvalid<FileStorageMoveObjectInput>(
      fileStorageMoveObjectInputSchema,
      input,
    );
    const { fromKey, toKey } = parsed;

    if (fromKey === toKey) {
      return { ok: true } as const;
    }

    const existing = this.store.get(fromKey);
    if (!existing) {
      throw createFileStorageError("not_found", "object_not_found");
    }

    const dest: StoredObject = {
      ...existing,
      key: toKey,
      contentType: parsed.options.contentType ?? existing.contentType,
      public: parsed.options.public ?? existing.public,
      metadata: parsed.options.metadata ?? existing.metadata,
      lastModified: new Date(),
    };

    this.store.set(toKey, dest);
    this.store.delete(fromKey);
    return { ok: true } as const;
  }
}

export const runFileStorageContract = (make: () => FileStoragePort) => {
  describe("FileStoragePort contract", () => {
    let storage: FileStoragePort;

    beforeEach(() => {
      storage = make();
    });

    it("put/get/head/delete/list round-trips", async () => {
      const key = "uploads/example.txt";
      const content = Buffer.from("hello world");

      const putResult = await storage.putObject({
        key,
        content,
        options: { contentType: "text/plain" },
      });
      expect(putResult.size).toBe(content.length);
      expect(putResult.url).toContain(key);
      expect(putResult.etag).toBeDefined();

      const head = await storage.headObject({ key });
      expect(head.exists).toBe(true);
      expect(head.size).toBe(content.length);
      expect(head.contentType).toBe("text/plain");
      expect(head.lastModified).toBeInstanceOf(Date);

      const list = await storage.listObjects({
        prefix: "uploads",
        limit: FILE_STORAGE_DEFAULT_LIST_LIMIT,
      });
      expect(list.keys.map((entry) => entry.key)).toContain(key);

      const url = await storage.getObjectUrl({
        key,
        options: { expiresSec: 120 },
      });
      expect(url.url).toContain(key);

      await storage.deleteObject({ key });
      const afterDelete = await storage.headObject({ key });
      expect(afterDelete.exists).toBe(false);
    });

    it("getObject returns the whole object, or only the requested range", async () => {
      const key = "uploads/range.bin";
      const content = Buffer.from("0123456789");
      await storage.putObject({
        key,
        content,
        options: { contentType: "application/octet-stream" },
      });

      const whole = await storage.getObject({ key });
      expect(whole.content.equals(content)).toBe(true);
      expect(whole.size).toBe(10);

      // Inclusive on both ends.
      const head = await storage.getObject({ key, range: { start: 0, end: 3 } });
      expect(head.content.toString()).toBe("0123");
      expect(head.size).toBe(4);

      const middle = await storage.getObject({
        key,
        range: { start: 4, end: 6 },
      });
      expect(middle.content.toString()).toBe("456");

      // An end past the last byte is clamped to the object.
      const clamped = await storage.getObject({
        key,
        range: { start: 0, end: 262_143 },
      });
      expect(clamped.content.equals(content)).toBe(true);
      expect(clamped.size).toBe(10);

      await expect(
        storage.getObject({ key, range: { start: 5, end: 4 } }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      // A start at or past the end is unsatisfiable (S3/R2: 416).
      await expect(
        storage.getObject({ key, range: { start: 10, end: 20 } }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("distinguishes public and signed URLs", async () => {
      const publicKey = "assets/logo.svg";
      const privateKey = "secure/data.bin";

      const publicPut = await storage.putObject({
        key: publicKey,
        content: Buffer.from("public"),
        options: { public: true },
      });
      await storage.putObject({
        key: privateKey,
        content: Buffer.from("private"),
        options: {},
      });

      const publicUrl = await storage.getObjectUrl({
        key: publicKey,
        options: {},
      });
      expect(publicUrl.url).toEqual(publicPut.url);

      const signedShort = await storage.getObjectUrl({
        key: privateKey,
        options: { expiresSec: 120 },
      });
      const signedLong = await storage.getObjectUrl({
        key: privateKey,
        options: { expiresSec: 480 },
      });
      expect(signedShort.url).not.toEqual(signedLong.url);

      await expect(
        storage.getObjectUrl({ key: privateKey, options: {} as any }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      } satisfies Partial<FileStorageError>);
    });

    it("returns a public URL when options.public is set for a non-public object", async () => {
      // Models a presigned-public upload whose public metadata flag did not
      // round-trip: the object is stored without the flag, but the caller
      // explicitly requests the public URL.
      const key = "assets/presigned-public.png";
      await storage.putObject({
        key,
        content: Buffer.from("img"),
        options: {},
      });

      const result = await storage.getObjectUrl({
        key,
        options: { public: true },
      });
      // A public URL is unsigned: no signing query params (X-Amz-* / token).
      const resolved = new URL(result.url);
      expect(resolved.searchParams.has("token")).toBe(false);
      expect(
        [...resolved.searchParams.keys()].some((k) =>
          k.toLowerCase().startsWith("x-amz-"),
        ),
      ).toBe(false);

      await expect(
        storage.getObjectUrl({ key: "missing/object.png", options: { public: true } }),
      ).rejects.toMatchObject({
        code: "not_found",
      } satisfies Partial<FileStorageError>);
    });

    it("supports idempotent deletes", async () => {
      const key = "tickets/qrcode.png";
      await storage.putObject({ key, content: Buffer.from("qr"), options: {} });

      await storage.deleteObject({ key });
      await expect(storage.deleteObject({ key })).resolves.toEqual({
        ok: true,
      });
    });

    it("lists objects with pagination", async () => {
      const prefix = "logs/2025";
      const total = 205;

      for (let i = 0; i < total; i += 1) {
        const key = `${prefix}/event-${String(i).padStart(4, "0")}.json`;
        await storage.putObject({
          key,
          content: Buffer.from(String(i)),
          options: {},
        });
      }

      const firstPage = await storage.listObjects({ prefix, limit: 50 });
      expect(firstPage.keys).toHaveLength(50);
      expect(firstPage.nextCursor).toBeDefined();

      const secondPage = await storage.listObjects({
        prefix,
        limit: 50,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.keys).toHaveLength(50);

      const remaining = await storage.listObjects({
        prefix,
        limit: FILE_STORAGE_MAX_LIST_LIMIT,
        cursor: secondPage.nextCursor,
      });
      expect(remaining.keys.length).toBe(total - 100);
      expect(remaining.nextCursor).toBeUndefined();
    });

    it("normalizes keys and rejects invalid paths", async () => {
      const rawKey = "/folder//child.txt";
      const normalized = normalizeStorageKey(rawKey);

      await storage.putObject({
        key: rawKey,
        content: Buffer.from("data"),
        options: {},
      });

      const list = await storage.listObjects({ prefix: "folder", limit: 10 });
      expect(list.keys.map((entry) => entry.key)).toContain(normalized);

      const headRaw = await storage.headObject({ key: rawKey });
      expect(headRaw.exists).toBe(true);

      await expect(
        storage.putObject({
          key: "folder/../secret",
          content: Buffer.from("x"),
          options: {},
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      } satisfies Partial<FileStorageError>);

      const longPrefix = "a".repeat(FILE_STORAGE_PREFIX_MAX_LENGTH + 1);
      await expect(
        storage.listObjects({ prefix: longPrefix, limit: 10 }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await expect(
        storage.listObjects({
          prefix: "folder",
          limit: FILE_STORAGE_MAX_LIST_LIMIT + 1,
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    });
  });
};
