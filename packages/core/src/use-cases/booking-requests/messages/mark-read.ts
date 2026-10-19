import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import {
  ensureBookingThreadReader,
  messagesIn,
  requireBookingRequest,
} from "./_shared/thread-access";

// ─────────────────────────────────────────────────────────────────────────────
// markBookingRequestMessagesRead — the reading side stamps `readAt` on the
// messages authored by the OPPOSITE side up to a timestamp.
//
// Semantics live in the PORT (`BookingRequestMessagesRepo.markRead`): only
// COUNTERPARTY rows with `createdAt <= upToCreatedAt` and a null `readAt` are
// touched — the reader's own messages never are, and neither are SYSTEM ledger
// entries (an entry can never be unread, so it must never wear a read
// receipt). Idempotent by construction (a second call finds nothing unread).
//
// Works on CLOSED threads too — reading a declined request's history must
// still clear its unread badge.
//
// Audit: intentionally none — benign, high-frequency, self-only (the exact
// precedent of support/mark-thread-read). Still one `repos.tx()` per the
// one-mutation-one-transaction standard.
// ─────────────────────────────────────────────────────────────────────────────

export const markBookingRequestMessagesReadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    /**
     * The READER's side — verified (see thread-access). "ACT" (a confirmed
     * tagged artist, read-only) is accepted and stamps nothing.
     */
    side: z.enum(["VENUE", "PERFORMER", "ACT"]),
    /** Only messages with `createdAt <= upToCreatedAt` are stamped. */
    upToCreatedAt: z.coerce.date(),
  })
  .strict();

export const markBookingRequestMessagesReadOutputSchema = z
  .object({
    /** Rows newly stamped read (0 on an idempotent repeat). */
    updated: z.number().int().nonnegative(),
  })
  .strict();

export type MarkBookingRequestMessagesReadUseCaseInput = z.infer<
  typeof markBookingRequestMessagesReadInputSchema
>;
export type MarkBookingRequestMessagesReadOutput = z.infer<
  typeof markBookingRequestMessagesReadOutputSchema
>;

export type MarkBookingRequestMessagesReadDeps = {
  /** See post-message.ts for the Required<> staging note. */
  repos: Repos & Required<Pick<Repos, "bookingRequestMessages">>;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function markBookingRequestMessagesRead(
  deps: MarkBookingRequestMessagesReadDeps,
  rawInput: unknown,
): Promise<MarkBookingRequestMessagesReadOutput> {
  const input = parseInput(markBookingRequestMessagesReadInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  // READ gate: clearing your own unread badge is reading, not conversing —
  // membership-any, mirroring list-messages (thread-access module doc).
  await ensureBookingThreadReader(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  // A confirmed act is neither party: `readAt` is one shared stamp per
  // message, per SIDE, and an act stamping it would clear the venue's or the
  // sender's badge. The gate above still ran — a pending act gets a refusal,
  // not a quiet success.
  if (input.side === "ACT") {
    return markBookingRequestMessagesReadOutputSchema.parse({ updated: 0 });
  }
  const side = input.side;

  const updated = await deps.repos.tx(async (tx) =>
    messagesIn(tx).markRead({
      bookingRequestId: request.id,
      side,
      upToCreatedAt: input.upToCreatedAt,
    }),
  );

  deps.logger?.info("booking_requests.messages_marked_read", {
    bookingRequestId: request.id,
    side: input.side,
    updated,
  });

  return markBookingRequestMessagesReadOutputSchema.parse({ updated });
}
