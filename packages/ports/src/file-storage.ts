import { Readable } from "node:stream";
import { z } from "zod";

export type FileStorageErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "dependency_failed"
  | "transient";

export type FileStorageError<
  TCode extends FileStorageErrorCode = FileStorageErrorCode,
> = {
  code: TCode;
  message: string;
};

const KEY_MAX_LENGTH = 2048;
const PREFIX_MAX_LENGTH = 1024;
export const FILE_STORAGE_KEY_MAX_LENGTH = KEY_MAX_LENGTH;
export const FILE_STORAGE_PREFIX_MAX_LENGTH = PREFIX_MAX_LENGTH;
export const FILE_STORAGE_DEFAULT_LIST_LIMIT = 100;
export const FILE_STORAGE_MAX_LIST_LIMIT = 1000;

/**
 * Creates a typed {@link FileStorageError} instance.
 */
export function createFileStorageError<TCode extends FileStorageErrorCode>(
  code: TCode,
  message: string,
): FileStorageError<TCode> {
  return { code, message } as const;
}

/**
 * Type guard that checks whether a value is a {@link FileStorageError}.
 */
export function isFileStorageError(error: unknown): error is FileStorageError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    (error as { code: string }).code.length > 0
  );
}

const normalizePath = (
  raw: string,
  { allowEmpty, maxLength }: { allowEmpty: boolean; maxLength: number },
) => {
  if (typeof raw !== "string") {
    throw createFileStorageError("invalid_input", "key_must_be_string");
  }

  const trimmed = raw.trim();
  const sanitized = trimmed.replace(/\\/g, "/");
  const withoutLeadingSlash = sanitized.replace(/^\/+/, "");
  const collapsedSeparators = withoutLeadingSlash.replace(/\/{2,}/g, "/");

  const segments = collapsedSeparators
    .split("/")
    .filter((segment) => segment.length > 0);

  if (!segments.length) {
    if (allowEmpty) {
      return "";
    }
    throw createFileStorageError("invalid_input", "key_empty");
  }

  if (segments.some((segment) => segment === "..")) {
    throw createFileStorageError(
      "invalid_input",
      "key_parent_segment_forbidden",
    );
  }

  const normalized = segments.join("/");

  if (!allowEmpty && normalized.length === 0) {
    throw createFileStorageError("invalid_input", "key_empty");
  }

  if (normalized.length > maxLength) {
    throw createFileStorageError("invalid_input", "key_too_long");
  }

  return normalized;
};

/**
 * Normalizes a storage key by removing leading slashes, collapsing duplicate separators, and
 * rejecting any parent directory traversals.
 *
 * @throws {@link FileStorageError} with `code: "invalid_input"` when the key is malformed.
 */
export const normalizeStorageKey = (rawKey: string): string =>
  normalizePath(rawKey, { allowEmpty: false, maxLength: KEY_MAX_LENGTH });

/**
 * Normalizes a storage prefix. Prefixes may be empty (representing the root namespace).
 *
 * @throws {@link FileStorageError} with `code: "invalid_input"` when the prefix is malformed.
 */
export const normalizeStoragePrefix = (rawPrefix: string): string =>
  normalizePath(rawPrefix, { allowEmpty: true, maxLength: PREFIX_MAX_LENGTH });

const applyNormalization = <T extends string>(
  value: T,
  normalizer: (input: string) => string,
  ctx: z.RefinementCtx,
) => {
  try {
    return normalizer(value);
  } catch (error) {
    if (isFileStorageError(error) && error.code === "invalid_input") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
      return z.NEVER;
    }
    throw error;
  }
};

export const fileStorageKeySchema = z
  .string()
  .max(KEY_MAX_LENGTH)
  .transform((value, ctx) =>
    applyNormalization(value, normalizeStorageKey, ctx),
  );

export const fileStoragePrefixSchema = z
  .string()
  .max(PREFIX_MAX_LENGTH)
  .transform((value, ctx) =>
    applyNormalization(value, normalizeStoragePrefix, ctx),
  );

export const fileStorageMetadataSchema = z.record(z.string(), z.string());

export const fileStoragePutObjectOptionsSchema = z
  .object({
    contentType: z.string().min(1).optional(),
    public: z.boolean().optional(),
    metadata: fileStorageMetadataSchema.optional(),
  })
  .default({});

