import { describe, expect, it, vi } from "vitest";

import {
  addressCorroborates,
  applyProposedLink,
  AUDIT_ACTION_LINKED,
  AUDIT_ACTION_REVERTED,
  buildPlaceIndex,
  buildPlanFile,
  countCorroboratedReviews,
  isDistinctivePlaceName,
  matchListing,
  normalizeName,
  parseBatchSize,
  parseLimit,
  parseOptionalValue,
  parsePlanFile,
  revertAppliedLink,
  summarizeLinks,
  summarizeReviews,
  titleFragments,
  type Classification,
  type LinkBackfillTx,
  type ListingCandidate,
  type PlaceCandidate,
  type ProposedLink,
} from "../src/scripts/backfill/done/plan-link-community-listing-places";

/**
 * Unit tests for the two-phase backfill that links PUBLISHED COMMUNITY
 * listings to the Place their title already names. NO DATABASE: the matcher is
 * pure and the write routines take a structural `tx`, so everything here runs
 * against an in-memory world.
 *
 * The load-bearing assertions in this file are the REFUSALS. A wrong link puts
 * somebody's open mic on another business's claimable venue page, so every
 * test that proves the matcher declines to guess is protecting a real user
 * from a real harm — and a change that turns one of those refusals into a
 * confident match is exactly the regression this file exists to catch.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EVENT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const EVENT_B = "bbbbbbbb-2222-4222-8222-222222222222";
const PLACE_COMEDY = "11111111-1111-4111-8111-111111111111";
const PLACE_CAROL = "22222222-2222-4222-8222-222222222222";
const PLACE_EAST_ROOM = "33333333-3333-4333-8333-333333333333";
const PLACE_SIPS = "44444444-4444-4444-8444-444444444444";
const PLACE_SUNSET = "55555555-5555-4555-8555-555555555555";
const PLACE_EAST_ROOM_DUPE = "66666666-6666-4666-8666-666666666666";
const PLACE_CLOSED = "77777777-7777-4777-8777-777777777777";
const PLACE_CAROL_EXACT = "88888888-8888-4888-8888-888888888888";

function place(overrides: Partial<PlaceCandidate> & { id: string; name: string }): PlaceCandidate {
  return {
    address: "100 Nowhere St, Nashville, TN 37203",
    addrLine1: "100 Nowhere St",
    city: "Nashville",
    region: "TN",
    postcode: "37203",
    status: "ACTIVE",
    listedInDirectory: true,
    ...overrides,
  };
}

const THIRD_COAST = place({
  id: PLACE_COMEDY,
  name: "Third Coast Comedy Club",
  address: "1310 Clinton St #115, Nashville, TN 37203",
  addrLine1: "1310 Clinton St #115",
});

const CAROL_ANNS = place({
  id: PLACE_CAROL,
  name: "Carol Ann's Home Cooking",
  address: "3020 Nolensville Pike, Nashville, TN 37211",
  addrLine1: "3020 Nolensville Pike",
  postcode: "37211",
});

/**
 * The same venue as CAROL_ANNS, but a Place row whose name is EXACTLY what the
 * title says. Short and generic, so only the address can rescue it.
 */
const CAROL_ANNS_EXACT = place({
  id: PLACE_CAROL_EXACT,
  name: "Carol Ann's",
  address: "3020 Nolensville Pike, Nashville, TN 37211",
  addrLine1: "3020 Nolensville Pike",
  postcode: "37211",
});

const EAST_ROOM = place({
  id: PLACE_EAST_ROOM,
  name: "The East Room",
  address: "2412 Gallatin Ave, Nashville, TN 37206",
  addrLine1: "2412 Gallatin Ave",
  postcode: "37206",
});

function listing(
  overrides: Partial<ListingCandidate> & { title: string },
): ListingCandidate {
  return {
    eventId: EVENT_A,
    startsAt: new Date("2026-10-01T01:00:00.000Z"),
    addressText: null,
    placeId: null,
    stewardship: "COMMUNITY",
    status: "PUBLISHED",
    ...overrides,
  };
}

