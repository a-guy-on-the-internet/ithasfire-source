import type { TxRepos } from "@th/ports/repos";
import type {
  QuotaSubjectType,
  ResourceLimitKind,
} from "@th/types/repos/resource-quotas";

/**
 * Shared object-storage cleanup helpers for event lifecycle paths.
 *
 * Both deleteEvent (hard cascade) and cancelEvent need to identify the storage
 * keys/prefixes an event owns and route them through the pending-object-deletion
 * outbox. Centralising the HLS-prefix derivation + media collection here keeps
 * the two paths producing identical targets — drift between "delete" and
 * "cancel" cleanup is exactly how blobs leak.
 */

/** The storage-quota subject (org or human) that owns an event's bytes. */
export interface EventStorageQuotaSubject {
  subjectType: QuotaSubjectType;
  subjectId: string;
  kind: ResourceLimitKind;
}

/**
 * Resolves the `STORAGE_BYTES_*` quota subject that owns an event's media bytes
 * — orgId → ORG, else humanId → HUMAN, else null. This MUST mirror the
 * upload-side increment (request-event-audio-upload / request-event-image-upload)
 * so a delete credits back exactly what the upload charged. Images store
 * `ownerType:"EVENT"`, so the subject is never on the image row — it always
 * comes from the event.
 */
export function eventStorageQuotaSubject(event: {
  orgId: string | null;
  humanId: string | null;
}): EventStorageQuotaSubject | null {
  if (event.orgId) {
    return {
      subjectType: "ORG",
      subjectId: event.orgId,
      kind: "STORAGE_BYTES_ORG",
    };
  }
  if (event.humanId) {
    return {
      subjectType: "HUMAN",
      subjectId: event.humanId,
      kind: "STORAGE_BYTES_HUMAN",
    };
  }
  return null;
}

/** The set of storage keys/prefixes a piece of media owns. */
export interface EventMediaDeletionTargets {
  /** Exact keys to delete (audio source files + image objects). */
  exactKeys: string[];
  /** Prefixes to list-and-delete (HLS playlist + segment "folders"). */
  prefixes: string[];
}

/** Audio targets plus the audio_upload row ids and freed bytes they came from. */
export interface EventAudioDeletionTargets extends EventMediaDeletionTargets {
  /** audio_upload ids collected (so callers can soft-delete the rows). */
  audioUploadIds: string[];
  /** Σ of the collected uploads' `sourceSizeBytes` (null treated as 0n). */
  audioBytes: bigint;
}

/** Media targets plus the freed bytes, split by media type. */
export interface EventMediaDeletionTargetsWithBytes
  extends EventMediaDeletionTargets {
  /** Σ of the collected audio uploads' `sourceSizeBytes`. */
  audioBytes: bigint;
  /** Σ of the collected images' `sizeBytes`. */
  imageBytes: bigint;
}

/**
 * Strips the trailing `/audio.m3u8` (the playlist filename) from an HLS
 * playlist key to derive the parent "folder" prefix that holds the playlist
 * plus every `.ts` segment. Returns null when the key has no parent segment.
 */
export function deriveHlsPrefix(hlsPlaylistKey: string): string | null {
  const lastSlash = hlsPlaylistKey.lastIndexOf("/");
  if (lastSlash <= 0) {
    // Defensive: real transcoder keys are always nested under an
    // `events/{eventId}/audio/{id}/` folder, so this branch isn't expected in
    // practice. Returning null lets the caller fall back to deleting the
    // playlist key directly rather than scoping a useless root-level scan.
    return null;
  }
  // Include the trailing slash so list/delete is scoped to this folder.
  return `${hlsPlaylistKey.slice(0, lastSlash)}/`;
}

/**
 * Reads the event's audio uploads (INCLUDING soft-deleted rows) and resolves
 * the storage keys/prefixes they own, plus the row ids.
 *
 * Includes soft-deleted uploads: `AudioUpload.event` is `onDelete: Cascade`, so
 * deleting the event hard-deletes any soft-deleted rows immediately. The orphan
 * sweep reclaims soft-deleted audio via `listSoftDeleted`, which needs the row
 * to still exist — it can never see a cascade-deleted row, so its sourceKey +
 * HLS folder would leak forever unless collected here. The audio source file
 * lives under the shared `uploads/audio/` prefix and is deleted by EXACT key
 * (never prefix-wipe that). The transcoded playlist + all segments live
 * together under the playlist's parent folder, so that folder is a PREFIX
 * target to catch every `.ts` segment.
 *
 * MUST run while the rows still exist (inside the tx, before any cascade).
 */
export async function collectEventAudioDeletionTargets(
  repos: Pick<TxRepos, "audioUploads">,
  eventId: string,
): Promise<EventAudioDeletionTargets> {
  const exactKeys: string[] = [];
  const prefixes: string[] = [];
  const audioUploadIds: string[] = [];
  let audioBytes = 0n;

  const audioUploads =
    await repos.audioUploads.listByEventIdIncludingDeleted(eventId);
  for (const audio of audioUploads) {
    audioUploadIds.push(audio.id);
    // Quota bytes are LIVE-only: an already-soft-deleted row had its bytes
    // credited back when the sweep soft-deleted it, so re-crediting here (the
    // event later deletes/cancels within the ~7-day hard-delete window) would
    // double-credit. No `deletedAt` at read time means "being removed for the
    // first time now" → credit once. Enqueue + soft-delete coverage below
    // intentionally spans ALL rows (idempotent), so blobs never leak.
    if (!audio.deletedAt) {
      audioBytes += audio.sourceSizeBytes ?? 0n;
    }
    if (audio.sourceKey) {
      exactKeys.push(audio.sourceKey);
    }
    if (audio.hlsPlaylistKey) {
      const prefix = deriveHlsPrefix(audio.hlsPlaylistKey);
      if (prefix) {
        prefixes.push(prefix);
      } else {
        // No parent folder to scope a prefix scan — delete the playlist key
        // directly so it isn't leaked.
        exactKeys.push(audio.hlsPlaylistKey);
      }
    }
  }

  return { exactKeys, prefixes, audioUploadIds, audioBytes };
}

/**
 * Resolves the full set of storage keys/prefixes an event owns — audio (source
 * + HLS, including soft-deleted) AND images (hero + rich-text content images,
 * including soft-deleted rows, which cascade away with the event regardless of
 * `deletedAt`). Used by deleteEvent's hard cascade.
 *
 * MUST run while the rows still exist (inside the tx).
 */
export async function collectEventMediaDeletionTargets(
  repos: Pick<TxRepos, "audioUploads" | "images">,
  eventId: string,
): Promise<EventMediaDeletionTargetsWithBytes> {
  const audio = await collectEventAudioDeletionTargets(repos, eventId);
  const exactKeys = [...audio.exactKeys];
  const prefixes = [...audio.prefixes];

  // Images (hero + rich-text content images). Enqueue targets span soft-deleted
  // rows too — they cascade away with the event regardless of `deletedAt`. The
  // quota credit is LIVE-only (no `deletedAt`): a soft-deleted image was
  // already credited when the sweep soft-deleted it, so re-crediting would
  // double-credit.
  let imageBytes = 0n;
  const images = await repos.images.listByEventId(eventId);
  for (const image of images) {
    if (!image.deletedAt) {
      imageBytes += image.sizeBytes ?? 0n;
    }
    if (image.key) {
      exactKeys.push(image.key);
    }
  }

  return { exactKeys, prefixes, audioBytes: audio.audioBytes, imageBytes };
}
