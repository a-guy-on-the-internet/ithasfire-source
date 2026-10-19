import { randomUUID } from "node:crypto";

import { isAppError } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingRequestAskRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import { readImageDimensions } from "../../../lib/images/image-dimensions";
import { stripImageMetadata } from "../../../lib/images/strip-image-metadata";
import {
  IMAGE_STRIP_BUSY,
  withImageStripSlot,
} from "../../storage/strip-uploaded-image";
import { describeError } from "../../../lib/io";
import { enqueueImageModeration } from "../../moderation/enqueue-image-moderation";
import { enforceQuota, incrementResourceUsage } from "../../quotas/enforce-quota";
import { markForSearchReindex } from "../../search/search-reindex-marks";
import { eventStorageQuotaSubject } from "../../storage/event-media-targets";
import {
  BOOKING_ATTACHMENT_CONTENT_TYPES,
  isBookingAttachmentImage,
  type BookingAttachmentContentType,
} from "../_shared/attachment-files";

// ─────────────────────────────────────────────────────────────────────────────
// Answers that map onto the night (venue-booking-standards v1.1 V10, FR-009d).
//
//   · IMAGE + "Use as the event image" → the event's hero, through the event
//     image pipeline: a SERVER-SIDE copy of the private attachment into the
//     public `events/{eventId}/images/` namespace, an Image row (finalized),
//     an EVENT_HERO moderation record (PENDING — hidden on public surfaces
//     until the drain approves it), and `Event.heroImageId` set ONLY while it
//     is empty. Runs at mint (createEventFromAgreement, every entry) and when
//     the answer lands after the mint.
//   · SET_LENGTH → the terms' end: `proposedEndDate = proposedDate +
//     minutes` ({@link setLengthEndDate}). Applied in the answer's own
//     transaction to DRAFT terms that name a start; otherwise picked up by
//     every later place the terms get a start — the accept's seed, Send
//     terms, Book without terms — through {@link effectiveSetLengthMinutes}
//     (the pitch's own set length, else the latest answered ask).
//   · FILE / LINK / TEXT stay on the request ("From the booking" is UI).
//
// THE IMAGE COPY IS IDEMPOTENT PER (ask, event), AND NEVER OVERWRITES:
//   - the destination key names the ask AND the answer file
//     (`booking-ask-{askId}-{attachmentId}.{ext}`). The object is public
//     the moment it is written, BEFORE the CAS below, so a key shared across
//     answers would let a delayed run for an OLD answer overwrite the bytes
//     behind an image moderation already approved (review W1). Two runs can
//     only ever write the same key with the same bytes;
//   - the DB half is one transaction opened by a CAS on the ask
//     (`stampAskEventImage`: ANSWERED, same attachment, not yet stamped for
//     this event). The loser writes no row; if no Image row uses its key
//     (its answer was replaced), the object goes on the deletion outbox, so
//     it never stays in the bucket without a record.
//   An Image row whose hero CAS lost (someone set a hero in between) is
//   referenced by nothing, so the storage sweep reclaims it and its object
//   through the deletion outbox — never a leak with no record.
//
// NEVER FAILS THE CALLER. Every failure is a deliberate swallow: logged at
// error AND reported (ReporterPort convention). The mint, or the answer, has
// already committed.
// ─────────────────────────────────────────────────────────────────────────────

/** Event states whose image a booking may still fill. */
const MAPPABLE_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "PUBLISHED",
]);

