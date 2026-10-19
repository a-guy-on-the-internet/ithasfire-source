import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import {
  createFakeBookingStandards,
  type FakeBookingStandards,
} from "@th/test-utils/fakes/booking-standards";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EmbedRecord } from "@th/types/repos/embeds";
import type { BookingStandardItemInput } from "@th/types/repos/booking-standards";

import {
  createBookingInquiry,
  type CreateBookingInquiryDeps,
} from "../create-booking-inquiry";
import {
  NOW,
  PLACE_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "../../booking-requests/__tests__/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Venue booking standards on the ANONYMOUS embed inquiry (venue-booking-
// standards spec, FR-006): the same list the signed-in path enforces, for
// the calendar the inquiry routes to (the place's default), refused before
// the per-place flood cap is spent. Fails open on a degraded read.
// ─────────────────────────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-0000000000d0";
const DEFAULT_CAL = "ca1e0da1-1111-4111-8111-111111111111";
const ORIGIN = "https://venue.example.com";

const embed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "place",
  subjectId: PLACE_ID,
  domain: "venue.example.com",
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: null,
  createdAt: new Date("2025-01-01"),
};

/** The place's default calendar, taking PERFORM (the embed's only intent). */
const performingDefault = {
  id: DEFAULT_CAL,
  placeId: PLACE_ID,
  isDefault: true,
  acceptsPerform: true,
  acceptsRent: false,
  acceptsUse: false,
  rentalMode: "REQUEST",
};

