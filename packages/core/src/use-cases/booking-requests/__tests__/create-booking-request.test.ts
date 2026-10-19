import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  createBookingRequest,
  BOOKING_REQUEST_TTL_DAYS,
  BOOKING_WINDOW_PAST_GRACE_MS,
} from "../create-booking-request";
import type { CreateBookingRequestDeps } from "../create-booking-request";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  buildBookingRequestRecord,
  buildPerformerProfile,
  buildPlaceRecord,
  systemEntriesFor,
  withTx,
} from "./helpers";

type BuildDepsOptions = {
  place?: PlaceRecord | null;
  profile?: PerformerProfileRecord | null;
  openRequest?: BookingRequestRecord | null;
  membership?: OrgMembership | null;
  genreTags?: string[];
  humanStats?: Record<string, unknown> | null;
  /**
   * Opening-hours / blackout rows for the availability check (3b). These are
   * `CalendarAvailability` rows now (venue-hierarchy FR-007) — use
   * `calendarId: null` for the place-wide scope these fixtures assume.
   */
  availabilityRows?: Array<Record<string, unknown>>;
  /**
   * Calendars repo for the FR-008 routing tests. Omitted = a place with NO
   * calendars (findById/findDefaultForPlace resolve null), so requests route
   * `calendarId: null` — which keeps every pre-hierarchy expectation intact.
   *
   * NOTE: the availability check (3b) also goes through this repo now, so any
   * override must implement `listByPlace` + `listAvailabilityForPlace` too.
   */
  calendars?: unknown;
};

/** Default calendars fake: the place has no calendars at all. */
const makeEmptyCalendarsFake = (
  availabilityRows: Array<Record<string, unknown>> = [],
) => ({
  findById: vi.fn(async () => null),
  findDefaultForPlace: vi.fn(async () => null),
  listByPlace: vi.fn(async () => []),
  listAvailabilityForPlace: vi.fn(async () => availabilityRows),
  // Availability-onboarding FR-005 gate (3a). Default `|| 1` = CONFIGURED:
  // these fixtures model "rows exist but impose no window policy" (e.g. a
  // dated exception outside the probe — representable in prod), so the
  // pre-existing escape-hatch expectations stay intact. The FR-005 tests
  // below force 0 explicitly to model a venue that never set hours.
  countAvailabilityForPlace: vi.fn(async () => availabilityRows.length || 1),
});