export type AskImageMappingDeps = {
  repos: Repos;
  /**
   * Absent → the copy is skipped (logged): a composition root that did not
   * wire storage maps nothing, and the next mint or answer retries.
   */
  storage?: Pick<FileStoragePort, "getObject" | "putObject" | "getObjectUrl">;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type AskImageMappingOutcome =
  | { outcome: "mapped"; askId: string; imageId: string; heroSet: boolean }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed" };

/** `proposedDate + minutes` (minutes are whole and bounded by the ask). */
export function setLengthEndDate(proposedDate: Date, minutes: number): Date {
  return new Date(proposedDate.getTime() + minutes * 60_000);
}

/**
 * The latest ANSWERED SET_LENGTH ask's minutes, or null — the accept-time
 * seed for a request whose pitch left set length empty.
 */
export async function answeredSetLengthMinutes(
  tx: Pick<TxRepos, "bookingRequests">,
  bookingRequestId: string,
): Promise<number | null> {
  const answered = (await tx.bookingRequests.listAsks(bookingRequestId))
    .filter(
      (ask) =>
        ask.kind === "SET_LENGTH" &&
        ask.status === "ANSWERED" &&
        ask.answerMinutes !== null,
    )
    .sort(byAnsweredAtDesc);
  return answered[0]?.answerMinutes ?? null;
}

/**
 * The set length the terms' end is built from: the pitch's own, else the
 * latest ANSWERED SET_LENGTH ask (V10). The ONE resolver behind every place
 * the terms get a start after the answer — the accept's seed
 * (`accept-in-tx`), Send terms (`send-booking-terms`) and Book without terms
 * (`book-night-without-terms`) — so an answer given while the terms named no
 * date is not lost (review W3).
 */
export async function effectiveSetLengthMinutes(
  repos: Pick<TxRepos, "bookingRequests">,
  request: { id: string; setLengthMinutes: number | null },
): Promise<number | null> {
  if (request.setLengthMinutes !== null) return request.setLengthMinutes;
  return answeredSetLengthMinutes(repos, request.id);
}

/**
 * Apply a SET_LENGTH answer to the request's DRAFT terms, inside the
 * caller's transaction. A no-op when there are no terms, they are past DRAFT,
 * or they name no start. The header write is a status CAS; losing it (the
 * terms were sent meanwhile) is a no-op too — the answer stands either way.
 * Returns the end it wrote, or null.
 */
export async function applySetLengthToDraftTerms(
  tx: Pick<TxRepos, "agreements" | "audit">,
  args: {
    request: Pick<BookingRequestRecord, "id" | "agreementId">;
    askId: string;
    minutes: number;
    actorHumanId: string;
    now: Date;
  },
): Promise<Date | null> {
  if (!args.request.agreementId) return null;
  const agreement = await tx.agreements.getById(args.request.agreementId);
  if (!agreement || agreement.status !== "DRAFT" || !agreement.proposedDate) {
    return null;
  }
  const proposedEndDate = setLengthEndDate(agreement.proposedDate, args.minutes);
  try {
    await tx.agreements.updateHeader({
      id: agreement.id,
      expectedFrom: ["DRAFT"],
      proposedEndDate,
    });
  } catch (error) {
    // The adapter's CAS throws `{ code: "conflict" }` after a zero-row
    // updateMany — no SQL error, so the transaction is still usable.
    if (isConflict(error)) return null;
    throw error;
  }
  await tx.audit.log({
    entity: "agreement",
    entityId: agreement.id,
    action: "booking_agreement.end_set_from_ask",
    data: {
      bookingRequestId: args.request.id,
      askId: args.askId,
      minutes: args.minutes,
      proposedEndDate: proposedEndDate.toISOString(),
      actorHumanId: args.actorHumanId,
    },
    at: args.now,
  });
  return proposedEndDate;
}

/**
 * Copy the request's "use as the event image" answer into `eventId` as its
 * hero, when the event has none (module header). `askId` narrows to one ask
 * (the answer path); omitted = the latest-answered such ask (the mint path).
 * Never throws.
 */
export async function mapAskImageToEvent(
  deps: AskImageMappingDeps,
  args: {
    bookingRequestId: string;
    eventId: string;
    askId?: string;
    /** Use-case name for logs / Sentry tags. */
    context: string;
  },
): Promise<AskImageMappingOutcome> {
  const logger = deps.logger?.child({ useCase: "mapAskImageToEvent" });
  try {
    const candidates = (
      await deps.repos.bookingRequests.listAsks(args.bookingRequestId)
    )
      .filter(
        (ask) =>
          ask.kind === "IMAGE" &&
          ask.useAsEventImage &&
          ask.status === "ANSWERED" &&
          ask.answerAttachmentId !== null &&
          ask.eventImageEventId !== args.eventId &&
          (args.askId === undefined || ask.id === args.askId),
      )
      .sort(byAnsweredAtDesc);
    const ask = candidates[0];
    if (!ask) return { outcome: "skipped", reason: "no_image_answer" };

    if (!deps.storage) {
      logger?.info("booking_asks.image_mapping_skipped_no_storage", {
        bookingRequestId: args.bookingRequestId,
        eventId: args.eventId,
        askId: ask.id,
      });
      return { outcome: "skipped", reason: "no_storage" };
    }

    const event = await deps.repos.events.getById(args.eventId);
    if (!event || !MAPPABLE_EVENT_STATUSES.has(event.status)) {
      return { outcome: "skipped", reason: "event_not_live" };
    }
    // A cheap pre-check so an event that already has a hero costs no copy;
    // the authoritative guard is the conditional write below.
    if (event.heroImageKey || event.heroImageUrl) {
      return { outcome: "skipped", reason: "event_has_hero" };
    }

    const attachment = await deps.repos.bookingRequests.getAttachment({
      id: ask.answerAttachmentId!,
      bookingRequestId: args.bookingRequestId,
    });
    if (
      !attachment ||
      attachment.deletedAt !== null ||
      !isBookingAttachmentImage(attachment.contentType)
    ) {
      return { outcome: "skipped", reason: "answer_file_gone" };
    }

    const contentType = attachment.contentType.toLowerCase() as BookingAttachmentContentType;
    const key = askEventImageKey({
      eventId: event.id,
      askId: ask.id,
      attachmentId: attachment.id,
      contentType,
    });
    const quota = eventStorageQuotaSubject(event);
    const delta = BigInt(attachment.sizeBytes);
    if (quota) {
      await enforceQuota(deps.repos, { ...quota, delta });
    }

    // The copy. Storage I/O stays OUTSIDE the transaction. The private
    // attachment becomes PUBLIC here, so its metadata (EXIF GPS, XMP, IPTC,
    // appended MPF images) is stripped first; orientation is kept. Bytes the
    // stripper cannot parse throw `ImageMetadataStripError` BEFORE anything is
    // written, landing in the catch below (logged, reported, `failed`): an
    // unstripped file is never published. Read, strip and write share the
    // process-wide strip slots with event-image finalize, which bound how
    // many files this size are in memory at once. Only plain data leaves the
    // slot: the pixel size (the poster's `width`/`height`, as finalize
    // records for a direct upload; pure, null when the header is unreadable)
    // is read inside, so neither buffer is alive during the tx below.
    const storage = deps.storage;
    const dimensions = await withImageStripSlot(async () => {
      const source = await storage.getObject({ key: attachment.storageKey });
      const out = stripImageMetadata(source.content, contentType);
      await storage.putObject({
        key,
        content: out.bytes,
        options: { contentType, public: true },
      });
      return readImageDimensions(out.bytes);
    });
    const { url: publicUrl } = await deps.storage.getObjectUrl({
      key,
      options: { public: true },
    });

    const imageId = randomUUID();
    const now = deps.clock.now();
    const answeredBy = ask.answeredByHumanId ?? ask.askedByHumanId;

    const result = await deps.repos.tx(async (tx) => {
      const won = await tx.bookingRequests.stampAskEventImage({
        id: ask.id,
        bookingRequestId: args.bookingRequestId,
        attachmentId: attachment.id,
        eventId: event.id,
        imageId,
      });
      if (!won) {
        // Lost: write no row. If an Image row already uses our key, our
        // object IS that image (same ask + same answer file → same key, same
        // bytes; a CAS we lost to has committed its row). Otherwise nothing
        // will ever point at it (the answer moved on) — outbox it.
        const referenced = (await tx.images.listByEventId(event.id)).some(
          (image) => image.key === key,
        );
        if (!referenced) {
          await tx.pendingObjectDeletions.enqueueMany([
            {
              targetKey: key,
              targetKind: "KEY",
              source: "booking_request_ask_event_image",
              sourceId: ask.id,
            },
          ]);
        }
        return null;
      }

      await tx.images.create({
        id: imageId,
        ownerType: "EVENT",
        ownerId: event.id,
        eventId: event.id,
        key,
        publicUrl,
        contentType,
        sizeBytes: delta,
        createdByHumanId: answeredBy,
      });
      await tx.images.markUploaded({
        id: imageId,
        uploadedAt: now,
        key,
        publicUrl,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      });
      await enqueueImageModeration(tx, {
        storageKey: key,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId: event.id,
        publicUrl,
        contentType,
        createdByHumanId: answeredBy,
      });
      if (quota) {
        await incrementResourceUsage(tx, { ...quota, delta });
      }
      const heroSet = await tx.events.setHeroImageIfEmpty({
        eventId: event.id,
        imageId,
      });
      if (heroSet) {
        await tx.images.attach({
          ownerId: event.id,
          imageIds: [imageId],
          attachedAt: now,
        });
        await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
      }
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "event.hero_from_booking_ask",
        data: {
          bookingRequestId: args.bookingRequestId,
          askId: ask.id,
          attachmentId: attachment.id,
          imageId,
          heroSet,
        },
        at: now,
      });
      return { heroSet };
    });

    if (!result) {
      return { outcome: "skipped", reason: "already_mapped" };
    }
    logger?.info("booking_asks.image_mapped", {
      bookingRequestId: args.bookingRequestId,
      eventId: event.id,
      askId: ask.id,
      imageId,
      heroSet: result.heroSet,
    });
    return {
      outcome: "mapped",
      askId: ask.id,
      imageId,
      heroSet: result.heroSet,
    };
  } catch (error) {
    // Deliberate swallow: the mint / the answer already committed; the next
    // mint retry or answer re-runs the copy (idempotent per (ask, event)).
    // A full strip queue lands here too (`RATE_LIMITED` / image_strip_busy
    // from withImageStripSlot): the event then has no poster until one of
    // those re-runs. Tagged `strip_busy` so that case is told apart from a
    // real copy failure; there is no retry machinery for it.
    const stripBusy =
      isAppError(error) &&
      error.code === "RATE_LIMITED" &&
      error.message === IMAGE_STRIP_BUSY;
    logger?.error("booking_asks.image_mapping_failed", {
      bookingRequestId: args.bookingRequestId,
      eventId: args.eventId,
      stripBusy,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: args.context,
          step: stripBusy ? "strip_busy" : "ask_image_mapping",
        },
        extra: {
          bookingRequestId: args.bookingRequestId,
          eventId: args.eventId,
          askId: args.askId ?? null,
        },
      });
    } catch {
      // Reporting is best-effort.
    }
    return { outcome: "failed" };
  }
}

