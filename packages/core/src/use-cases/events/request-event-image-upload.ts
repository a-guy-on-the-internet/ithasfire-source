import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import { fail } from "../../lib/errors";
import { fail as appFail } from "@th/errors";
import { COMMUNITY_MODERATION_ROLES } from "../community/_shared/suggestion-validation";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { eventStorageQuotaSubject } from "../storage/event-media-targets";

// ─────────────────────────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum event image size in bytes (25 MB). */
export const MAX_EVENT_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * How long the presigned PUT URL stays valid (1 hour to complete the upload).
 * Finalize schedules a second deletion of the upload key after this, so a
 * re-PUT through the still-valid URL after finalize does not stay public.
 */
export const EVENT_IMAGE_PRESIGN_TTL_SECONDS = 3600;

/**
 * Allowed event image content types mapped to their storage-key extension.
 *
 * Mirrors `entityPageImageContentTypeToExtension` in
 * `../entity-pages/page-image-upload-helpers.ts`. Explicit map rather than
 * deriving from the MIME subtype, so a type whose subtype is not a usable
 * extension can never mint a broken key.
 *
 * RASTER ONLY — no SVG. Azure AI Content Safety cannot analyze SVG (verified:
 * `400 InvalidRequestBody "The image format is not supported."`), and a 400 is
 * non-retryable in `azure-content-safety-adapter`, so every SVG hero failed
 * closed to a degraded FLAGGED record. FLAGGED is terminal — `moderateImage`
 * no-ops on any non-PENDING record — so an SVG hero was invisible forever with
 * no way for the organizer to fix it. Do not re-add SVG without first giving
 * the moderation pipeline a way to score it (rasterize before scoring, or
 * exempt the format from the gate).
 */
export const eventImageContentTypeToExtension = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type EventImageContentType =
  keyof typeof eventImageContentTypeToExtension;

export const EVENT_IMAGE_CONTENT_TYPES = Object.keys(
  eventImageContentTypeToExtension,
) as readonly EventImageContentType[];

export const requestEventImageUploadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    eventId: z.string().min(1),
    /** Content-Type of the image being uploaded */
    contentType: z
      .string()
      .regex(/^image\/(jpeg|png|gif|webp)$/, "invalid_content_type"),
    /** File size in bytes */
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_EVENT_IMAGE_BYTES, "file_too_large"),
  })
  .strict();

export type RequestEventImageUploadInput = z.infer<
  typeof requestEventImageUploadInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schema
// ─────────────────────────────────────────────────────────────────────────────

export const requestEventImageUploadOutputSchema = z.object({
  /** Unique ID for this image record */
  imageId: z.string().min(1),
  /** Presigned URL to upload the image directly to R2 */
  uploadUrl: z.string().min(1),
  /** R2 object key for the image */
  key: z.string().min(1),
  /**
   * Headers the client MUST send verbatim on the presigned PUT. These are
   * signed into the presigned URL, so omitting one (or sending a different
   * value) fails the upload with a signature mismatch.
   *
   * Currently only `Content-Type`. Kept as a map rather than a single field so
   * a future signed header does not change the response shape.
   */
  uploadHeaders: z.record(z.string(), z.string()),
});