function indexOf(...places: PlaceCandidate[]) {
  return buildPlaceIndex(places);
}

function expectAuto(classification: Classification): ProposedLink {
  expect(classification.kind).toBe("auto");
  if (classification.kind !== "auto") throw new Error("unreachable");
  return classification.link;
}

// ── Normalization ────────────────────────────────────────────────────────────

describe("normalizeName", () => {
  it("DELETES apostrophes rather than spacing them", () => {
    // The whole distinctiveness floor rests on this: "carol ann s" would be
    // three tokens and would sail past a floor built to refuse exactly this
    // shape of name.
    expect(normalizeName("Carol Ann's")).toBe("carol anns");
    expect(normalizeName("Carol Ann’s")).toBe("carol anns");
  });

  it("drops a leading 'the' on both sides of a comparison", () => {
    expect(normalizeName("The East Room")).toBe("east room");
    expect(normalizeName("East Room")).toBe("east room");
  });

  it("folds diacritics and expands an ampersand", () => {
    expect(normalizeName("Café Coco")).toBe("cafe coco");
    expect(normalizeName("Robert's & Sons")).toBe("roberts and sons");
  });
});

describe("titleFragments", () => {
  it("offers the tail after EVERY separator, plus the whole title", () => {
    const fragments = titleFragments("Open Mic at Sips at Sunset");
    expect(fragments.map((f) => f.normalized)).toEqual([
      "sips at sunset",
      "sunset",
      "open mic at sips at sunset",
    ]);
  });

  it("does not treat 'at' inside a word as a separator", () => {
    const fragments = titleFragments("Bathhouse Beats");
    expect(fragments.map((f) => f.kind)).toEqual(["whole-title"]);
  });

  it("accepts '@' as a separator", () => {
    const fragments = titleFragments("Jazz Night @ The Blue Room");
    expect(fragments[0]?.normalized).toBe("blue room");
  });
});

describe("isDistinctivePlaceName", () => {
  it("accepts a three-word, twelve-character venue name", () => {
    expect(isDistinctivePlaceName(normalizeName("Third Coast Comedy Club"))).toBe(true);
  });

  it("refuses two-word names, real and generic alike", () => {
    // These are the SAME shape. There is no rule that keeps the real one and
    // drops the fake one, so both are refused and the address has to rescue.
    expect(isDistinctivePlaceName(normalizeName("Carol Ann's"))).toBe(false);
    expect(isDistinctivePlaceName(normalizeName("The East Room"))).toBe(false);
    expect(isDistinctivePlaceName(normalizeName("Our Spot"))).toBe(false);
  });

  it("refuses a long name built entirely from generic words", () => {
    expect(isDistinctivePlaceName(normalizeName("The Live Music Venue"))).toBe(false);
  });
});

// ── Address corroboration ────────────────────────────────────────────────────

describe("addressCorroborates", () => {
  it("agrees on house number, street token and city", () => {
    expect(
      addressCorroborates("3020 Nolensville Pike, Nashville, TN 37211", CAROL_ANNS),
    ).toBe(true);
  });

  it("refuses a different house number on the same street", () => {
    expect(
      addressCorroborates("3021 Nolensville Pike, Nashville, TN 37211", CAROL_ANNS),
    ).toBe(false);
  });

  it("refuses when the city disagrees", () => {
    expect(
      addressCorroborates("3020 Nolensville Pike, Memphis, TN 38104", CAROL_ANNS),
    ).toBe(false);
  });

  it("refuses when the postcode is present on both sides and disagrees", () => {
    expect(
      addressCorroborates("3020 Nolensville Pike, Nashville, TN 37203", CAROL_ANNS),
    ).toBe(false);
  });

  it("refuses a listing with no address at all", () => {
    expect(addressCorroborates(null, CAROL_ANNS)).toBe(false);
    expect(addressCorroborates("   ", CAROL_ANNS)).toBe(false);
  });
});

// ── The matcher ──────────────────────────────────────────────────────────────

