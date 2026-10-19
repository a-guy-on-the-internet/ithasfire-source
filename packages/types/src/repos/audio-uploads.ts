/**
 * AudioUpload records used by AudioUploadsRepo
 */

export type AudioUploadStatus =
  | "PENDING"
  | "UPLOADED"
  | "TRANSCODING"
  | "READY"
  | "FAILED";

export interface AudioUploadRecord {
  id: string;
  eventId: string;

  // Source file info
  sourceKey: string;
  /**
   * LEGACY / DO NOT READ. Historically held a presigned URL for the private
   * source object, minted with a 7-day expiry at finalize and never refreshed
   * — so every event's audio 404'd a week after upload. Nothing writes a URL
   * here any more and no read path consults it; `resolveEventAudio` signs a
   * short-lived URL from `sourceKey` on demand instead. Existing rows still
   * carry long-expired strings.
   */
  sourceUrl: string;
  sourceContentType: string | null;
  sourceSizeBytes: bigint | null;

  // HLS output (populated after transcoding)
  hlsPlaylistKey: string | null;
  hlsPlaylistUrl: string | null;
  segmentCount: number | null;
  durationSeconds: number | null;
  waveformPeaks: number[] | null;

  // Status tracking
  status: AudioUploadStatus;
  uploadedAt: Date | null;
  transcodedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;

  // Attachment tracking
  attached: boolean;
  attachedAt: Date | null;
  detachedAt: Date | null;
  deletedAt: Date | null;

  // Ownership
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAudioUploadInput {
  id: string;
  eventId: string;
  sourceKey: string;
  sourceUrl: string;
  sourceContentType: string | null;
  sourceSizeBytes: bigint | null;
  createdByHumanId: string;
}

export interface MarkAudioUploadedInput {
  id: string;
  uploadedAt: Date;
  /**
   * DEPRECATED — leave unset. A URL for the private source object is a
   * presigned, expiring credential and must not be persisted; see the note on
   * `AudioUploadRecord.sourceUrl`. Retained only so the field's absence is a
   * deliberate choice rather than a signature change.
   */
  sourceUrl?: string;
}

export interface MarkAudioTranscodingInput {
  id: string;
}

export interface MarkAudioTranscodedInput {
  id: string;
  hlsPlaylistUrl: string;
  hlsPlaylistKey: string;
  segmentCount: number;
  durationSeconds: number;
  transcodedAt: Date;
  waveformPeaks?: number[];
}

export interface MarkAudioFailedInput {
  id: string;
  failedAt: Date;
  failureReason: string;
}

export interface AttachAudioUploadsInput {
  eventId: string;
  audioUploadIds: string[];
  attachedAt: Date;
}

export interface DetachAudioUploadsInput {
  eventId: string;
  audioUploadIds: string[];
  detachedAt: Date;
}

export interface SoftDeleteAudioUploadsInput {
  audioUploadIds: string[];
  deletedAt: Date;
}
