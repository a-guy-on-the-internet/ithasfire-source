import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "../../lib/errors";
import { fail as appFail } from "@th/errors";
import { COMMUNITY_MODERATION_ROLES } from "../community/_shared/suggestion-validation";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { eventStorageQuotaSubject } from "../storage/event-media-targets";

// ─────────────────────────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Hard cap for an event audio source upload (enforced again at finalize). */
export const MAX_EVENT_AUDIO_BYTES = 100 * 1024 * 1024;

export const requestEventAudioUploadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    eventId: z.string().min(1),
    /** Content-Type of the audio being uploaded */
    contentType: z
      .string()
      .regex(
        /^audio\/(mpeg|mp3|mp4|x-m4a|wav|ogg|webm|aac)$/,
        "invalid_content_type",
      ),
    /** File size in bytes (max 100 MB) */
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_EVENT_AUDIO_BYTES, "file_too_large"),
    /** Base64-encoded SHA-256 checksum computed client-side for integrity verification */
    checksumSHA256: z.string().min(1).optional(),
  })
  .strict();

export type RequestEventAudioUploadInput = z.infer<
  typeof requestEventAudioUploadInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schema
// ─────────────────────────────────────────────────────────────────────────────

export const requestEventAudioUploadOutputSchema = z.object({
  /** Unique ID for this audio upload record */
  audioUploadId: z.string().min(1),
  /** Presigned URL to upload the audio directly to R2 */
  uploadUrl: z.string().min(1),
  /** R2 object key for the source audio */
  key: z.string().min(1),
});

export type RequestEventAudioUploadOutput = z.infer<
  typeof requestEventAudioUploadOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type RequestEventAudioUploadDeps = {
  repos: Pick<Repos, "events" | "audioUploads" | "tx" | "resourceQuotas">;
  /**
   * `hasStaffRole` is what admits a community MODERATOR to a DRAFT listing's
   * audio (the EventBuilder mounts the audio uploader next to the image one)
   * — see the authorization block.
   */
  authz: Pick<AuthZPort, "canEditEvent" | "hasStaffRole">;
  fileStorage: Pick<FileStoragePort, "presignPutObject">;
  logger: LoggerPort;
  /**
   * Wakes the audio transcoder while the browser PUTs the file, so its cold
   * start (ffmpeg image pull + node boot, ~20-30s) overlaps the upload instead
   * of following it. Prod runs the transcoder at min 0 instances on the
   * strength of this. The upload never fails because of it and waits at most
   * WARM_UP_WAIT_MS for it. Absent = no warm-up (tests, envs with no
   * transcoder).
   */
  warmTranscoder?: () => Promise<void>;
  /** Reports a failed warm-up, the one deliberate swallow here. */
  reportError?: ReporterPort;
};

/**
 * How long the mutation waits for the warm-up before returning anyway. The API
 * runs under request-based billing (cpu_idle = true), so work left running
 * after the response is starved of CPU: an un-awaited publish could sit until
 * the next request and wake the transcoder too late. The warm-up starts before
 * presign and the upload row, so it normally settles inside them and this
 * bound costs nothing; it only caps a slow Pub/Sub token or publish.
 */
export const WARM_UP_WAIT_MS = 2_000;

/**
 * Start the warm-up. The returned promise never rejects: a failure costs only
 * the cold start the warm-up was meant to hide, so it is logged and reported
 * (ReporterPort convention), never thrown. A synchronous throw from
 * `warmTranscoder` and a throwing reporter are both guarded.
 */
function startTranscoderWarmUp(
  deps: Pick<
    RequestEventAudioUploadDeps,
    "warmTranscoder" | "reportError" | "logger"
  >,
  context: { audioUploadId: string; eventId: string },
): Promise<void> {
  const { warmTranscoder } = deps;
  if (!warmTranscoder) return Promise.resolve();

  const onFailure = (err: unknown) => {
    deps.logger.error("Audio transcoder warm-up failed", { err, ...context });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "requestEventAudioUpload", stage: "warm_transcoder" },
        extra: context,
      });
    } catch {
      // A throwing reporter must never change the upload's outcome.
    }
  };

  try {
    return Promise.resolve(warmTranscoder()).catch(onFailure);
  } catch (err) {
    onFailure(err);
    return Promise.resolve();
  }
}