describe("matchListing — the accept path", () => {
  it("auto-links an unambiguous ' at <distinctive venue>' title", () => {
    const link = expectAuto(
      matchListing(
        listing({ title: "Roast the Host at Third Coast Comedy Club" }),
        indexOf(THIRD_COAST, CAROL_ANNS, EAST_ROOM),
      ),
    );

    expect(link.placeId).toBe(PLACE_COMEDY);
    expect(link.signal).toBe("at-suffix-exact");
    expect(link.confidence).toBe("high");
    expect(link.matchedText).toBe("Third Coast Comedy Club");
    // The rollback value is recorded on every proposal, always null.
    expect(link.priorPlaceId).toBeNull();
    expect(link.bucket).toBe("auto");
  });

  it("auto-links a whole-title exact match as title-exact", () => {
    const link = expectAuto(
      matchListing(
        listing({ title: "Third Coast Comedy Club" }),
        indexOf(THIRD_COAST),
      ),
    );
    expect(link.signal).toBe("title-exact");
  });

  it("records a corroborating address on a proposal it would make anyway", () => {
    const link = expectAuto(
      matchListing(
        listing({
          title: "Roast the Host at Third Coast Comedy Club",
          addressText: "1310 Clinton St, Nashville, TN 37203",
        }),
        indexOf(THIRD_COAST),
      ),
    );
    expect(link.addressCorroborated).toBe(true);
    expect(link.confidence).toBe("high");
  });
});

