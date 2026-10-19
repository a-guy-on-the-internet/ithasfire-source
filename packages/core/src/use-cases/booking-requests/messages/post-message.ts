import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestMessageRow } from "@th/ports/repos/booking-request-messages";

import { parseInput } from "../../../lib/io";
import { plainTextMultilineRequired } from "../../../lib/sanitize-plain-text";
import { fail } from "@th/errors";
import type { NotifyBookingRequestMessagePostedFn } from "../notify-booking-request-message";
import { isEligibleAssignee } from "../assign-booking-request";
import { appendBookingSystemEntry } from "./_shared/system-entries";
import {
  ensureBookingThreadParticipant,
  messagesIn,
  requireBookingRequest,
} from "./_shared/thread-access";

// ─────────────────────────────────────────────────────────────────────────────
// postBookingRequestMessage — append one message to a request's thread
// (booking-conversation FR-001/FR-002; venue-hierarchy FR-012).
//
// The request IS the thread. The append and the denormalized
// `BookingRequest.lastMessageAt` bump run in the SAME `repos.tx()` (port
// mandate on `BookingRequestMessagesRepo.create` — a message that committed
// without the bump sorts wrongly in every inbox forever).
//
// SYSTEM is never client-postable: the input side enum is VENUE | PERFORMER
// only. SYSTEM rows are LEDGER ENTRIES, minted exclusively by
// `appendBookingSystemEntry` (_shared/system-entries.ts) from inside a
// transition's own transaction — never through this use case.
//
// NOTE(step 6): rate limiting is TRANSPORT-owned (same split as the other
// abuse throttles) — the tRPC procedure that wires this use case must apply
// ~30 posts/hour per actor before calling in. Core stays limiter-free so
// SYSTEM/backfill paths are never throttled.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body bound — mirrors `SUPPORT_MESSAGE_MAX` (support/schemas.ts) and the
 * 2026-07-14 spec's FR-001 "1..4000". Sanitized (house multiline helper)
 * BEFORE the length floor/cap.
 */
export const BOOKING_MESSAGE_MAX = 4000;

export const postBookingRequestMessageInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    /** The author's declared side — verified, never trusted (thread-access doc). */
    side: z.enum(["VENUE", "PERFORMER"]),
    body: plainTextMultilineRequired(BOOKING_MESSAGE_MAX),
  })
  .strict();

/**
 * One thread row on the wire — a human MESSAGE or a SYSTEM ENTRY (the ledger
 * rows described in `_shared/system-entries.ts`). One schema for both because
 * the thread is one chronological list; entries are identified by
 * `authorSide === "SYSTEM"` + a non-null `systemKind`.
 */
