import { Readable, Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { LoggerPort } from "@th/ports/logger";

import {
  resolveRequestTimeouts,
  s3RequestHandlerOptions,
  startDeadline,
  type FileStorageRequestTimeouts,
} from "../request-timeouts";
import {
  type FileStoragePort,
  type FileStoragePutObjectInput,
  type FileStoragePutObjectOutput,
  type FileStorageGetObjectUrlInput,
  type FileStorageGetObjectUrlOutput,
  type FileStorageDeleteObjectInput,
  type FileStorageDeleteObjectOutput,
  type FileStorageHeadObjectInput,
  type FileStorageHeadObjectOutput,
  type FileStorageGetObjectInput,
  type FileStorageGetObjectOutput,
  type FileStorageListObjectsInput,
  type FileStorageListObjectsOutput,
  type FileStoragePresignPutObjectInput,
  type FileStoragePresignPutObjectOutput,
  type FileStorageMoveObjectInput,
  type FileStorageMoveObjectOutput,
  createFileStorageError,
  fileStoragePutObjectInputSchema,
  fileStorageGetObjectUrlInputSchema,
  fileStorageDeleteObjectInputSchema,
  fileStorageHeadObjectInputSchema,
  fileStorageGetObjectInputSchema,
  fileStorageListObjectsInputSchema,
  fileStoragePresignPutObjectInputSchema,
  fileStorageMoveObjectInputSchema,
  FILE_STORAGE_DECLARED_BYTES_METADATA_KEY,
} from "@th/ports/file-storage";

import { mapS3Error } from "../map-s3-error";
const PUBLIC_METADATA_FLAG = "th-public";

class CountingStream extends Transform {
  bytes = 0;

  constructor() {
    super({ objectMode: false });
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    const bufferChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);
    this.bytes += bufferChunk.length;
    callback(null, bufferChunk);
  }
}

type ParseSchema<T> = { parse: (input: unknown) => T };

const parseInput = <T>(schema: ParseSchema<T>, input: unknown): T => {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const message = Array.isArray(
        (error as { issues?: Array<{ message: string }> }).issues,
      )
        ? ((error as { issues?: Array<{ message: string }> }).issues?.[0]
            ?.message ?? "invalid_input")
        : "invalid_input";
      throw createFileStorageError("invalid_input", message);
    }
    throw error;
  }
};

type CloudflareR2AdapterOptions = {
  bucket: string;
  /**
   * Connect/idle timeouts and the hard getObject/putObject deadlines;
   * defaults to `DEFAULT_FILE_STORAGE_REQUEST_TIMEOUTS`
   * (`../request-timeouts.ts`). Without them a hung read never fails.
   */
  timeouts?: Partial<FileStorageRequestTimeouts>;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  defaultPublic?: boolean;
  logger?: LoggerPort;
};

type WithClient = CloudflareR2AdapterOptions & {
  client?: S3Client;
};

type S3ListObject = NonNullable<ListObjectsV2CommandOutput["Contents"]>[number];

const sanitizeBaseUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  return url.replace(/\/+$/g, "");
};

