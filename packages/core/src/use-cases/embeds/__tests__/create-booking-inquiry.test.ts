import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { TurnstilePort } from "@th/ports/turnstile";
import type { EmbedRecord } from "@th/types/repos/embeds";

import {
  createBookingInquiry,
  BOOKING_INQUIRY_PLACE_DAILY_MAX,
  BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
  bookingInquiryPlaceDailyKey,
  type CreateBookingInquiryDeps,
} from "../create-booking-inquiry";
import { BOOKING_REQUEST_TTL_DAYS } from "../../booking-requests/create-booking-request";
import {
  NOW,
  PLACE_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "../../booking-requests/__tests__/helpers";

const EMBED_ID = "00000000-0000-4000-8000-0000000000d0";

const DOMAIN = "venue.example.com";
const MATCHING_ORIGIN = "https://venue.example.com";
const WRONG_ORIGIN = "https://attacker.example.net";
const PUBLIC_APP_URL = "http://localhost:3000";

const baseEmbed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "place",
  subjectId: PLACE_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: null,
  createdAt: new Date("2025-01-01"),
};

type BuildDepsOptions = {
  embed?: EmbedRecord | null;
  place?: PlaceRecord | null;
  openAnonymous?: BookingRequestRecord | null;
  /** Opening-hours / blackout rows for the availability gate. */
  availabilityRows?: Array<Record<string, unknown>>;
  /** Calendars of the place, for the availability gate's scope resolution. */
  calendars?: Array<Record<string, unknown>>;
  /** The place's default calendar, for FR-008 routing. Null = unrouted. */
  defaultCalendar?: Record<string, unknown> | null;
  turnstile?: TurnstilePort | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const embed = options.embed === undefined ? baseEmbed : options.embed;
  const place =
    options.place === undefined ? buildPlaceRecord() : options.place;

  const embeds = { getById: vi.fn(async () => embed) };
  const places = { getById: vi.fn(async () => place) };
  const bookingRequests = {
    findOpenByContactEmailAndPlace: vi.fn(
      async () => options.openAnonymous ?? null,
    ),
    create: vi.fn(async (input: Record<string, unknown>) =>
      buildBookingRequestRecord({
        ...(input as Partial<BookingRequestRecord>),
        performerOwnerType: null,
        performerOwnerId: null,
      }),
    ),
  };
  const audit = { log: vi.fn(async () => {}) };
  // Availability gate. No rows = the venue has never declared hours, which is
  // the documented escape hatch, so these fixtures behave exactly as before.
  // Rows are `CalendarAvailability` now (venue-hierarchy FR-007); the place has
  // no calendars here, so only place-wide (`calendarId: null`) rows apply.
  const calendars = {
    listByPlace: vi.fn(async () => options.calendars ?? []),
    listAvailabilityForPlace: vi.fn(async () => options.availabilityRows ?? []),
    // FR-008 routing: the embed never names a calendar, so the inquiry routes
    // to the place's default — the SAME calendar the availability gate above
    // resolved. Default fixture: no calendars, so it routes null (unrouted),
    // which is what every pre-existing expectation in this file assumes.
    findDefaultForPlace: vi.fn(async () => options.defaultCalendar ?? null),
    // Availability-onboarding FR-005 gate. Default `|| 1` = CONFIGURED (rows
    // exist but impose no window policy — same posture as the
    // create-booking-request fixtures), so every pre-existing escape-hatch
    // expectation stays intact; the FR-005 test forces 0 explicitly.
    countAvailabilityForPlace: vi.fn(
      async () => (options.availabilityRows ?? []).length || 1,
    ),
  };
  const events = {
    listPublishedOccurrencesByPlace: vi.fn(async () => []),
  };

  const mocks = {
    embeds,
    places,
    bookingRequests,
    audit,
    calendars,
    events,
  };

  const deps: CreateBookingInquiryDeps = {
    repos: withTx(mocks) as unknown as CreateBookingInquiryDeps["repos"],
    clock: { now: () => NOW },
    logger: createTestLogger(),
    turnstile: options.turnstile ?? null,
    publicAppUrl: PUBLIC_APP_URL,
  };

  return { deps, mocks };
}