describe("matchListing — the refusals", () => {
  it("refuses a title that matches two different places", () => {
    const sips = place({ id: PLACE_SIPS, name: "Sips at Sunset Rooftop Bar" });
    const sunset = place({ id: PLACE_SUNSET, name: "Sunset Rooftop Bar" });

    const result = matchListing(
      listing({ title: "Open Mic at Sips at Sunset Rooftop Bar" }),
      indexOf(sips, sunset),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("ambiguous-multiple-places");
    expect(result.entry.candidates.map((c) => c.placeId).sort()).toEqual(
      [PLACE_SIPS, PLACE_SUNSET].sort(),
    );
  });

  it("refuses when two ACTIVE places share the same name, and says so", () => {
    const dupe = place({ id: PLACE_EAST_ROOM_DUPE, name: "East Room" });

    const result = matchListing(
      listing({ title: "Poetry Night at The East Room" }),
      indexOf(EAST_ROOM, dupe),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    // A different fix from an ambiguous title: merge the venue rows.
    expect(result.entry.reason).toBe("duplicate-place-name");
  });

  it("refuses a short generic name EVEN WHEN the address agrees", () => {
    // The brief's rule, unconditional: "Our Spot" is never auto-linked. A
    // matching address is a note for the human, not a second vote — a listing
    // and a user-submitted Place stub are quite capable of carrying two copies
    // of the same original address string, which is not independence.
    const result = matchListing(
      listing({
        title: "Grown and Sexy Open Mic at Carol Ann's",
        addressText: "3020 Nolensville Pike, Nashville, TN 37211",
      }),
      indexOf(CAROL_ANNS_EXACT),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("generic-place-name");
    expect(result.entry.note).toMatch(/likely approval/);
    expect(result.entry.candidates[0]?.addressCorroborated).toBe(true);
    // The operator's shortlist counts it.
    expect(countCorroboratedReviews([result.entry])).toBe(1);
  });

  it("refuses a short generic name with no corroborating address", () => {
    const result = matchListing(
      listing({
        title: "Poetry Night at The East Room",
        addressText: "somewhere in East Nashville",
      }),
      indexOf(EAST_ROOM),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("generic-place-name");
    expect(result.entry.candidates).toHaveLength(1);
    expect(result.entry.candidates[0]?.placeId).toBe(PLACE_EAST_ROOM);
  });

  it("refuses an abbreviated venue name, and shows the candidate", () => {
    // The real shape: the title says "Carol Ann's", the Place row is called
    // "Carol Ann's Home Cooking". A prefix is a LEAD, never a write.
    const result = matchListing(
      listing({
        title: "Grown and Sexy Open Mic at Carol Ann's",
        addressText: "3020 Nolensville Pike, Nashville, TN 37211",
      }),
      indexOf(CAROL_ANNS),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("partial-name-match");
    expect(result.entry.candidates[0]).toMatchObject({
      placeId: PLACE_CAROL,
      signal: "at-suffix-partial",
      // Even a corroborating address does not promote a partial to auto.
      addressCorroborated: true,
    });
  });

  it("does not raise a one-token tail as a partial — it prefixes half the table", () => {
    const barrelhouse = place({ id: PLACE_SUNSET, name: "Barrelhouse Nashville" });
    const result = matchListing(
      listing({ title: "Trivia at Barrel" }),
      indexOf(barrelhouse),
    );
    expect(result).toEqual({ kind: "no-match" });
  });

  it("refuses a bare substring hit with no separator", () => {
    // The crude `LIKE '%name%'` probe. Visible for a human, never written.
    const result = matchListing(
      listing({ title: "Third Coast Comedy Club Presents: Roast the Host" }),
      indexOf(THIRD_COAST),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("weak-substring-only");
    expect(result.entry.candidates[0]?.signal).toBe("weak-substring");
  });

  it("refuses when the only name match is a non-ACTIVE place", () => {
    const closed = place({
      id: PLACE_CLOSED,
      name: "Third Coast Comedy Club",
      status: "ARCHIVED",
    });

    const result = matchListing(
      listing({ title: "Roast the Host at Third Coast Comedy Club" }),
      indexOf(closed),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("inactive-place");
  });

  it("never touches a listing that already has a placeId", () => {
    const result = matchListing(
      listing({
        title: "Roast the Host at Third Coast Comedy Club",
        placeId: PLACE_CAROL,
      }),
      indexOf(THIRD_COAST, CAROL_ANNS),
    );

    // Not "auto to Third Coast" — the existing link wins, whatever it says.
    expect(result).toEqual({ kind: "already-linked", placeId: PLACE_CAROL });
  });

  it("refuses a row that is not a PUBLISHED COMMUNITY listing", () => {
    const result = matchListing(
      listing({
        title: "Roast the Host at Third Coast Comedy Club",
        stewardship: "OWNED",
      }),
      indexOf(THIRD_COAST),
    );

    expect(result.kind).toBe("needs-review");
    if (result.kind !== "needs-review") throw new Error("unreachable");
    expect(result.entry.reason).toBe("unexpected-listing-state");
  });

  it("reports no match when the venue has no row at all", () => {
    const result = matchListing(
      listing({ title: "Open Mic at The Nonexistent Room For Poets" }),
      indexOf(THIRD_COAST),
    );
    expect(result).toEqual({ kind: "no-match" });
  });

  it("prefers refusing ambiguity over applying the distinctiveness gate", () => {
    // Both candidates are distinctive; ambiguity is still checked first.
    const a = place({ id: PLACE_SIPS, name: "Sips at Sunset Rooftop Bar" });
    const b = place({ id: PLACE_SUNSET, name: "Sunset Rooftop Bar" });
    const result = matchListing(
      listing({ title: "Open Mic at Sips at Sunset Rooftop Bar" }),
      indexOf(a, b),
    );
    expect(result.kind).toBe("needs-review");
  });
});

// ── The in-memory world for the write routines ───────────────────────────────

type EventRow = {
  id: string;
  title: string;
  placeId: string | null;
  stewardship: string;
  status: string;
};

function makeWorld(events: EventRow[], places: PlaceCandidate[]) {
  const eventState = new Map(events.map((e) => [e.id, { ...e }]));
  const placeState = new Map(places.map((p) => [p.id, { ...p }]));
  const audits: Array<{ action: string; entityId: string; data: Record<string, unknown> }> = [];

  const tx: LinkBackfillTx = {
    event: {
      findUnique: vi.fn(async ({ where }) => {
        const row = eventState.get(where.id);
        return row
          ? {
              id: row.id,
              title: row.title,
              placeId: row.placeId,
              stewardship: row.stewardship,
              status: row.status,
            }
          : null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = eventState.get(where.id);
        // A faithful compare-and-swap: EVERY clause in the WHERE has to hold,
        // so a test cannot pass by accident on a write whose guard was dropped.
        if (!row) return { count: 0 };
        if (row.placeId !== where.placeId) return { count: 0 };
        if (row.stewardship !== where.stewardship) return { count: 0 };
        row.placeId = data.placeId;
        return { count: 1 };
      }),
    },
    place: {
      findUnique: vi.fn(async ({ where }) => {
        const row = placeState.get(where.id);
        return row
          ? {
              id: row.id,
              name: row.name,
              status: row.status,
              // A fixture that names no mode is a public (EXACT) venue.
              locationMode:
                (row as { locationMode?: string }).locationMode ?? "EXACT",
            }
          : null;
      }),
    },
  };

  const deps = {
    logAudit: vi.fn(async (entry: {
      entity: string;
      entityId: string;
      action: string;
      data: Record<string, unknown>;
    }) => {
      audits.push({ action: entry.action, entityId: entry.entityId, data: entry.data });
    }),
  };

  return { tx, deps, eventState, placeState, audits };
}

const LINK: ProposedLink = {
  eventId: EVENT_A,
  eventTitle: "Roast the Host at Third Coast Comedy Club",
  eventStartsAt: "2026-10-01T01:00:00.000Z",
  eventAddressText: "1310 Clinton St #115, Nashville, TN 37203",
  priorPlaceId: null,
  placeId: PLACE_COMEDY,
  placeName: "Third Coast Comedy Club",
  placeAddress: "1310 Clinton St #115, Nashville, TN 37203",
  placeListedInDirectory: true,
  signal: "at-suffix-exact",
  matchedText: "Third Coast Comedy Club",
  confidence: "high",
  addressCorroborated: true,
  bucket: "auto",
};

function unlinkedEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENT_A,
    title: LINK.eventTitle,
    placeId: null,
    stewardship: "COMMUNITY",
    status: "PUBLISHED",
    ...overrides,
  };
}

const META = { planGeneratedAt: "2026-09-12T00:00:00.000Z" };

// ── applyProposedLink ────────────────────────────────────────────────────────

describe("applyProposedLink", () => {
  it("links the event and audits it through the injected repo", async () => {
    const world = makeWorld([unlinkedEvent()], [THIRD_COAST]);

    const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);

    expect(outcome).toEqual({ kind: "linked", eventId: EVENT_A, placeId: PLACE_COMEDY });
    expect(world.eventState.get(EVENT_A)?.placeId).toBe(PLACE_COMEDY);
    expect(world.audits).toHaveLength(1);
    expect(world.audits[0]?.action).toBe(AUDIT_ACTION_LINKED);
    // The audit row carries the rollback value and the evidence.
    expect(world.audits[0]?.data).toMatchObject({
      priorPlaceId: null,
      placeId: PLACE_COMEDY,
      signal: "at-suffix-exact",
      confidence: "high",
    });
  });

  it("IS IDEMPOTENT — a second run over the same plan writes nothing", async () => {
    const world = makeWorld([unlinkedEvent()], [THIRD_COAST]);

    const first = await applyProposedLink(world.tx, world.deps, LINK, META);
    const second = await applyProposedLink(world.tx, world.deps, LINK, META);

    expect(first.kind).toBe("linked");
    expect(second).toEqual({
      kind: "already-applied",
      eventId: EVENT_A,
      placeId: PLACE_COMEDY,
    });
    // One write, one audit row. Not two of either.
    expect(world.tx.event.updateMany).toHaveBeenCalledTimes(1);
    expect(world.audits).toHaveLength(1);
  });

  it("NEVER overwrites a placeId somebody else set", async () => {
    const world = makeWorld(
      [unlinkedEvent({ placeId: PLACE_CAROL })],
      [THIRD_COAST, CAROL_ANNS],
    );

    const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);

    expect(outcome.kind).toBe("skipped");
    expect(world.eventState.get(EVENT_A)?.placeId).toBe(PLACE_CAROL);
    expect(world.tx.event.updateMany).not.toHaveBeenCalled();
    expect(world.audits).toHaveLength(0);
  });

  it("skips a listing whose title changed since the plan was reviewed", async () => {
    // The match was DERIVED from the title. A retitled listing has no
    // surviving evidence, so the reviewed conclusion is void.
    const world = makeWorld(
      [unlinkedEvent({ title: "Roast the Host (moved!)" })],
      [THIRD_COAST],
    );

    const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/title changed/i);
    expect(world.tx.event.updateMany).not.toHaveBeenCalled();
  });

  it("skips a listing that stopped being a PUBLISHED COMMUNITY row", async () => {
    for (const overrides of [{ stewardship: "OWNED" }, { status: "DRAFT" }]) {
      const world = makeWorld([unlinkedEvent(overrides)], [THIRD_COAST]);
      const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);
      expect(outcome.kind).toBe("skipped");
      expect(world.tx.event.updateMany).not.toHaveBeenCalled();
    }
  });

  it("skips a place that vanished, went inactive, or was renamed", async () => {
    const cases: Array<[string, PlaceCandidate[]]> = [
      ["missing", []],
      ["inactive", [place({ id: PLACE_COMEDY, name: LINK.placeName, status: "ARCHIVED" })]],
      ["renamed", [place({ id: PLACE_COMEDY, name: "Fourth Coast Comedy Club" })]],
    ];
    for (const [, places] of cases) {
      const world = makeWorld([unlinkedEvent()], places);
      const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);
      expect(outcome.kind).toBe("skipped");
      expect(world.tx.event.updateMany).not.toHaveBeenCalled();
    }
  });

  it("REFUSES a place that withholds its address — the typed street would stay on the event", async () => {
    // Fail-closed: only the literal "EXACT" links (the fake maps an absent
    // mode to EXACT, so the unrecognised values stand in for a broken row).
    for (const locationMode of ["OBSCURED", "", "exact"]) {
      const withheld = {
        ...place({ id: PLACE_COMEDY, name: LINK.placeName }),
        locationMode,
      } as PlaceCandidate;
      const world = makeWorld([unlinkedEvent()], [withheld]);

      const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);

      expect(outcome.kind).toBe("skipped");
      if (outcome.kind !== "skipped") throw new Error("unreachable");
      expect(outcome.reason).toMatch(/withholds its address/);
      expect(world.tx.event.updateMany).not.toHaveBeenCalled();
      expect(world.audits).toHaveLength(0);
    }
  });

  it("reports a lost compare-and-swap instead of auditing a write that did not happen", async () => {
    const world = makeWorld([unlinkedEvent()], [THIRD_COAST]);
    // Somebody links the row between our read and our write.
    world.tx.event.updateMany = vi.fn(async () => ({ count: 0 }));

    const outcome = await applyProposedLink(world.tx, world.deps, LINK, META);

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/compare-and-swap/i);
    expect(world.audits).toHaveLength(0);
  });
});

