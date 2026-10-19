import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import type { PrismaClientOrTx } from "../types";

// The start-keyed half of the address-reveal scan. A plain candidate read:
// the holder gate in core decides what, if anything, is revealed. These pin
// the WHERE so the scan cannot quietly widen (drafts, EXACT rows, freeform
// events) or drop the cursor gate.

const STARTS_AFTER = new Date("2026-09-25T12:00:00.000Z");
const STARTS_AT_OR_BEFORE = new Date("2026-09-26T12:00:00.000Z");

function scanWith(rows: unknown[] = []) {
  const findMany = vi.fn(async () => rows);
  const prisma = { event: { findMany } } as unknown as PrismaClientOrTx;
  return { scan: makeEventsRepo(prisma), findMany };
}

describe("makeEventsRepo.findObscuredPlaceEventsStartingIn", () => {
  it("scheduled scan: PUBLISHED, OBSCURED, at a venue, starting in (after, atOrBefore], cursor unset", async () => {
    const { scan, findMany } = scanWith();

    await scan.findObscuredPlaceEventsStartingIn({
      startsAfter: STARTS_AFTER,
      startsAtOrBefore: STARTS_AT_OR_BEFORE,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = (findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; orderBy: unknown },
    ])[0];
    // Either anchor of the venue floor `max(startsAt, venueConfirmedStartsAt)
    // − 24h` landing in the window makes a candidate (N1): a show its
    // organizer moved earlier than the date the venue confirmed unlocks off
    // the CONFIRMED date, which a startsAt-only read never finds.
    expect(args.where).toEqual({
      status: "PUBLISHED",
      locationMode: "OBSCURED",
      placeId: { not: null },
      OR: [
        { startsAt: { gt: STARTS_AFTER, lte: STARTS_AT_OR_BEFORE } },
        {
          venueConfirmedStartsAt: { gt: STARTS_AFTER, lte: STARTS_AT_OR_BEFORE },
        },
      ],
      addressRevealNotifiedAt: null,
    });
    expect(args.orderBy).toEqual({ startsAt: "asc" });
  });

  it("an explicit eventId (ops re-drive) bypasses the cursor but keeps every other guard", async () => {
    const { scan, findMany } = scanWith();

    await scan.findObscuredPlaceEventsStartingIn({
      startsAfter: STARTS_AFTER,
      startsAtOrBefore: STARTS_AT_OR_BEFORE,
      eventId: "event-1",
    });

    const args = (findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ])[0];
    expect(args.where).toEqual({
      status: "PUBLISHED",
      locationMode: "OBSCURED",
      placeId: { not: null },
      OR: [
        { startsAt: { gt: STARTS_AFTER, lte: STARTS_AT_OR_BEFORE } },
        {
          venueConfirmedStartsAt: { gt: STARTS_AFTER, lte: STARTS_AT_OR_BEFORE },
        },
      ],
      id: "event-1",
    });
    expect(args.where).not.toHaveProperty("addressRevealNotifiedAt");
  });
});