function buildDeps(
  options: {
    bookingStandards?: Partial<FakeBookingStandards>;
    defaultCalendar?: Record<string, unknown> | null;
  } = {},
) {
  const defaultCalendar =
    options.defaultCalendar === undefined ? performingDefault : options.defaultCalendar;
  const mocks = {
    embeds: { getById: vi.fn(async () => embed) },
    places: { getById: vi.fn(async () => buildPlaceRecord()) },
    bookingRequests: {
      findOpenByContactEmailAndPlace: vi.fn(async () => null),
      create: vi.fn(async (input: Record<string, unknown>) =>
        buildBookingRequestRecord({
          ...(input as Partial<BookingRequestRecord>),
          // Anonymous: no sender pair (the helper's type predates null here).
          performerOwnerType: null as never,
          performerOwnerId: null as never,
        }),
      ),
    },
    audit: { log: vi.fn(async () => {}) },
    calendars: {
      listByPlace: vi.fn(async () => []),
      listAvailabilityForPlace: vi.fn(async () => []),
      findDefaultForPlace: vi.fn(async () => defaultCalendar),
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
    events: { listPublishedOccurrencesByPlace: vi.fn(async () => []) },
    bookingStandards: options.bookingStandards ?? createFakeBookingStandards(),
  };
  const rateLimit = {
    consume: vi.fn(async () => ({ allowed: true, remaining: 29, retryAfterSeconds: 0 })),
  };
  const reportError = vi.fn();
  const deps: CreateBookingInquiryDeps = {
    repos: withTx(mocks) as unknown as CreateBookingInquiryDeps["repos"],
    clock: { now: () => NOW },
    logger: createTestLogger(),
    publicAppUrl: "http://localhost:3000",
    rateLimit,
    reportError,
  };
  return { deps, mocks, rateLimit, reportError };
}

async function withItems(ownerType: "PLACE" | "CALENDAR", ownerId: string, items: BookingStandardItemInput[]) {
  const fake = createFakeBookingStandards();
  await fake.replaceItems({ ownerType, ownerId, intent: "PERFORM", items });
  return fake;
}

const input = {
  embedId: EMBED_ID,
  hostOrigin: ORIGIN,
  contactName: "Jo Doe",
  contactEmail: "jo@example.com",
  actName: "The Basement Tapes",
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-08-14"],
};

describe("createBookingInquiry — venue booking standards (FR-006)", () => {
  it("a REQUIRED music link on the DEFAULT calendar blocks an inquiry without one — before the flood cap is spent", async () => {
    const { deps, mocks, rateLimit } = buildDeps({
      bookingStandards: await withItems("CALENDAR", DEFAULT_CAL, [
        { field: "LINK_MUSIC", label: "Send us a music link", requirement: "REQUIRED" },
      ]),
    });

    await expect(createBookingInquiry(deps, input)).rejects.toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "LINK_MUSIC", label: "Send us a music link" }] },
    });
    expect(mocks.calendars.findDefaultForPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(rateLimit.consume).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("the same inquiry WITH the link passes", async () => {
    const { deps, mocks } = buildDeps({
      bookingStandards: await withItems("CALENDAR", DEFAULT_CAL, [
        { field: "LINK_MUSIC", label: "Send us a music link", requirement: "REQUIRED" },
      ]),
    });

    await createBookingInquiry(deps, { ...input, linkMusic: "https://band.example/listen" });

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("a place with no calendar uses the place default", async () => {
    const { deps } = buildDeps({
      defaultCalendar: null,
      bookingStandards: await withItems("PLACE", PLACE_ID, [
        { field: "EXPECTED_DRAW", label: "Your draw", requirement: "REQUIRED" },
      ]),
    });

    await expect(createBookingInquiry(deps, input)).rejects.toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "EXPECTED_DRAW", label: "Your draw" }] },
    });
  });

  it("a default calendar that no longer takes PERFORM: its stale PERFORM rows never block (resolves as no calendar → the place default); the inquiry still routes to it", async () => {
    const bookingStandards = await withItems("CALENDAR", DEFAULT_CAL, [
      { field: "LINK_MUSIC", label: "Stale calendar rule", requirement: "REQUIRED" },
    ]);
    const roomOnly = { ...performingDefault, acceptsPerform: false, acceptsUse: true };

    const passes = buildDeps({ bookingStandards, defaultCalendar: roomOnly });
    await createBookingInquiry(passes.deps, input);
    expect(passes.mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: DEFAULT_CAL }),
    );
    // ONE default-calendar read serves both the gate and the routing.
    expect(passes.mocks.calendars.findDefaultForPlace).toHaveBeenCalledTimes(1);

    // The place default still applies in that case (what the options read
    // serves as `placeStandards`).
    await bookingStandards.replaceItems({
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      intent: "PERFORM",
      items: [{ field: "EXPECTED_DRAW", label: "Your draw", requirement: "REQUIRED" }],
    });
    await expect(
      createBookingInquiry(buildDeps({ bookingStandards, defaultCalendar: roomOnly }).deps, input),
    ).rejects.toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "EXPECTED_DRAW", label: "Your draw" }] },
    });
  });

  it("SUGGESTED items and the platform defaults never block", async () => {
    const suggested = buildDeps({
      bookingStandards: await withItems("CALENDAR", DEFAULT_CAL, [
        { field: "LINK_MUSIC", label: "Music", requirement: "SUGGESTED" },
      ]),
    });
    await createBookingInquiry(suggested.deps, input);
    expect(suggested.mocks.bookingRequests.create).toHaveBeenCalledTimes(1);

    const nothingSet = buildDeps();
    await createBookingInquiry(nothingSet.deps, input);
    expect(nothingSet.mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("BILL: `actName` alone (row 0) does not meet a REQUIRED bill; one extra act does", async () => {
    const bookingStandards = await withItems("CALENDAR", DEFAULT_CAL, [
      { field: "BILL", label: "Who else is on the bill", requirement: "REQUIRED" },
    ]);

    await expect(
      createBookingInquiry(buildDeps({ bookingStandards }).deps, input),
    ).rejects.toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "BILL", label: "Who else is on the bill" }] },
    });

    const withAct = buildDeps({ bookingStandards });
    await createBookingInquiry(withAct.deps, {
      ...input,
      bill: { acts: [{ kind: "external", name: "The Openers" }] },
    });
    expect(withAct.mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("degrade: a throwing standards read fails OPEN and is reported", async () => {
    const readFailure = new Error('relation "BookingStandardItem" does not exist');
    const { deps, mocks, reportError } = buildDeps({
      bookingStandards: {
        listForOwners: vi.fn(async () => {
          throw readFailure;
        }),
      },
    });

    await createBookingInquiry(deps, input);

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(readFailure, {
      tags: { useCase: "loadEffectiveBookingStandards" },
      extra: { placeId: PLACE_ID, calendarIds: [DEFAULT_CAL] },
    });
  });
});