/** Wait for `pending`, but never longer than `ms`. */
async function settleWithin(pending: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([pending, bound]);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requests a presigned URL for uploading event audio directly to R2.
 *
 * Creates an AudioUpload record in PENDING state and returns a presigned URL
 * that the client can PUT bytes to. After the upload completes, the client
 * must call `finalizeEventAudioUpload` to mark it as uploaded and trigger
 * transcoding.
 */
export const requestEventAudioUpload = async (
  deps: RequestEventAudioUploadDeps,
  rawInput: unknown,
): Promise<RequestEventAudioUploadOutput> => {
  const { repos, authz, fileStorage, logger } = deps;

  // ─── Parse input ───────────────────────────────────────────────────────────
  const parsed = requestEventAudioUploadInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "invalid_input",
    );
  }
  const input = parsed.data;

  // ─── Verify event exists ───────────────────────────────────────────────────
  const event = await repos.events.getById(input.eventId);

  // Same indistinguishability discipline as `requestEventImageUpload`: both
  // 404-producing paths ("no such event", "a DRAFT listing you are not a
  // moderator of") do one event read plus one staff probe, so neither is
  // cheaper than the other. The OWNED-event path never calls it.
  const probeCommunityModerator = () =>
    authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });

  if (!event) {
    await probeCommunityModerator();
    return appFail("EVENT_NOT_FOUND");
  }

  // ─── Authorization ─────────────────────────────────────────────────────────
  // OWNED events: must be an event editor (unchanged).
  //
  // COMMUNITY listings had NO branch here at all, which meant audio was
  // refused on every one of them at every status: `canEditEvent` resolves an
  // event's org and then its human owner, and an ownerless row has neither, so
  // it always answered false. The builder mounts the audio uploader alongside
  // the image one, so without this a community listing could carry a body
  // image and never a track.
  //
  // MODERATOR + DRAFT only, deliberately narrower than the image path. Images
  // have the FR-015 any-signed-in-user arm because `heroImageId` is a
  // whitelisted SUGGESTION field, so an outsider's upload lands unattached and
  // waits for approval. Audio has no suggestion field and no approval step —
  // finalize attaches it — so opening it to non-moderators, or to a live
  // listing, would be a content write on a public page outside the moderation
  // queue. That is the same line `community.updateListing` draws.
  //
  // Everyone else keeps the refusal they had, and the two refusals stay
  // distinct on purpose: an OWNED event the actor cannot edit is
  // NOT_AUTHORIZED (the event's existence is not a secret — it is public), a
  // community DRAFT is EVENT_NOT_FOUND (its existence IS the secret).
  if (event.stewardship !== "COMMUNITY") {
    const canEdit = await authz.canEditEvent({
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
    });
    if (!canEdit.allowed) {
      return appFail("NOT_AUTHORIZED");
    }
  } else {
    const moderator = await probeCommunityModerator();
    if (event.status !== "DRAFT" || !moderator.allowed) {
      return appFail("EVENT_NOT_FOUND");
    }
  }

  // ─── Enforce storage quota ──────────────────────────────────────────────────
  // Charged to the EVENT'S OWNER (`eventStorageQuotaSubject`, the subject the
  // delete path credits): a delegate's upload spends the principal's quota.
  // Only an ownerless row falls back to the uploading human.
  const audioQuotaSubject = eventStorageQuotaSubject(event) ?? {
    subjectType: "HUMAN" as const,
    subjectId: input.actorHumanId,
    kind: "STORAGE_BYTES_HUMAN" as const,
  };
  await enforceQuota(repos as any, {
    ...audioQuotaSubject,
    delta: BigInt(input.sizeBytes),
  });

  // ─── Generate storage key ──────────────────────────────────────────────────
  const audioUploadId = crypto.randomUUID();
  const extension =
    input.contentType.split("/")[1]?.replace("mpeg", "mp3") ?? "mp3";
  const key = `uploads/audio/${audioUploadId}.${extension}`;

  // Authorised and within quota: wake the transcoder now, alongside presign and
  // the upload row, so it boots while the browser PUTs the file.
  const warmUp = startTranscoderWarmUp(deps, {
    audioUploadId,
    eventId: input.eventId,
  });

  // ─── Request presigned URL from R2 ─────────────────────────────────────────
  let uploadUrl: string;
  try {
    const presignResult = await fileStorage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: false, // Source audio is private; only HLS output is public
      checksumSHA256: input.checksumSHA256,
      options: {
        expiresSec: 3600, // 1 hour to complete upload
      },
    });
    uploadUrl = presignResult.uploadUrl;
  } catch (err) {
    logger.error("Failed to presign event audio upload", {
      err,
      key,
      eventId: input.eventId,
    });
    return appFail("STORAGE_ERROR", { cause: err });
  }

  // ─── Create AudioUpload record in pending state ────────────────────────────
  await repos.audioUploads.create({
    id: audioUploadId,
    eventId: input.eventId,
    sourceKey: key,
    sourceUrl: "", // Will be resolved after finalization
    sourceContentType: input.contentType,
    sourceSizeBytes: BigInt(input.sizeBytes),
    createdByHumanId: input.actorHumanId,
  });

  logger.info("Event audio upload requested", {
    audioUploadId,
    eventId: input.eventId,
    key,
  });

  // Track storage usage
  await incrementResourceUsage(repos as any, {
    ...audioQuotaSubject,
    delta: BigInt(input.sizeBytes),
  });

  // Bounded: see WARM_UP_WAIT_MS. Never rejects.
  await settleWithin(warmUp, WARM_UP_WAIT_MS);

  return {
    audioUploadId,
    uploadUrl,
    key,
  };
};
