import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { makeEventsRepo } from "../events";

// ─────────────────────────────────────────────────────────────────────────────
// `countCommunityListingsAtPlace` — FR-007's "what am I being asked to accept?"
// number (community-listings-at-claimed-venues).
//
// The WHERE is the whole behaviour here, and every clause in it is a decision
// that can be wrong in a way no type catches. This pins the shape; the real
// rows are proven in `test/integration/venue-confirmation.test.ts`.
//
// The two clauses worth stating out loud, because the obvious query gets both
// wrong:
//   · WITHDRAWN listings are EXCLUDED even though confirmation is not filtered
//     at all. Withdrawal negates the community arm (FR-003), so flipping the
//     flag can never confirm one — counting it promises the owner something
//     the switch cannot deliver.
//   · "Upcoming" is TWO clauses, because `Event.startsAt` on a recurring
//     listing is a pin that can go stale while its SCHEDULED nights run months
//     out. Those nights are exactly what accepting would block.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function repoWithCapturedWhere() {
  const count = vi.fn(async () => 7);
  const repo = makeEventsRepo({ event: { count } } as never);
  return {
    repo,
    count,
    where: () =>
      (count.mock.calls[0]![0] as { where: Prisma.EventWhereInput }).where,
  };
}

describe("countCommunityListingsAtPlace", () => {
  it("counts only PUBLISHED, PUBLIC, COMMUNITY rows at the given place", async () => {
    const { repo, where } = repoWithCapturedWhere();
    await repo.countCommunityListingsAtPlace({ placeId: PLACE_ID, now: NOW });

    expect(where()).toMatchObject({
      placeId: PLACE_ID,
      stewardship: "COMMUNITY",
      status: "PUBLISHED",
      visibility: "PUBLIC",
    });
  });

  it("EXCLUDES withdrawn listings — the flag can never confirm one", async () => {
    // Without this clause the owner is told "accept the 5 listings claiming
    // your room", flips it on, and sees none: FR-003 negates the community arm
    // for every one of them.
    const { repo, where } = repoWithCapturedWhere();
    await repo.countCommunityListingsAtPlace({ placeId: PLACE_ID, now: NOW });

    expect(where().venueConfirmationWithdrawnAt).toBeNull();
  });

  it("counts a recurring listing whose startsAt PIN is stale but whose nights are not", async () => {
    // `Event.startsAt` on a recurring listing mirrors one night and can fall
    // behind (see listPublishedByPlace's `includeDateOccurrences` ordering
    // caveat). A `startsAt: { gt: now }` filter alone reports 0 for a weekly
    // open mic that accepting would block every week of.
    const { repo, where } = repoWithCapturedWhere();
    await repo.countCommunityListingsAtPlace({ placeId: PLACE_ID, now: NOW });

    expect(where().OR).toEqual([
      { startsAt: { gt: NOW } },
      { dates: { some: { status: "SCHEDULED", startsAt: { gt: NOW } } } },
    ]);
  });

  it("uses `some`, so a residency counts once rather than once per night", async () => {
    const { repo, where } = repoWithCapturedWhere();
    await repo.countCommunityListingsAtPlace({ placeId: PLACE_ID, now: NOW });

    const dateArm = (where().OR as Array<Record<string, unknown>>)[1]!;
    expect(Object.keys(dateArm.dates as object)).toEqual(["some"]);
  });

  it("does NOT filter on confirmation — unconfirmed is the entire point", async () => {
    // Filtering by confirmation would answer zero for every place that has not
    // yet consented, i.e. every place this number is shown to.
    const { repo, where } = repoWithCapturedWhere();
    await repo.countCommunityListingsAtPlace({ placeId: PLACE_ID, now: NOW });

    const w = where() as Record<string, unknown>;
    expect(w).not.toHaveProperty("venueConfirmedAt");
    expect(w).not.toHaveProperty("venueConfirmedPlaceId");
  });

  it("returns the count the database gives it, unmodified", async () => {
    const { repo } = repoWithCapturedWhere();
    await expect(
      repo.countCommunityListingsAtPlace({ placeId: PLACE_ID, now: NOW }),
    ).resolves.toBe(7);
  });
});