export const bookingRequestMessageOutputSchema = z
  .object({
    id: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    authorSide: z.enum(["VENUE", "PERFORMER", "SYSTEM"]),
    authorHumanId: z.string().uuid().nullable(),
    /** Empty string on a system entry — the sentence is rendered, not stored. */
    body: z.string(),
    /**
     * Kept a plain `string`, NOT the `BookingSystemEntryKind` enum: a row
     * written by a newer build can carry a kind this one has never heard of,
     * and an enum here would make the whole PAGE fail to parse over one
     * unknown row. Clients narrow with `isBookingSystemEntryKind` and skip
     * what they do not recognize.
     */
    systemKind: z.string().nullable(),
    /**
     * Per-kind params. Left unvalidated on the read path for the same
     * forward-compatibility reason as `systemKind`; the write path
     * (`appendBookingSystemEntry`) is where the shape is enforced.
     */
    systemData: z.record(z.string(), z.unknown()).nullable(),
    readAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict();

export type PostBookingRequestMessageInput = z.infer<
  typeof postBookingRequestMessageInputSchema
>;
export type PostBookingRequestMessageOutput = z.infer<
  typeof bookingRequestMessageOutputSchema
>;

export type PostBookingRequestMessageDeps = {
  /**
   * `bookingRequestMessages` is required on the aggregate since Step 5 — the
   * `Required<Pick>` is now redundant but harmless, kept as an explicit
   * statement of what the use case consumes.
   */
  repos: Repos & Required<Pick<Repos, "bookingRequestMessages">>;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional post-commit counterparty notification (booking-conversation
   * FR-003), composed by the transport layer. Runs AFTER the transaction
   * committed; a throwing notifier never fails the committed message
   * (deliberate swallow + guarded reportError — house convention).
   */
  notifyBookingRequestMessagePosted?: NotifyBookingRequestMessagePostedFn;
  /** Best-effort reporter for the notification swallow branch. */
  reportError?: ReporterPort;
};

export async function postBookingRequestMessage(
  deps: PostBookingRequestMessageDeps,
  rawInput: unknown,
): Promise<PostBookingRequestMessageOutput> {
  const input = parseInput(postBookingRequestMessageInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );

  // Participant authz for the DECLARED side — the ONLY gate on a post. Status
  // is deliberately not consulted: a declined/withdrawn/expired request keeps a
  // fully writable thread, because the thread is the booking's history (see the
  // module header in _shared/thread-access.ts).
  await ensureBookingThreadParticipant(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  const now = deps.clock.now();

  // Auto-assign (booking-holds FR-015): the first STAFF reply on an
  // unassigned, org-owned TO_VENUE request assigns its author — resolved
  // BEFORE the tx (two reads), applied INSIDE it. A direct human owner of an
  // org-owned place who holds no edit-role membership is not an eligible
  // assignee and is skipped; human-owned venues never carry an assignee.
  const autoAssign =
    input.side === "VENUE" &&
    request.direction === "TO_VENUE" &&
    request.assigneeHumanId === null &&
    (await shouldAutoAssign(deps.repos, request.placeId, input.actorHumanId));

  const message = await deps.repos.tx(async (tx) => {
    // In-tx EXISTENCE re-check. It no longer re-checks status (the thread has
    // no status gate) but it is NOT dead: `BookingRequest.place` and
    // `.organizerOrg` are `onDelete: Cascade`, so deleting a place/org between
    // the read above and this transaction takes the request row — and its
    // messages — with it. Without the re-read the insert would surface as a raw
    // Prisma foreign-key error instead of the typed
    // BOOKING_REQUEST_NOT_FOUND every other path returns.
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh) {
      throw fail("BOOKING_REQUEST_NOT_FOUND");
    }

    const created = await messagesIn(tx).create({
      bookingRequestId: request.id,
      authorSide: input.side,
      authorHumanId: input.actorHumanId,
      body: input.body,
    });

    // SAME tx as the create — port mandate (see module header).
    await tx.bookingRequests.touchLastMessageAt({
      id: request.id,
      at: created.createdAt,
    });

    // Re-checked on the FRESH row: a concurrent assign wins.
    if (autoAssign && fresh.assigneeHumanId === null) {
      await tx.bookingRequests.setAssignee({
        id: request.id,
        assigneeHumanId: input.actorHumanId,
      });
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_request.assigned",
        data: {
          assigneeHumanId: input.actorHumanId,
          previousAssigneeHumanId: null,
        },
        actorHumanId: input.actorHumanId,
      });
    }

    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.message_posted",
      data: {
        messageId: created.id,
        authorSide: input.side,
        actorHumanId: input.actorHumanId,
        // Deliberately NO body content — the audit trail is metadata-only.
        bodyLength: created.body.length,
        autoAssigned: autoAssign && fresh.assigneeHumanId === null,
      },
      at: now,
    });

    return created;
  });

  await notifyCounterparty(deps, request, message);

  deps.logger?.info("booking_requests.message_posted", {
    bookingRequestId: request.id,
    messageId: message.id,
    authorSide: input.side,
    actorHumanId: input.actorHumanId,
  });

  return bookingRequestMessageOutputSchema.parse(message);
}

/**
 * FR-015 eligibility for the auto-assign: the place is org-owned and the
 * author holds an edit role in one of its owning orgs.
 */
async function shouldAutoAssign(
  repos: Pick<Repos, "places" | "authz">,
  placeId: string,
  actorHumanId: string,
): Promise<boolean> {
  const place = await repos.places.getById(placeId);
  if (!place || place.orgIdsWithAccess.length === 0) return false;
  return isEligibleAssignee(repos, place.orgIdsWithAccess, actorHumanId);
}

/**
 * Post-commit "the other side has a new message" notification — deliberate
 * swallow with guarded reportError (ReporterPort convention): a throwing
 * notifier never fails the already-committed message.
 */
async function notifyCounterparty(
  deps: PostBookingRequestMessageDeps,
  request: Parameters<NotifyBookingRequestMessagePostedFn>[0]["bookingRequest"],
  message: BookingRequestMessageRow,
): Promise<void> {
  if (!deps.notifyBookingRequestMessagePosted) return;
  try {
    await deps.notifyBookingRequestMessagePosted({
      bookingRequest: request,
      message,
      recipientSide: message.authorSide === "VENUE" ? "PERFORMER" : "VENUE",
    });
  } catch (error) {
    deps.logger?.error("booking_requests.notify_message_posted_failed", {
      bookingRequestId: request.id,
      messageId: message.id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "postBookingRequestMessage" },
        extra: { bookingRequestId: request.id, messageId: message.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never fail the
      // committed message.
    }
  }
}
