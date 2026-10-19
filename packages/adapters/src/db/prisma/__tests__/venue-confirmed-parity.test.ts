import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

import {
  isVenueConfirmed,
  venueConfirmedFilterFor,
  type VenueConfirmationEventFields,
  type VenueConfirmationPlaceFields,
} from "@th/core/lib/venue-confirmation";

import {
  makeEventsRepo,
  venueConfirmedFragment,
  venueConfirmedSqlArms,
} from "../events";

// ─────────────────────────────────────────────────────────────────────────────
// THE PARITY TEST (community-listings-at-claimed-venues FR-004).
//
// Venue confirmation is expressed THREE times, and it cannot be collapsed into
// one function — one runs in JS over loaded records, two must push into SQL:
//
//   1. `isVenueConfirmed`        packages/core/src/lib/venue-confirmation.ts
//   2. `venueConfirmedFragment`  ../events.ts — Prisma `EventWhereInput` for
//        listPublishedByPlace / listPublishedOccurrencesByPlace /
//        listPublishedByPlaceIds / listByCalendar
//   3. `venueConfirmedSqlArms`   ../events.ts — hand-written `Prisma.sql` for
//        pickRandomEvent's `$queryRaw`
//
// (`venueConfirmedFilterFor` is a thin accessor, NOT a fourth expression.)
//
// If they drift, public reads and SQL reads silently disagree about which
// events a venue has — a venue page and a venue calendar showing different
// listings, with nothing failing. So ONE fixture corpus covering every arm and
// every negation runs through all three paths and must produce IDENTICAL
// verdicts.
//
// HOW THE SQL PATHS ARE EVALUATED WITHOUT A DATABASE: two small interpreters
// below, one per rendering. They are deliberately NARROW and they THROW on any
// shape they do not recognise — a permissive interpreter would silently return
// false for a new arm and turn this gate into one of the fake gates this repo
// already documents. The real-Postgres proof lives in
// `test/integration/venue-confirmation.test.ts`; this file is the one that
// runs everywhere, on every change, with no container.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PLACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_HUMAN_ID = "44444444-4444-4444-8444-444444444444";
const STRANGER_ORG_ID = "55555555-5555-4555-8555-555555555555";
const STRANGER_HUMAN_ID = "66666666-6666-4666-8666-666666666666";

const AT = new Date("2026-09-12T12:00:00.000Z");

type Fixture = {
  name: string;
  event: VenueConfirmationEventFields;
  place: VenueConfirmationPlaceFields;
  expected: boolean;
  /** Which arm (or negation) this row exists to pin. */
  pins: string;
};

function place(
  over: Partial<VenueConfirmationPlaceFields> = {},
): VenueConfirmationPlaceFields {
  return {
    id: PLACE_ID,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
    ...over,
  };
}

function event(
  over: Partial<VenueConfirmationEventFields> = {},
): VenueConfirmationEventFields {
  return {
    orgId: null,
    humanId: null,
    placeId: PLACE_ID,
    stewardship: "OWNED",
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    ...over,
  };
}

const OWNED_PLACE = place({
  orgIdsWithAccess: [OWNER_ORG_ID],
  humanIdsWithAccess: [OWNER_HUMAN_ID],
});

const ACCEPTING_PLACE = place({ acceptsCommunityListings: true });

/**
 * Every arm and every negation. A failure names the arm it broke.
 */
