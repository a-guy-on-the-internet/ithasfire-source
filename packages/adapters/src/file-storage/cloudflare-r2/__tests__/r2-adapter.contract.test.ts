import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it } from "vitest";

import { CloudflareR2Adapter } from "../r2-adapter";
import { runFileStorageContract } from "@th/test-utils/contracts/file-storage";

const PUBLIC_METADATA_FLAG = "th-public";

// NOTE: aws-sdk-client-mock's types can conflict with AWS SDK v3's (Smithy) types when
// multiple copies of @smithy/types exist in the dependency graph. Runtime behavior is
// fine; we loosen the generics here to keep package-level `tsc` happy.
const s3Mock = mockClient(S3Client as unknown as new (...args: any[]) => any);

type StoredObject = {
  key: string;
  buffer: Buffer;
  metadata: Record<string, string>;
  public: boolean;
  contentType?: string;
  etag: string;
  lastModified: Date;
};

const store = new Map<string, StoredObject>();

const extractInput = <T extends object>(value: T | { input: T }): T =>
  value && typeof value === "object" && "input" in value
    ? (value as { input: T }).input
    : (value as T);

const baseConfig = {
  bucket: "test-bucket",
  endpoint: "https://test-account.r2.local",
  accessKeyId: "TESTKEY",
  secretAccessKey: "TESTSECRET",
  publicBaseUrl: "https://cdn.test.example",
};

const runWithAdapter = (
  overrides?: Partial<typeof baseConfig> & { defaultPublic?: boolean },
) =>
  new CloudflareR2Adapter({
    ...baseConfig,
    defaultPublic: overrides?.defaultPublic ?? false,
    publicBaseUrl: overrides?.publicBaseUrl ?? baseConfig.publicBaseUrl,
    endpoint: overrides?.endpoint ?? baseConfig.endpoint,
    bucket: overrides?.bucket ?? baseConfig.bucket,
    accessKeyId: overrides?.accessKeyId ?? baseConfig.accessKeyId,
    secretAccessKey: overrides?.secretAccessKey ?? baseConfig.secretAccessKey,
  });

const collectBody = async (body: unknown): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`Unsupported body type: ${typeof body}`);
};

const mapList = (input: ListObjectsV2CommandInput): StoredObject[] => {
  const prefix = input.Prefix ?? "";
  return [...store.values()]
    .filter((item) => item.key.startsWith(prefix))
    .sort((a, b) => a.key.localeCompare(b.key));
};

const setupS3Mock = () => {
  s3Mock.on(PutObjectCommand as any).callsFake(async (command) => {
    const input = extractInput(command);
    const key = input.Key ?? "";
    const buffer = await collectBody(input.Body);
    const metadataEntries = Object.entries(input.Metadata ?? {}) as Array<
      [string, string]
    >;
    const metadata = Object.fromEntries(
      metadataEntries.map(([k, v]) => [k.toLowerCase(), v ?? ""]),
    );
    const isPublic = metadata[PUBLIC_METADATA_FLAG] === "true";
    const etag = createHash("sha1").update(buffer).digest("hex");
    const stored: StoredObject = {
      key,
      buffer,
      metadata,
      public: isPublic,
      contentType: input.ContentType ?? undefined,
      etag,
      lastModified: new Date(),
    };
    store.set(key, stored);
    return { ETag: `"${etag}"` };
  });

  s3Mock.on(HeadObjectCommand as any).callsFake(async (command) => {
    const input = extractInput(command);
    const key = input.Key ?? "";
    const obj = store.get(key);
    if (!obj) {
      const error = new Error("NotFound");
      (error as any).name = "NotFound";
      (error as any).$metadata = { httpStatusCode: 404 };
      throw error;
    }
    return {
      ContentLength: obj.buffer.length,
      ContentType: obj.contentType,
      ETag: `"${obj.etag}"`,
      LastModified: obj.lastModified,
      Metadata: obj.metadata,
    };
  });

  s3Mock.on(DeleteObjectCommand as any).callsFake(async (command) => {
    const input = extractInput(command);
    const key = input.Key ?? "";
    store.delete(key);
    return {};
  });

  s3Mock.on(GetObjectCommand as any).callsFake(async (command) => {
    const input = extractInput(command);
    const key = input.Key ?? "";
    const obj = store.get(key);
    if (!obj) {
      const error = new Error("NoSuchKey");
      (error as any).name = "NoSuchKey";
      (error as any).$metadata = { httpStatusCode: 404 };
      throw error;
    }
    // S3 Range semantics: `bytes=start-end`, both inclusive, end clamped.
    const range = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? "");
    if (range && Number(range[1]) >= obj.buffer.length) {
      const error = new Error("The requested range is not satisfiable");
      (error as any).name = "InvalidRange";
      (error as any).$metadata = { httpStatusCode: 416 };
      throw error;
    }
    const body = range
      ? obj.buffer.subarray(Number(range[1]), Number(range[2]) + 1)
      : obj.buffer;
    return {
      Body: {
        transformToByteArray: async () => new Uint8Array(body),
      },
      ContentType: obj.contentType,
      ContentLength: body.length,
    };
  });

  s3Mock.on(ListObjectsV2Command as any).callsFake(async (command) => {
    const input = extractInput(command);
    const allObjects = mapList(input);
    const limit = input.MaxKeys ?? 1000;
    const cursor = input.ContinuationToken
      ? Number.parseInt(input.ContinuationToken, 10)
      : 0;
    const page = allObjects.slice(cursor, cursor + limit);
    const nextCursor =
      cursor + limit < allObjects.length ? String(cursor + limit) : undefined;

    return {
      Contents: page.map((obj) => ({
        Key: obj.key,
        Size: obj.buffer.length,
        LastModified: obj.lastModified,
      })),
      NextContinuationToken: nextCursor,
    };
  });
};