// ── revertAppliedLink ────────────────────────────────────────────────────────

describe("revertAppliedLink", () => {
  it("restores the prior null and audits the reversal", async () => {
    const world = makeWorld([unlinkedEvent({ placeId: PLACE_COMEDY })], [THIRD_COAST]);

    const outcome = await revertAppliedLink(world.tx, world.deps, LINK);

    expect(outcome.kind).toBe("linked");
    expect(world.eventState.get(EVENT_A)?.placeId).toBeNull();
    expect(world.audits[0]?.action).toBe(AUDIT_ACTION_REVERTED);
  });

  it("leaves a row that has since been pointed somewhere else", async () => {
    const world = makeWorld([unlinkedEvent({ placeId: PLACE_CAROL })], [THIRD_COAST]);

    const outcome = await revertAppliedLink(world.tx, world.deps, LINK);

    expect(outcome.kind).toBe("skipped");
    expect(world.eventState.get(EVENT_A)?.placeId).toBe(PLACE_CAROL);
    expect(world.audits).toHaveLength(0);
  });
});

// ── The plan file ────────────────────────────────────────────────────────────

describe("plan file", () => {
  const plan = buildPlanFile({
    generatedAt: new Date("2026-09-12T00:00:00.000Z"),
    databaseHost: "localhost",
    counts: { examined: 19, proposed: 1 },
    links: [LINK],
    needsReview: [
      {
        eventId: EVENT_B,
        eventTitle: "Poetry Night at The East Room",
        eventStartsAt: "2026-10-02T01:00:00.000Z",
        eventAddressText: null,
        reason: "generic-place-name",
        note: "too generic",
        candidates: [],
      },
    ],
  });

  it("round-trips through JSON", () => {
    const parsed = parsePlanFile(JSON.parse(JSON.stringify(plan)));
    expect(parsed.links).toEqual([LINK]);
    expect(parsed.needsReview).toHaveLength(1);
  });

  it("tells a reader that needsReview[] is never applied", () => {
    expect(plan._readme).toMatch(/needsReview\[\] is NEVER written/);
  });

  it("rejects an unknown key from a hand edit rather than dropping it", () => {
    const raw = JSON.parse(JSON.stringify(plan));
    raw.links[0].placeSlug = "oops";
    expect(() => parsePlanFile(raw)).toThrow();
  });

  it("rejects a hand-copied duplicate event in links[]", () => {
    const raw = JSON.parse(JSON.stringify(plan));
    raw.links.push(JSON.parse(JSON.stringify(raw.links[0])));
    expect(() => parsePlanFile(raw)).toThrow(/more than once/);
  });

  it("rejects a plan written by a different or older script", () => {
    const raw = JSON.parse(JSON.stringify(plan));
    raw.version = 2;
    expect(() => parsePlanFile(raw)).toThrow();
  });

  it("refuses a non-null priorPlaceId — the candidate set is placeId IS NULL", () => {
    const raw = JSON.parse(JSON.stringify(plan));
    raw.links[0].priorPlaceId = PLACE_CAROL;
    expect(() => parsePlanFile(raw)).toThrow();
  });
});

