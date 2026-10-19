import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { eventOwnerSideSchema } from "../booking-agreements/_shared/event-owner-side";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "./_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  loadStaffHoldContext,
} from "./_shared/hold-context";

// ─────────────────────────────────────────────────────────────────────────────
// confirmBookingHold — RETIRED from the request flow (booking-the-night N4,
// FR-005). Holds are pencil: a request's night is booked when the sender
// agrees the terms (FR-001, `respondToBookingAgreement`) or when the venue
// books it without terms on a night the pitch asked for (FR-004,
// `bookNightWithoutTerms`, which is this use case's former body plus those
// gates). Both take the line through the same `takeLine`.
//
// Every hold today hangs off a booking request, so this refuses every call
// with HOLD_CONFIRM_RETIRED — AFTER the venue gate, so a stranger learns
// nothing about the hold. Holds without a request
// (docs/specs/2026-09-30/holds-without-a-request.spec.yaml, not built) will
// decide their own booking path; this stub is where that lands if it needs
// one. The schemas stay so the transport contract (and its clients) keep
// compiling until the thread UI drops the button (P5).
// ─────────────────────────────────────────────────────────────────────────────

export const confirmBookingHoldInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    holdId: z.uuid(),
    /**
     * Pass-through to the shared mint (`createEventFromAgreementForHold`):
     * who owns the minted draft (venue-confirmation spec "Who mints, who
     * owns"). Omitted = the default by the request's intent.
     */
    ownerOverride: eventOwnerSideSchema.optional(),
  })
  .strict();

export const confirmBookingHoldOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    eventId: z.uuid(),
    agreementId: z.uuid(),
    /** Every hold tx1 released (siblings + competitors), for the caller's UI. */
    releasedHoldIds: z.array(z.uuid()),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const confirmBookingHoldWireOutputSchema = z.object(
  confirmBookingHoldOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type ConfirmBookingHoldInput = z.infer<
  typeof confirmBookingHoldInputSchema
>;
export type ConfirmBookingHoldOutput = z.infer<
  typeof confirmBookingHoldOutputSchema
>;
export type ConfirmBookingHoldWireOutput = z.infer<
  typeof confirmBookingHoldWireOutputSchema
>;

export type ConfirmBookingHoldDeps = {
  /** Full bag — the post-commit mint runs the standard save internals. */
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  taxRateLookup?: TaxRateLookupPort | null;
  /** Threaded into the mint's orphan-draft branch; also the pitch-seed lookup. */
  reportError?: ReporterPort;
  /**
   * Pass-through to the shared mint: an org sender's SELF row on the bill
   * links the org's public page (lineup-booking-requests v2, FR-006).
   */
  publicAppUrl?: string | null;
  /**
   * `canManagePlace`, passed through to the shared mint's save internals
   * (REQUIRED there — place-address-withholding W1). Wire from `ctx.authz`.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
};

export async function confirmBookingHold(
  deps: ConfirmBookingHoldDeps,
  rawInput: unknown,
): Promise<ConfirmBookingHoldOutput> {
  const input = parseInput(confirmBookingHoldInputSchema, rawInput);
  const ctx = await loadStaffHoldContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
  );
  throw fail("HOLD_CONFIRM_RETIRED", {
    meta: { holdId: ctx.hold.id, bookingRequestId: ctx.request?.id ?? null },
  });
}