export class CloudflareR2Adapter implements FileStoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl?: string;
  private readonly defaultPublic: boolean;
  private readonly logger?: LoggerPort;
  private readonly timeouts: FileStorageRequestTimeouts;

  constructor(options: WithClient) {
    this.timeouts = resolveRequestTimeouts(options.timeouts);
    this.bucket = options.bucket;
    this.publicBaseUrl = sanitizeBaseUrl(options.publicBaseUrl);
    this.defaultPublic = Boolean(options.defaultPublic);
    this.logger = options.logger;

    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: "auto",
        forcePathStyle: true,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
        requestHandler: s3RequestHandlerOptions(this.timeouts),
      });
  }

  async putObject(
    input: FileStoragePutObjectInput,
  ): Promise<FileStoragePutObjectOutput> {
    const parsed = parseInput(fileStoragePutObjectInputSchema, input);
    const isPublic = parsed.options.public ?? this.defaultPublic;
    if (isPublic && !this.publicBaseUrl) {
      throw createFileStorageError(
        "invalid_input",
        "public_base_url_not_configured",
      );
    }

    const metadata: Record<string, string> = {};
    if (parsed.options.metadata) {
      for (const [key, value] of Object.entries(parsed.options.metadata)) {
        metadata[key.toLowerCase()] = value;
      }
    }
    metadata[PUBLIC_METADATA_FLAG] = isPublic ? "true" : "false";

    let body: Buffer | Readable = parsed.content;
    let size: number | undefined;
    let counter: CountingStream | undefined;

    if (Buffer.isBuffer(parsed.content)) {
      size = parsed.content.byteLength;
    } else {
      const source = parsed.content as Readable;
      counter = new CountingStream();
      source.once("error", (err) => counter?.destroy(err));
      counter.once("error", (err) => source.destroy(err));
      source.pipe(counter);
      body = counter;
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: parsed.key,
      Body: body,
      ContentType: parsed.options.contentType,
      Metadata: metadata,
    });

    // Hard deadline over the whole upload, SDK retries included: the SDK's
    // own timeouts do not bound a stalled transfer (see request-timeouts.ts).
    const deadline = startDeadline("putObject", this.timeouts.writeDeadlineMs);
    try {
      // The counter has error listeners wired to the caller's source
      // stream (above), so at the deadline it is destroyed WITH the error and
      // the source is torn down too.
      const result = await deadline.race(
        this.client.send(command, { abortSignal: deadline.signal }),
        counter,
        true,
      );
      const etag = result.ETag?.replace(/"/g, "") ?? undefined;
      const url = isPublic
        ? `${this.publicBaseUrl}/${parsed.key}`
        : await this.signGetUrl(parsed.key, 900);

      if (!size && counter) {
        size = counter.bytes;
      }

      return {
        url,
        etag,
        size,
      };
    } catch (error) {
      this.logError("putObject", error, { deadlineExceeded: deadline.expired });
      if (deadline.expired) throw deadline.error();
      throw mapS3Error(error);
    } finally {
      deadline.clear();
    }
  }

  async getObjectUrl(
    input: FileStorageGetObjectUrlInput,
  ): Promise<FileStorageGetObjectUrlOutput> {
    const parsed = parseInput(fileStorageGetObjectUrlInputSchema, input);
    const { key } = parsed;

    const head = await this.headObjectInternal(key);
    if (!head) {
      throw createFileStorageError("not_found", "object_not_found");
    }

    // The caller knows the object was presigned as public; trust that over the
    // stored metadata flag, which may not have round-tripped from the browser.
    const isPublic = parsed.options.public === true || isMarkedPublic(head);
    if (isPublic) {
      if (!this.publicBaseUrl) {
        throw createFileStorageError(
          "invalid_input",
          "public_base_url_not_configured",
        );
      }
      return { url: `${this.publicBaseUrl}/${key}` };
    }

    const expires = parsed.options.expiresSec;
    if (!expires) {
      throw createFileStorageError(
        "invalid_input",
        "expires_required_for_private_object",
      );
    }

    return { url: await this.signGetUrl(key, expires) };
  }

  async deleteObject(
    input: FileStorageDeleteObjectInput,
  ): Promise<FileStorageDeleteObjectOutput> {
    const parsed = parseInput(fileStorageDeleteObjectInputSchema, input);
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: parsed.key,
    });
    try {
      await this.client.send(command);
      return { ok: true } as const;
    } catch (error) {
      this.logError("deleteObject", error);
      const mapped = mapS3Error(error);
      if (mapped.code === "not_found") {
        return { ok: true } as const;
      }
      throw mapped;
    }
  }

  async headObject(
    input: FileStorageHeadObjectInput,
  ): Promise<FileStorageHeadObjectOutput> {
    const parsed = parseInput(fileStorageHeadObjectInputSchema, input);
    const head = await this.headObjectInternal(parsed.key);
    if (!head) {
      return { exists: false };
    }

    return {
      exists: true,
      size: head.ContentLength ?? undefined,
      contentType: head.ContentType ?? undefined,
      etag: head.ETag?.replace(/"/g, "") ?? undefined,
      lastModified: head.LastModified ?? undefined,
      ...(head.Metadata ? { metadata: lowerCaseKeys(head.Metadata) } : {}),
    };
  }

  // Raw-byte fetch used by the image-moderation worker to base64-encode an
  // object for the provider. R2 is S3-compatible, so this mirrors the S3
  // adapter's GetObject implementation exactly.
  async getObject(
    input: FileStorageGetObjectInput,
  ): Promise<FileStorageGetObjectOutput> {
    const parsed = parseInput(fileStorageGetObjectInputSchema, input);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: parsed.key,
      // Inclusive on both ends, same as the port's range.
      ...(parsed.range
        ? { Range: `bytes=${parsed.range.start}-${parsed.range.end}` }
        : {}),
    });

    // Hard deadline over the request AND the body read: the SDK's own
    // timeouts stop watching once headers arrive (see request-timeouts.ts).
    // At the deadline the request is aborted and the body stream destroyed.
    const deadline = startDeadline("getObject", this.timeouts.readDeadlineMs);
    try {
      const response = await deadline.race(
        this.client.send(command, { abortSignal: deadline.signal }),
      );
      const content = await deadline.race(
        streamBodyToBuffer(response.Body),
        response.Body,
      );
      return {
        content,
        contentType: response.ContentType ?? undefined,
        size: response.ContentLength ?? content.byteLength,
      };
    } catch (error) {
      this.logError("getObject", error, { deadlineExceeded: deadline.expired });
      if (deadline.expired) throw deadline.error();
      throw mapS3Error(error);
    } finally {
      deadline.clear();
    }
  }

  async listObjects(
    input: FileStorageListObjectsInput,
  ): Promise<FileStorageListObjectsOutput> {
    const parsed = parseInput(fileStorageListObjectsInputSchema, input);
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: parsed.prefix || undefined,
      ContinuationToken: parsed.cursor,
      MaxKeys: parsed.limit,
    });

    try {
      const response = await this.client.send(command);
      const contents = (response.Contents ?? []) as S3ListObject[];
      const keys = contents.flatMap((item: S3ListObject) => {
        const key = item.Key;
        if (!key)
          return [] as Array<{
            key: string;
            size?: number;
            lastModified?: Date;
          }>;
        return [
          {
            key,
            size: item.Size ?? undefined,
            lastModified: item.LastModified ?? undefined,
          },
        ];
      });

      return {
        keys,
        nextCursor: response.NextContinuationToken ?? undefined,
      };
    } catch (error) {
      this.logError("listObjects", error);
      throw mapS3Error(error);
    }
  }

  async presignPutObject(
    input: FileStoragePresignPutObjectInput,
  ): Promise<FileStoragePresignPutObjectOutput> {
    const parsed = parseInput(fileStoragePresignPutObjectInputSchema, input);
    const isPublic = parsed.public ?? this.defaultPublic;
    if (isPublic && !this.publicBaseUrl) {
      throw createFileStorageError(
        "invalid_input",
        "public_base_url_not_configured",
      );
    }

    const metadata: Record<string, string> = {};
    if (parsed.metadata) {
      for (const [key, value] of Object.entries(parsed.metadata)) {
        metadata[key.toLowerCase()] = value;
      }
    }
    metadata[PUBLIC_METADATA_FLAG] = isPublic ? "true" : "false";
    // Best-effort record of the declared size (signed into the URL, so the
    // client can't alter it). Finalize paths read it back via headObject; a
    // store that drops presign-time metadata just leaves them on the kind's
    // max, and the signed Content-Length below is the hard bound.
    metadata[FILE_STORAGE_DECLARED_BYTES_METADATA_KEY] = String(
      parsed.sizeBytes,
    );

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: parsed.key,
      ContentType: parsed.contentType,
      // When provided, Content-Disposition is signed into the URL (headers on
      // the command are signed by default) — the client's PUT MUST send a
      // matching `Content-Disposition` header or the signature check fails.
      ...(parsed.contentDisposition
        ? { ContentDisposition: parsed.contentDisposition }
        : {}),
      // Signed as a header (content-length is not in the SDK's unsignable
      // set), so the PUT must carry exactly `sizeBytes` bytes or the store
      // rejects the signature. Browsers derive Content-Length from the Blob
      // and scripts cannot override it, so an honest uploader passes
      // `file.size`. Without this a 1-byte declaration could carry a
      // multi-GB body past the storage quota (F11, 2026-09-29).
      ContentLength: parsed.sizeBytes,
      Metadata: metadata,
    });

    const expires = parsed.options.expiresSec ?? 900;

    try {
      const uploadUrl = await getSignedUrl(this.client, command, {
        expiresIn: expires,
      });
      return { uploadUrl };
    } catch (error) {
      this.logError("presignPutObject", error);
      throw mapS3Error(error);
    }
  }

  async moveObject(
    input: FileStorageMoveObjectInput,
  ): Promise<FileStorageMoveObjectOutput> {
    const parsed = parseInput(fileStorageMoveObjectInputSchema, input);
    const { fromKey, toKey } = parsed;

    if (fromKey === toKey) {
      return { ok: true } as const;
    }

    // Ensure source exists and capture current metadata/visibility.
    const head = await this.headObjectInternal(fromKey);
    if (!head) {
      throw createFileStorageError("not_found", "object_not_found");
    }

    const sourceMetadata = head.Metadata ?? {};
    const sourceIsPublic = isMarkedPublic(head);

    const destIsPublic = parsed.options.public ?? sourceIsPublic;
    if (destIsPublic && !this.publicBaseUrl) {
      throw createFileStorageError(
        "invalid_input",
        "public_base_url_not_configured",
      );
    }

    // Merge/override metadata while keeping our public flag consistent.
    const mergedMetadata: Record<string, string> = {
      ...sourceMetadata,
      ...(parsed.options.metadata
        ? Object.fromEntries(
            Object.entries(parsed.options.metadata).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ]),
          )
        : {}),
    };
    mergedMetadata[PUBLIC_METADATA_FLAG] = destIsPublic ? "true" : "false";

    const contentType =
      parsed.options.contentType ?? head.ContentType ?? undefined;

    const command = new CopyObjectCommand({
      Bucket: this.bucket,
      Key: toKey,
      CopySource: `${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
      MetadataDirective: "REPLACE",
      Metadata: mergedMetadata,
      ContentType: contentType,
    });

    try {
      await this.client.send(command);
      await this.deleteObject({ key: fromKey });
      return { ok: true } as const;
    } catch (error) {
      this.logError("moveObject", error);
      throw mapS3Error(error);
    }
  }

  private async headObjectInternal(
    key: string,
  ): Promise<HeadObjectCommandOutput | null> {
    const command = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
    // Same hard ceiling as a read: a HEAD that never answers must not hold
    // its caller (finalize HEADs before taking a strip slot).
    const deadline = startDeadline("headObject", this.timeouts.readDeadlineMs);
    try {
      return await deadline.race(
        this.client.send(command, { abortSignal: deadline.signal }),
      );
    } catch (error) {
      if (deadline.expired) {
        this.logError("headObject", error, { deadlineExceeded: true });
        throw deadline.error();
      }
      const mapped = mapS3Error(error);
      if (mapped.code === "not_found") {
        return null;
      }
      this.logError("headObject", error, { deadlineExceeded: false });
      throw mapped;
    } finally {
      deadline.clear();
    }
  }

  private async signGetUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error) {
      this.logError("signGetUrl", error);
      throw mapS3Error(error);
    }
  }

  private logError(
    operation: string,
    error: unknown,
    extra?: { deadlineExceeded: boolean },
  ) {
    this.logger?.error("r2_adapter_error", { err: error, op: operation, ...extra });
  }
}

/**
 * Collects a GetObject `Body` (SDK v3 streaming payload) into a Buffer. Handles
 * the SDK's `transformToByteArray()` helper (Node + browser runtimes) and falls
 * back to Node stream / typed-array / string bodies for test doubles.
 */
const streamBodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray: unknown }).transformToByteArray ===
      "function"
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }
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
  throw createFileStorageError("dependency_failed", "unsupported_body_type");
};

const isMarkedPublic = (head: HeadObjectCommandOutput): boolean => {
  const metadata = head.Metadata ?? {};
  const flag =
    metadata[PUBLIC_METADATA_FLAG] ??
    metadata[PUBLIC_METADATA_FLAG.toLowerCase()];
  return flag === "true";
};

function lowerCaseKeys(
  metadata: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}