export const fileStoragePutObjectInputSchema = z.object({
  key: fileStorageKeySchema,
  content: z.union([z.instanceof(Buffer), z.instanceof(Readable)]),
  options: fileStoragePutObjectOptionsSchema,
});

export const fileStoragePutObjectOutputSchema = z.object({
  url: z.string().min(1),
  etag: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
});

export const fileStorageGetObjectUrlOptionsSchema = z
  .object({
    expiresSec: z.number().int().positive().max(604800).optional(),
    /**
     * When true, the adapter returns the public URL directly without inferring
     * visibility from object metadata. Use for objects uploaded via a presigned
     * public PUT, where the `x-amz-meta-th-public` flag may not have
     * round-tripped from the browser. Public readability is bucket-policy
     * driven, so the per-object metadata flag is not authoritative.
     */
    public: z.boolean().optional(),
  })
  .default({});

export const fileStorageGetObjectUrlInputSchema = z.object({
  key: fileStorageKeySchema,
  options: fileStorageGetObjectUrlOptionsSchema,
});

export const fileStorageGetObjectUrlOutputSchema = z.object({
  url: z.string().min(1),
});

export const fileStorageDeleteObjectInputSchema = z.object({
  key: fileStorageKeySchema,
});

export const fileStorageDeleteObjectOutputSchema = z.object({
  ok: z.literal(true),
});

/**
 * A byte range, HTTP-style: `start` and `end` are both INCLUSIVE offsets
 * (`{ start: 0, end: 1023 }` is the first KiB). An `end` past the object's
 * last byte is clamped to it, as S3 does. A `start` at or past the end
 * (including any range on an empty object) is unsatisfiable: S3/R2 answer
 * 416 InvalidRange, which the adapters surface as `invalid_input`, and the
 * in-memory fake throws the same.
 */
export const fileStorageByteRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((r) => r.end >= r.start, {
    message: "range_end_before_start",
    path: ["end"],
  });

export const fileStorageGetObjectInputSchema = z.object({
  key: fileStorageKeySchema,
  /** Read only these bytes instead of the whole object (S3 `Range`). */
  range: fileStorageByteRangeSchema.optional(),
});

