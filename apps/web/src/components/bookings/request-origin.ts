// ─────────────────────────────────────────────────────────────────────────────
// IS THIS AN EVENT-FIRST REQUEST? (booking-the-night N15 / FR-011)
//
// The request variant of `venueConfirmation.confirm` is refused with
// VENUE_CONFIRMATION_NOT_FOR_REQUESTS unless the request was built from an
// event (`originEventId` set, confirm-venue-event.ts). The list summary
// carries that as `builtFromEvent` — a boolean on purpose, so the venue never
// receives the origin event id itself. The row answers directly; there is no
// inference from the stage fields.
// ─────────────────────────────────────────────────────────────────────────────

export function isProvenEventFirstRow(row: { builtFromEvent: boolean }): boolean {
  return row.builtFromEvent;
}
