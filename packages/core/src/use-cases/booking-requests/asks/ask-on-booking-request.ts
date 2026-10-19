import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import { lockRequestBookingAndAssertNotCancelled } from "../../booking-holds/_shared/request-booking-lock";
import { BOOKING_STANDARD_FIELDS } from "../../booking-standards/standard-fields";
import { appendBookingSystemEntry } from "../messages/_shared/system-entries";
import {
  ensureBookingThreadParticipant,
  requireBookingRequest,
} from "../messages/_shared/thread-access";
import {
  BOOKING_ASK_LABEL_MAX,
  BOOKING_ASK_NOTE_MAX,
  assertRequestTakesAsks,
  bookingRequestAskKindSchema,
  bookingRequestAskOutputSchema,
  requireToVenueForAsks,
  toAskOutput,
  type BookingRequestAskOutput,
} from "./_shared/ask-schemas";
import {
  fireAskNotice,
  type NotifyBookingRequestAskFn,
} from "./notify-booking-request-ask";

// ─────────────────────────────────────────────────────────────────────────────
// askOnBookingRequest (venue-booking-standards v1.1 V9, V11, FR-009b): the
// venue asks the sender for one typed thing. See `_shared/ask-schemas.ts` for
// the state machine and who may do what.
//
// One transaction, under the request's booking lock (so a concurrent decline,
// withdraw or Cancel booking is seen): re-read the request, refuse a closed
// one, insert the ask, write `booking_request.ask_opened`, audit. After
// commit, the sender side hears `booking.ask-received`.
// ─────────────────────────────────────────────────────────────────────────────

export const askOnBookingRequestInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    kind: bookingRequestAskKindSchema,
    /** The venue's wording ("Poster", "Tech rider"). Sanitized, then 1–80. */
    label: plainTextRequired(BOOKING_ASK_LABEL_MAX),
    /** Optional note; sanitized, ≤ 240; empty → none. */
    note: plainTextOptional(BOOKING_ASK_NOTE_MAX).optional(),
    /** The standard this ask came from ("Ask for…" suggestions). */
    standardField: z
      .enum(BOOKING_STANDARD_FIELDS as [string, ...string[]])
      .optional(),
    /** IMAGE only: "Use as the event image" (V10). */
    useAsEventImage: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.useAsEventImage && value.kind !== "IMAGE") {
      ctx.addIssue({
        code: "custom",
        path: ["useAsEventImage"],
        message: "use_as_event_image_requires_image",
      });
    }
  });

export type AskOnBookingRequestInput = z.input<
  typeof askOnBookingRequestInputSchema
>;

export type AskOnBookingRequestDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Post-commit `booking.ask-received` to the sender side (transport-composed). */
  notifyBookingRequestAsk?: NotifyBookingRequestAskFn;
  /** Reports a swallowed notifier failure. */
  reportError?: ReporterPort;
};

export async function askOnBookingRequest(
  deps: AskOnBookingRequestDeps,
  rawInput: unknown,
): Promise<BookingRequestAskOutput> {
  const input = parseInput(askOnBookingRequestInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  // Authority before state: an outsider learns nothing about the request.
  await ensureBookingThreadParticipant(
    deps.repos,
    request,
    input.actorHumanId,
    "VENUE",
  );
  requireToVenueForAsks(request);

  const now = deps.clock.now();
  const note = input.note && input.note.length > 0 ? input.note : null;

  const { ask, fresh } = await deps.repos.tx(async (tx) => {
    // The booking lock first, like every request-state writer; a cancelled
    // booking refuses (BOOKING_CANCELLED). Then the fresh row's status.
    await lockRequestBookingAndAssertNotCancelled(tx, request.id);
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh) {
      throw fail("BOOKING_REQUEST_NOT_FOUND");
    }
    assertRequestTakesAsks(fresh, now);

    const ask = await tx.bookingRequests.createAsk({
      bookingRequestId: fresh.id,
      kind: input.kind,
      label: input.label,
      note,
      standardField: (input.standardField ?? null) as
        | (typeof BOOKING_STANDARD_FIELDS)[number]
        | null,
      useAsEventImage: input.kind === "IMAGE" && input.useAsEventImage === true,
      askedByHumanId: input.actorHumanId,
      askedAt: now,
    });

    await appendBookingSystemEntry(tx, {
      bookingRequestId: fresh.id,
      kind: "booking_request.ask_opened",
      data: { askId: ask.id, kind: ask.kind, label: ask.label },
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: fresh.id,
      action: "booking_request.ask_opened",
      data: {
        askId: ask.id,
        kind: ask.kind,
        standardField: ask.standardField,
        useAsEventImage: ask.useAsEventImage,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    return { ask, fresh };
  });

  await fireAskNotice(
    deps,
    { event: "asked", bookingRequest: fresh, ask, actorHumanId: input.actorHumanId },
    "askOnBookingRequest",
  );

  deps.logger?.info("booking_requests.ask_opened", {
    bookingRequestId: request.id,
    askId: ask.id,
    kind: ask.kind,
    actorHumanId: input.actorHumanId,
  });

  return bookingRequestAskOutputSchema.parse(toAskOutput(ask, null));
}
