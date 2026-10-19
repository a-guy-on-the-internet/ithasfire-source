import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";

/**
 * Availability-onboarding transport wiring (docs/specs/2026-08-31):
 * - `places.getAvailabilitySetupState` — the detector's FIXED wire contract
 *   `{ configured, calendarCount, defaultCalendarId, acceptsBookingRequests }`
 *   + ctx-actor injection.
 * - the FR-003 nudge composition on `setBookingAcceptance` / `createCalendar`
 *   (ctx.notify + ctx.idempotency + ctx.publicAppUrl assembled into the hook).
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111"; // test-helpers default
const PLACE_ID = "55555555-5555-4555-8555-555555555555";
const PUBLIC_APP_URL = "https://ithasfire.test";

function buildPlaceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    name: "The Dark Room",
    slug: "the-dark-room",
    formattedAddress: "1 Main St",
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37203",
    countryCode: "US",
    capacity: null,
    lat: null,
    lng: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [ACTOR_ID],
    phone: null,
    website: null,
    listedInDirectory: false,
    acceptsBookingRequests: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildWorld(options: { seedAvailability?: boolean } = {}) {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });
  // Every calendar has ≥1 space (venue-confirmation spec): createCalendar
  // now requires `spaceIds`, so the world seeds a room to join.
  const space = spaces.seed({ placeId: PLACE_ID, name: "Main Space" });
  const calendar = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Main",
    slug: "main",
    isDefault: true,
  });
  if (options.seedAvailability) {
    calendars.seedAvailability({
      placeId: PLACE_ID,
      calendarId: null,
      dayOfWeek: 5,
      startTime: "19:00",
      endTime: "23:00",
      isOpen: true,
    });
  }

  const place = buildPlaceRecord();
  const places = {
    getById: vi.fn(async () => place),
    upsert: vi.fn(async () => place),
    // `setBookingAcceptance` writes the one column as a compare-and-set.
    setFlag: vi.fn(async () => ({ changed: true })),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const authz = {
    getOrgMemberships: vi.fn(async () => []),
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: [ACTOR_ID],
    })),
    getOrgMembership: vi.fn(async () => null),
  };
  const humans = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR_ID },
      identity: { username: "owner" },
    })),
  };
  const entityPages = { getByOwner: vi.fn(async () => null) };
  const organizations = { getById: vi.fn(async () => null) };

  const txRepos = {
    spaces,
    calendars,
    audit,
    authz,
    places,
  } as unknown as TxRepos;
  const repos = {
    spaces,
    calendars,
    audit,
    authz,
    places,
    humans,
    entityPages,
    organizations,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const notify = vi.fn(async () => ({ ok: true }));
  const idempotency = {
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  };

  return {
    repos,
    calendars,
    calendar,
    space,
    places,
    notify,
    idempotency,
  };
}

describe("places.getAvailabilitySetupState", () => {
  it("returns the FIXED wire contract for an unconfigured place", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    const result = await caller.getAvailabilitySetupState({
      placeId: PLACE_ID,
    });

    expect(result).toEqual({
      configured: false,
      calendarCount: 1,
      defaultCalendarId: w.calendar.id,
      acceptsBookingRequests: false,
    });
  });

  it("flips configured once ANY availability row exists", async () => {
    const w = buildWorld({ seedAvailability: true });
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    const result = await caller.getAvailabilitySetupState({
      placeId: PLACE_ID,
    });

    expect(result).toEqual({
      configured: true,
      calendarCount: 1,
      defaultCalendarId: w.calendar.id,
      acceptsBookingRequests: false,
    });
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one (.strict omit pattern)", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    await expect(
      caller.getAvailabilitySetupState({
        placeId: PLACE_ID,
        actorHumanId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("availability-setup nudge wiring (FR-003)", () => {
  it("setBookingAcceptance OFF→ON on an unconfigured place sends the in-app-only nudge through ctx.notify", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, {
      repos: w.repos,
      notify: w.notify as never,
      idempotency: w.idempotency as never,
      publicAppUrl: PUBLIC_APP_URL,
    });

    await caller.setBookingAcceptance({ placeId: PLACE_ID, accepts: true });

    expect(w.idempotency.begin).toHaveBeenCalledWith(
      `availability-setup:${PLACE_ID}`,
      60,
    );
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(w.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: "place.availability-setup-needed",
        idempotencyKey: `availability-setup:${PLACE_ID}`,
        payload: expect.objectContaining({
          placeId: PLACE_ID,
          placeName: "The Dark Room",
          calendarsUrl: `${PUBLIC_APP_URL}/admin/@owner/places/${PLACE_ID}/calendars`,
        }),
        channels: {
          email: { enabled: false },
          push: { enabled: false },
          sms: { enabled: false },
        },
      }),
    );
  });

  it("setBookingAcceptance on a CONFIGURED place sends nothing", async () => {
    const w = buildWorld({ seedAvailability: true });
    const { caller } = createCaller(placesRouter, {
      repos: w.repos,
      notify: w.notify as never,
      idempotency: w.idempotency as never,
      publicAppUrl: PUBLIC_APP_URL,
    });

    await caller.setBookingAcceptance({ placeId: PLACE_ID, accepts: true });

    expect(w.notify).not.toHaveBeenCalled();
    expect(w.idempotency.begin).not.toHaveBeenCalled();
  });

  it("createCalendar for an unconfigured place sends the nudge; a held claim suppresses a repeat", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, {
      repos: w.repos,
      notify: w.notify as never,
      idempotency: w.idempotency as never,
      publicAppUrl: PUBLIC_APP_URL,
    });

    await caller.createCalendar({
      placeId: PLACE_ID,
      spaceIds: [w.space.id],
      name: "Live Music",
    });
    expect(w.notify).toHaveBeenCalledTimes(1);

    // Second trigger while the durable claim is committed/held: begin refuses.
    w.idempotency.begin.mockResolvedValueOnce(false);
    await caller.createCalendar({
      placeId: PLACE_ID,
      spaceIds: [w.space.id],
      name: "Comedy",
    });
    expect(w.notify).toHaveBeenCalledTimes(1);
  });

  it("a failing nudge never fails the toggle (swallow posture over the wire)", async () => {
    const w = buildWorld();
    w.notify.mockRejectedValue(new Error("notify down"));
    const { caller } = createCaller(placesRouter, {
      repos: w.repos,
      notify: w.notify as never,
      idempotency: w.idempotency as never,
      publicAppUrl: PUBLIC_APP_URL,
    });

    await expect(
      caller.setBookingAcceptance({ placeId: PLACE_ID, accepts: true }),
    ).resolves.toMatchObject({ acceptsBookingRequests: true });
    // The claim is freed for a later retry.
    expect(w.idempotency.fail).toHaveBeenCalledWith(
      `availability-setup:${PLACE_ID}`,
      "notify down",
    );
  });
});