/**
 * The event a request's booking created, if any: the finalized event, else
 * the draft anchor (which is also where an event-first origin is linked).
 */
export async function bookedEventIdForRequest(
  repos: Pick<Repos, "agreements">,
  request: Pick<BookingRequestRecord, "agreementId">,
): Promise<string | null> {
  if (!request.agreementId) return null;
  const agreement = await repos.agreements.getById(request.agreementId);
  return agreement?.eventId ?? agreement?.draftEventId ?? null;
}

/**
 * Where an ask's answer lands in the event's public image namespace. Names
 * the answer FILE as well as the ask, so different answers never share a key
 * (see the module header, review W1).
 */
export function askEventImageKey(args: {
  eventId: string;
  askId: string;
  attachmentId: string;
  contentType: BookingAttachmentContentType;
}): string {
  const extension = BOOKING_ATTACHMENT_CONTENT_TYPES[args.contentType];
  return `events/${args.eventId}/images/booking-ask-${args.askId}-${args.attachmentId}.${extension}`;
}

function byAnsweredAtDesc(
  a: BookingRequestAskRecord,
  b: BookingRequestAskRecord,
): number {
  return (b.answeredAt?.getTime() ?? 0) - (a.answeredAt?.getTime() ?? 0);
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict"
  );
}