const FIXTURES: Fixture[] = [
  // ── stamp arm ────────────────────────────────────────────────────────────
  {
    name: "1. stamped for THIS place, not withdrawn",
    event: event({ venueConfirmedAt: AT, venueConfirmedPlaceId: PLACE_ID }),
    place: place(),
    expected: true,
    pins: "stamp arm holds",
  },
  {
    name: "2. stamped but WITHDRAWN",
    event: event({
      venueConfirmedAt: AT,
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: AT,
    }),
    place: place(),
    expected: false,
    pins: "withdrawal negates the stamp arm",
  },
  {
    name: "3. stamped for a DIFFERENT place",
    event: event({
      venueConfirmedAt: AT,
      venueConfirmedPlaceId: OTHER_PLACE_ID,
    }),
    place: place(),
    expected: false,
    pins: "the stamp is bound to the place it was issued for (security H1)",
  },
  {
    name: "4. stamped, event has NO placeId",
    event: event({
      placeId: null,
      venueConfirmedAt: AT,
      venueConfirmedPlaceId: PLACE_ID,
    }),
    place: place(),
    expected: false,
    pins: "a placeless event is at no venue, so no venue vouches",
  },

  // ── owner arm ────────────────────────────────────────────────────────────
  {
    name: "5. unstamped, orgId is an owning org",
    event: event({ orgId: OWNER_ORG_ID }),
    place: OWNED_PLACE,
    expected: true,
    pins: "owner arm (org) — confirmed by construction",
  },
  {
    name: "6. unstamped, humanId is a direct human owner",
    event: event({ humanId: OWNER_HUMAN_ID }),
    place: OWNED_PLACE,
    expected: true,
    pins: "owner arm (human) — confirmed by construction",
  },
  {
    name: "7. unstamped, owner ids present but NOT matching",
    event: event({ orgId: STRANGER_ORG_ID, humanId: STRANGER_HUMAN_ID }),
    place: OWNED_PLACE,
    expected: false,
    pins: "owner arm negation — a stranger's event is not the venue's word",
  },
  {
    name: "8. owner-arm match AND withdrawnAt set",
    event: event({ orgId: OWNER_ORG_ID, venueConfirmationWithdrawnAt: AT }),
    place: OWNED_PLACE,
    expected: true,
    pins:
      "FR-003 RULING: withdrawal does NOT negate the OWNER arm. " +
      "withdraw-venue-confirmation.ts refuses venue-owned events outright " +
      "(INVALID_STATUS: venue_owned_event), so the owner arm is absolute.",
  },

  // ── community arm (FR-002) ───────────────────────────────────────────────
  {
    name: "9. COMMUNITY at an ACCEPTING place, not withdrawn",
    event: event({ stewardship: "COMMUNITY" }),
    place: ACCEPTING_PLACE,
    expected: true,
    pins: "the new community arm holds",
  },
  {
    name: "10. COMMUNITY at a place with the flag OFF",
    event: event({ stewardship: "COMMUNITY" }),
    place: place(),
    expected: false,
    pins: "consent is explicit — default false confirms nothing",
  },
  {
    name: "11. COMMUNITY at an ACCEPTING place, WITHDRAWN",
    event: event({
      stewardship: "COMMUNITY",
      venueConfirmationWithdrawnAt: AT,
    }),
    place: ACCEPTING_PLACE,
    expected: false,
    pins:
      "FR-003: withdrawal negates the community arm, so an owner can reject " +
      "ONE bad listing without switching the venue-wide flag off",
  },
  {
    name: "12. COMMUNITY pointing at ANOTHER place",
    event: event({ stewardship: "COMMUNITY", placeId: OTHER_PLACE_ID }),
    place: ACCEPTING_PLACE,
    expected: false,
    pins: "consent from venue A never travels to venue B",
  },
  {
    name: "13. COMMUNITY with NO placeId",
    event: event({ stewardship: "COMMUNITY", placeId: null }),
    place: ACCEPTING_PLACE,
    expected: false,
    pins: "an unattached listing is at no venue",
  },
  {
    name: "14. OWNED (not COMMUNITY) at an ACCEPTING place",
    event: event({ orgId: STRANGER_ORG_ID }),
    place: ACCEPTING_PLACE,
    expected: false,
    pins:
      "blanket consent is for OWNERLESS listings only — an owned third-party " +
      "event still needs a stamp",
  },
  {
    name: "15. COMMUNITY, also stamped-and-withdrawn, flag ON",
    event: event({
      stewardship: "COMMUNITY",
      venueConfirmedAt: AT,
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: AT,
    }),
    place: ACCEPTING_PLACE,
    expected: false,
    pins: "withdrawal negates stamp AND community together",
  },
  {
    name: "16. COMMUNITY at an ACCEPTING place that also owns the event",
    event: event({ stewardship: "COMMUNITY", orgId: OWNER_ORG_ID }),
    place: place({
      orgIdsWithAccess: [OWNER_ORG_ID],
      acceptsCommunityListings: true,
    }),
    expected: true,
    pins: "arms are an OR — two holding is still true",
  },

  // ── nothing at all ───────────────────────────────────────────────────────
  {
    name: "17. unstamped OWNED event, no owners, flag off",
    event: event(),
    place: place(),
    expected: false,
    pins: "the empty case — no arm holds",
  },
  {
    name: "18. COMMUNITY, flag ON, but the place row is a DIFFERENT venue",
    event: event({ stewardship: "COMMUNITY", placeId: PLACE_ID }),
    place: place({ id: OTHER_PLACE_ID, acceptsCommunityListings: true }),
    expected: false,
    pins:
      "the community arm compares event.placeId to place.id, not to itself — " +
      "a caller that hands in the wrong place row gets false, not a match",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Interpreter 1 — Prisma `EventWhereInput` (the list reads)
// ─────────────────────────────────────────────────────────────────────────────

/** The event columns the fragment is allowed to reference. */
const WHERE_FIELDS = [
  "orgId",
  "humanId",
  "placeId",
  "stewardship",
  "venueConfirmedAt",
  "venueConfirmationWithdrawnAt",
  "venueConfirmedPlaceId",
] as const;
type WhereField = (typeof WHERE_FIELDS)[number];

function columnOf(e: VenueConfirmationEventFields, field: WhereField): unknown {
  switch (field) {
    case "orgId":
      return e.orgId ?? null;
    case "humanId":
      return e.humanId ?? null;
    case "placeId":
      return e.placeId ?? null;
    case "stewardship":
      return e.stewardship;
    case "venueConfirmedAt":
      return e.venueConfirmedAt ?? null;
    case "venueConfirmationWithdrawnAt":
      return e.venueConfirmationWithdrawnAt ?? null;
    case "venueConfirmedPlaceId":
      return e.venueConfirmedPlaceId ?? null;
  }
}

function matchesCondition(actual: unknown, condition: unknown): boolean {
  if (condition === null) return actual === null;
  if (typeof condition === "string") return actual === condition;
  if (condition && typeof condition === "object") {
    const keys = Object.keys(condition as Record<string, unknown>);
    if (keys.length !== 1) {
      throw new Error(
        `parity interpreter: unsupported multi-key condition ${JSON.stringify(condition)}`,
      );
    }
    const [key] = keys;
    const value = (condition as Record<string, unknown>)[key!];
    if (key === "not") {
      if (value !== null) {
        throw new Error("parity interpreter: only `{ not: null }` is supported");
      }
      return actual !== null;
    }
    if (key === "in") {
      if (!Array.isArray(value)) {
        throw new Error("parity interpreter: `in` must take an array");
      }
      return value.includes(actual as never);
    }
    throw new Error(`parity interpreter: unsupported operator \`${key}\``);
  }
  throw new Error(
    `parity interpreter: unsupported condition ${JSON.stringify(condition)}`,
  );
}

function evaluateWhere(
  where: Prisma.EventWhereInput,
  e: VenueConfirmationEventFields,
): boolean {
  const entries = Object.entries(where);
  if (entries.length === 0) {
    throw new Error("parity interpreter: empty where clause");
  }
  // Top-level keys AND together, exactly as Prisma composes them.
  return entries.every(([key, value]) => {
    if (key === "OR") {
      if (!Array.isArray(value)) {
        throw new Error("parity interpreter: `OR` must take an array");
      }
      // An empty OR would match NOTHING in Prisma. The fragment never emits
      // one (it always contributes the stamp arm), so treat it as a drift
      // signal rather than silently returning false.
      if (value.length === 0) {
        throw new Error("parity interpreter: unexpected empty `OR`");
      }
      return value.some((arm) =>
        evaluateWhere(arm as Prisma.EventWhereInput, e),
      );
    }
    if (!(WHERE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `parity interpreter: unsupported where key \`${key}\` — a new arm ` +
          `was added to venueConfirmedFragment without teaching this test ` +
          `about it. Teach it, do not widen it blindly.`,
      );
    }
    return matchesCondition(columnOf(e, key as WhereField), value);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Interpreter 2 — the raw `Prisma.sql` arms (pickRandomEvent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates ONE rendered arm by matching its SQL text against the exact set of
 * shapes `venueConfirmedSqlArms` emits, then applying that shape's semantics to
 * the fixture. Any unrecognised SQL throws.
 *
 * `sql.strings` is the template's literal chunks and `sql.values` its bound
 * parameters, so both the shape and the bound values are checked — a bound
 * `placeId` that stopped being the place under read would fail here.
 */
function evaluateSqlArm(
  kind: string,
  sql: Prisma.Sql,
  e: VenueConfirmationEventFields,
  boundPlaceId: string,
): boolean {
  const text = sql.strings.join("?").replace(/\s+/g, " ").trim();
  switch (kind) {
    case "stamp": {
      expect(text).toBe(
        '(e."venueConfirmedAt" IS NOT NULL AND e."venueConfirmationWithdrawnAt" IS NULL AND e."venueConfirmedPlaceId" = e."placeId")',
      );
      return (
        (e.venueConfirmedAt ?? null) !== null &&
        (e.venueConfirmationWithdrawnAt ?? null) === null &&
        (e.venueConfirmedPlaceId ?? null) === (e.placeId ?? null) &&
        // `venueConfirmedPlaceId = placeId` in SQL is NULL (not true) when
        // either side is NULL, so a placeless event never matches.
        (e.placeId ?? null) !== null
      );
    }
    case "orgOwner": {
      expect(text).toBe('e."orgId" = ANY(?::text[])');
      const ids = sql.values[0] as string[];
      return (e.orgId ?? null) !== null && ids.includes(e.orgId!);
    }
    case "humanOwner": {
      expect(text).toBe('e."humanId" = ANY(?::text[])');
      const ids = sql.values[0] as string[];
      return (e.humanId ?? null) !== null && ids.includes(e.humanId!);
    }
    case "community": {
      expect(text).toBe(
        '(e."stewardship" = \'COMMUNITY\' AND e."venueConfirmationWithdrawnAt" IS NULL AND e."placeId" = ?)',
      );
      // Read the BOUND VALUE, exactly as the owner arms do — do not re-derive
      // it from the caller's argument. The `?` above proves a parameter exists,
      // never WHICH one, and this is the only arm whose binding is supplied by
      // the caller rather than being a column-to-column compare. Asserting the
      // caller handed us the right id is the whole point.
      expect(sql.values).toHaveLength(1);
      expect(sql.values[0]).toBe(boundPlaceId);
      const bound = sql.values[0] as string;
      return (
        e.stewardship === "COMMUNITY" &&
        (e.venueConfirmationWithdrawnAt ?? null) === null &&
        (e.placeId ?? null) !== null &&
        e.placeId === bound
      );
    }
    default:
      throw new Error(
        `parity interpreter: unknown SQL arm kind \`${kind}\` — a new arm was ` +
          `added to venueConfirmedSqlArms without teaching this test about it.`,
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("venue confirmation — TS/SQL parity over one fixture corpus", () => {
  it("the corpus covers every arm and every negation", () => {
    // A guard against someone deleting rows to make a failure go away.
    expect(FIXTURES).toHaveLength(18);
    expect(FIXTURES.filter((f) => f.expected)).toHaveLength(6);
    expect(new Set(FIXTURES.map((f) => f.name)).size).toBe(FIXTURES.length);
  });

  describe.each(FIXTURES)("$name", (fixture) => {
    const { event: e, place: p, expected, pins } = fixture;

    it(`isVenueConfirmed (TS) — ${pins}`, () => {
      expect(isVenueConfirmed(e, p)).toBe(expected);
    });

    it("venueConfirmedFragment (Prisma WhereInput) agrees with the TS verdict", () => {
      // Read the place the event is actually at, exactly as every caller does:
      // the fragment is bound to the place being READ, which is `p.id`.
      const fragment = venueConfirmedFragment(
        { placeId: p.id },
        venueConfirmedFilterFor(p),
      );
      expect(fragment).toHaveLength(1);
      // The outer query pins `placeId` to the place under read; the fragment
      // composes with it as an AND, so replicate that scoping here.
      const inScope = (e.placeId ?? null) === p.id;
      const matched = inScope && evaluateWhere(fragment[0]!, e);
      expect(matched).toBe(isVenueConfirmed(e, p));
    });

    it("venueConfirmedSqlArms (raw pickRandomEvent SQL) agrees with the TS verdict", () => {
      const arms = venueConfirmedSqlArms(
        venueConfirmedFilterFor(p),
        Prisma.sql`${p.id}`,
      );
      expect(arms.length).toBeGreaterThan(0);
      const inScope = (e.placeId ?? null) === p.id;
      const matched =
        inScope && arms.some((arm) => evaluateSqlArm(arm.kind, arm.sql, e, p.id));
      expect(matched).toBe(isVenueConfirmed(e, p));
    });
  });

  // ── The arm-selection source both renderings share ───────────────────────

  it("the flag OFF contributes no community clause to the fragment", () => {
    const before = venueConfirmedFragment(
      { placeId: PLACE_ID },
      { orgIds: [OWNER_ORG_ID], humanIds: [], acceptsCommunityListings: false },
    );
    expect(JSON.stringify(before)).not.toContain("stewardship");
    expect(JSON.stringify(before)).not.toContain("COMMUNITY");
  });

  it("the batched { placeIds } form binds the community arm with IN", () => {
    const fragment = venueConfirmedFragment(
      { placeIds: [PLACE_ID, OTHER_PLACE_ID] },
      { orgIds: [], humanIds: [], acceptsCommunityListings: true },
    );
    // Documented looseness (port doc on listPublishedByPlaceIds): ONE boolean
    // across the whole fan-out. Pinned so the looseness stays deliberate.
    expect(fragment[0]!.OR).toContainEqual({
      stewardship: "COMMUNITY",
      venueConfirmationWithdrawnAt: null,
      placeId: { in: [PLACE_ID, OTHER_PLACE_ID] },
    });
  });

  it("an undefined filter contributes no fragment and no arms at all", () => {
    expect(venueConfirmedFragment({ placeId: PLACE_ID }, undefined)).toEqual([]);
    expect(
      venueConfirmedSqlArms(undefined, Prisma.sql`${PLACE_ID}`),
    ).toEqual([]);
  });

  // ── The CALL SITE, not just the builder ──────────────────────────────────
  //
  // `venueConfirmedSqlArms` takes the place binding as an argument, so every
  // test above proves only that it renders whatever it was handed. That is one
  // hop short of the thing that can actually break: `pickRandomEvent` choosing
  // the WRONG expression to hand it. Measured — swapping
  // `Prisma.sql`${input.placeId}`` for `Prisma.sql`${input.orgId}`` in
  // pickRandomEvent left all 59 assertions above green while production
  // matched community listings against an org id. So the binding is asserted
  // HERE, against the real repo method, by capturing the SQL it emits.

  it("pickRandomEvent binds the community arm to the PLACE under read, not some other id", async () => {
    const captured: Prisma.Sql[] = [];
    const fakePrisma = {
      $queryRaw: async (sql: Prisma.Sql) => {
        captured.push(sql);
        return []; // no row → the method short-circuits before findUnique
      },
      event: {
        findUnique: async () => {
          throw new Error("must not be reached: $queryRaw returned no rows");
        },
      },
    };

    const repo = makeEventsRepo(fakePrisma as never);
    await repo.pickRandomEvent({
      window: { from: new Date("2026-01-01"), to: new Date("2026-12-31") },
      near: null,
      q: null,
      // A DIFFERENT id from placeId, so binding the wrong one is detectable.
      orgId: OWNER_ORG_ID,
      placeId: PLACE_ID,
      excludeEventIds: [],
      venueConfirmedFor: {
        orgIds: [OWNER_ORG_ID],
        humanIds: [],
        acceptsCommunityListings: true,
      },
    });

    expect(captured).toHaveLength(1);
    const text = captured[0]!.strings.join("?").replace(/\s+/g, " ");
    expect(text).toContain('e."stewardship" = \'COMMUNITY\'');

    // Find the value bound to the COMMUNITY clause's own placeholder, by
    // position. A whole-query `toContain(PLACE_ID)` would not do: the outer
    // `e."placeId" = ${input.placeId}` condition binds the same id anyway, so
    // the wrong binding inside the arm would hide behind it. `strings[i]` is
    // the text BEFORE `values[i]`, so the community placeholder is the one
    // whose preceding chunk ends the arm's `e."placeId" = `.
    const { strings, values } = captured[0]!;
    const communityIdx = strings.findIndex(
      (chunk, i) =>
        chunk.includes("e.\"stewardship\" = 'COMMUNITY'") &&
        chunk.trimEnd().endsWith('e."placeId" =') &&
        i < values.length,
    );
    expect(communityIdx).toBeGreaterThanOrEqual(0);
    expect(values[communityIdx]).toBe(PLACE_ID);
  });

  it("with consent OFF, pickRandomEvent emits no community clause at all", async () => {
    const captured: Prisma.Sql[] = [];
    const fakePrisma = {
      $queryRaw: async (sql: Prisma.Sql) => {
        captured.push(sql);
        return [];
      },
      event: { findUnique: async () => null },
    };

    await makeEventsRepo(fakePrisma as never).pickRandomEvent({
      window: { from: new Date("2026-01-01"), to: new Date("2026-12-31") },
      near: null,
      q: null,
      orgId: null,
      placeId: PLACE_ID,
      excludeEventIds: [],
      venueConfirmedFor: {
        orgIds: [],
        humanIds: [],
        acceptsCommunityListings: false,
      },
    });

    expect(captured[0]!.strings.join("?")).not.toContain("COMMUNITY");
  });

  it("the interpreters THROW on a shape they do not understand", () => {
    // This is what stops the parity test from silently passing over a new arm.
    expect(() =>
      evaluateWhere({ title: "anything" } as Prisma.EventWhereInput, event()),
    ).toThrow(/unsupported where key/);
    expect(() =>
      evaluateSqlArm("newArm", Prisma.sql`TRUE`, event(), PLACE_ID),
    ).toThrow(/unknown SQL arm kind/);
  });
});