function makeTurnstile(valid: boolean): TurnstilePort {
  return { enabled: true, verify: vi.fn(async () => valid) };
}

const baseInput = {
  embedId: EMBED_ID,
  hostOrigin: MATCHING_ORIGIN,
  contactName: "Jo Doe",
  contactEmail: "Jo.Doe@Example.COM",
  actName: "The Basement Tapes",
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-08-14", "2026-08-21"],
};

describe("createBookingInquiry", () => {
  it("creates an anonymous EMBED row (lowercased email, TTL expiry) and audits with source=embed", async () => {
    const { deps, mocks } = buildDeps();

    const result = await createBookingInquiry(deps, baseInput);

    expect(result.bookingRequestId).toBeDefined();
    const expectedExpiry = new Date(
      NOW.getTime() + BOOKING_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        contactName: "Jo Doe",
        contactEmail: "jo.doe@example.com",
        source: "EMBED",
        embedId: EMBED_ID,
        actName: "The Basement Tapes",
        expiresAt: expectedExpiry,
        // Lineup v3 L12: an inquiry always records a bill (its act is row 0).
        billRecorded: true,
      }),
    );
    // Anonymous: no performer owner pair is ever forwarded to the repo.
    const createArg = mocks.bookingRequests.create.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(createArg.performerOwnerType).toBeUndefined();
    expect(createArg.performerOwnerId).toBeUndefined();

    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_request",
        action: "booking_request.created",
        data: expect.objectContaining({
          placeId: PLACE_ID,
          source: "embed",
          embedId: EMBED_ID,
          contactEmail: "jo.doe@example.com",
        }),
        at: NOW,
      }),
    );
  });

  // ── Origin enforcement (NFR-001: fail closed, no partial writes) ──────────

  it("rejects a mismatched host origin before reading the place (fail closed)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, { ...baseInput, hostOrigin: WRONG_ORIGIN }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(mocks.places.getById).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("rejects a null host origin (fail closed)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, { ...baseInput, hostOrigin: null }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(mocks.places.getById).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("allows our own web origin (admin preview / direct view)", async () => {
    const { deps } = buildDeps();

    const result = await createBookingInquiry(deps, {
      ...baseInput,
      hostOrigin: PUBLIC_APP_URL,
    });
    expect(result.bookingRequestId).toBeDefined();
  });

  it("rejects a REVOKED embed as not found", async () => {
    const { deps, mocks } = buildDeps({
      embed: { ...baseEmbed, status: "REVOKED" },
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "EMBED_NOT_FOUND",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("rejects a non-place subject type before Turnstile / place reads", async () => {
    const turnstile = makeTurnstile(true);
    const { deps, mocks } = buildDeps({
      embed: { ...baseEmbed, subjectType: "organization" },
      turnstile,
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "UNSUPPORTED_SUBJECT_TYPE",
    });
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(mocks.places.getById).not.toHaveBeenCalled();
  });

  // ── Turnstile (NFR-002) ────────────────────────────────────────────────────

  it("requires a Turnstile token when enforcement is enabled", async () => {
    const { deps, mocks } = buildDeps({ turnstile: makeTurnstile(true) });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "TURNSTILE_TOKEN_REQUIRED",
    });
    expect(mocks.places.getById).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("rejects a failed Turnstile verification (forwarding the request IP), no row written", async () => {
    const turnstile = makeTurnstile(false);
    const { deps, mocks } = buildDeps({ turnstile });

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        turnstileToken: "tok-123",
        requestIp: "203.0.113.7",
      }),
    ).rejects.toMatchObject({ code: "TURNSTILE_VERIFICATION_FAILED" });
    expect(turnstile.verify).toHaveBeenCalledWith("tok-123", "203.0.113.7");
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("passes with a valid Turnstile token", async () => {
    const turnstile = makeTurnstile(true);
    const { deps } = buildDeps({ turnstile });

    const result = await createBookingInquiry(deps, {
      ...baseInput,
      turnstileToken: "tok-123",
    });
    expect(result.bookingRequestId).toBeDefined();
    expect(turnstile.verify).toHaveBeenCalledTimes(1);
  });

  // ── Place gate ─────────────────────────────────────────────────────────────

  it("rejects a missing place", async () => {
    const { deps } = buildDeps({ place: null });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  // ── P3a (unclaimed venues) ── amendment 2026-09-25.
  it("refuses an UNCLAIMED place with PLACE_NOT_TAKING_REQUESTS — before standards, the budget, any write or notice", async () => {
    for (const place of [
      buildPlaceRecord({
        verificationStatus: "UNVERIFIED",
        humanIdsWithAccess: [],
        orgIdsWithAccess: [],
      }),
      // Claimed is not VERIFIED: a staff-waived, opted-in place nobody holds.
      buildPlaceRecord({
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: true,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [],
      }),
    ]) {
      const { deps, mocks } = buildDeps({ place });
      const consume = vi.fn();
      const notifyBookingRequestReceived = vi.fn();
      deps.rateLimit = { consume } as never;
      deps.notifyBookingRequestReceived = notifyBookingRequestReceived;

      await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
        code: "PLACE_NOT_TAKING_REQUESTS",
        meta: { placeId: place.id, placeName: "Test Venue" },
      });
      expect(mocks.calendars.countAvailabilityForPlace).not.toHaveBeenCalled();
      expect(mocks.bookingRequests.findOpenByContactEmailAndPlace).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
      expect(notifyBookingRequestReceived).not.toHaveBeenCalled();
    }
  });

  it("rejects an unverified place server-side regardless of the widget state", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ verificationStatus: "PENDING" }),
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_VERIFIED",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("rejects a place that paused booking requests", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ acceptsBookingRequests: false }),
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("REFUSES an UNCONFIGURED place with booking_requests_unconfigured (fail-closed, like the main site)", async () => {
    // Availability-onboarding FR-005: the embed must make the same decision
    // as bookingRequests.create, or it becomes the hole the gate closes.
    const { deps, mocks } = buildDeps();
    mocks.calendars.countAvailabilityForPlace = vi.fn(async () => 0);

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "booking_requests_unconfigured",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  // ── Anonymous dedupe (FR-005) ──────────────────────────────────────────────

  it("rejects a duplicate open inquiry via the pre-check (lowercased lookup)", async () => {
    const { deps, mocks } = buildDeps({
      openAnonymous: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Jo Doe",
        contactEmail: "jo.doe@example.com",
        source: "EMBED",
      }),
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "DUPLICATE_OPEN_REQUEST",
    });
    expect(
      mocks.bookingRequests.findOpenByContactEmailAndPlace,
    ).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      contactEmail: "jo.doe@example.com",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("surfaces the adapter race loser (duplicate_open_request P2002 map) as the SAME typed error", async () => {
    // Two concurrent submissions can both pass the pre-check; the partial
    // unique index BookingRequest_open_anon_pair_key makes the loser's insert
    // fail and the adapter maps it — the widget must see one consistent code.
    const { deps, mocks } = buildDeps();
    mocks.bookingRequests.create.mockRejectedValueOnce({
      code: "duplicate_open_request",
      message: "duplicate_open_request",
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "DUPLICATE_OPEN_REQUEST",
    });
  });

  it("rethrows non-duplicate transaction failures untouched", async () => {
    const { deps, mocks } = buildDeps();
    const dbDown = new Error("connection refused");
    mocks.bookingRequests.create.mockRejectedValueOnce(dbDown);

    await expect(createBookingInquiry(deps, baseInput)).rejects.toBe(dbDown);
  });

  // ── Input hygiene (NFR-002: same sanitizer as createBookingRequest) ───────

  it("sanitizes free text: HTML stripped from message/techNeeds/contactName before length checks", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingInquiry(deps, {
      ...baseInput,
      contactName: "<b>Jo</b> Doe",
      message: "We'd love to play.<script>alert(1)</script> Any Fridays open?",
      techNeeds: "Two mics<img src=x onerror=alert(1)> and a DI.",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contactName: "Jo Doe",
        message: "We'd love to play. Any Fridays open?",
        techNeeds: "Two mics and a DI.",
      }),
    );
  });

  it("rejects a message that collapses below the 10-char floor after sanitization", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        message: "<script>alert(1)</script>hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("sanitizes actName and genre: HTML + bidi/zero-width stripped before length checks", async () => {
    // Anonymous free text is fully untrusted — actName/genre are tightened
    // to the sanitizing helper on THIS path (the signed-in path keeps its
    // trim-only rules; separate follow-up).
    const { deps, mocks } = buildDeps();

    await createBookingInquiry(deps, {
      ...baseInput,
      // U+202E = RTL override (spoofing), U+200B/U+200D = zero-width chars.
      actName: "The <b>Basement</b>\u202E Tapes\u200B",
      genre: "indie<script>alert(1)</script> rock\u200D",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actName: "The Basement Tapes",
        genre: "indie rock",
      }),
    );
  });

  it("rejects an actName that collapses to nothing after sanitization (tag/control-only input)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        actName: "<script>alert(1)</script>\u202E\u200B",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createBookingInquiry(deps, { ...baseInput, genre: "<i></i>\u200B" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("enforces the shared fee-ask refine (amount requires GUARANTEE/DOOR_SPLIT) and snapshots the currency", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        feeType: "NEGOTIABLE",
        feeAmountCents: 25_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createBookingInquiry(deps, { ...baseInput, feeAmountCents: 25_000 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();

    await createBookingInquiry(deps, {
      ...baseInput,
      feeType: "GUARANTEE",
      feeAmountCents: 50_000,
    });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
    );
  });

  it("rejects a set length that is not one of the shared presets", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, { ...baseInput, setLengthMinutes: 37 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("strict schema rejects unknown keys (no verified-stats smuggling, no owner injection)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        verifiedStatsSnapshot: { totalEventsPerformed: 9999 },
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        performerOwnerId: "11111111-1111-4111-8111-111111111111",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("rejects invalid contact emails and bad preferred dates", async () => {
    const { deps } = buildDeps();

    await expect(
      createBookingInquiry(deps, { ...baseInput, contactEmail: "not-an-email" }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      createBookingInquiry(deps, {
        ...baseInput,
        preferredDates: ["not-a-date"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-place daily flood cap (security-review follow-up, 2026-07-13)
// ─────────────────────────────────────────────────────────────────────────────

describe("createBookingInquiry — per-place daily flood cap", () => {
  const PLACE_DAILY_KEY = bookingInquiryPlaceDailyKey(PLACE_ID);

  function allowingRateLimit() {
    return {
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0,
      })),
    };
  }

  function denyingRateLimit() {
    return {
      consume: vi.fn(async () => ({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 12_345,
      })),
    };
  }

  it("consumes the place-keyed daily budget (exact key/max/window) before the write", async () => {
    const rateLimit = allowingRateLimit();
    const { deps, mocks } = buildDeps();
    deps.rateLimit = rateLimit;

    await createBookingInquiry(deps, baseInput);

    expect(rateLimit.consume).toHaveBeenCalledTimes(1);
    expect(rateLimit.consume).toHaveBeenCalledWith(
      PLACE_DAILY_KEY,
      BOOKING_INQUIRY_PLACE_DAILY_MAX,
      BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
    );
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("rejects with RATE_LIMITED once the place budget is exhausted — no row, no audit", async () => {
    const rateLimit = denyingRateLimit();
    const { deps, mocks } = buildDeps();
    deps.rateLimit = rateLimit;

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      meta: {
        scope: "booking_inquiry_place_daily",
        retryAfterSeconds: 12_345,
      },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("does NOT burn budget on a Turnstile-failing request (consume runs post-Turnstile)", async () => {
    // The whole point of consuming inside the use case instead of at the
    // transport middleware: unverified bots must not be able to exhaust a
    // venue's daily budget and DoS the widget for legitimate performers.
    const rateLimit = allowingRateLimit();
    const { deps } = buildDeps({ turnstile: makeTurnstile(false) });
    deps.rateLimit = rateLimit;

    await expect(
      createBookingInquiry(deps, { ...baseInput, turnstileToken: "tok-bad" }),
    ).rejects.toMatchObject({ code: "TURNSTILE_VERIFICATION_FAILED" });
    expect(rateLimit.consume).not.toHaveBeenCalled();
  });

  it("does NOT burn budget on a duplicate open inquiry (consume runs after the dedupe pre-check)", async () => {
    const rateLimit = allowingRateLimit();
    const { deps } = buildDeps({
      openAnonymous: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactEmail: "jo.doe@example.com",
        source: "EMBED",
      }),
    });
    deps.rateLimit = rateLimit;

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      code: "DUPLICATE_OPEN_REQUEST",
    });
    expect(rateLimit.consume).not.toHaveBeenCalled();
  });

  it("keys the budget by place — a different place consumes a different bucket", async () => {
    const OTHER_PLACE_ID = "00000000-0000-4000-8000-0000000000d9";
    const rateLimit = allowingRateLimit();
    const { deps } = buildDeps({
      embed: { ...baseEmbed, subjectId: OTHER_PLACE_ID },
      place: buildPlaceRecord({ id: OTHER_PLACE_ID }),
    });
    deps.rateLimit = rateLimit;

    await createBookingInquiry(deps, baseInput);

    expect(rateLimit.consume).toHaveBeenCalledWith(
      bookingInquiryPlaceDailyKey(OTHER_PLACE_ID),
      BOOKING_INQUIRY_PLACE_DAILY_MAX,
      BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
    );
    expect(rateLimit.consume).not.toHaveBeenCalledWith(
      PLACE_DAILY_KEY,
      expect.anything(),
      expect.anything(),
    );
  });

  it("fails open when the limiter backend throws — submission succeeds, swallow is reported (ReporterPort convention)", async () => {
    const limiterDown = new Error("redis connection refused");
    const rateLimit = {
      consume: vi.fn(async () => {
        throw limiterDown;
      }),
    };
    const reportError = vi.fn();
    const { deps, mocks } = buildDeps();
    deps.rateLimit = rateLimit;
    deps.reportError = reportError;

    const result = await createBookingInquiry(deps, baseInput);

    expect(result.bookingRequestId).toBeDefined();
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(limiterDown, {
      tags: { useCase: "createBookingInquiry" },
      extra: { placeId: PLACE_ID, embedId: EMBED_ID },
    });
  });

  it("fail-open works unwired (no reportError) and a throwing reporter is harmless", async () => {
    const rateLimit = {
      consume: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const { deps } = buildDeps();
    deps.rateLimit = rateLimit;
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    await expect(createBookingInquiry(deps, baseInput)).resolves.toMatchObject({
      bookingRequestId: expect.any(String),
    });
  });

  it("skips the cap entirely when the dep is absent (backwards compatible)", async () => {
    const { deps, mocks } = buildDeps();
    // No deps.rateLimit set.
    const result = await createBookingInquiry(deps, baseInput);
    expect(result.bookingRequestId).toBeDefined();
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue notification hook (booking-request-embed-button FR-008 / NFR-004)
// ─────────────────────────────────────────────────────────────────────────────

describe("createBookingInquiry — venue notification hook", () => {
  it("fires notifyBookingRequestReceived post-commit with the created record + place", async () => {
    const { deps, mocks } = buildDeps();
    const notifyBookingRequestReceived = vi.fn(async () => {});
    deps.notifyBookingRequestReceived = notifyBookingRequestReceived;

    const result = await createBookingInquiry(deps, baseInput);

    expect(notifyBookingRequestReceived).toHaveBeenCalledTimes(1);
    const args = notifyBookingRequestReceived.mock.calls[0]![0] as {
      bookingRequest: { id: string; source: string };
      place: { id: string };
    };
    expect(args.bookingRequest.id).toBe(result.bookingRequestId);
    expect(args.bookingRequest.source).toBe("EMBED");
    expect(args.place.id).toBe(PLACE_ID);
    expect(mocks.bookingRequests.create).toHaveBeenCalled();
  });

  it("a throwing notifier is swallowed AND reported — the committed inquiry still succeeds", async () => {
    const { deps } = buildDeps();
    const reportError = vi.fn();
    deps.notifyBookingRequestReceived = vi.fn(async () => {
      throw new Error("notify pipeline down");
    });
    deps.reportError = reportError;

    const result = await createBookingInquiry(deps, baseInput);

    expect(result.bookingRequestId).toBeDefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "createBookingInquiry" },
      extra: {
        bookingRequestId: result.bookingRequestId,
        placeId: PLACE_ID,
        embedId: EMBED_ID,
      },
    });
  });

  it("swallow works unwired (no reportError) and a throwing reporter is harmless", async () => {
    const unwired = buildDeps();
    unwired.deps.notifyBookingRequestReceived = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      createBookingInquiry(unwired.deps, baseInput),
    ).resolves.toMatchObject({ bookingRequestId: expect.any(String) });

    const throwingReporter = buildDeps();
    throwingReporter.deps.notifyBookingRequestReceived = vi.fn(async () => {
      throw new Error("boom");
    });
    throwingReporter.deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      createBookingInquiry(throwingReporter.deps, baseInput),
    ).resolves.toMatchObject({ bookingRequestId: expect.any(String) });
  });

  // ── Calendar routing (FR-008) ─────────────────────────────────────────────

  it("routes the inquiry to the place's DEFAULT calendar", async () => {
    // The gate above already judged the requested dates against the default
    // calendar's hours and spaces. Persisting `calendarId: null` anyway would
    // leave the venue looking at a request that appears on no calendar, while
    // its dates were validated against one — and it would diverge from the
    // signed-in path, which routes to the default in exactly this situation.
    const CAL = "ca1e0da1-4444-4444-8444-444444444444";
    const { deps, mocks } = buildDeps({
      calendars: [
        {
          id: CAL,
          placeId: PLACE_ID,
          name: "Main Calendar",
          isDefault: true,
          spaces: [],
        },
      ],
      defaultCalendar: { id: CAL, placeId: PLACE_ID, isDefault: true },
    });

    await createBookingInquiry(deps, baseInput);

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: CAL }),
    );
  });

  it("stays unrouted (null) when the place has no calendars at all", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingInquiry(deps, baseInput);

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: null }),
    );
  });
});

// ── The bill (lineup-booking-requests v2, FR-005) ────────────────────────────
// Anonymous inquiries carry FREE-TEXT acts only: the inquiry's own actName is
// row 0, extras follow. Never a SELF row (no sender pair), never a tagged
// human — a humanId anywhere is a strict-schema 400 (no enumeration surface).

describe("createBookingInquiry — the bill (FR-005)", () => {
  const TAGGED_HUMAN = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

  /** The bill rows written for the inquiry, via the act store `withTx` wires. */
  const actsFor = async (deps: CreateBookingInquiryDeps, id: string) =>
    (
      deps.repos.bookingRequests as unknown as {
        listActsForRequests: (
          ids: string[],
        ) => Promise<Array<Record<string, unknown>>>;
      }
    ).listActsForRequests([id]);

  it("with no bill, writes ONE row: the submitted actName as EXTERNAL, confirmed, sortOrder 0", async () => {
    const { deps } = buildDeps();

    const result = await createBookingInquiry(deps, baseInput);

    expect(await actsFor(deps, result.bookingRequestId)).toEqual([
      expect.objectContaining({
        source: "EXTERNAL",
        externalName: "The Basement Tapes",
        externalUrl: null,
        actOwnerType: null,
        actOwnerId: null,
        confirmation: "CONFIRMED",
        sortOrder: 0,
        role: "PERFORMER",
      }),
    ]);
  });

  it("writes actName then the extra free-text acts in order, sanitized, with distinct sortOrders", async () => {
    const { deps } = buildDeps();

    const result = await createBookingInquiry(deps, {
      ...baseInput,
      bill: {
        acts: [
          {
            kind: "external",
            name: "  The <i>Openers</i> ",
            url: "https://openers.example",
          },
          { kind: "external", name: "DJ Late" },
        ],
      },
    });

    const acts = await actsFor(deps, result.bookingRequestId);
    expect(
      acts.map((act) => [act.source, act.externalName, act.externalUrl, act.sortOrder]),
    ).toEqual([
      ["EXTERNAL", "The Basement Tapes", null, 0],
      ["EXTERNAL", "The Openers", "https://openers.example", 1],
      ["EXTERNAL", "DJ Late", null, 2],
    ]);
    expect(acts.every((act) => act.confirmation === "CONFIRMED")).toBe(true);
  });

  it.each([
    ["a tagged entry", { acts: [{ kind: "tagged", humanId: TAGGED_HUMAN }] }],
    ["a humanId on a free-text act", { acts: [{ kind: "external", name: "X", humanId: TAGGED_HUMAN }] }],
    ["an act with no kind", { acts: [{ name: "X" }] }],
    ["includeSelf (anonymous has no self)", { includeSelf: true, acts: [] }],
    ["a javascript: url", { acts: [{ kind: "external", name: "X", url: "javascript:alert(1)" }] }],
    [
      "more than 11 extra acts",
      { acts: Array.from({ length: 12 }, (_, i) => ({ kind: "external", name: `Act ${i}` })) },
    ],
  ])("rejects %s as a strict-schema error — nothing read, nothing written", async (_label, bill) => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingInquiry(deps, { ...baseInput, bill }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.embeds.getById).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("accepts exactly 11 extra acts (12 rows with actName)", async () => {
    const { deps } = buildDeps();

    const result = await createBookingInquiry(deps, {
      ...baseInput,
      bill: {
        acts: Array.from({ length: 11 }, (_, i) => ({
          kind: "external",
          name: `Act ${i}`,
        })),
      },
    });

    const acts = await actsFor(deps, result.bookingRequestId);
    expect(acts).toHaveLength(12);
    expect(acts.map((act) => act.sortOrder)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
  });

  it("a failed bill write fails the inquiry (same tx — never swallowed) and no venue notification goes out", async () => {
    const notifyBookingRequestReceived = vi.fn(async () => {});
    const { deps } = buildDeps();
    deps.notifyBookingRequestReceived = notifyBookingRequestReceived;
    (
      deps.repos.bookingRequests as unknown as { addActs: unknown }
    ).addActs = vi.fn(async () => {
      throw { code: "invalid_input", message: "booking_request_self_act_without_sender" };
    });

    await expect(createBookingInquiry(deps, baseInput)).rejects.toMatchObject({
      message: "booking_request_self_act_without_sender",
    });
    expect(notifyBookingRequestReceived).not.toHaveBeenCalled();
  });
});
