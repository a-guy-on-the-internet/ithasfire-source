import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "../../lib/errors";
import { fail as appFail } from "@th/errors";
import { verifyUploadedObjectSize } from "../storage/verify-uploaded-object-size";
import { MAX_EVENT_AUDIO_BYTES } from "./request-event-audio-upload";

// ─────────────────────────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────────────────────────

export const finalizeEventAudioUploadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    audioUploadId: z.string().min(1),
  })
  .strict();

export type FinalizeEventAudioUploadInput = z.infer<
  typeof finalizeEventAudioUploadInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schema
// ─────────────────────────────────────────────────────────────────────────────

export const finalizeEventAudioUploadOutputSchema = z.object({
  audioUploadId: z.string().min(1),
  status: z.string().min(1),
});

export type FinalizeEventAudioUploadOutput = z.infer<
  typeof finalizeEventAudioUploadOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional callback to enqueue a transcode job. When not provided (e.g. in
 * tests or environments without the transcoder service), the audio upload is
 * marked as UPLOADED but transcoding is not triggered.
 */
export type EnqueueTranscodeJob = (payload: {
  audioUploadId: string;
  eventId: string;
  sourceKey: string;
  outputPrefix: string;
  deleteSourceOnSuccess: boolean;
}) => Promise<void>;

