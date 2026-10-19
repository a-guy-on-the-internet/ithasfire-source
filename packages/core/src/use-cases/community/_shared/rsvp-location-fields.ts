import type { EventRecord } from "@th/ports/repos/events";

import type { HolderAddress } from "../../../lib/location/resolve-holder-address";

/**
 * The "Where" / "Address" pair an RSVP notification carries, decided by the
 * same gate a ticket holder's surfaces use (`resolveHolderAddress`). An RSVP
 * is attendance: the attendee gets exactly what a ticket holder gets.
 *
 * Unlocked: unchanged from before the gate — the organizer's `locationLabel`
 * as the venue line, and the street from whichever row holds the truth (the
 * Place for a venue that withholds its address).
 *
 * Locked (before the reveal, NEVER, or a venue that withholds its address
 * and has not confirmed this event by hand, which covers a community listing
 * accepted only by the venue's blanket consent): no street at all. The venue line keeps the organizer's
 * `locationLabel` (it is already public on the event page) and falls back to
 * the coarse area label, so the attendee still knows roughly where, and
 * nothing more. The notifications carry no lock copy of their own, so the
 * reason does not change what is sent.
 */
export function rsvpLocationFields(
  event: Pick<EventRecord, "locationLabel">,
  holderAddress: HolderAddress,
): { venueName: string | null; addressText: string | null } {
  if (holderAddress.locked) {
    return {
      venueName: event.locationLabel ?? holderAddress.label,
      addressText: null,
    };
  }
  return {
    venueName: event.locationLabel ?? null,
    addressText: holderAddress.addressText,
  };
}
