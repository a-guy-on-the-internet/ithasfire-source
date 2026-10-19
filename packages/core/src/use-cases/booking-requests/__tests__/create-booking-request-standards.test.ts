import { describe, expect, it, vi } from "vitest";

import type { PlaceRecord } from "@th/ports/repos/places";
import {
  createFakeBookingStandards,
  type FakeBookingStandards,
} from "@th/test-utils/fakes/booking-standards";
import type { BookingStandardItemInput } from "@th/types/repos/booking-standards";

import {
  createBookingRequest,
  type CreateBookingRequestDeps,
} from "../create-booking-request";
import {
  getPlaceBookingOptions,
  type GetPlaceBookingOptionsDeps,
} from "../../places/get-place-booking-options";
import {
  ACTOR_ID,
  NOW,
  PLACE_ID,
  buildBookingRequestRecord,
  buildPerformerProfile,
  buildPlaceRecord,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Venue booking standards on the signed-in create path (venue-booking-
// standards spec, FR-006 / NFR-002). The venue's REQUIRED items for the
// ROUTED calendar + intent block with STANDARDS_UNMET and the venue's own
// label; nothing else ever blocks; a failed read fails open (and is seen).
// ─────────────────────────────────────────────────────────────────────────────

const CAL_MAIN = "ca1e0da1-1111-4111-8111-111111111111";
const CAL_BAR = "ca1e0da1-2222-4222-8222-222222222222";
const CAL_ROOM = "ca1e0da1-3333-4333-8333-333333333333";
const SPACE_ID = "5face000-1111-4111-8111-111111111111";

function calendarRow(overrides: Record<string, unknown>) {
  return {
    id: CAL_MAIN,
    placeId: PLACE_ID,
    name: "Main",
    slug: "main",
    description: null,
    isDefault: true,
    defaultStartTime: null,
    defaultCategoryId: null,
    eventTemplate: null,
    acceptsPerform: true,
    acceptsRent: false,
    acceptsUse: false,
    rentalRateCents: null,
    rentalRateCurrency: null,
    rentalRateVisible: false,
    rentalMode: "REQUEST",
    spaces: [{ id: SPACE_ID, placeId: PLACE_ID, name: "Room", status: "ACTIVE" }],
    ...overrides,
  };
}

const CALENDARS = [
  calendarRow({}),
  calendarRow({ id: CAL_BAR, name: "Bar", slug: "bar", isDefault: false }),
  calendarRow({
    id: CAL_ROOM,
    name: "Room hire",
    slug: "room-hire",
    isDefault: false,
    acceptsPerform: false,
    acceptsRent: true,
  }),
];

function buildDeps(
  options: {
    place?: PlaceRecord;
    bookingStandards?: Partial<FakeBookingStandards> | FakeBookingStandards;
    rateLimit?: { consume: ReturnType<typeof vi.fn> };
    calendars?: unknown[];
  } = {},
) {
  const calendarRows = options.calendars ?? CALENDARS;
  const bookingStandards = options.bookingStandards ?? createFakeBookingStandards();
  const mocks = {
    bookingRequests: {
      findOpenByPerformerAndPlace: vi.fn(async () => null),
      create: vi.fn(async (input: Record<string, unknown>) =>
        buildBookingRequestRecord(input as never),
      ),
    },
    performerProfiles: { getByOwner: vi.fn(async () => buildPerformerProfile()) },
    places: { getById: vi.fn(async () => options.place ?? buildPlaceRecord()) },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, genreTags: [] })),
      getByIds: vi.fn(async () => []),
    },
    entityPages: { getByOwners: vi.fn(async () => []) },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
    humanStats: { findByHumanId: vi.fn(async () => null) },
    events: {
      listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    calendars: {
      findById: vi.fn(async () => null),
      findDefaultForPlace: vi.fn(async () => calendarRows[0] ?? null),
      listByPlace: vi.fn(async () => calendarRows),
      listAvailabilityForPlace: vi.fn(async () => []),
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
    bookingStandards,
  };
  const repos = withTx(mocks);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  const reportError = vi.fn();
  const deps: CreateBookingRequestDeps = {
    repos: repos as unknown as CreateBookingRequestDeps["repos"],
    clock: { now: () => NOW },
    logger: logger as unknown as CreateBookingRequestDeps["logger"],
    reportError,
    rateLimit: (options.rateLimit ?? null) as CreateBookingRequestDeps["rateLimit"],
  };
  return { deps, mocks, repos, logger, reportError };
}

async function withItems(
  rows: {
    ownerType: "PLACE" | "CALENDAR";
    ownerId: string;
    intent?: "PERFORM" | "RENT" | "USE";
    items: BookingStandardItemInput[];
  }[],
) {
  const fake = createFakeBookingStandards();
  for (const row of rows) {
    await fake.replaceItems({ intent: "PERFORM", ...row });
  }
  return fake;
}

const MUSIC_REQUIRED: BookingStandardItemInput = {
  field: "LINK_MUSIC",
  label: "Send us a music link",
  requirement: "REQUIRED",
};