describe("CloudflareR2Adapter", () => {
  beforeEach(() => {
    store.clear();
    s3Mock.reset();
    setupS3Mock();
  });

  runFileStorageContract(() => runWithAdapter());

  it("can presign PUT uploads", async () => {
    const adapter = runWithAdapter({ defaultPublic: false });
    const key = "uploads/presigned/avatar.png";

    const result = await adapter.presignPutObject({
      key,
      contentType: "image/png",
      sizeBytes: 1024,
      public: true,
      options: { expiresSec: 600 },
    });

    const parsed = new URL(result.uploadUrl);
    expect(parsed.protocol).toMatch(/^https?:$/);
    // S3 presigned URLs should include Expires query param.
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("600");
    // No contentDisposition requested → header must NOT be part of the
    // signature (existing clients don't send it).
    expect(parsed.searchParams.get("X-Amz-SignedHeaders") ?? "").not.toContain(
      "content-disposition",
    );
  });

  it("signs Content-Disposition into presigned PUTs when requested (SVG defense in depth)", async () => {
    const adapter = runWithAdapter({ defaultPublic: false });

    const result = await adapter.presignPutObject({
      key: "events/evt_1/images/img_1.svg",
      contentType: "image/svg+xml",
      contentDisposition: "attachment",
      sizeBytes: 1024,
      public: true,
      options: { expiresSec: 600 },
    });

    const parsed = new URL(result.uploadUrl);
    // The header is signed, so the browser PUT MUST send
    // `Content-Disposition: attachment` or the signature check fails.
    const signedHeaders = decodeURIComponent(
      parsed.searchParams.get("X-Amz-SignedHeaders") ?? "",
    );
    expect(signedHeaders).toContain("content-disposition");
  });

  it("returns CDN URLs for public objects without exposing internal endpoint", async () => {
    const adapter = runWithAdapter();
    const key = "assets/logo.svg";
    const put = await adapter.putObject({
      key,
      content: Buffer.from("logo"),
      options: { public: true, contentType: "image/svg+xml" },
    });
    expect(put.url).toBe(`${baseConfig.publicBaseUrl}/${key}`);

    const resolved = await adapter.getObjectUrl({ key, options: {} });
    expect(resolved.url).toBe(`${baseConfig.publicBaseUrl}/${key}`);
  });

  it("resolves a public URL via options.public for an object stored without the public flag", async () => {
    // Reproduces the presigned-PUT bug: the browser uploads bytes but never
    // echoes the signed x-amz-meta-th-public header, so the object lands
    // without the public metadata flag. options.public must still mint the CDN URL.
    const adapter = runWithAdapter({ defaultPublic: false });
    const key = "events/evt_1/images/img_1.jpg";
    await adapter.putObject({
      key,
      content: Buffer.from("bytes"),
      options: {},
    });

    const resolved = await adapter.getObjectUrl({
      key,
      options: { public: true },
    });
    expect(resolved.url).toBe(`${baseConfig.publicBaseUrl}/${key}`);
  });

  it("generates signed URLs honoring the requested expiration", async () => {
    const adapter = runWithAdapter({ defaultPublic: false });
    const key = "private/doc.pdf";
    await adapter.putObject({
      key,
      content: Buffer.from("secret"),
      options: {},
    });

    const { url } = await adapter.getObjectUrl({
      key,
      options: { expiresSec: 600 },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("600");
  });

  it("getObject returns the raw bytes + content type of a stored object", async () => {
    const adapter = runWithAdapter();
    const key = "events/evt_1/hero.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await adapter.putObject({
      key,
      content: bytes,
      options: { contentType: "image/jpeg" },
    });

    const result = await adapter.getObject({ key });
    expect(result.content.equals(bytes)).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.size).toBe(bytes.length);
  });

  it("getObject throws not_found for a missing object", async () => {
    const adapter = runWithAdapter();
    await expect(
      adapter.getObject({ key: "missing/object.png" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("handles large streaming uploads without buffering everything in memory", async () => {
    const adapter = runWithAdapter();
    const key = "streams/large.bin";
    const chunk = Buffer.alloc(256 * 1024, 7);
    const totalChunks = 8;
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < totalChunks; i += 1) {
          yield chunk;
        }
      })(),
    );

    const result = await adapter.putObject({
      key,
      content: stream,
      options: { contentType: "application/octet-stream" },
    });
    expect(result.size).toBe(chunk.length * totalChunks);

    const head = await adapter.headObject({ key });
    expect(head.exists).toBe(true);
    expect(head.size).toBe(chunk.length * totalChunks);
  });
});