function buildHumanStats(overrides: Record<string, unknown> = {}) {
  return {
    id: "stats-1",
    humanId: ACTOR_ID,
    totalEventsPerformed: 5,
    totalTicketsAttributed: 100,
    avgDrawPerEvent: 20,
    topCities: [{ city: "Nashville", country: "US", tickets: 40 }],
    topPlaceIds: ["place-1"],
    topGenres: ["indie"],
    channelBreakdown: [{ source: "ref_link", tickets: 33 }],
    totalConsentedFans: 12,
    repeatFanCount: 4,
    followerCount: 88,
    last90DayTickets: 25,
    last90DayEvents: 2,
    computedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildDeps(options: BuildDepsOptions = {}) {
  const place =
    options.place === undefined ? buildPlaceRecord() : options.place;
  const profile =
    options.profile === undefined ? buildPerformerProfile() : options.profile;

  const bookingRequests = {
    findOpenByPerformerAndPlace: vi.fn(async () => options.openRequest ?? null),
    create: vi.fn(async (input: Record<string, unknown>) =>
      buildBookingRequestRecord(input as Partial<BookingRequestRecord>),
    ),
  };
  const performerProfiles = { getByOwner: vi.fn(async () => profile) };
  const places = { getById: vi.fn(async () => place) };
  const humans = {
    getById: vi.fn(async () => ({
      id: ACTOR_ID,
      genreTags: options.genreTags ?? [],
    })),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };
  const humanStats = {
    findByHumanId: vi.fn(async () =>
      options.humanStats === undefined ? null : options.humanStats,
    ),
  };
  // Availability check (3b). These fixtures declare NO opening hours, which is
  // the escape hatch: a venue that has never set any is not date-checked, so
  // every existing expectation here still describes the same behaviour.
  const events = {
    listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
    listPublishedOccurrencesByPlace: vi.fn(async () => []),
  };

  const mocks = {
    bookingRequests,
    performerProfiles,
    places,
    humans,
    authz,
    audit,
    humanStats,
    events,
    calendars:
      options.calendars ??
      makeEmptyCalendarsFake(options.availabilityRows ?? []),
  };

  const deps: CreateBookingRequestDeps = {
    repos: withTx(mocks) as unknown as CreateBookingRequestDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks };
}

const baseInput = {
  actorHumanId: ACTOR_ID,
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
  placeId: PLACE_ID,
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-07-10", "2026-07-17"],
  expectedDraw: 80,
  genre: "punk",
};

describe("createBookingRequest", () => {
  it("creates a PENDING request with a 14-day expiry and audits", async () => {
    const { deps, mocks } = buildDeps();

    const result = await createBookingRequest(deps, baseInput);

    expect(result.bookingRequestId).toBeDefined();
    const expectedExpiry = new Date(
      NOW.getTime() + BOOKING_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        expiresAt: expectedExpiry,
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_request",
        action: "booking_request.created",
      }),
    );
  });

  it("rejects when performer mode is not enabled (jobs[] is never the gate)", async () => {
    const { deps, mocks } = buildDeps({ profile: null });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("rejects a disabled performer profile", async () => {
    const { deps } = buildDeps({
      profile: buildPerformerProfile({ disabledAt: NOW }),
    });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
  });

  it("rejects an unverified place", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
    });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });
  });

  it("rejects a place that is not accepting requests", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({ acceptsBookingRequests: false }),
    });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({ code: "PLACE_NOT_ACCEPTING_REQUESTS" });
  });

  it("rejects a duplicate open request for the same (performer, place)", async () => {
    const { deps, mocks } = buildDeps({
      openRequest: buildBookingRequestRecord({ status: "VIEWED" }),
    });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({ code: "DUPLICATE_OPEN_REQUEST" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("propagates the DB unique backstop when the pre-check race is lost (P2002 → duplicate_open_request)", async () => {
    // Two concurrent creates can both pass `findOpenByPerformerAndPlace`;
    // the partial unique index "BookingRequest_open_pair_key" makes the
    // loser's insert fail, and the adapter maps that P2002 to the same
    // domain error as the pre-check.
    const { deps, mocks } = buildDeps();
    mocks.bookingRequests.create.mockRejectedValueOnce({
      code: "duplicate_open_request",
      message: "duplicate_open_request",
    });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "duplicate_open_request",
    });
  });

  it("rejects an actor who does not control the human sender", async () => {
    const { deps } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        performerOwnerId: "12121212-1212-4121-8121-121212121212",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("requires an org edit role for an org sender", async () => {
    const viewer = { deps: undefined as unknown as CreateBookingRequestDeps };
    ({ deps: viewer.deps } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
      profile: buildPerformerProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
      }),
    }));

    await expect(
      createBookingRequest(viewer.deps, {
        ...baseInput,
        performerOwnerType: "org",
        performerOwnerId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
      profile: buildPerformerProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
      }),
    });

    await createBookingRequest(deps, {
      ...baseInput,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
    );
  });

  it("prefills genre from the human's first genreTag when omitted", async () => {
    const { deps, mocks } = buildDeps({ genreTags: ["shoegaze", "punk"] });

    const { genre: _omitted, ...inputWithoutGenre } = baseInput;
    await createBookingRequest(deps, inputWithoutGenre);

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ genre: "shoegaze" }),
    );
  });

  // ── Verified-stats snapshot (FR-009) ──────────────────────────────────────

  it("snapshots eligible human stats (+ computedAt) when includeVerifiedStats is true", async () => {
    const { deps, mocks } = buildDeps({ humanStats: buildHumanStats() });

    await createBookingRequest(deps, {
      ...baseInput,
      includeVerifiedStats: true,
    });

    expect(mocks.humanStats.findByHumanId).toHaveBeenCalledWith(ACTOR_ID);
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        verifiedStatsSnapshot: {
          totalEventsPerformed: 5,
          avgDrawPerEvent: 20,
          repeatFanCount: 4,
          refLinkTickets: 33,
          last90DayTickets: 25,
          last90DayEvents: 2,
          computedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    );
  });

  it("stores null when the human is not yet eligible (<3 shows)", async () => {
    const { deps, mocks } = buildDeps({
      humanStats: buildHumanStats({ totalEventsPerformed: 2 }),
    });

    await createBookingRequest(deps, {
      ...baseInput,
      includeVerifiedStats: true,
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedStatsSnapshot: null }),
    );
  });

  it("stores null for an org sender even when eligible stats exist", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
      profile: buildPerformerProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
      }),
      humanStats: buildHumanStats(),
    });

    await createBookingRequest(deps, {
      ...baseInput,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
      includeVerifiedStats: true,
    });

    // Org senders never read HumanStats and never snapshot.
    expect(mocks.humanStats.findByHumanId).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedStatsSnapshot: null }),
    );
  });

  it("stores null when includeVerifiedStats is omitted/false", async () => {
    const { deps, mocks } = buildDeps({ humanStats: buildHumanStats() });

    await createBookingRequest(deps, baseInput);

    expect(mocks.humanStats.findByHumanId).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedStatsSnapshot: null }),
    );
  });

  it("never trusts a client-supplied snapshot — strict schema rejects it, server value wins otherwise", async () => {
    const { deps, mocks } = buildDeps({ humanStats: buildHumanStats() });

    // A client cannot smuggle its own numbers in: the strict input schema
    // rejects the unknown `verifiedStatsSnapshot` key outright.
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        includeVerifiedStats: true,
        verifiedStatsSnapshot: { totalEventsPerformed: 9999 },
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();

    // And when the flag is set legitimately, only the server aggregate is used.
    await createBookingRequest(deps, {
      ...baseInput,
      includeVerifiedStats: true,
    });
    const call = mocks.bookingRequests.create.mock.calls[0]![0] as {
      verifiedStatsSnapshot: { totalEventsPerformed: number };
    };
    expect(call.verifiedStatsSnapshot.totalEventsPerformed).toBe(5);
  });

  it("rejects invalid input (empty message / bad dates)", async () => {
    const { deps } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        message: "hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        preferredDates: ["not-a-date"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── Expanded pitch fields (2026-07-11) ────────────────────────────────────

  it("persists the new pitch fields and snapshots the fee currency", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      actName: "The Midnight Owls",
      lineupSize: 4,
      setLengthMinutes: 45,
      contactPhone: "+1 (615) 555-0199",
      techNeeds: "Two vocal mics, one DI for keys.",
      feeType: "GUARANTEE",
      feeAmountCents: 50_000,
      linkMusic: "https://example.com/music",
      linkVideo: "https://example.com/video",
      linkSocial: "https://example.com/social",
      linkEpk: "https://example.com/epk",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actName: "The Midnight Owls",
        lineupSize: 4,
        setLengthMinutes: 45,
        contactPhone: "+1 (615) 555-0199",
        techNeeds: "Two vocal mics, one DI for keys.",
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
        linkMusic: "https://example.com/music",
        linkVideo: "https://example.com/video",
        linkSocial: "https://example.com/social",
        linkEpk: "https://example.com/epk",
      }),
    );
  });

  it("no longer accepts (or writes) the legacy `links` array on create", async () => {
    const { deps, mocks } = buildDeps();

    // `links` is stripped from the strict create schema — supplying it fails.
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        links: ["https://example.com/epk"],
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // A clean create never forwards a populated links array to the repo.
    await createBookingRequest(deps, baseInput);
    const call = mocks.bookingRequests.create.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.links).toBeUndefined();
  });

  it("leaves feeCurrency null when no fee amount is given", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      feeType: "NEGOTIABLE",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ feeType: "NEGOTIABLE", feeCurrency: null }),
    );
  });

  it("rejects a fee amount without a GUARANTEE/DOOR_SPLIT fee type", async () => {
    const { deps, mocks } = buildDeps();

    // Amount with NEGOTIABLE — rejected.
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        feeType: "NEGOTIABLE",
        feeAmountCents: 25_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Amount with feeType omitted — rejected.
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        feeAmountCents: 25_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();

    // Amount with DOOR_SPLIT — accepted.
    await createBookingRequest(deps, {
      ...baseInput,
      feeType: "DOOR_SPLIT",
      feeAmountCents: 25_000,
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        feeType: "DOOR_SPLIT",
        feeAmountCents: 25_000,
        feeCurrency: "usd",
      }),
    );
  });

  it("rejects a set length that is not one of the presets", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        setLengthMinutes: 37,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();

    // A preset value is accepted.
    await createBookingRequest(deps, {
      ...baseInput,
      setLengthMinutes: 90,
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ setLengthMinutes: 90 }),
    );
  });

  it("rejects a non-http(s) typed link server-side (javascript:/data: bypass)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        linkMusic: "javascript:alert(1)",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        linkVideo: "data:text/html,<script>alert(1)</script>",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();

    // http(s) typed links are accepted.
    await createBookingRequest(deps, {
      ...baseInput,
      linkMusic: "https://example.com/music",
      linkEpk: "http://example.com/epk",
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        linkMusic: "https://example.com/music",
        linkEpk: "http://example.com/epk",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue notification hook (booking-request-embed-button FR-008 / NFR-004)
// ─────────────────────────────────────────────────────────────────────────────

describe("createBookingRequest — venue notification hook", () => {
  it("fires notifyBookingRequestReceived post-commit with the created record + place", async () => {
    const { deps, mocks } = buildDeps();
    const notifyBookingRequestReceived = vi.fn(async () => {});
    deps.notifyBookingRequestReceived = notifyBookingRequestReceived;

    const result = await createBookingRequest(deps, baseInput);

    expect(notifyBookingRequestReceived).toHaveBeenCalledTimes(1);
    const args = notifyBookingRequestReceived.mock.calls[0]![0] as {
      bookingRequest: { id: string };
      place: { id: string };
    };
    expect(args.bookingRequest.id).toBe(result.bookingRequestId);
    expect(args.place.id).toBe(PLACE_ID);
    // Post-commit ordering: the row was created before the hook fired.
    expect(mocks.bookingRequests.create).toHaveBeenCalled();
  });

  it("a throwing notifier is swallowed AND reported — the committed submission still succeeds", async () => {
    const { deps } = buildDeps();
    const reportError = vi.fn();
    deps.notifyBookingRequestReceived = vi.fn(async () => {
      throw new Error("notify pipeline down");
    });
    deps.reportError = reportError;

    const result = await createBookingRequest(deps, baseInput);

    expect(result.bookingRequestId).toBeDefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "createBookingRequest" },
      extra: {
        bookingRequestId: result.bookingRequestId,
        placeId: PLACE_ID,
      },
    });
  });

  it("swallow works unwired (no reportError) and a throwing reporter is harmless", async () => {
    const unwired = buildDeps();
    unwired.deps.notifyBookingRequestReceived = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      createBookingRequest(unwired.deps, baseInput),
    ).resolves.toMatchObject({ bookingRequestId: expect.any(String) });

    const throwingReporter = buildDeps();
    throwingReporter.deps.notifyBookingRequestReceived = vi.fn(async () => {
      throw new Error("boom");
    });
    throwingReporter.deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      createBookingRequest(throwingReporter.deps, baseInput),
    ).resolves.toMatchObject({ bookingRequestId: expect.any(String) });
  });

  it("REFUSES an UNCONFIGURED place (zero availability rows) with booking_requests_unconfigured", async () => {
    // Availability-onboarding FR-005: a venue that never set hours is
    // publicly "not taking requests right now". The client hides the form;
    // this proves the mutation refuses too, so the two cannot drift.
    const calendars = makeEmptyCalendarsFake();
    calendars.countAvailabilityForPlace = vi.fn(async () => 0);
    const { deps, mocks } = buildDeps({ calendars });

    await expect(
      createBookingRequest(deps, baseInput),
    ).rejects.toMatchObject({
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "booking_requests_unconfigured",
    });

    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("passes the FR-005 gate the moment ONE availability row exists", async () => {
    // The mirror: a single row (even one that imposes no window policy on the
    // requested night) is "configured", and the pitch goes through.
    const calendars = makeEmptyCalendarsFake();
    calendars.countAvailabilityForPlace = vi.fn(async () => 1);
    const { deps } = buildDeps({ calendars });

    await expect(createBookingRequest(deps, baseInput)).resolves.toMatchObject({
      bookingRequestId: expect.any(String),
    });
    expect(calendars.countAvailabilityForPlace).toHaveBeenCalledWith(PLACE_ID);
  });

  it("rejects a night the venue is dark, even though the client sent it", async () => {
    // The picker filters these out; this proves the use case is the authority
    // and a crafted payload cannot book a closed night.
    const { deps } = buildDeps({
      availabilityRows: [
        {
          id: "w-fri",
          placeId: PLACE_ID,
          // Place-wide scope (venue-hierarchy FR-007): applies to every
          // calendar, which is what "the venue's hours" means here.
          calendarId: null,
          dayOfWeek: 5,
          date: null,
          startTime: "18:00",
          endTime: "23:00",
          note: null,
          isOpen: true,
        },
      ],
    });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        // 2099-01-05 is a Monday, and this venue only opens on Fridays.
        preferredDates: ["2099-01-05T19:00"],
      }),
    ).rejects.toMatchObject({ code: "BOOKING_DATE_UNAVAILABLE" });
  });

  it("accepts a night inside the venue's declared hours", async () => {
    const { deps } = buildDeps({
      availabilityRows: [
        {
          id: "w-fri",
          placeId: PLACE_ID,
          // Place-wide scope (venue-hierarchy FR-007): applies to every
          // calendar, which is what "the venue's hours" means here.
          calendarId: null,
          dayOfWeek: 5,
          date: null,
          startTime: "18:00",
          endTime: "23:00",
          note: null,
          isOpen: true,
        },
      ],
    });

    // 2099-01-02 is a Friday.
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        preferredDates: ["2099-01-02T19:00"],
      }),
    ).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calendar routing (venue-hierarchy FR-008)