const baseInput = {
  actorHumanId: ACTOR_ID,
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
  placeId: PLACE_ID,
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-07-10"],
};

async function captured(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err as { code?: string; meta?: Record<string, unknown> },
  );
}

describe("createBookingRequest — venue booking standards (FR-006)", () => {
  it("a REQUIRED music link that is missing → STANDARDS_UNMET with the VENUE's label; nothing is written or spent", async () => {
    const rateLimit = { consume: vi.fn() };
    const { deps, mocks, repos } = buildDeps({
      bookingStandards: await withItems([
        { ownerType: "CALENDAR", ownerId: CAL_MAIN, items: [MUSIC_REQUIRED] },
      ]),
      rateLimit,
    });

    const err = await captured(
      createBookingRequest(deps, {
        ...baseInput,
        // A tagged act would spend budget — it must not get that far.
        bill: { includeSelf: true, acts: [{ kind: "tagged", humanId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" }] },
      }),
    );

    expect(err).toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "LINK_MUSIC", label: "Send us a music link" }] },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect((repos as unknown as { tx: ReturnType<typeof vi.fn> }).tx).not.toHaveBeenCalled();
    expect(mocks.entityPages.getByOwners).not.toHaveBeenCalled();
    expect(rateLimit.consume).not.toHaveBeenCalled();
  });

  it("the same pitch WITH the link passes", async () => {
    const { deps, mocks, reportError } = buildDeps({
      bookingStandards: await withItems([
        { ownerType: "CALENDAR", ownerId: CAL_MAIN, items: [MUSIC_REQUIRED] },
      ]),
    });

    await createBookingRequest(deps, {
      ...baseInput,
      linkMusic: "https://band.example/listen",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lists every unmet REQUIRED item, in the venue's display order", async () => {
    const { deps } = buildDeps({
      bookingStandards: await withItems([
        {
          ownerType: "CALENDAR",
          ownerId: CAL_MAIN,
          items: [
            { field: "EXPECTED_DRAW", label: "Your usual draw", requirement: "REQUIRED" },
            { field: "GENRE", label: "Genre", requirement: "SUGGESTED" },
            MUSIC_REQUIRED,
          ],
        },
      ]),
    });

    const err = await captured(createBookingRequest(deps, baseInput));

    expect(err.meta).toEqual({
      items: [
        { field: "EXPECTED_DRAW", label: "Your usual draw" },
        { field: "LINK_MUSIC", label: "Send us a music link" },
      ],
    });
  });

  it("SUGGESTED items never block", async () => {
    const { deps, mocks } = buildDeps({
      bookingStandards: await withItems([
        {
          ownerType: "CALENDAR",
          ownerId: CAL_MAIN,
          items: [{ ...MUSIC_REQUIRED, requirement: "SUGGESTED" }],
        },
      ]),
    });

    await createBookingRequest(deps, baseInput);

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("nothing configured (platform defaults) never blocks — the NFR-002 day-one guarantee", async () => {
    const { deps, mocks } = buildDeps();

    // No link, no draw, no set length: every platform item is unmet — and
    // every one is SUGGESTED.
    await createBookingRequest(deps, baseInput);

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  it("routes by calendar: the default inherits the place default; a named calendar with its own list uses that list", async () => {
    const bookingStandards = await withItems([
      { ownerType: "PLACE", ownerId: PLACE_ID, items: [MUSIC_REQUIRED] },
      {
        ownerType: "CALENDAR",
        ownerId: CAL_BAR,
        items: [{ field: "EXPECTED_DRAW", label: "Bar draw", requirement: "REQUIRED" }],
      },
    ]);

    const onDefault = await captured(
      createBookingRequest(buildDeps({ bookingStandards }).deps, baseInput),
    );
    expect(onDefault.meta).toEqual({
      items: [{ field: "LINK_MUSIC", label: "Send us a music link" }],
    });

    const onBar = await captured(
      createBookingRequest(buildDeps({ bookingStandards }).deps, {
        ...baseInput,
        calendarId: CAL_BAR,
        // Meets the PLACE list — irrelevant: the bar's own list wins whole.
        linkMusic: "https://band.example/listen",
      }),
    );
    expect(onBar.meta).toEqual({ items: [{ field: "EXPECTED_DRAW", label: "Bar draw" }] });
  });

  it("claimed place with NO calendar: the REQUIRED place default the options read serves as placeStandards is the one create enforces", async () => {
    const bookingStandards = await withItems([
      { ownerType: "PLACE", ownerId: PLACE_ID, items: [MUSIC_REQUIRED] },
    ]);
    const { deps, repos, mocks } = buildDeps({ bookingStandards, calendars: [] });

    const options = await getPlaceBookingOptions(
      { repos, now: () => NOW } as unknown as GetPlaceBookingOptionsDeps,
      { placeId: PLACE_ID },
    );
    expect(options.calendars).toEqual([]);
    expect(options.placeStandards.PERFORM!.standards).toEqual([
      {
        source: "place",
        field: "LINK_MUSIC",
        requirement: "REQUIRED",
        label: "Send us a music link",
        hint: null,
      },
    ]);

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "LINK_MUSIC", label: "Send us a music link" }] },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();

    await createBookingRequest(deps, { ...baseInput, linkMusic: "https://band.example/listen" });
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: null }),
    );
  });

  it("RENT: a REQUIRED headcount on the room calendar blocks a request without one", async () => {
    const { deps } = buildDeps({
      bookingStandards: await withItems([
        {
          ownerType: "CALENDAR",
          ownerId: CAL_ROOM,
          intent: "RENT",
          items: [{ field: "EXPECTED_ATTENDANCE", label: "How many people", requirement: "REQUIRED" }],
        },
      ]),
    });

    const rent = {
      actorHumanId: ACTOR_ID,
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      placeId: PLACE_ID,
      calendarId: CAL_ROOM,
      intent: "RENT",
      purpose: "Album release party",
      requestedStartsAt: "2026-07-01T18:00:00.000Z",
      requestedEndsAt: "2026-07-01T22:00:00.000Z",
    };
    await expect(createBookingRequest(deps, rent)).rejects.toMatchObject({
      code: "STANDARDS_UNMET",
      meta: { items: [{ field: "EXPECTED_ATTENDANCE", label: "How many people" }] },
    });
    await expect(
      createBookingRequest(deps, { ...rent, expectedAttendance: 80 }),
    ).resolves.toMatchObject({ bookingRequestId: expect.any(String) });
  });

  describe("BILL (D2b: ≥ 1 act on the bill besides the sender)", () => {
    const billRequired = () =>
      withItems([
        {
          ownerType: "CALENDAR",
          ownerId: CAL_MAIN,
          items: [{ field: "BILL", label: "Who else is on the bill", requirement: "REQUIRED" }],
        },
      ]);

    it("a legacy request with NO bill (the sender alone) is blocked", async () => {
      const { deps, mocks } = buildDeps({ bookingStandards: await billRequired() });

      await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
        code: "STANDARDS_UNMET",
        meta: { items: [{ field: "BILL", label: "Who else is on the bill" }] },
      });
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    });

    it("v3 L12: an EMPTY bill (no LINEUP_REQUIRED any more) is still blocked by a REQUIRED BILL", async () => {
      const { deps, mocks } = buildDeps({ bookingStandards: await billRequired() });

      await expect(
        createBookingRequest(deps, { ...baseInput, bill: { includeSelf: false, acts: [] } }),
      ).rejects.toMatchObject({
        code: "STANDARDS_UNMET",
        meta: { items: [{ field: "BILL", label: "Who else is on the bill" }] },
      });
      expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    });

    it("a bill of the sender only is blocked", async () => {
      const { deps } = buildDeps({ bookingStandards: await billRequired() });

      await expect(
        createBookingRequest(deps, { ...baseInput, bill: { includeSelf: true, acts: [] } }),
      ).rejects.toMatchObject({ code: "STANDARDS_UNMET" });
    });

    it("the sender plus one other act passes", async () => {
      const { deps, mocks } = buildDeps({ bookingStandards: await billRequired() });

      await createBookingRequest(deps, {
        ...baseInput,
        bill: { includeSelf: true, acts: [{ kind: "external", name: "The Openers" }] },
      });

      expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    });
  });

  it("an UNCLAIMED venue is refused before its standards are read (amendment 2026-09-25)", async () => {
    // A previous claimant's REQUIRED items are never consulted: the venue
    // takes no requests at all, so the refusal precedes the standards read.
    const standards = await withItems([
      { ownerType: "PLACE", ownerId: PLACE_ID, items: [MUSIC_REQUIRED] },
      { ownerType: "CALENDAR", ownerId: CAL_MAIN, items: [MUSIC_REQUIRED] },
    ]);
    const listForOwners = vi.spyOn(standards, "listForOwners");
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ verificationStatus: "UNVERIFIED", humanIdsWithAccess: [] }),
      bookingStandards: standards,
    });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_TAKING_REQUESTS",
    });
    expect(listForOwners).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  describe("degrade (the standards read throws)", () => {
    const failingRepo = () => ({
      listForOwners: vi.fn(async () => {
        throw new Error('relation "BookingStandardItem" does not exist');
      }),
      replaceItems: vi.fn(),
      replaceExamples: vi.fn(),
    });

    it("fails OPEN — the request is created — and the failure is logged + reported", async () => {
      const { deps, mocks, logger, reportError } = buildDeps({
        bookingStandards: failingRepo(),
      });

      await createBookingRequest(deps, baseInput);

      expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        "booking_standards.load_failed",
        expect.objectContaining({ placeId: PLACE_ID }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("does not exist") }),
        expect.objectContaining({ tags: { useCase: "loadEffectiveBookingStandards" } }),
      );
    });

    it("a throwing reporter does not turn the fail-open into a failure", async () => {
      const { deps, mocks } = buildDeps({ bookingStandards: failingRepo() });
      deps.reportError = vi.fn(() => {
        throw new Error("sentry down");
      });

      await createBookingRequest(deps, baseInput);

      expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    });
  });
});
