import { z } from "zod";

import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";

import { parseInput } from "../../lib/io";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { requirePlaceBookingAuthority } from "../booking-requests/_shared/place-access";
import {
  bookingHoldNotificationIntentSchema,
  type BookingHoldNotificationIntent,
} from "./_shared/booking-hold-intents";
import {
  requirePlace,
  requireRequest,
  requireToVenueRequest,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import { lineKeysOf } from "./_shared/hold-line";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// settleBookingHolds: the dedicated write-on-read call (FR-007). Reads never
// write, so a surface that just PROJECTED `lapsed: true` calls this to
// persist the lapse and collect the notifications owed. Settles every line
// the request's live holds sit in. Staff-gated (edit roles); idempotent.
// ─────────────────────────────────────────────────────────────────────────────

export const settleBookingHoldsInputSchema = z
  .object({ actorHumanId: z.uuid(), bookingRequestId: z.uuid() })
  .strict();

export const settleBookingHoldsOutputSchema = z
  .object({
    settledHoldIds: z.array(z.uuid()),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
  })
  .strict();

/** What transport puts on the wire: the intents stay server-side. */
export const settleBookingHoldsWireOutputSchema = z.object(
  settleBookingHoldsOutputSchema.omit({
    notificationIntents: true,
  }).shape,
);

export type SettleBookingHoldsInput = z.infer<
  typeof settleBookingHoldsInputSchema
>;
export type SettleBookingHoldsOutput = z.infer<
  typeof settleBookingHoldsOutputSchema
>;
export type SettleBookingHoldsWireOutput = z.infer<
  typeof settleBookingHoldsWireOutputSchema
>;
export type SettleBookingHoldsDeps = BookingHoldDeps;

export async function settleBookingHolds(
  deps: SettleBookingHoldsDeps,
  rawInput: unknown,
): Promise<SettleBookingHoldsOutput> {
  const input = parseInput(settleBookingHoldsInputSchema, rawInput);
  const now = deps.clock.now();

  const request = requireToVenueRequest(
    await requireRequest(deps.repos, input.bookingRequestId),
  );
  const place = await requirePlace(deps.repos, request.placeId);
  // Staff only (FR-002): settling every line of a request is the place's.
  await requirePlaceBookingAuthority(deps.repos, place, input.actorHumanId);
  const placeTz = resolveBookingTimezone(place.timezone);

  const outcome = await deps.repos.tx(async (tx) => {
    const holds = await tx.bookingHolds.listForRequest(request.id);
    // Lines in the global lock order (settleLine locks each as it goes).
    const lines = lineKeysOf(
      holds.filter((hold) =>
        (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status),
      ),
    );
    const intents: BookingHoldNotificationIntent[] = [];
    for (const key of lines) {
      const settled = await settleLine(tx, { ...key, now, placeTz });
      intents.push(...settled.intents);
    }
    // Which of THIS request's holds left their line in this call: live
    // before, not live after. (Settlement of a shared line can also release
    // OTHER requests' holds — those ride `intents`, not this list.)
    const after = new Map(
      (await tx.bookingHolds.listForRequest(request.id)).map((h) => [h.id, h]),
    );
    const settledHoldIds = holds
      .filter(
        (h) =>
          (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(
            h.status,
          ) && after.get(h.id)?.status === "RELEASED",
      )
      .map((h) => h.id);
    return { settledHoldIds, notificationIntents: intents };
  });

  return settleBookingHoldsOutputSchema.parse(outcome);
}
