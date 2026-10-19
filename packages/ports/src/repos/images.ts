import type {
  AttachImagesInput,
  CreateImageInput,
  DetachImagesInput,
  ImageOwnerType,
  ImageRecord,
  MarkImageUploadedInput,
  PrimaryImageRef,
  SoftDeleteImagesInput,
} from "@th/types/repos/images";

export interface ImagesRepo {
  /**
   * Create a new image placeholder (before upload).
   */
  create(input: CreateImageInput): Promise<ImageRecord>;

  /**
   * Get a single image by ID.
   */
  getById(id: string): Promise<ImageRecord | null>;

  /**
   * Resolve multiple images by IDs in a single query.
   */
  resolveByIds(ids: string[]): Promise<ImageRecord[]>;

  /**
   * Mark an image as uploaded: sets uploadedAt, publicUrl and the storage
   * key the image is now served from (finalize moves it to the
   * metadata-stripped copy).
   *
   * CONDITIONAL on the row being neither uploaded nor deleted yet: returns
   * the updated row, or null when it was already marked (a concurrent
   * finalize won), was retired (soft-deleted), or does not exist. The caller
   * decides what losing means.
   */
  markUploaded(input: MarkImageUploadedInput): Promise<ImageRecord | null>;

  /**
   * Attach images to their owner's content (referenced in ProseMirror doc).
   */
  attach(input: AttachImagesInput): Promise<void>;

  /**
   * Detach images from their owner's content (no longer referenced).
   */
  detach(input: DetachImagesInput): Promise<void>;

  /**
   * Soft-delete images (marks deletedAt).
   */
  softDelete(input: SoftDeleteImagesInput): Promise<void>;

  /**
   * Soft-delete ONE image only if it was never finalized and is not already
   * deleted (`uploadedAt` and `deletedAt` both null). Returns whether this
   * call did it, so a caller crediting quota back for the row does so exactly
   * once however many requests race. Finalize uses it to retire an upload it
   * refused, so the same upload cannot be finalized (and refused) again.
   */
  softDeleteIfUnfinalized(input: { id: string; deletedAt: Date }): Promise<boolean>;

  /**
   * List all images for a given owner.
   */
  listByOwner(
    ownerType: ImageOwnerType,
    ownerId: string,
  ): Promise<ImageRecord[]>;

  /**
   * List every image attached to an event via the `eventId` FK, INCLUDING
   * soft-deleted rows. These all cascade-delete with the event, so callers
   * cleaning up the underlying storage objects must see them regardless of
   * their `deletedAt` state.
   */
  listByEventId(eventId: string): Promise<ImageRecord[]>;

  // NOTE: there is deliberately no `listOrphaned` here. It selected
  // `attached: false AND uploadedAt != null AND createdAt < olderThan` — the
  // exact predicate that made the storage sweep delete every live organizer
  // upload 24h after it landed (prod, 2026-08-08). `attached` is set by
  // nothing but the seed script, so it never described orphanhood. Reachability
  // is computed from the event's own hero FK / body / pending suggestions; see
  // `listSweepCandidates` and `sweepOrphanedUploads`. Do not reintroduce this.

  /**
   * Get the primary (hero, non-deleted, finalized) image for multiple events.
   * Returns a map of eventId -> { publicUrl, key } (event absent when it has no
   * image). Used for search index building and event listing/card reads.
   *
   * Carries the storage `key` (not just the url) so PUBLIC callers can run the
   * moderation visibility gate (`resolveVisibleImageKeys`) before surfacing the
   * url — a flagged/pending hero must not leak onto a card.
   */
  getPrimaryImageRefs(
    eventIds: string[],
  ): Promise<Map<string, PrimaryImageRef>>;

  /**
   * List images old enough to be CONSIDERED for garbage collection. Does NOT
   * include soft-deleted rows.
   *
   * This is deliberately a candidate query, not an orphan query: age is the
   * only thing the database can decide on its own. Whether a candidate is
   * actually unreferenced is resolved by the caller against the owning event's
   * hero FK and body JSON (see `sweepOrphanedUploads`).
   *
   * It replaced a `attached: false` predicate, which looked like an orphan test
   * but was not one — nothing outside the seed script ever set `attached`, so
   * every genuinely uploaded image matched it and the sweep deleted live media
   * 24h after upload.
   */
  listSweepCandidates(input: {
    /** Only consider images created strictly before this instant. */
    createdBefore: Date;
    limit: number;
    /**
     * Keyset cursor: return only rows ordering strictly after this
     * `(createdAt, id)` pair. REQUIRED for correctness, not just efficiency —
     * referenced images are never soft-deleted, so without a cursor the oldest
     * N live images occupy the window forever and every newer orphan is
     * invisible to the sweep for good.
     */
    after?: { createdAt: Date; id: string } | null;
  }): Promise<ImageRecord[]>;

  /** List soft-deleted records older than cutoff (for hard-delete). */
  listSoftDeleted(input: {
    deletedBefore: Date;
    limit: number;
  }): Promise<ImageRecord[]>;

  /** Permanently remove a record from the database. */
  hardDelete(id: string): Promise<void>;
}

export type {
  AttachImagesInput,
  CreateImageInput,
  DetachImagesInput,
  ImageOwnerType,
  ImageRecord,
  MarkImageUploadedInput,
  PrimaryImageRef,
  SoftDeleteImagesInput,
} from "@th/types/repos/images";
