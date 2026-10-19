/**
 * Generic Image records used by ImagesRepo.
 *
 * Images are owned by an entity (event, org, etc.) identified by
 * ownerType + ownerId.  For EVENT images the optional eventId FK
 * preserves cascade-delete behaviour.
 */

export type ImageOwnerType = "EVENT" | "ORG";

export interface ImageRecord {
  id: string;
  ownerType: ImageOwnerType;
  ownerId: string;
  eventId: string | null;
  key: string;
  publicUrl: string;
  contentType: string | null;
  sizeBytes: bigint | null;
  /**
   * Pixel size as the browser displays it (EXIF orientation applied), read
   * from the file header at finalize. Null when unknown: rows from before
   * 2026-10, or a header the parser could not read.
   */
  width: number | null;
  height: number | null;
  uploadedAt: Date | null;
  attached: boolean;
  attachedAt: Date | null;
  detachedAt: Date | null;
  deletedAt: Date | null;
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The primary (first-attached, non-deleted) image for an event, as returned by
 * {@link ImagesRepo.getPrimaryImageRefs}. Carries the R2 storage `key` alongside
 * the `publicUrl` so public read paths can run the moderation visibility gate
 * (which is keyed by storage key) before surfacing the url.
 */
export interface PrimaryImageRef {
  publicUrl: string;
  /** R2 storage key — the join key for read-time moderation gating. */
  key: string;
}

export interface CreateImageInput {
  id: string;
  ownerType: ImageOwnerType;
  ownerId: string;
  /** Set when ownerType === "EVENT" for cascade-delete FK. */
  eventId?: string | null;
  key: string;
  publicUrl: string;
  contentType: string | null;
  sizeBytes: bigint | null;
  createdByHumanId: string;
}

export interface MarkImageUploadedInput {
  id: string;
  uploadedAt: Date;
  /**
   * Storage key of the bytes being published. Finalize passes the key of the
   * metadata-stripped copy, which differs from the key the client uploaded
   * to (the row's key at create); a caller that wrote the final bytes itself
   * passes the key it created the row with.
   */
  key: string;
  /** Resolved public URL for the uploaded image (the object at `key`). */
  publicUrl: string;
  /**
   * Header-read pixel size. Omitted (or null) leaves the column as it is;
   * finalize passes both or neither.
   */
  width?: number | null;
  height?: number | null;
}

export interface AttachImagesInput {
  ownerId: string;
  imageIds: string[];
  attachedAt: Date;
}

export interface DetachImagesInput {
  ownerId: string;
  imageIds: string[];
  detachedAt: Date;
}

export interface SoftDeleteImagesInput {
  imageIds: string[];
  deletedAt: Date;
}
