/**
 * @deprecated Import from `@th/adapters/file-storage/s3` instead.
 * This re-export exists only for backward compatibility during the rename migration.
 */
export {
  S3FileStorageAdapter,
  S3FileStorageAdapter as CloudflareR2Adapter,
  type S3FileStorageAdapterOptions,
  type S3FileStorageAdapterOptions as CloudflareR2AdapterOptions,
} from "../s3/s3-adapter";
