import { z } from "zod";

import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// The freeze state, as every deal read returns it (freeze-the-deal FR-001,
// lifecycle "read": returned with every deal read).
//
// The freeze lives on the event the deal's scope resolves to: the event for an
// EVENT target, the booking's finalized event else its draft event for a
// BOOKING_AGREEMENT target (`bookingDealScope`). Null when the deal has no
// event (an org default, a booking with no event yet): nothing to freeze.
// `eventId` is the id the editor passes to `freezeEventDeal` and
// `listDealChanges`.
// ─────────────────────────────────────────────────────────────────────────────

export const dealFreezeViewSchema = z
  .object({
    eventId: z.uuid(),
    /** Null = not frozen. */
    dealFrozenAt: z.date().nullable(),
    /** Null = frozen automatically (first publish, the backfill), or not frozen. */
    dealFrozenByHumanId: z.uuid().nullable(),
  })
  .strict()
  .nullable();

export type DealFreezeView = z.infer<typeof dealFreezeViewSchema>;

export async function loadDealFreezeView(
  repos: Pick<Repos, "events">,
  eventId: string | null,
): Promise<DealFreezeView> {
  if (!eventId) return null;
  const event = await repos.events.getById(eventId);
  if (!event) return null;
  return {
    eventId: event.id,
    dealFrozenAt: event.dealFrozenAt ?? null,
    dealFrozenByHumanId: event.dealFrozenByHumanId ?? null,
  };
}
