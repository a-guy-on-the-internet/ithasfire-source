/**
 * When tickets for an event went on sale: schema.org `Offer.validFrom`.
 *
 * Its own module so the FR-014 sales-window guard
 * (`lib/orders/__tests__/price-read-invariant.test.ts`) can exempt this one
 * reported-date read without exempting `build-event-seo.ts`, where a real
 * "on sale now" decision (`availability`) would go and must use
 * `resolveTicketTypeSellability`.
 *
 * Each ticket type opens at its own `salesOpenAt`, or, when that bound is
 * absent ("no bound", every pre-existing row) or unreadable, at the moment the
 * event went live (`publishedAt`), matching how `resolveTicketTypeSaleState`
 * treats an unreadable bound. The answer is the EARLIEST of those across the
 * ticket types that feed the price range (all of them). With no ticket types
 * it is `publishedAt` alone. Null for an event that was never published and
 * has no explicit sales opening.
 *
 * A type with no `salesOpenAt` counts as opening at `publishedAt` rather than
 * being skipped: skipping it would claim a later on-sale date than the one
 * buyers actually had whenever another type opens after the event went live.
 *
 * No opening is earlier than `publishedAt` when the event has one: a sales
 * window set to open on 09-01 for an event published on 09-15 sold nothing
 * before 09-15, because nobody could see it.
 */
export function offersValidFrom(
  event: { publishedAt?: Date | null },
  ticketTypes: ReadonlyArray<{ salesOpenAt?: Date | null }>,
): Date | null {
  const publishedAt = readable(event.publishedAt);
  const candidates =
    ticketTypes.length === 0
      ? [publishedAt]
      : ticketTypes.map((t) => readable(t.salesOpenAt) ?? publishedAt);
  let earliest: Date | null = null;
  for (const raw of candidates) {
    if (!raw) continue;
    const candidate =
      publishedAt && raw.getTime() < publishedAt.getTime() ? publishedAt : raw;
    if (earliest === null || candidate.getTime() < earliest.getTime()) {
      earliest = candidate;
    }
  }
  return earliest;
}

const readable = (d: Date | null | undefined): Date | null =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