export type FinalizeEventAudioUploadDeps = {
  /** `events` is read only to branch on stewardship — see the authz block. */
  repos: Pick<Repos, "audioUploads" | "events" | "tx">;
  authz: Pick<AuthZPort, "canEditEvent">;
  // `getObjectUrl` deliberately dropped: finalize no longer mints a source URL
  // (see the note at the markUploaded call). Signing happens per read.
  fileStorage: Pick<FileStoragePort, "headObject" | "deleteObject">;
  logger: LoggerPort;
  enqueueTranscodeJob?: EnqueueTranscodeJob;
  /**
   * Reports the deliberate swallows: a failed delete of an oversize upload,
   * and a failed transcode enqueue (the upload stays UPLOADED).
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finalizes an event audio upload after the client has PUT bytes to R2.
 *
 * Verifies the object exists in R2, marks the AudioUpload record as UPLOADED,
 * and enqueues a transcode job (when the transcoder service is configured).
 */
export const finalizeEventAudioUpload = async (
  deps: FinalizeEventAudioUploadDeps,
  rawInput: unknown,
): Promise<FinalizeEventAudioUploadOutput> => {
  const { repos, authz, fileStorage, logger, enqueueTranscodeJob } = deps;

  // ─── Parse input ───────────────────────────────────────────────────────────
  const parsed = finalizeEventAudioUploadInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "invalid_input",
    );
  }
  const input = parsed.data;

  // ─── Fetch audio upload record ─────────────────────────────────────────────
  const audioUpload = await repos.audioUploads.getById(input.audioUploadId);
  if (!audioUpload) {
    return appFail("AUDIO_UPLOAD_NOT_FOUND");
  }

  // ─── Authorization ─────────────────────────────────────────────────────────
  // COMMUNITY listings: `canEditEvent` always fails for an ownerless row, so
  // finalize is gated on the UPLOADER instead — the same signed-in identity
  // that passed `requestEventAudioUpload`'s moderator+DRAFT gate, was
  // quota-charged, and holds the presigned PUT. Byte-for-byte the rule
  // `finalizeEventImageUpload` already uses for the same reason.
  //
  // Note this does NOT re-probe the staff role: a moderator demoted between
  // request and finalize can still finish an upload they legitimately started.
  // That is the image path's behaviour too, and the blast radius is a track on
  // an invisible DRAFT. The gate that matters is request.
  //
  // OWNED events are unchanged: must be an event editor.
  const event = await repos.events.getById(audioUpload.eventId);
  if (event?.stewardship === "COMMUNITY") {
    if (audioUpload.createdByHumanId !== input.actorHumanId) {
      return appFail("NOT_AUTHORIZED");
    }
  } else {
    const canEdit = await authz.canEditEvent({
      actorHumanId: input.actorHumanId,
      eventId: audioUpload.eventId,
    });
    if (!canEdit.allowed) {
      return appFail("NOT_AUTHORIZED");
    }
  }

  // ─── Check if already finalized ────────────────────────────────────────────
  if (audioUpload.uploadedAt) {
    return {
      audioUploadId: audioUpload.id,
      status: audioUpload.status,
    };
  }

  // ─── Verify object exists in R2, at no more than the declared size ────────
  // `headObject` reports a missing object as `{ exists: false }` rather than
  // throwing, so the old try/catch here never fired and a never-uploaded
  // source was marked UPLOADED. F11: the quota was charged from
  // `sourceSizeBytes`, so a bigger object is deleted and refused.
  const head = await verifyUploadedObjectSize(
    { storage: fileStorage, logger, reportError: deps.reportError },
    {
      key: audioUpload.sourceKey,
      maxBytes: MAX_EVENT_AUDIO_BYTES,
      declaredBytes: audioUpload.sourceSizeBytes,
      context: "finalizeEventAudioUpload",
    },
  );
  if (!head.exists) {
    logger.warn("Audio not found in storage during finalization", {
      audioUploadId: input.audioUploadId,
      key: audioUpload.sourceKey,
    });
    return appFail("UPLOAD_NOT_COMPLETE");
  }

  // ─── Mark as uploaded ──────────────────────────────────────────────────────
  //
  // `sourceUrl` is deliberately NOT written here. The source object is private
  // (`request-event-audio-upload` uploads it with `public: false`), so any URL
  // for it is a presigned, EXPIRING credential. This used to sign one for 7
  // days and persist it to `audio_uploads.sourceUrl` — which meant every
  // event's audio started 404ing exactly one week after upload, forever, with
  // nothing in the code path to refresh it.
  //
  // `resolveEventAudio` now mints a short-lived URL from `sourceKey` on every
  // read instead. There IS a round-trip per read (`getObjectUrl` HEADs the
  // object first), so the reasoning this replaced — "refreshing them on every
  // page load isn't worth the round-trip" — was not wrong about the cost; it
  // was wrong about the trade. The page is ISR-cached, the object count is
  // per-event, and the alternative was storing a credential that outlived its
  // own validity and broke every event's audio a week after upload.
  await repos.audioUploads.markUploaded({
    id: input.audioUploadId,
    uploadedAt: new Date(),
  });

  logger.info("Event audio upload finalized", {
    audioUploadId: input.audioUploadId,
    eventId: audioUpload.eventId,
  });

  // ─── Enqueue transcode job ─────────────────────────────────────────────────
  if (enqueueTranscodeJob) {
    try {
      await enqueueTranscodeJob({
        audioUploadId: audioUpload.id,
        eventId: audioUpload.eventId,
        sourceKey: audioUpload.sourceKey,
        outputPrefix: `events/${audioUpload.eventId}/audio/${audioUpload.id}`,
        // Keep the source mp3 around — non-Safari browsers can't play the
        // HLS playlist natively, so the raw source is the only universally-
        // playable URL we can put in <audio src> until we ship hls.js.
        deleteSourceOnSuccess: false,
      });
      logger.info("Transcode job enqueued", {
        audioUploadId: audioUpload.id,
        eventId: audioUpload.eventId,
      });
    } catch (err) {
      // Log but don't fail — the upload is persisted; transcoding can be
      // retried manually or picked up by a sweep job.
      logger.error("Failed to enqueue transcode job", {
        audioUploadId: audioUpload.id,
        err,
      });
      try {
        deps.reportError?.(err, {
          tags: {
            area: "audio_transcode_enqueue",
            useCase: "finalizeEventAudioUpload",
          },
          extra: {
            audioUploadId: audioUpload.id,
            eventId: audioUpload.eventId,
          },
        });
      } catch {
        // Best-effort reporting must never change the outcome.
      }
    }
  }

  return {
    audioUploadId: audioUpload.id,
    status: "UPLOADED",
  };
};
