import type {
  AttachAudioUploadsInput,
  AudioUploadRecord,
  CreateAudioUploadInput,
  DetachAudioUploadsInput,
  MarkAudioFailedInput,
  MarkAudioTranscodedInput,
  MarkAudioTranscodingInput,
  MarkAudioUploadedInput,
  SoftDeleteAudioUploadsInput,
} from "@th/types/repos/audio-uploads";

export interface AudioUploadsRepo {
  /**
   * Create a new audio upload placeholder (before upload).
   */
  create(input: CreateAudioUploadInput): Promise<AudioUploadRecord>;

  /**
   * Get a single audio upload by ID.
   */
  getById(id: string): Promise<AudioUploadRecord | null>;

  /**
   * Resolve multiple audio uploads by IDs in a single query.
   */
  resolveByIds(ids: string[]): Promise<AudioUploadRecord[]>;

  /**
   * Mark an audio upload as uploaded (source file received).
   */
  markUploaded(input: MarkAudioUploadedInput): Promise<AudioUploadRecord>;

  /**
   * Mark an audio upload as transcoding (processing started).
   */
  markTranscoding(input: MarkAudioTranscodingInput): Promise<AudioUploadRecord>;

  /**
   * Mark an audio upload as transcoded (HLS files ready).
   */
  markTranscoded(input: MarkAudioTranscodedInput): Promise<AudioUploadRecord>;

  /**
   * Mark an audio upload as failed.
   */
  markFailed(input: MarkAudioFailedInput): Promise<AudioUploadRecord>;

  /**
   * Attach audio uploads to an event's content.
   */
  attach(input: AttachAudioUploadsInput): Promise<void>;

  /**
   * Detach audio uploads from an event's content.
   */
  detach(input: DetachAudioUploadsInput): Promise<void>;

  /**
   * Soft-delete audio uploads (marks deletedAt).
   */
  softDelete(input: SoftDeleteAudioUploadsInput): Promise<void>;

  /**
   * List all audio uploads for an event.
   */
  listByEventId(eventId: string): Promise<AudioUploadRecord[]>;

  /**
   * List every audio upload attached to an event via the `eventId` FK,
   * INCLUDING soft-deleted rows.
   *
   * Used by event deletion to reclaim object storage. The `AudioUpload.event`
   * relation is `onDelete: Cascade`, so deleting the event hard-deletes its
   * soft-deleted AudioUpload rows immediately. The orphan sweep
   * (`listSoftDeleted`) requires the soft-deleted row to still exist, so it can
   * never reclaim a cascade-deleted upload — callers cleaning up storage on
   * event delete must therefore see soft-deleted rows here regardless of
   * `deletedAt`. Do NOT use this for editor-facing reads (use
   * {@link listByEventId}, which excludes deleted rows).
   */
  listByEventIdIncludingDeleted(
    eventId: string,
  ): Promise<AudioUploadRecord[]>;

  /**
   * List audio uploads pending transcoding.
   * Used by the transcoder to pick up work.
   */
  listPendingTranscode(input: { limit: number }): Promise<AudioUploadRecord[]>;

  /** List uploads stuck in PENDING or UPLOADED status older than cutoff. */
  listStalled(input: {
    olderThan: Date;
    limit: number;
  }): Promise<AudioUploadRecord[]>;

  // NOTE: there is deliberately no `listDetached` here. It selected on
  // `attached: false`, which nothing outside the seed script ever sets, so it
  // returned every live upload and the storage sweep deleted audio that events
  // were still playing. Audio is reachable for as long as its event exists
  // (`eventId` is NOT NULL and cascades, and `resolveEventAudio` lists every
  // non-soft-deleted row), so there is no orphan class for a sweep to collect —
  // event deletion enqueues its own blobs. Do not reintroduce this.

  /** List soft-deleted records older than cutoff (for hard-delete). */
  listSoftDeleted(input: {
    deletedBefore: Date;
    limit: number;
  }): Promise<AudioUploadRecord[]>;

  /** Permanently remove a record from the database. */
  hardDelete(id: string): Promise<void>;
}

export type {
  AttachAudioUploadsInput,
  AudioUploadRecord,
  CreateAudioUploadInput,
  DetachAudioUploadsInput,
  MarkAudioFailedInput,
  MarkAudioTranscodedInput,
  MarkAudioTranscodingInput,
  MarkAudioUploadedInput,
  SoftDeleteAudioUploadsInput,
} from "@th/types/repos/audio-uploads";