export const fileStorageGetObjectOutputSchema = z.object({
  content: z.instanceof(Buffer),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const fileStorageHeadObjectInputSchema = z.object({
  key: fileStorageKeySchema,
});

export const fileStorageHeadObjectOutputSchema = z.object({
  exists: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  etag: z.string().optional(),
  lastModified: z.date().optional(),
  /**
   * User metadata stored on the object (keys lower-cased), when the store
   * reports it. Presigned uploads carry {@link FILE_STORAGE_DECLARED_BYTES_METADATA_KEY}
   * where the store honours presign-time metadata; callers MUST treat it as
   * best-effort (absent on stores that drop query-string metadata).
   */
  metadata: z.record(z.string(), z.string()).optional(),
});

/**
 * Metadata key adapters stamp on presigned PUTs with the declared
 * `sizeBytes`. It is part of the signed URL, so a client cannot change it,
 * but not every S3-compatible store persists presign-time metadata — read it
 * as a hint, never as the only size bound.
 */
export const FILE_STORAGE_DECLARED_BYTES_METADATA_KEY = "th-declared-bytes";

export const fileStorageListObjectsInputSchema = z.object({
  prefix: fileStoragePrefixSchema,
  cursor: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(FILE_STORAGE_MAX_LIST_LIMIT)
    .default(FILE_STORAGE_DEFAULT_LIST_LIMIT),
});

export const fileStorageListObjectsOutputSchema = z.object({
  keys: z.array(
    z.object({
      key: fileStorageKeySchema,
      size: z.number().int().nonnegative().optional(),
      lastModified: z.date().optional(),
    }),
  ),
  nextCursor: z.string().min(1).optional(),
});

export const fileStoragePresignPutObjectOptionsSchema = z
  .object({
    /**
     * Optional TTL for the signed URL. Defaults are adapter-specific.
     */
    expiresSec: z.number().int().positive().max(86_400).optional(),
  })
  .default({});

export const fileStoragePresignPutObjectInputSchema = z.object({
  key: fileStorageKeySchema,
  /**
   * Content-Type the client will send with the PUT request.
   *
   * Adapters SHOULD ensure the signed URL enforces this when possible; callers
   * MUST still validate content types in their own domain boundaries.
   */
  contentType: z.string().min(1),
  /**
   * Optional `Content-Disposition` for the stored object (e.g. `attachment`).
   *
   * When provided, adapters MUST sign it into the presigned URL, which means
   * the client's PUT request MUST include a matching `Content-Disposition`
   * header or the upload fails signature verification. Used as defense in
   * depth for content types that are dangerous to render inline (e.g. SVG:
   * direct navigation downloads instead of executing as a document).
   */
  contentDisposition: z.string().min(1).optional(),
  /**
   * Declared payload size in bytes. S3-compatible adapters sign it into the
   * URL as `Content-Length`, so the client's PUT MUST send exactly this many
   * bytes (browsers set Content-Length from the Blob, so pass `file.size`).
   * Finalize paths still HEAD the object and reject anything larger.
   */
  sizeBytes: z.number().int().positive(),
  /**
   * Whether the uploaded object should be publicly readable.
   *
   * For S3-compatible stores, adapters commonly encode this as metadata and use
   * `publicBaseUrl` for stable public URLs.
   */
  public: z.boolean().optional(),
  /**
   * Base64-encoded SHA-256 checksum of the file, computed client-side.
   *
   * When provided, the presigned URL will enforce this checksum — the PUT
   * request MUST include an `x-amz-checksum-sha256` header with this value.
   * This provides cryptographic integrity verification for browser uploads
   * where the SDK's default CRC32 checksums are not available.
   */
  checksumSHA256: z.string().min(1).optional(),
  metadata: fileStorageMetadataSchema.optional(),
  options: fileStoragePresignPutObjectOptionsSchema,
});

export const fileStoragePresignPutObjectOutputSchema = z.object({
  /** Signed URL the client can PUT bytes to. */
  uploadUrl: z.string().min(1),
});

export const fileStorageMoveObjectOptionsSchema = z
  .object({
    /**
     * Optional override for `Content-Type` on the destination object.
     *
     * When omitted, adapters SHOULD preserve the source object's content type.
     */
    contentType: z.string().min(1).optional(),
    /**
     * Optional override for public visibility on the destination object.
     *
     * When omitted, adapters SHOULD preserve the source object's visibility.
     */
    public: z.boolean().optional(),
    /**
     * Optional metadata merge/override for the destination object.
     *
     * When omitted, adapters SHOULD preserve the source object's metadata.
     */
    metadata: fileStorageMetadataSchema.optional(),
  })
  .default({});

export const fileStorageMoveObjectInputSchema = z.object({
  fromKey: fileStorageKeySchema,
  toKey: fileStorageKeySchema,
  options: fileStorageMoveObjectOptionsSchema,
});

export const fileStorageMoveObjectOutputSchema = z.object({
  ok: z.literal(true),
});

export type FileStoragePutObjectInput = z.infer<
  typeof fileStoragePutObjectInputSchema
>;
export type FileStoragePutObjectOutput = z.infer<
  typeof fileStoragePutObjectOutputSchema
>;
export type FileStorageGetObjectUrlInput = z.infer<
  typeof fileStorageGetObjectUrlInputSchema
>;
export type FileStorageGetObjectUrlOutput = z.infer<
  typeof fileStorageGetObjectUrlOutputSchema
>;
export type FileStorageDeleteObjectInput = z.infer<
  typeof fileStorageDeleteObjectInputSchema
>;
export type FileStorageDeleteObjectOutput = z.infer<
  typeof fileStorageDeleteObjectOutputSchema
>;
export type FileStorageGetObjectInput = z.infer<
  typeof fileStorageGetObjectInputSchema
>;
export type FileStorageGetObjectOutput = z.infer<
  typeof fileStorageGetObjectOutputSchema
>;
export type FileStorageHeadObjectInput = z.infer<
  typeof fileStorageHeadObjectInputSchema
>;
export type FileStorageHeadObjectOutput = z.infer<
  typeof fileStorageHeadObjectOutputSchema
>;
export type FileStorageListObjectsInput = z.infer<
  typeof fileStorageListObjectsInputSchema
>;
export type FileStorageListObjectsOutput = z.infer<
  typeof fileStorageListObjectsOutputSchema
>;
export type FileStoragePresignPutObjectInput = z.infer<
  typeof fileStoragePresignPutObjectInputSchema
>;
export type FileStoragePresignPutObjectOutput = z.infer<
  typeof fileStoragePresignPutObjectOutputSchema
>;
export type FileStorageMoveObjectInput = z.infer<
  typeof fileStorageMoveObjectInputSchema
>;
export type FileStorageMoveObjectOutput = z.infer<
  typeof fileStorageMoveObjectOutputSchema
>;

/**
 * Storage-agnostic interface for managing binary objects such as uploads, ticket assets, and images.
 *
 * Implementations should rely on the exported Zod schemas to validate and normalize inputs prior to
 * interacting with their backing store. All methods MUST be asynchronous and should raise
 * {@link FileStorageError} instances when an operation cannot be fulfilled.
 */
export interface FileStoragePort {
  /**
   * Stores an object at the provided key. Existing objects MUST be overwritten atomically.
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when the key or payload is malformed.
   * - `code: "dependency_failed" | "transient"` when underlying storage cannot complete the write.
   */
  putObject(
    input: FileStoragePutObjectInput,
  ): Promise<FileStoragePutObjectOutput>;

  /**
   * Produces a fetchable URL for the object at the provided key. Private objects SHOULD require a
   * TTL (`expiresSec`) to generate a signed URL. Public objects MAY ignore the TTL parameter and
   * return a stable URL.
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when the key is malformed or required TTL is missing.
   * - `code: "not_found"` when the object does not exist.
   * - `code: "dependency_failed" | "transient"` when URL resolution fails.
   */
  getObjectUrl(
    input: FileStorageGetObjectUrlInput,
  ): Promise<FileStorageGetObjectUrlOutput>;

  /**
   * Removes the object associated with the key. The operation MUST be idempotent; deleting a missing
   * object should succeed with `{ ok: true }`.
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when the key is malformed.
   * - `code: "dependency_failed" | "transient"` on storage errors.
   */
  deleteObject(
    input: FileStorageDeleteObjectInput,
  ): Promise<FileStorageDeleteObjectOutput>;

  /**
   * Fetches lightweight metadata for the specified object without returning its content.
   *
   * @throws {@link FileStorageError} with `code: "invalid_input"` when the key is malformed.
   */
  headObject(
    input: FileStorageHeadObjectInput,
  ): Promise<FileStorageHeadObjectOutput>;

  /**
   * Fetches the full raw bytes of the object at the provided key, along with its
   * content type and size when the store reports them. Used by out-of-band
   * workers that must read an object's contents (e.g. image moderation
   * base64-encoding the bytes for the provider).
   *
   * With `range`, only those bytes are fetched and returned in `content`
   * (fewer when the object ends first), and `size` is the length of what came
   * back, not of the whole object. Used to read an image header without
   * pulling a 25 MB upload. Implementations MUST honour it rather than read
   * the whole object and slice.
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when the key or range is malformed.
   * - `code: "not_found"` when the object does not exist.
   * - `code: "dependency_failed" | "transient"` on storage errors.
   */
  getObject(
    input: FileStorageGetObjectInput,
  ): Promise<FileStorageGetObjectOutput>;

  /**
   * Lists object keys by prefix. The method MUST honor `limit` (defaulting to 100) and return a
   * `nextCursor` token when more items are available. Cursors MUST be opaque to callers.
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when the prefix, cursor, or limit are malformed.
   */
  listObjects(
    input: FileStorageListObjectsInput,
  ): Promise<FileStorageListObjectsOutput>;

  /**
   * Produces a signed, time-limited URL for uploading an object via HTTP PUT.
   *
   * Callers MUST upload with the exact `contentType` and exactly the
   * declared `sizeBytes` (signed as `Content-Length` where supported).
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when the key or parameters are malformed.
   * - `code: "dependency_failed" | "transient"` when underlying storage cannot create a signed URL.
   */
  presignPutObject(
    input: FileStoragePresignPutObjectInput,
  ): Promise<FileStoragePresignPutObjectOutput>;

  /**
   * Moves/renames an object from `fromKey` to `toKey`.
   *
   * Semantics:
   * - MUST be idempotent when `fromKey === toKey` (no-op).
   * - MUST overwrite any existing object at `toKey`.
   * - SHOULD preserve content type and metadata unless overridden via `options`.
   * - SHOULD behave like copy+delete when the underlying store lacks atomic renames.
   *
   * @throws {@link FileStorageError} with:
   * - `code: "invalid_input"` when keys/options are malformed.
   * - `code: "not_found"` when the source key does not exist.
   * - `code: "dependency_failed" | "transient"` on storage errors.
   */
  moveObject(
    input: FileStorageMoveObjectInput,
  ): Promise<FileStorageMoveObjectOutput>;
}