// ── Counting ─────────────────────────────────────────────────────────────────

describe("summaries", () => {
  it("splits the confidence distribution an operator reads before running", () => {
    const medium: ProposedLink = {
      ...LINK,
      eventId: EVENT_B,
      confidence: "medium",
      placeListedInDirectory: false,
      addressCorroborated: true,
    };
    expect(summarizeLinks([LINK, medium])).toEqual({
      high: 1,
      medium: 1,
      addressCorroborated: 2,
      directoryListed: 1,
      atSuffix: 2,
      titleExact: 0,
      manual: 0,
    });
  });

  it("counts every review reason separately, including the zeroes", () => {
    const counts = summarizeReviews([
      {
        eventId: EVENT_A,
        eventTitle: "x",
        eventStartsAt: "2026-10-01T01:00:00.000Z",
        eventAddressText: null,
        reason: "ambiguous-multiple-places",
        note: "",
        candidates: [],
      },
    ]);
    expect(counts["ambiguous-multiple-places"]).toBe(1);
    expect(counts["generic-place-name"]).toBe(0);
    expect(Object.keys(counts)).toHaveLength(7);
  });
});

// ── Flags ────────────────────────────────────────────────────────────────────

describe("flag parsing", () => {
  it("refuses a limit that would silently mean 'the whole table'", () => {
    expect(() => parseLimit("nope")).toThrow(/--limit/);
    expect(() => parseLimit("0")).toThrow(/--limit/);
    expect(() => parseLimit("-5")).toThrow(/--limit/);
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit("25")).toBe(25);
  });

  it("bounds the batch size, because a batch is one transaction", () => {
    expect(parseBatchSize(undefined)).toBe(25);
    expect(() => parseBatchSize("1000")).toThrow(/<= 200/);
    expect(() => parseBatchSize("0")).toThrow();
  });

  it("refuses an empty --start-after instead of widening the run", () => {
    expect(() => parseOptionalValue("", "--start-after")).toThrow(/empty/);
    expect(parseOptionalValue(undefined, "--start-after")).toBeUndefined();
  });
});
