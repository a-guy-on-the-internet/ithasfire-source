import { describe, expect, it, vi } from "vitest";

import { getAvailabilitySetupState } from "../get-availability-setup-state";
import type { GetAvailabilitySetupStateDeps } from "../get-availability-setup-state";
import type { OrgMembership } from "@th/ports/repos/authz";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_CALENDAR_ID = "44444444-4444-4444-8444-444444444444";

type BuildOptions = {
  place?: Record<string, unknown> | null;
  membership?: OrgMembership | null;
  availabilityRowCount?: number;
  calendarCount?: number;
  defaultCalendar?: { id: string } | null;
  acceptsBookingRequests?: boolean;
};

function buildDeps(options: BuildOptions = {}) {
  const place =
    options.place === undefined
      ? {
          id: PLACE_ID,
          humanIdsWithAccess: [ACTOR_ID],
          orgIdsWithAccess: [],
          acceptsBookingRequests: options.acceptsBookingRequests ?? false,
        }
      : options.place;

  const places = { getById: vi.fn(async () => place) };
  const authz = {
    getOrgMemberships: vi.fn(async () =>
      options.membership ? [options.membership] : [],
    ),
  };
  const calendars = {
    countAvailabilityForPlace: vi.fn(
      async () => options.availabilityRowCount ?? 0,
    ),
    countForPlace: vi.fn(async () => options.calendarCount ?? 0),
    findDefaultForPlace: vi.fn(
      async () =>
        (options.defaultCalendar === undefined
          ? null
          : options.defaultCalendar) as { id: string } | null,
    ),
  };

  const deps = {
    repos: { places, authz, calendars },
  } as unknown as GetAvailabilitySetupStateDeps;

  return { deps, mocks: { places, authz, calendars } };
}

const baseInput = { actorHumanId: ACTOR_ID, placeId: PLACE_ID };

describe("getAvailabilitySetupState", () => {
  it("reports UNCONFIGURED for a place with zero availability rows", async () => {
    const { deps } = buildDeps({ availabilityRowCount: 0, calendarCount: 0 });

    await expect(getAvailabilitySetupState(deps, baseInput)).resolves.toEqual({
      configured: false,
      calendarCount: 0,
      defaultCalendarId: null,
      acceptsBookingRequests: false,
    });
  });

  it("reports CONFIGURED for a place with place-wide rows (calendarId null counts)", async () => {
    // Place-wide rows have no calendarId, so calendarCount can legitimately
    // be 0 while the place is configured — the detector must not conflate
    // "has calendars" with "has hours".
    const { deps } = buildDeps({ availabilityRowCount: 2, calendarCount: 0 });

    await expect(getAvailabilitySetupState(deps, baseInput)).resolves.toEqual({
      configured: true,
      calendarCount: 0,
      defaultCalendarId: null,
      acceptsBookingRequests: false,
    });
  });

  it("reports CONFIGURED for per-calendar rows and surfaces the default calendar id", async () => {
    const { deps, mocks } = buildDeps({
      availabilityRowCount: 1,
      calendarCount: 3,
      defaultCalendar: { id: DEFAULT_CALENDAR_ID },
    });

    await expect(getAvailabilitySetupState(deps, baseInput)).resolves.toEqual({
      configured: true,
      calendarCount: 3,
      defaultCalendarId: DEFAULT_CALENDAR_ID,
      acceptsBookingRequests: false,
    });
    expect(mocks.calendars.countAvailabilityForPlace).toHaveBeenCalledWith(
      PLACE_ID,
    );
  });

  it("calendars-but-no-rows is still UNCONFIGURED (a calendar programs nothing by itself)", async () => {
    const { deps } = buildDeps({
      availabilityRowCount: 0,
      calendarCount: 2,
      defaultCalendar: { id: DEFAULT_CALENDAR_ID },
    });

    await expect(getAvailabilitySetupState(deps, baseInput)).resolves.toEqual({
      configured: false,
      calendarCount: 2,
      defaultCalendarId: DEFAULT_CALENDAR_ID,
      acceptsBookingRequests: false,
    });
  });

  it("carries the RAW toggle: accepting-but-unconfigured reads { configured: false, acceptsBookingRequests: true }", async () => {
    // The FR-004 banner's trigger is exactly this pair — one read, no
    // per-venue getPlaceForEdit fan-out.
    const { deps } = buildDeps({
      availabilityRowCount: 0,
      acceptsBookingRequests: true,
    });

    await expect(getAvailabilitySetupState(deps, baseInput)).resolves.toEqual({
      configured: false,
      calendarCount: 0,
      defaultCalendarId: null,
      acceptsBookingRequests: true,
    });
  });

  it("a non-accepting place reads acceptsBookingRequests: false", async () => {
    const { deps } = buildDeps({
      availabilityRowCount: 0,
      acceptsBookingRequests: false,
    });

    await expect(
      getAvailabilitySetupState(deps, baseInput),
    ).resolves.toMatchObject({ acceptsBookingRequests: false });
  });

  it("allows an owning-org member (same gate as setPlaceBookingAcceptance)", async () => {
    const { deps } = buildDeps({
      place: {
        id: PLACE_ID,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      },
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
      availabilityRowCount: 1,
    });

    await expect(getAvailabilitySetupState(deps, baseInput)).resolves.toMatchObject(
      { configured: true },
    );
  });

  it("rejects a non-owner with NOT_RESOURCE_OWNER before any calendar read", async () => {
    const { deps, mocks } = buildDeps({
      place: {
        id: PLACE_ID,
        humanIdsWithAccess: ["99999999-9999-4999-8999-999999999999"],
        orgIdsWithAccess: [],
      },
      membership: null,
    });

    await expect(
      getAvailabilitySetupState(deps, baseInput),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.calendars.countAvailabilityForPlace).not.toHaveBeenCalled();
  });

  it("throws PLACE_NOT_FOUND for a missing place", async () => {
    const { deps } = buildDeps({ place: null });

    await expect(
      getAvailabilitySetupState(deps, baseInput),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });
});