// ─────────────────────────────────────────────────────────────────────────────

describe("createBookingRequest — calendar routing", () => {
  const CALENDAR_ID = "ca1e0da1-1111-4111-8111-111111111111";
  const OTHER_PLACE_CALENDAR_ID = "ca1e0da1-2222-4222-8222-222222222222";
  const DEFAULT_CALENDAR_ID = "ca1e0da1-3333-4333-8333-333333333333";

  const makeCalendarsFake = (
    availabilityRows: Array<Record<string, unknown>> = [],
  ) => ({
    findById: vi.fn(async (id: string) => {
      if (id === CALENDAR_ID) return { id, placeId: PLACE_ID, name: "Live Music" };
      if (id === OTHER_PLACE_CALENDAR_ID)
        return { id, placeId: "99999999-9999-4999-8999-999999999999", name: "Foreign" };
      return null;
    }),
    findDefaultForPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? { id: DEFAULT_CALENDAR_ID, placeId, name: "Main Calendar", isDefault: true }
        : null,
    ),
    // The availability check (3b) resolves scope through the PLACE's own
    // calendar list — that list IS the cross-place isolation, so the foreign
    // calendar deliberately does not appear here.
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [
            {
              id: DEFAULT_CALENDAR_ID,
              placeId,
              name: "Main Calendar",
              isDefault: true,
              spaces: [],
            },
            {
              id: CALENDAR_ID,
              placeId,
              name: "Live Music",
              isDefault: false,
              spaces: [],
            },
          ]
        : [],
    ),
    // Availability rows for the gate (3b). Default is NO declared hours, so
    // the escape hatch keeps every routing expectation about dates untouched;
    // the gate-scope tests below pass calendar-scoped rows instead.
    listAvailabilityForPlace: vi.fn(async () => availabilityRows),
    // FR-005 unconfigured gate (3a): `|| 1` keeps these routing fixtures
    // CONFIGURED (see makeEmptyCalendarsFake) so they exercise routing, not
    // the gate.
    countAvailabilityForPlace: vi.fn(async () => availabilityRows.length || 1),
  });

  it("defaults an omitted calendarId to the place's default calendar", async () => {
    const calendars = makeCalendarsFake();
    const { deps, mocks } = buildDeps({ calendars });

    await createBookingRequest(deps, baseInput);

    // ONE read of the place's own calendar list answers routing, intent
    // acceptance and space membership together.
    expect(calendars.listByPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: DEFAULT_CALENDAR_ID }),
    );
  });

  it("persists an explicit same-place calendarId", async () => {
    const calendars = makeCalendarsFake();
    const { deps, mocks } = buildDeps({ calendars });

    await createBookingRequest(deps, { ...baseInput, calendarId: CALENDAR_ID });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: CALENDAR_ID }),
    );
    // Resolved off the place's own list — never a by-id lookup that could
    // confirm a foreign calendar exists.
    expect(calendars.findById).not.toHaveBeenCalled();
  });

  it("CROSS-PLACE calendarId surfaces as CALENDAR_NOT_FOUND with NO mutation", async () => {
    const calendars = makeCalendarsFake();
    const { deps, mocks } = buildDeps({ calendars });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        calendarId: OTHER_PLACE_CALENDAR_ID,
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });

    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("unknown calendarId surfaces as CALENDAR_NOT_FOUND (indistinguishable from cross-place)", async () => {
    const calendars = makeCalendarsFake();
    const { deps, mocks } = buildDeps({ calendars });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        calendarId: "12312312-1231-4123-8123-123123123123",
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("place with NO default calendar: omitted calendarId routes null (unrouted, never fails the pitch)", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingRequest(deps, baseInput);
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: null }),
    );

    // An EXPLICIT calendarId that resolves to nothing is CALENDAR_NOT_FOUND
    // (same posture as cross-place — indistinguishable on purpose).
    await expect(
      createBookingRequest(deps, { ...baseInput, calendarId: CALENDAR_ID }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
  });
  // ── The gate is answered against the ROUTED calendar, not the default ──────
  //
  // Everything above asserts the `create` PAYLOAD. None of it touches the
  // availability gate at step 3b, because the fixtures declare no hours and
  // the escape hatch waves them through — so deleting the `calendarId` spread
  // in the findUnavailableBookingDates call leaves them all green. These are
  // the ones that go red.

  const WEDNESDAY_ONLY_ON_LIVE_MUSIC = [
    {
      id: "live-music-wed",
      placeId: PLACE_ID,
      // Scoped to the Live Music calendar ONLY — not place-wide. The default
      // calendar therefore has no hours of its own.
      calendarId: CALENDAR_ID,
      dayOfWeek: 3,
      date: null,
      startTime: "19:00",
      endTime: "23:00",
      note: null,
      isOpen: true,
    },
  ];
  // 2099-01-05 is a Monday; 2099-01-07 is a Wednesday.
  const A_MONDAY = "2099-01-05T19:00";
  const A_WEDNESDAY = "2099-01-07T19:00";

  it("REJECTS a Monday against the routed calendar's Wednesday-only hours", async () => {
    const calendars = makeCalendarsFake(WEDNESDAY_ONLY_ON_LIVE_MUSIC);
    const { deps, mocks } = buildDeps({ calendars });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        calendarId: CALENDAR_ID,
        preferredDates: [A_MONDAY],
      }),
    ).rejects.toMatchObject({ code: "BOOKING_DATE_UNAVAILABLE" });

    // Rejected BEFORE any write, like every other gate on this path.
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("ACCEPTS the Wednesday those hours actually offer, and routes it there", async () => {
    // The mirror. Without it the test above would also pass if the gate
    // rejected everything — e.g. if the rows never reached it at all.
    const calendars = makeCalendarsFake(WEDNESDAY_ONLY_ON_LIVE_MUSIC);
    const { deps, mocks } = buildDeps({ calendars });

    await createBookingRequest(deps, {
      ...baseInput,
      calendarId: CALENDAR_ID,
      preferredDates: [A_WEDNESDAY],
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: CALENDAR_ID }),
    );
  });

  it("scopes the no-declared-hours ESCAPE HATCH per calendar, not per venue", async () => {
    // The same Monday, judged twice against the same venue.
    //
    // Routed to Live Music it is REJECTED (that calendar declared Wednesdays
    // only — asserted above). Routed to the DEFAULT calendar it is ACCEPTED,
    // because that calendar has declared no hours at all and therefore has no
    // policy to enforce — the escape hatch, applied at the scope the answer is
    // computed at.
    //
    // The alternative would be for one calendar to inherit another's hours,
    // which is precisely what FR-007 forbids. Documented here because it is
    // subtle and looks like a hole until you see which calendar was asked.
    const calendars = makeCalendarsFake(WEDNESDAY_ONLY_ON_LIVE_MUSIC);
    const { deps, mocks } = buildDeps({ calendars });

    await createBookingRequest(deps, {
      ...baseInput,
      preferredDates: [A_MONDAY],
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: DEFAULT_CALENDAR_ID }),
    );
  });

  it("a PLACE-WIDE rule still binds a calendar that declared nothing", async () => {
    // The other half, so the escape hatch above cannot be mistaken for "the
    // default calendar is never checked". A place-wide row (calendarId null)
    // reaches every calendar, so the default has hours after all — and a
    // Monday outside them is rejected.
    const calendars = makeCalendarsFake([
      {
        id: "venue-wide-wed",
        placeId: PLACE_ID,
        calendarId: null,
        dayOfWeek: 3,
        date: null,
        startTime: "19:00",
        endTime: "23:00",
        note: null,
        isOpen: true,
      },
    ]);
    const { deps, mocks } = buildDeps({ calendars });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        preferredDates: [A_MONDAY],
      }),
    ).rejects.toMatchObject({ code: "BOOKING_DATE_UNAVAILABLE" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Tags + taxFormStatus (venue-hierarchy FR-008)
// ─────────────────────────────────────────────────────────────────────────────

describe("createBookingRequest — tags + taxFormStatus", () => {
  it("sanitizes, trims, drops empties, and dedupes tags before persisting", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      tags: [
        "  indie rock  ",
        "<script>alert(1)</script>DIY",
        "   ",
        "indie rock", // duplicate after trim
        "loud",
      ],
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ["indie rock", "DIY", "loud"],
      }),
    );
  });

  it("rejects an over-length tag at the boundary (sanitize BEFORE the cap)", async () => {
    const { deps } = buildDeps();
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        tags: ["x".repeat(41)],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects more than 20 tags", async () => {
    const { deps } = buildDeps();
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("persists an empty tags array when omitted", async () => {
    const { deps, mocks } = buildDeps();
    await createBookingRequest(deps, baseInput);
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ tags: [] }),
    );
  });

  it("REJECTS taxFormStatus at create — the venue-side workflow flag is never client-settable here", async () => {
    const { deps, mocks } = buildDeps();
    await expect(
      createBookingRequest(deps, { ...baseInput, taxFormStatus: "RECEIVED" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intents on requests + unclaimed parking (venue-confirmation-and-booking-
// intents spec, docs/specs/2026-08-27)
// ─────────────────────────────────────────────────────────────────────────────

describe("createBookingRequest — intents (PERFORM | RENT | USE)", () => {
  const CALENDAR_ID = "ca1e0da1-4444-4444-8444-444444444444";
  const OTHER_CALENDAR_ID = "ca1e0da1-5555-4555-8555-555555555555";
  const SPACE_ID = "5face000-1111-4111-8111-111111111111";
  const OTHER_SPACE_ID = "5face000-2222-4222-8222-222222222222";
  const RETIRED_SPACE_ID = "5face000-3333-4333-8333-333333333333";

  type CalendarConfig = {
    acceptsPerform?: boolean;
    acceptsRent?: boolean;
    acceptsUse?: boolean;
    rentalMode?: "REQUEST" | "INSTANT";
  };

  /**
   * A place with ONE default calendar (configurable intents) joined to
   * `SPACE_ID` + a retired room, and a SECOND calendar that owns
   * `OTHER_SPACE_ID`. Availability is "configured, no policy" so PERFORM
   * routes through the gate untouched.
   */
  const makeIntentCalendarsFake = (config: CalendarConfig = {}) => {
    const main = {
      id: CALENDAR_ID,
      placeId: PLACE_ID,
      name: "Main Calendar",
      isDefault: true,
      acceptsPerform: config.acceptsPerform ?? true,
      acceptsRent: config.acceptsRent ?? true,
      acceptsUse: config.acceptsUse ?? true,
      rentalMode: config.rentalMode ?? "REQUEST",
    };
    const other = {
      id: OTHER_CALENDAR_ID,
      placeId: PLACE_ID,
      name: "Back Bar",
      isDefault: false,
      acceptsPerform: true,
      acceptsRent: true,
      acceptsUse: true,
      rentalMode: "REQUEST",
    };
    const space = (id: string, status = "ACTIVE") => ({
      id,
      placeId: PLACE_ID,
      name: id,
      status,
    });
    return {
      findById: vi.fn(async (id: string) =>
        id === CALENDAR_ID ? main : id === OTHER_CALENDAR_ID ? other : null,
      ),
      findDefaultForPlace: vi.fn(async (placeId: string) =>
        placeId === PLACE_ID ? main : null,
      ),
      listByPlace: vi.fn(async (placeId: string) =>
        placeId === PLACE_ID
          ? [
              { ...main, spaces: [space(SPACE_ID), space(RETIRED_SPACE_ID, "RETIRED")] },
              { ...other, spaces: [space(OTHER_SPACE_ID)] },
            ]
          : [],
      ),
      listAvailabilityForPlace: vi.fn(async () => []),
      countAvailabilityForPlace: vi.fn(async () => 1),
    };
  };

  const rentInput = {
    actorHumanId: ACTOR_ID,
    performerOwnerType: "human",
    performerOwnerId: ACTOR_ID,
    placeId: PLACE_ID,
    intent: "RENT",
    spaceId: SPACE_ID,
    requestedStartsAt: "2026-10-04T23:00:00.000Z",
    requestedEndsAt: "2026-10-05T04:00:00.000Z",
    purpose: "Private birthday party",
    expectedAttendance: 60,
  } as const;

  it("PERFORM is the default intent and writes exactly what it always wrote", async () => {
    // Byte-identical PERFORM contract: the intent columns land as their
    // column defaults (PERFORM, null space/window/purpose). Nothing is ever
    // parked (amendment 2026-09-25): the stamp is not written at all. Every
    // pre-intent test above still runs unchanged; this pins the payload for
    // the new columns specifically.
    const { deps, mocks } = buildDeps({ calendars: makeIntentCalendarsFake() });

    const result = await createBookingRequest(deps, baseInput);

    expect(result).toEqual({ bookingRequestId: expect.any(String) });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "PERFORM",
        spaceId: null,
        requestedStartsAt: null,
        requestedEndsAt: null,
        purpose: null,
        expectedAttendance: null,
        message: baseInput.message,
        preferredDates: baseInput.preferredDates,
      }),
    );
    expect(mocks.bookingRequests.create.mock.calls[0]![0]).not.toHaveProperty(
      "parkedUnclaimedAt",
    );
  });

  it("RENT: no performer profile needed; persists space + window + purpose and derives message/preferredDates", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });

    const result = await createBookingRequest(deps, rentInput);

    expect(result.bookingRequestId).toBeDefined();
    // The performer gate is PERFORM-only — the profile repo is never asked.
    expect(mocks.performerProfiles.getByOwner).not.toHaveBeenCalled();
    // The window is the request: no hours are consulted for RENT.
    expect(deps.repos.calendars.countAvailabilityForPlace).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "RENT",
        calendarId: CALENDAR_ID,
        spaceId: SPACE_ID,
        requestedStartsAt: new Date("2026-10-04T23:00:00.000Z"),
        requestedEndsAt: new Date("2026-10-05T04:00:00.000Z"),
        purpose: "Private birthday party",
        expectedAttendance: 60,
        // NOT NULL columns filled from what the variant collects: the
        // purpose, and the window's start as a place-local day (the fixture
        // place has no timezone → platform default America/Chicago, where
        // 23:00Z on Oct 4 is still Oct 4).
        message: "Private birthday party",
        preferredDates: ["2026-10-04"],
      }),
    );
    expect(mocks.bookingRequests.create.mock.calls[0]![0]).not.toHaveProperty(
      "parkedUnclaimedAt",
    );
  });

  it("USE: same shape as RENT, and an explicit message is kept over the purpose", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });

    await createBookingRequest(deps, {
      ...rentInput,
      intent: "USE",
      message: "We meet every first Sunday; this is our October gathering.",
      purpose: "Community meeting",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "USE",
        purpose: "Community meeting",
        message: "We meet every first Sunday; this is our October gathering.",
      }),
    );
  });

  it("PERFORM still requires performer mode (the gate did not move, it narrowed)", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });

    await expect(
      createBookingRequest(deps, { ...baseInput, intent: "PERFORM" }),
    ).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("a performer can choose RENT — the profile is not consulted and not required", async () => {
    const { deps, mocks } = buildDeps({ calendars: makeIntentCalendarsFake() });
    await createBookingRequest(deps, rentInput);
    expect(mocks.performerProfiles.getByOwner).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("refuses an intent the routed calendar does not accept — INVALID_INPUT / calendar_rejects_intent, no write", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake({ acceptsRent: false }),
    });

    await expect(createBookingRequest(deps, rentInput)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
      meta: { calendarId: CALENDAR_ID, intent: "RENT" },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("refuses PERFORM on a calendar that turned performances off", async () => {
    const { deps } = buildDeps({
      calendars: makeIntentCalendarsFake({ acceptsPerform: false }),
    });
    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
    });
  });

  it("refuses RENT on an INSTANT-mode calendar (instant book excludes rental requests); USE is unaffected", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake({ rentalMode: "INSTANT" }),
    });
    await expect(createBookingRequest(deps, rentInput)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
    });
    await createBookingRequest(deps, { ...rentInput, intent: "USE" });
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("RENT/USE at a place with NO calendar is refused — nothing there can accept a room", async () => {
    // The empty default fake resolves no calendar at all.
    const { deps, mocks } = buildDeps({ profile: null });
    await expect(createBookingRequest(deps, rentInput)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
      meta: { calendarId: null, intent: "RENT" },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("RENT WITHOUT a space is ACCEPTED and persists spaceId: null — the room comes off the request (ruling 2026-09-22)", async () => {
    // Extends the 2026-08-31 holds ruling ("THE SPACE PICKER IS GONE"): a
    // RENT/USE request is a place in line for a WINDOW on a CALENDAR.
    // Nothing downstream reads a room off the request, and accept/mint
    // already mints spacelessly (accept-mint.test.ts) rather than refusing.
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });
    const { spaceId: _omitted, ...noSpace } = rentInput;

    const result = await createBookingRequest(deps, noSpace);

    expect(result.bookingRequestId).toBeDefined();
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "RENT",
        // It still ROUTES — to the calendar and the window, which are what a
        // request is.
        calendarId: CALENDAR_ID,
        spaceId: null,
        requestedStartsAt: new Date("2026-10-04T23:00:00.000Z"),
        requestedEndsAt: new Date("2026-10-05T04:00:00.000Z"),
        purpose: "Private birthday party",
      }),
    );
  });

  // (A SUPPLIED space is still asserted onto the routed calendar — the
  // relaxation is "not required", not "not checked". Pinned below by
  // "a space on ANOTHER calendar of the same place is refused".)

  it("RENT without a space but ALSO without a window is STILL invalid_input — the window did not move", async () => {
    // The sibling of the case above: dropping the room requirement must not
    // drop the window requirement, which the SQL CHECK still enforces too.
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });
    const {
      spaceId: _omitted,
      requestedStartsAt: _s,
      requestedEndsAt: _e,
      ...bare
    } = rentInput;

    await expect(createBookingRequest(deps, bare)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("RENT without a purpose or without a window is invalid_input", async () => {
    const { deps } = buildDeps({ profile: null, calendars: makeIntentCalendarsFake() });
    const { purpose: _p, ...noPurpose } = rentInput;
    await expect(createBookingRequest(deps, noPurpose)).rejects.toMatchObject({
      code: "invalid_input",
    });
    const { requestedEndsAt: _e, ...noEnd } = rentInput;
    await expect(createBookingRequest(deps, noEnd)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("a window that ends before (or at) its start is invalid_input; so is one longer than the cap", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });
    await expect(
      createBookingRequest(deps, {
        ...rentInput,
        requestedStartsAt: "2026-10-05T04:00:00.000Z",
        requestedEndsAt: "2026-10-04T23:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createBookingRequest(deps, {
        ...rentInput,
        requestedEndsAt: rentInput.requestedStartsAt,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createBookingRequest(deps, {
        ...rentInput,
        requestedEndsAt: "2026-12-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("RENT/USE: a window that already started (beyond the 1h grace) is BOOKING_DATE_UNAVAILABLE / past", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });
    // NOW is 2026-06-10T12:00Z. Two hours ago: refused.
    await expect(
      createBookingRequest(deps, {
        ...rentInput,
        requestedStartsAt: "2026-06-10T10:00:00.000Z",
        requestedEndsAt: "2026-06-10T14:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "BOOKING_DATE_UNAVAILABLE",
      meta: { dates: ["2026-06-10T10:00:00.000Z"], reasons: ["past"] },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    // Inside the grace (started 30 minutes ago): accepted.
    const inGrace = new Date(NOW.getTime() - BOOKING_WINDOW_PAST_GRACE_MS / 2);
    await createBookingRequest(deps, {
      ...rentInput,
      requestedStartsAt: inGrace.toISOString(),
      requestedEndsAt: "2026-06-10T14:00:00.000Z",
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("a space on ANOTHER calendar of the same place is refused — space_not_on_calendar", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      calendars: makeIntentCalendarsFake(),
    });
    await expect(
      createBookingRequest(deps, { ...rentInput, spaceId: OTHER_SPACE_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "space_not_on_calendar",
      meta: { calendarId: CALENDAR_ID, spaceId: OTHER_SPACE_ID },
    });
    // Routed to that calendar explicitly, the same space is fine.
    await createBookingRequest(deps, {
      ...rentInput,
      calendarId: OTHER_CALENDAR_ID,
      spaceId: OTHER_SPACE_ID,
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: OTHER_CALENDAR_ID, spaceId: OTHER_SPACE_ID }),
    );
  });

  it("an unknown space, or a RETIRED one, is refused identically", async () => {
    const { deps } = buildDeps({ profile: null, calendars: makeIntentCalendarsFake() });
    await expect(
      createBookingRequest(deps, { ...rentInput, spaceId: "5face000-9999-4999-8999-999999999999" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "space_not_on_calendar" });
    await expect(
      createBookingRequest(deps, { ...rentInput, spaceId: RETIRED_SPACE_ID }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "space_not_on_calendar" });
  });

  it("PERFORM may name a space too, and it is checked the same way", async () => {
    const { deps, mocks } = buildDeps({ calendars: makeIntentCalendarsFake() });
    await expect(
      createBookingRequest(deps, { ...baseInput, spaceId: OTHER_SPACE_ID }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "space_not_on_calendar" });
    await createBookingRequest(deps, { ...baseInput, spaceId: SPACE_ID });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "PERFORM", spaceId: SPACE_ID }),
    );
  });

  it("sanitizes `purpose` before the 200-char cap and bounds attendance", async () => {
    const { deps, mocks } = buildDeps({ profile: null, calendars: makeIntentCalendarsFake() });
    await createBookingRequest(deps, {
      ...rentInput,
      purpose: "<b>Birthday</b> party <script>alert(1)</script>",
    });
    const call = mocks.bookingRequests.create.mock.calls.at(-1)?.[0] as { purpose: string };
    expect(call.purpose).not.toContain("<");
    expect(call.purpose).toContain("Birthday");

    await expect(
      createBookingRequest(deps, { ...rentInput, purpose: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createBookingRequest(deps, { ...rentInput, expectedAttendance: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("visibilityHint is NOT accepted (dropped from v1 — no column to hold it)", async () => {
    const { deps } = buildDeps({ profile: null, calendars: makeIntentCalendarsFake() });
    await expect(
      createBookingRequest(deps, { ...rentInput, visibilityHint: "PUBLIC" } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("createBookingRequest — unclaimed venues take no requests (amendment 2026-09-25)", () => {
  /** No verified, unrevoked ownership → unclaimed. */
  const unclaimedPlace = (overrides: Partial<PlaceRecord> = {}) =>
    buildPlaceRecord({
      verificationStatus: "UNVERIFIED",
      acceptsBookingRequests: false,
      humanIdsWithAccess: [],
      orgIdsWithAccess: [],
      ...overrides,
    });

  /** Every collaborator that must stay untouched by a refused pitch. */
  function wireSpies(deps: CreateBookingRequestDeps) {
    const spies = {
      notifyBookingRequestReceived: vi.fn(async () => {}),
      notifyBookingLineupInvited: vi.fn(async () => {}),
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: 29,
        retryAfterSeconds: 0,
      })),
      listForOwners: vi.fn(async () => ({ rows: [] })),
    };
    deps.notifyBookingRequestReceived = spies.notifyBookingRequestReceived;
    deps.notifyBookingLineupInvited = spies.notifyBookingLineupInvited;
    deps.rateLimit = { consume: spies.consume } as never;
    (deps.repos as unknown as Record<string, unknown>).bookingStandards = {
      listForOwners: spies.listForOwners,
    };
    return spies;
  }

  it("refuses with PLACE_NOT_TAKING_REQUESTS, the venue's name in meta, and touches nothing else", async () => {
    const { deps, mocks } = buildDeps({ place: unclaimedPlace() });
    const spies = wireSpies(deps);

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_TAKING_REQUESTS",
      meta: { placeId: PLACE_ID, placeName: "Test Venue" },
    });

    // The ONE read is the place. No sender check, no performer gate, no
    // standards, no write, no ledger, no audit, no notification, no budget.
    expect(mocks.places.getById).toHaveBeenCalledTimes(1);
    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(mocks.performerProfiles.getByOwner).not.toHaveBeenCalled();
    expect(spies.listForOwners).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.findOpenByPerformerAndPlace).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
    expect(spies.consume).not.toHaveBeenCalled();
    expect(spies.notifyBookingRequestReceived).not.toHaveBeenCalled();
    expect(spies.notifyBookingLineupInvited).not.toHaveBeenCalled();
  });

  it("runs BEFORE the bill: a bill that would fail its own rules still gets the unclaimed refusal", async () => {
    const TAGGED = "7a99ed00-0000-4000-8000-000000000001";
    const dupe = buildDeps({ place: unclaimedPlace() });
    await expect(
      createBookingRequest(dupe.deps, {
        ...baseInput,
        bill: {
          includeSelf: true,
          acts: [
            { kind: "tagged", humanId: TAGGED },
            { kind: "tagged", humanId: TAGGED },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_TAKING_REQUESTS" });

    // RENT with a bill is BILL_NOT_ALLOWED at a claimed venue; at an
    // unclaimed one the venue refusal comes first.
    const rentWithBill = buildDeps({ place: unclaimedPlace(), profile: null });
    await expect(
      createBookingRequest(rentWithBill.deps, {
        actorHumanId: ACTOR_ID,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        placeId: PLACE_ID,
        intent: "RENT",
        requestedStartsAt: "2026-10-04T23:00:00.000Z",
        requestedEndsAt: "2026-10-05T04:00:00.000Z",
        purpose: "Private party",
        bill: { includeSelf: true, acts: [] },
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_TAKING_REQUESTS" });
  });

  it("claimed is NOT verified: a VERIFIED, opted-in place nobody holds (a staff waiver) is refused too", async () => {
    const { deps, mocks } = buildDeps({
      place: unclaimedPlace({
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: true,
      }),
    });
    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_TAKING_REQUESTS",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("an ownerless place is refused whatever its state: PENDING claim in flight, REJECTED, ARCHIVED", async () => {
    for (const overrides of [
      { verificationStatus: "PENDING" },
      { verificationStatus: "REJECTED" },
      { status: "ARCHIVED" },
    ] as Partial<PlaceRecord>[]) {
      const { deps, mocks } = buildDeps({ place: unclaimedPlace(overrides) });
      await expect(
        createBookingRequest(deps, baseInput),
        JSON.stringify(overrides),
      ).rejects.toMatchObject({ code: "PLACE_NOT_TAKING_REQUESTS" });
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    }
  });

  it("names the place in meta only while it is ACTIVE", async () => {
    for (const status of ["ARCHIVED", "SUSPENDED"] as const) {
      const { deps } = buildDeps({ place: unclaimedPlace({ status } as Partial<PlaceRecord>) });
      const error = await createBookingRequest(deps, baseInput).catch((e) => e);
      expect(error, status).toMatchObject({ code: "PLACE_NOT_TAKING_REQUESTS" });
      expect(error.meta, status).toEqual({ placeId: PLACE_ID });
    }
  });

  it("a missing place is still PLACE_NOT_FOUND", async () => {
    const { deps } = buildDeps({ place: null });
    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  it("an ORG-held place is claimed: the pitch goes through, opened entry only, no parked stamp", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
    });

    const result = await createBookingRequest(deps, baseInput);

    expect(result).toEqual({ bookingRequestId: expect.any(String) });
    expect(mocks.bookingRequests.create.mock.calls[0]![0]).not.toHaveProperty(
      "parkedUnclaimedAt",
    );
    const kinds = systemEntriesFor(deps.repos, result.bookingRequestId).map(
      (e) => e.systemKind,
    );
    expect(kinds).toEqual(["booking_request.opened"]);
    const audit = (
      mocks.audit.log.mock.calls as unknown as Array<[{ data: object }]>
    )[0]![0];
    expect(audit.data).not.toHaveProperty("parkedUnclaimed");
  });

  it("a claimed-but-unverified place still refuses PLACE_NOT_VERIFIED", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        verificationStatus: "PENDING",
        humanIdsWithAccess: [ACTOR_ID],
      }),
    });
    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_VERIFIED",
    });
  });

  it("a claimed place that opted out still refuses PLACE_NOT_ACCEPTING_REQUESTS", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({ acceptsBookingRequests: false }),
    });
    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
    });
  });
});