export type RequestEventImageUploadOutput = z.infer<
  typeof requestEventImageUploadOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type RequestEventImageUploadDeps = {
  repos: Pick<Repos, "events" | "images" | "tx" | "resourceQuotas">;
  /**
   * `hasStaffRole` is what admits a community MODERATOR to a DRAFT listing's
   * uploads (the EventBuilder authoring path) — see the authorization block.
   * Required, not optional: an omitted probe would fail closed and lock
   * moderators out of the builder with no signal.
   */
  authz: Pick<AuthZPort, "canEditEvent" | "hasStaffRole">;
  fileStorage: Pick<FileStoragePort, "presignPutObject">;
  logger: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requests a presigned URL for uploading an event image directly to R2.
 *
 * Creates an EventImage record in pending state and returns a presigned URL
 * that the client can PUT bytes to. After the upload completes, the client
 * must call `finalizeEventImageUpload` to mark the image as ready.
 */
export const requestEventImageUpload = async (
  deps: RequestEventImageUploadDeps,
  rawInput: unknown,
): Promise<RequestEventImageUploadOutput> => {
  const { repos, authz, fileStorage, logger } = deps;

  // ─── Parse input ───────────────────────────────────────────────────────────
  const parsed = requestEventImageUploadInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "invalid_input",
    );
  }
  const input = parsed.data;

  // ─── Verify event exists ───────────────────────────────────────────────────
  const event = await repos.events.getById(input.eventId);

  // The staff probe behind the community DRAFT branch (see the authorization
  // block). It is called on BOTH 404-producing paths — "no such event" and "a
  // DRAFT listing you are not a moderator of" — so the two cost the same one
  // event read plus one staff probe. Probing only on the branch that could
  // reveal a draft would have left the exact extra round-trip the branch is
  // supposed to hide. The OWNED-event path never calls it and pays nothing.
  const probeCommunityModerator = () =>
    authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });

  if (!event) {
    await probeCommunityModerator();
    return appFail("EVENT_NOT_FOUND");
  }

  // ─── Authorization ──────────────────────────────────────────────────────────
  // COMMUNITY listings (FR-015, community-managed-event-listings spec): any
  // SIGNED-IN user may upload an image to reference from an edit suggestion —
  // canEditEvent always fails for ownerless rows. `actorHumanId` is required
  // by the input schema and the transport procedure is protected, so
  // anonymous callers can never reach this branch. The upload is created
  // UNATTACHED (never set as hero here) and only attaches on suggestion
  // APPROVE; quota is charged to the UPLOADER's personal storage below.
  // OWNED events are unchanged: must be an event editor.
  if (event.stewardship !== "COMMUNITY") {
    const canEdit = await authz.canEditEvent({
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
    });
    if (!canEdit.allowed) {
      return appFail("NOT_AUTHORIZED");
    }
  } else if (event.status !== "PUBLISHED") {
    // A non-PUBLISHED COMMUNITY listing. TWO DIFFERENT ACTORS REACH HERE AND
    // THEY MUST NOT BE ABLE TO TELL THEY REACHED THE SAME PLACE.
    //
    //  · a community MODERATOR on a DRAFT listing is authoring it in the
    //    EventBuilder, which mounts the body-image and hero uploaders and
    //    keys them to `events/{eventId}/...` — so the draft row must accept
    //    uploads or the whole authoring flow is dead. Same
    //    COMMUNITY_MODERATION_ROLES gate as `community.createListing` /
    //    `publishListing` / `updateListing`.
    //
    //  · ANYONE ELSE gets the same EVENT_NOT_FOUND they got before this branch
    //    existed. That is load-bearing, not politeness. The COMMUNITY arm
    //    above lets ANY signed-in user upload to a listing, so a bare
    //    `status !== PUBLISHED → allow` would have turned this endpoint into
    //    an existence oracle for unpublished drafts: guess an id, see 404 vs
    //    200, learn whether a draft is sitting there. The refusal is identical
    //    in code, in body, and — via `probeCommunityModerator` running on the
    //    missing-event path too — in the work done to produce it.
    //
    // DRAFT only. CANCELLED / COMPLETED / ARCHIVED community listings stay
    // refused for everyone including moderators — uploads to a dead listing
    // are sweep fodder, which is what this branch always said.
    // Probed UNCONDITIONALLY, before the status test, so a CANCELLED listing
    // and a draft-you-cannot-see and a missing id all cost the same.
    const moderator = await probeCommunityModerator();
    if (event.status !== "DRAFT" || !moderator.allowed) {
      return appFail("EVENT_NOT_FOUND");
    }
  }
  // NOTE: this chain used to carry a fourth branch rejecting SVG on COMMUNITY
  // listings (organizer-only product policy). SVG is now refused for every
  // caller by the input schema above, so the branch was unreachable.
  // Known residual (recorded follow-up, do NOT build here): the presign below
  // is `public: true`, so a finalized suggestion upload is fetchable at its
  // R2 URL BEFORE the suggestion is approved — unlinked anywhere on the
  // platform, but hotlinkable by anyone holding the URL. The fix (non-public
  // keys until attach flips them public on APPROVE) is tracked as follow-up
  // work alongside the other suggestion-upload hardening items.

  // ─── Enforce storage quota ──────────────────────────────────────────────────
  // Charged to the EVENT'S OWNER — the same subject delete credits back
  // (`eventStorageQuotaSubject`). A delegate uploading to the principal's
  // event spends the principal's quota, not their own; charging the actor
  // would debit one human and credit another on delete. Only an ownerless
  // COMMUNITY listing (no owner subject) falls back to the uploading human.
  const quotaSubject = eventStorageQuotaSubject(event) ?? {
    subjectType: "HUMAN" as const,
    subjectId: input.actorHumanId,
    kind: "STORAGE_BYTES_HUMAN" as const,
  };
  await enforceQuota(repos as any, {
    ...quotaSubject,
    delta: BigInt(input.sizeBytes),
  });

  // ─── Generate storage key ──────────────────────────────────────────────────
  const imageId = crypto.randomUUID();
  const extension =
    eventImageContentTypeToExtension[
      input.contentType as EventImageContentType
    ] ?? "jpg";
  // The upload key carries its OWN random token, never the image id: the id
  // is public (e.g. `heroImageId` in event reads), and the client's original
  // (with its EXIF GPS) is readable at this key until finalize's deletion
  // lands. Derived from the id, anyone could rebuild its URL in that window.
  const key = `events/${input.eventId}/images/u-${crypto.randomUUID()}.${extension}`;

  // ─── Request presigned URL from R2 ─────────────────────────────────────────
  let uploadUrl: string;
  try {
    const presignResult = await fileStorage.presignPutObject({
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      public: true, // Event images are publicly accessible
      options: {
        expiresSec: EVENT_IMAGE_PRESIGN_TTL_SECONDS,
      },
    });
    uploadUrl = presignResult.uploadUrl;
  } catch (err) {
    logger.error("Failed to presign event image upload", {
      err,
      key,
      eventId: input.eventId,
    });
    return appFail("STORAGE_ERROR", { cause: err });
  }

  // ─── Create Image record in pending state ───────────────────────────────
  await repos.images.create({
    id: imageId,
    ownerType: "EVENT",
    ownerId: input.eventId,
    eventId: input.eventId,
    key,
    publicUrl: "", // Will be set after finalization
    contentType: input.contentType,
    sizeBytes: BigInt(input.sizeBytes),
    createdByHumanId: input.actorHumanId,
  });

  logger.info("Event image upload requested", {
    imageId,
    eventId: input.eventId,
    key,
  });

  // Track storage usage — same owner subject the quota was enforced against.
  await incrementResourceUsage(repos as any, {
    ...quotaSubject,
    delta: BigInt(input.sizeBytes),
  });

  return {
    imageId,
    uploadUrl,
    key,
    uploadHeaders: {
      "Content-Type": input.contentType,
    },
  };
};
