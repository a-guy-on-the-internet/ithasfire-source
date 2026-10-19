import { describe, expect, it, vi } from "vitest";

import type { BookingIntent } from "@th/types/repos/booking-requests";
import {
  createFakeBookingStandards,
  type FakeBookingStandards,
} from "@th/test-utils/fakes/booking-standards";

import { getPlaceBookingOptions } from "../get-place-booking-options";
import type { GetPlaceBookingOptionsDeps } from "../get-place-booking-options";
import { BOOKING_STANDARDS_PLATFORM_DEFAULTS } from "../../booking-standards/platform-defaults";

// The place-page request dialog's read (venue-confirmation spec). Public,
// so what is pinned is what may NOT leave: hidden rental rates, rentalMode,
// retired rooms, owner identities.

const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const MAIN = "ca1e0da1-1111-4111-8111-111111111111";
const BAR = "ca1e0da1-2222-4222-8222-222222222222";
const SPACE_A = "5face000-1111-4111-8111-111111111111";
const SPACE_B = "5face000-2222-4222-8222-222222222222";
const RETIRED = "5face000-3333-4333-8333-333333333333";

function calendar(overrides: Record<string, unknown>) {
  return {
    id: MAIN,
    placeId: PLACE_ID,
    name: "Main Calendar",
    slug: "main",
    isDefault: true,
    acceptsPerform: true,
    acceptsRent: false,
    acceptsUse: false,
    rentalRateCents: null,
    rentalRateCurrency: null,
    rentalRateVisible: false,
    rentalMode: "REQUEST",
    spaces: [],
    ...overrides,
  };
}

const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ORG_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const VIEWER_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-09-08T12:00:00.000Z");

/** What a calendar with NO venue rows shows for `intent`: the platform list. */
function platformWire(intent: BookingIntent) {
  const platform = BOOKING_STANDARDS_PLATFORM_DEFAULTS[intent];
  return {
    standards: platform.items.map((item) => ({ source: "platform", ...item })),
    examples: platform.examples.map((example) => ({ source: "platform", ...example })),
  };
}

function buildDeps(
  options: {
    place?: Record<string, unknown> | null;
    calendars?: unknown[];
    grant?: Record<string, unknown> | null;
    membershipRole?: string | null;
    bookingStandards?: FakeBookingStandards;
  } = {},
) {
  const place =
    options.place === null
      ? null
      : {
          id: PLACE_ID,
          status: "ACTIVE",
          verificationStatus: "VERIFIED",
          acceptsBookingRequests: true,
          humanIdsWithAccess: [OWNER_HUMAN_ID],
          orgIdsWithAccess: [],
          ...options.place,
        };
  const findActiveForActor = vi.fn(async () =>
    options.grant ? { placeId: PLACE_ID, ...options.grant } : null,
  );
  const getOrgMembership = vi.fn(async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
    options.membershipRole ? { orgId, humanId, role: options.membershipRole } : null,
  );
  // `canManagePlace`, the adapter's rule over this fake's data: a direct
  // owner, or an OWNER / ADMIN / EDITOR membership in an owning org (the
  // membership fake answers the same role for any org).
  const canManagePlace = vi.fn(
    async ({ actorHumanId }: { actorHumanId: string; placeId: string }) => {
      const humanIds = (place?.humanIdsWithAccess ?? []) as string[];
      const orgIds = (place?.orgIdsWithAccess ?? []) as string[];
      return {
        allowed:
          humanIds.includes(actorHumanId) ||
          (orgIds.length > 0 &&
            ["OWNER", "ADMIN", "EDITOR"].includes(options.membershipRole ?? "")),
      };
    },
  );
  const deps = {
    repos: {
      places: { getById: vi.fn(async () => place) },
      calendars: { listByPlace: vi.fn(async () => options.calendars ?? []) },
      placeBookingGrants: { findActiveForActor },
      authz: { getOrgMembership },
      bookingStandards: options.bookingStandards ?? createFakeBookingStandards(),
    },
    now: () => NOW,
    authz: { canManagePlace },
  } as unknown as GetPlaceBookingOptionsDeps;
  return Object.assign(deps, { findActiveForActor, getOrgMembership, canManagePlace });
}

