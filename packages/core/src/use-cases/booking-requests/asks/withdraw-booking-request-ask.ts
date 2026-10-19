import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { appendBookingSystemEntry } from "../messages/_shared/system-entries";
import {
  ensureBookingThreadParticipant,
  requireBookingRequest,
} from "../messages/_shared/thread-access";
import {
  bookingRequestAskOutputSchema,
  requireAsk,
  toAskOutput,
  type BookingRequestAskOutput,
} from "./_shared/ask-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// withdrawBookingRequestAsk (venue-booking-standards v1.1 FR-009b): the venue
// takes back an ask that is still OPEN.
//
// "The asker" is read as the venue SIDE: any venue-side participant may
// withdraw, not only the person who asked. Venue staff hand threads to each
// other (assignment, FR-015), and the attachment delete posture already
// treats the venue as one side; tying the ask to one login would strand it
// when that person leaves.
//
// OPEN → WITHDRAWN only. An ANSWERED ask refuses (INVALID_STATUS
// `booking_ask_answered`): its answer may already be the event's image or
// the terms' end time. Withdrawing an already-WITHDRAWN ask is an idempotent
// success (no second ledger entry). No notice: the sender's card simply
// closes; the ledger entry records it.
// ─────────────────────────────────────────────────────────────────────────────

export const withdrawBookingRequestAskInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    askId: z.string().uuid(),
  })
  .strict();

export type WithdrawBookingRequestAskUseCaseInput = z.infer<
  typeof withdrawBookingRequestAskInputSchema
>;

export type WithdrawBookingRequestAskDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function withdrawBookingRequestAsk(
  deps: WithdrawBookingRequestAskDeps,
  rawInput: unknown,
): Promise<BookingRequestAskOutput> {
  const input = parseInput(withdrawBookingRequestAskInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  await ensureBookingThreadParticipant(
    deps.repos,
    request,
    input.actorHumanId,
    "VENUE",
  );

  const ask = await requireAsk(deps.repos, {
    askId: input.askId,
    bookingRequestId: request.id,
  });
  if (ask.status === "WITHDRAWN") {
    return bookingRequestAskOutputSchema.parse(toAskOutput(ask, null));
  }
  if (ask.status === "ANSWERED") {
    throw fail("INVALID_STATUS", {
      message: "booking_ask_answered",
      meta: { askId: ask.id, status: ask.status },
    });
  }

  const now = deps.clock.now();

  const withdrawn = await deps.repos.tx(async (tx) => {
    const updated = await tx.bookingRequests.withdrawAsk({
      id: ask.id,
      bookingRequestId: request.id,
      withdrawnByHumanId: input.actorHumanId,
      withdrawnAt: now,
    });
    if (!updated) {
      // Lost the race: an answer (or another withdraw) landed first.
      const current = await tx.bookingRequests.getAsk({
        id: ask.id,
        bookingRequestId: request.id,
      });
      if (!current) throw fail("BOOKING_ASK_NOT_FOUND");
      if (current.status === "WITHDRAWN") return { ask: current, wrote: false };
      throw fail("INVALID_STATUS", {
        message: "booking_ask_answered",
        meta: { askId: ask.id, status: current.status },
      });
    }

    await appendBookingSystemEntry(tx, {
      bookingRequestId: request.id,
      kind: "booking_request.ask_withdrawn",
      data: { askId: updated.id, kind: updated.kind, label: updated.label },
      actorHumanId: input.actorHumanId,
    });
    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.ask_withdrawn",
      data: { askId: updated.id, actorHumanId: input.actorHumanId },
      at: now,
    });
    return { ask: updated, wrote: true };
  });

  deps.logger?.info("booking_requests.ask_withdrawn", {
    bookingRequestId: request.id,
    askId: ask.id,
    actorHumanId: input.actorHumanId,
    wrote: withdrawn.wrote,
  });

  return bookingRequestAskOutputSchema.parse(toAskOutput(withdrawn.ask, null));
}