const ORG_ID_FOR_CLAIM = "22222222-2222-4222-8222-222222222222";

describe("getPlaceBookingOptions", () => {
  it("returns each calendar's intents and ACTIVE rooms; the rate only when visible; INSTANT folds acceptsRent off", async () => {
    const deps = buildDeps({
      calendars: [
        calendar({
          acceptsRent: true,
          rentalRateCents: 50_000,
          rentalRateCurrency: "usd",
          rentalRateVisible: true,
          spaces: [
            { id: SPACE_A, name: "Main Room", status: "ACTIVE" },
            { id: RETIRED, name: "Old Annex", status: "RETIRED" },
          ],
        }),
        calendar({
          id: BAR,
          name: "Back Bar",
          isDefault: false,
          acceptsRent: true,
          acceptsUse: true,
          rentalRateCents: 20_000,
          rentalRateCurrency: "usd",
          // VISIBLE on the row, but INSTANT folds acceptsRent off — and the
          // rate must fold with it.
          rentalRateVisible: true,
          rentalMode: "INSTANT",
          spaces: [{ id: SPACE_B, name: "Bar", status: "ACTIVE" }],
        }),
        // Accepts NOTHING: not on offer, so not enumerable — name + rooms stay off the wire.
        calendar({
          id: "ca1e0da1-3333-4333-8333-333333333333",
          name: "Private Do-Not-Book",
          isDefault: false,
          acceptsPerform: false,
          spaces: [{ id: "5face000-4444-4444-8444-444444444444", name: "Secret Room", status: "ACTIVE" }],
        }),
      ],
    });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(out).toEqual({
      placeId: PLACE_ID,
      isClaimed: true,
      acceptsBookingRequests: true,
      calendars: [
        {
          id: MAIN,
          name: "Main Calendar",
          isDefault: true,
          acceptsPerform: true,
          acceptsRent: true,
          acceptsUse: false,
          rentalRateCents: 50_000,
          rentalRateCurrency: "usd",
          rentalRateVisible: true,
          spaces: [{ id: SPACE_A, name: "Main Room" }],
          // Nothing configured: the platform list for each intent it takes.
          standards: { PERFORM: platformWire("PERFORM"), RENT: platformWire("RENT") },
        },
        {
          id: BAR,
          name: "Back Bar",
          isDefault: false,
          acceptsPerform: true,
          // acceptsRent true on the row, but INSTANT excludes rental REQUESTS.
          acceptsRent: false,
          acceptsUse: true,
          // The rate folds with the FOLDED acceptsRent: visible on the row,
          // but not quoted for a calendar that takes no rental requests.
          rentalRateCents: null,
          rentalRateCurrency: null,
          rentalRateVisible: false,
          spaces: [{ id: SPACE_B, name: "Bar" }],
          // Keyed by the FOLDED intents: no RENT under INSTANT.
          standards: { PERFORM: platformWire("PERFORM"), USE: platformWire("USE") },
        },
      ],
      // Anonymous read: no authority, and no grant / membership lookup ran.
      viewer: { authority: "none" },
      // No calendar, nothing configured: the platform list, every intent.
      placeStandards: {
        PERFORM: platformWire("PERFORM"),
        RENT: platformWire("RENT"),
        USE: platformWire("USE"),
      },
    });
    expect(deps.findActiveForActor).not.toHaveBeenCalled();
    expect(deps.getOrgMembership).not.toHaveBeenCalled();
    // The wire shape is strict: no rentalMode, no slug, no owner ids.
    expect(Object.keys(out.calendars[0]!)).not.toContain("rentalMode");
    expect(JSON.stringify(out)).not.toContain("Do-Not-Book");
    expect(JSON.stringify(out)).not.toContain("Secret Room");
  });

  it("unclaimed place OFFERS NOTHING (amendment 2026-09-25): isClaimed false, not accepting, no calendars, no standards", async () => {
    for (const verificationStatus of ["UNVERIFIED", "PENDING", "REJECTED"] as const) {
      const deps = buildDeps({
        place: {
          verificationStatus,
          humanIdsWithAccess: [],
          orgIdsWithAccess: [],
          // The column is irrelevant: an unclaimed venue takes no requests.
          acceptsBookingRequests: true,
        },
        calendars: [calendar({})],
      });
      const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });
      expect(out.isClaimed).toBe(false);
      expect(out.acceptsBookingRequests).toBe(false);
      expect(out.calendars).toEqual([]);
      expect(out.placeStandards).toEqual({});
    }
  });

  it("claimed is NOT verified: a VERIFIED place nobody holds (staff waiver) is unclaimed too — the same predicate as the create gate", async () => {
    const deps = buildDeps({
      place: {
        verificationStatus: "VERIFIED",
        humanIdsWithAccess: [],
        orgIdsWithAccess: [],
        acceptsBookingRequests: true,
      },
      calendars: [calendar({})],
    });
    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });
    expect(out.isClaimed).toBe(false);
    expect(out.acceptsBookingRequests).toBe(false);
    expect(out.calendars).toEqual([]);
  });

  it("an ORG-held place is claimed and offers its calendars", async () => {
    const deps = buildDeps({
      place: { humanIdsWithAccess: [], orgIdsWithAccess: [ORG_ID_FOR_CLAIM] },
      calendars: [calendar({})],
    });
    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });
    expect(out.isClaimed).toBe(true);
    expect(out.calendars).toHaveLength(1);
  });

  it("claimed place that opted out reports acceptsBookingRequests false", async () => {
    const deps = buildDeps({ place: { acceptsBookingRequests: false } });
    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });
    expect(out.isClaimed).toBe(true);
    expect(out.acceptsBookingRequests).toBe(false);
  });

  it("PLACE_NOT_FOUND / PLACE_ARCHIVED / invalid id", async () => {
    await expect(getPlaceBookingOptions(buildDeps({ place: null }), { placeId: PLACE_ID })).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
    await expect(
      getPlaceBookingOptions(buildDeps({ place: { status: "ARCHIVED" } }), { placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_ARCHIVED" });
    await expect(getPlaceBookingOptions(buildDeps(), { placeId: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("a calendar with Rent OFF never quotes its stored rate, even when marked visible", async () => {
    const deps = buildDeps({
      calendars: [
        calendar({
          acceptsRent: false,
          rentalRateCents: 50_000,
          rentalRateCurrency: "usd",
          rentalRateVisible: true,
          spaces: [{ id: SPACE_A, name: "Main Room", status: "ACTIVE" }],
        }),
      ],
    });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(out.calendars[0]).toMatchObject({
      acceptsRent: false,
      rentalRateCents: null,
      rentalRateCurrency: null,
      rentalRateVisible: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// standards (venue-booking-standards spec, FR-004): per calendar, per intent
// it takes, the effective list — resolved by the create gate's own loader.
// ─────────────────────────────────────────────────────────────────────────────
describe("getPlaceBookingOptions — standards", () => {
  async function seeded() {
    const bookingStandards = createFakeBookingStandards();
    await bookingStandards.replaceItems({
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      intent: "PERFORM",
      items: [{ field: "LINK_MUSIC", label: "Send a music link", hint: "Any platform", requirement: "REQUIRED" }],
    });
    await bookingStandards.replaceItems({
      ownerType: "CALENDAR",
      ownerId: BAR,
      intent: "PERFORM",
      items: [{ field: "EXPECTED_DRAW", label: "Your draw", requirement: "REQUIRED" }],
    });
    await bookingStandards.replaceExamples({
      ownerType: "CALENDAR",
      ownerId: BAR,
      intent: "PERFORM",
      examples: [{ title: "Bar pitch", body: "We bring 40." }],
    });
    return bookingStandards;
  }

  const twoCalendars = [
    calendar({}),
    calendar({ id: BAR, name: "Back Bar", isDefault: false }),
  ];

  it("claimed venue: calendar rows win, the other calendar inherits the place default, venue examples come first", async () => {
    const bookingStandards = await seeded();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const deps = buildDeps({ calendars: twoCalendars, bookingStandards });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    // ONE storage read for the place and both calendars.
    expect(listSpy).toHaveBeenCalledTimes(1);
    // No calendar: the place default (for PERFORM), the platform elsewhere.
    expect(out.placeStandards.PERFORM!.standards).toEqual([
      expect.objectContaining({ source: "place", field: "LINK_MUSIC", requirement: "REQUIRED" }),
    ]);
    expect(out.placeStandards.RENT).toEqual(platformWire("RENT"));
    expect(out.calendars[0]!.standards).toEqual({
      PERFORM: {
        standards: [
          {
            source: "place",
            field: "LINK_MUSIC",
            requirement: "REQUIRED",
            label: "Send a music link",
            hint: "Any platform",
          },
        ],
        examples: platformWire("PERFORM").examples,
      },
    });
    expect(out.calendars[1]!.standards.PERFORM).toEqual({
      standards: [
        { source: "calendar", field: "EXPECTED_DRAW", requirement: "REQUIRED", label: "Your draw", hint: null },
      ],
      examples: [
        { source: "calendar", title: "Bar pitch", body: "We bring 40." },
        ...platformWire("PERFORM").examples,
      ],
    });
    // The internal drop counter never reaches the wire.
    expect(JSON.stringify(out)).not.toContain("droppedCount");
  });

  it("UNCLAIMED venue: a previous claimant's stored rows are never read — nothing is offered", async () => {
    const bookingStandards = await seeded();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const deps = buildDeps({
      place: { verificationStatus: "UNVERIFIED", humanIdsWithAccess: [], orgIdsWithAccess: [] },
      calendars: twoCalendars,
      bookingStandards,
    });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(out.isClaimed).toBe(false);
    expect(out.calendars).toEqual([]);
    expect(out.placeStandards).toEqual({});
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("never fails the read: a throwing standards read degrades to the platform defaults, logged + reported", async () => {
    const readFailure = new Error('relation "BookingStandardItem" does not exist');
    const bookingStandards = createFakeBookingStandards();
    vi.spyOn(bookingStandards, "listForOwners").mockRejectedValue(readFailure);
    const deps = buildDeps({ calendars: twoCalendars, bookingStandards });
    const reportError = vi.fn();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    Object.assign(deps, { reportError, logger });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(out.calendars).toHaveLength(2);
    for (const cal of out.calendars) {
      expect(cal.standards).toEqual({ PERFORM: platformWire("PERFORM") });
    }
    expect(out.placeStandards.PERFORM).toEqual(platformWire("PERFORM"));
    expect(logger.error).toHaveBeenCalledWith(
      "booking_standards.load_failed",
      expect.objectContaining({ placeId: PLACE_ID, err: readFailure }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      readFailure,
      expect.objectContaining({ tags: { useCase: "loadEffectiveBookingStandards" } }),
    );
  });

  it("a throwing reporter on the degrade branch still serves the read", async () => {
    const bookingStandards = createFakeBookingStandards();
    vi.spyOn(bookingStandards, "listForOwners").mockRejectedValue(new Error("boom"));
    const deps = buildDeps({ calendars: [calendar({})], bookingStandards });
    Object.assign(deps, {
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
    });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(out.calendars[0]!.standards).toEqual({ PERFORM: platformWire("PERFORM") });
  });

  it("claimed venue with NO offered calendar: ONE read for the place, and a REQUIRED place default is served in placeStandards", async () => {
    const bookingStandards = await seeded();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const deps = buildDeps({ calendars: [], bookingStandards });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(out.calendars).toEqual([]);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith({
      owners: [{ ownerType: "PLACE", ownerId: PLACE_ID }],
    });
    expect(out.placeStandards.PERFORM!.standards).toEqual([
      {
        source: "place",
        field: "LINK_MUSIC",
        requirement: "REQUIRED",
        label: "Send a music link",
        hint: "Any platform",
      },
    ]);
  });

  it("UNCLAIMED venue with no calendar at all: no read, nothing offered", async () => {
    const bookingStandards = await seeded();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const deps = buildDeps({
      place: { verificationStatus: "UNVERIFIED", humanIdsWithAccess: [], orgIdsWithAccess: [] },
      calendars: [],
      bookingStandards,
    });

    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });

    expect(listSpy).not.toHaveBeenCalled();
    expect(out.placeStandards).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// viewer.authority — the save's own classification, run BEFORE the save so
// the builder shows the third-party controls to a true third party only
// (owner ruling 2026-09-08). Each case names what `resolveBuilderVenueTrust`
// would do with an event this viewer creates under this owner.
// ─────────────────────────────────────────────────────────────────────────────
describe("getPlaceBookingOptions — viewer.authority", () => {
  it("no actor → none, and neither the grant nor the membership repo is consulted", async () => {
    const deps = buildDeps({ grant: { id: "g1" }, membershipRole: "OWNER" });
    const out = await getPlaceBookingOptions(deps, { placeId: PLACE_ID });
    expect(out.viewer).toEqual({ authority: "none" });
    expect(deps.findActiveForActor).not.toHaveBeenCalled();
    expect(deps.getOrgMembership).not.toHaveBeenCalled();
  });

  it("direct human owner (owner omitted = the acting human) → owner, no grant read", async () => {
    const deps = buildDeps();
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: OWNER_HUMAN_ID,
    });
    expect(out.viewer.authority).toBe("owner");
    expect(deps.findActiveForActor).not.toHaveBeenCalled();
  });

  it("direct human owner, explicit owner { kind: 'human' } → owner", async () => {
    const deps = buildDeps();
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: OWNER_HUMAN_ID,
      owner: { kind: "human" },
    });
    expect(out.viewer.authority).toBe("owner");
  });

  it("org edit-role member saving under the owning org → owner", async () => {
    const deps = buildDeps({
      place: { humanIdsWithAccess: [], orgIdsWithAccess: [OWNER_ORG_ID] },
      membershipRole: "EDITOR",
    });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: VIEWER_ID,
      owner: { kind: "org", orgId: OWNER_ORG_ID },
    });
    expect(out.viewer.authority).toBe("owner");
    expect(deps.getOrgMembership).toHaveBeenCalledWith({
      orgId: OWNER_ORG_ID,
      humanId: VIEWER_ID,
    });
    // The owning org is venue-owned: no grant read.
    expect(deps.findActiveForActor).not.toHaveBeenCalled();
  });

  it("the same member asking as THEMSELVES (owner human) → owner: they MANAGE the place, so the save stamps it (W1)", async () => {
    const deps = buildDeps({
      place: { humanIdsWithAccess: [], orgIdsWithAccess: [OWNER_ORG_ID] },
      membershipRole: "EDITOR",
    });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: VIEWER_ID,
      owner: { kind: "human" },
    });
    expect(out.viewer.authority).toBe("owner");
    // As a human they are not on the owner list: a grant was looked for
    // (none), then `canManagePlace` had the final word.
    expect(deps.findActiveForActor).toHaveBeenCalledTimes(1);
    expect(deps.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: VIEWER_ID,
      placeId: PLACE_ID,
    });
  });

  it("W1: the venue's PERSONAL owner asking as their own org (not on the owner list) → owner, no third-party controls", async () => {
    const deps = buildDeps({
      place: { humanIdsWithAccess: [OWNER_HUMAN_ID], orgIdsWithAccess: [] },
      membershipRole: "OWNER",
    });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: OWNER_HUMAN_ID,
      owner: { kind: "org", orgId: OWNER_ORG_ID },
    });
    expect(out.viewer.authority).toBe("owner");
  });

  it("org owner named by someone with NO edit role in it (VIEWER / non-member) → none, no grant read", async () => {
    for (const membershipRole of ["VIEWER", "SCANNER", "FINANCE", null]) {
      const deps = buildDeps({
        place: { humanIdsWithAccess: [], orgIdsWithAccess: [OWNER_ORG_ID] },
        membershipRole,
      });
      const out = await getPlaceBookingOptions(deps, {
        placeId: PLACE_ID,
        actorHumanId: VIEWER_ID,
        owner: { kind: "org", orgId: OWNER_ORG_ID },
      });
      expect(out.viewer.authority, `role=${membershipRole}`).toBe("none");
      expect(deps.findActiveForActor).not.toHaveBeenCalled();
    }
  });

  it("edit-role member of an org that does NOT own the place → none (their org is a third party)", async () => {
    const deps = buildDeps({
      place: { humanIdsWithAccess: [OWNER_HUMAN_ID], orgIdsWithAccess: [] },
      membershipRole: "ADMIN",
    });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: VIEWER_ID,
      owner: { kind: "org", orgId: OWNER_ORG_ID },
    });
    expect(out.viewer.authority).toBe("none");
  });

  it("person grantee (whole place) → grant; the lookup is the save's exact query (the owner as grantee)", async () => {
    const deps = buildDeps({ grant: { id: "g1" } });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: VIEWER_ID,
    });
    expect(out.viewer.authority).toBe("grant");
    expect(deps.findActiveForActor).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      calendarId: null,
      humanIds: [VIEWER_ID],
      orgIds: [],
      now: NOW,
    });
  });

  // holds-without-a-request FR-002 / H2: a grant may go to an org. Was: "an
  // org has no grant" (never consulted for an org owner).
  it("edit-role member saving under a GRANTEE org → grant; the lookup asks for the org", async () => {
    const deps = buildDeps({
      place: { humanIdsWithAccess: [OWNER_HUMAN_ID], orgIdsWithAccess: [] },
      membershipRole: "EDITOR",
      grant: { id: "g-org" },
    });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: VIEWER_ID,
      owner: { kind: "org", orgId: OWNER_ORG_ID },
    });
    expect(out.viewer.authority).toBe("grant");
    expect(deps.findActiveForActor).toHaveBeenCalledWith(
      expect.objectContaining({ humanIds: [], orgIds: [OWNER_ORG_ID], calendarId: null }),
    );
  });

  it("pending, declined, expired or revoked grant (the repo's active lookup returns null) → none", async () => {
    // Acceptance, expiry and revocation live IN the repo's WHERE
    // (`findActiveForActor` contract); the use case trusts a null answer.
    const deps = buildDeps({ grant: null });
    const out = await getPlaceBookingOptions(deps, {
      placeId: PLACE_ID,
      actorHumanId: VIEWER_ID,
    });
    expect(out.viewer.authority).toBe("none");
    expect(deps.findActiveForActor).toHaveBeenCalledWith(
      expect.objectContaining({ humanIds: [VIEWER_ID], now: NOW }),
    );
  });

  it("an unknown place is still PLACE_NOT_FOUND for an authenticated viewer", async () => {
    await expect(
      getPlaceBookingOptions(buildDeps({ place: null }), {
        placeId: PLACE_ID,
        actorHumanId: VIEWER_ID,
        owner: { kind: "org", orgId: OWNER_ORG_ID },
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("rejects a malformed owner (.strict): a humanId cannot be supplied for the human owner", async () => {
    await expect(
      getPlaceBookingOptions(buildDeps(), {
        placeId: PLACE_ID,
        actorHumanId: VIEWER_ID,
        owner: { kind: "human", humanId: OWNER_HUMAN_ID },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
