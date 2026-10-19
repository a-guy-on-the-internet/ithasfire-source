import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import { saveEventForOrg } from "../save-event-for-org";

/**
 * arrival-areas FR-014 through the REAL save path: an event save that moves
 * the event to another place switches its own arrival areas off and deletes
 * its hides of the old place's areas, in the save's transaction, with audit
 * rows; a save that leaves the location alone touches nothing.
 */

const OTHER_PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_AREA = "c0c0c0c0-c0c0-4c0c-8c0c-000000000001";
const OLD_PLACE_AREA = "c0c0c0c0-c0c0-4c0c-8c0c-000000000002";

function existingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "DRAFT",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2024-01-01T18:00:00.000Z"),
    endsAt: new Date("2024-01-01T18:00:00.000Z"),
    placeId: OTHER_PLACE_ID,
    savedLocationId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agreementResaleId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    currency: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

function place(): PlaceRecord {
  return {
    id: DEFAULT_PLACE_ID,
    name: "Test Place",
    slug: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    formattedAddress: "123 Anywhere St",
    addressLine1: "123 Anywhere St",
    addressLine2: null,
    city: "Example City",
    region: "TN",
    postalCode: "37201",
    countryCode: "US",
    capacity: null,
    lat: null,
    lng: null,
    phone: null,
    website: null,
    websiteSource: "UNKNOWN",
    addressHash: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
  } as PlaceRecord;
}

/** Puts an arrival-areas fake (one live event area, one stale hide) into every save transaction. */
function withArrivalAreas(ctx: ReturnType<typeof makeCreateEventTestContext>) {
  const arrivalAreas = {
    listForEvent: vi.fn(async (eventId: string) => [
      { id: EVENT_AREA, eventId, placeId: null, disabledAt: null },
    ]),
    setDisabledForEvent: vi.fn(async () => 1),
    deleteHidesForEventNotInPlace: vi.fn(async (eventId: string) => [
      { eventId, arrivalAreaId: OLD_PLACE_AREA },
    ]),
  };
  const audit: Array<{ action: string; entityId?: string | null; data?: unknown }> = [];
  const originalTx = ctx.deps.repos.tx.bind(ctx.deps.repos);
  ctx.deps.repos.tx = (async <T>(fn: (tx: TxRepos) => Promise<T>) =>
    originalTx((tx: TxRepos) =>
      fn({
        ...tx,
        arrivalAreas: arrivalAreas as unknown as TxRepos["arrivalAreas"],
        audit: {
          ...tx.audit,
          log: async (entry: { action: string; entityId?: string | null; data?: unknown }) => {
            audit.push(entry);
            await tx.audit.log(entry as never);
          },
        } as TxRepos["audit"],
      }),
    )) as typeof ctx.deps.repos.tx;
  return { arrivalAreas, audit };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  eventId: DEFAULT_EVENT_ID,
  actorHumanId: DEFAULT_ACTOR_ID,
  orgId: DEFAULT_ORG_ID,
  title: "My Event",
  startsAt: "2024-02-01T18:00:00.000Z",
  endsAt: "2024-02-01T19:00:00.000Z",
  location: { placeId: DEFAULT_PLACE_ID },
  clientKey: "idem-key-arrival-areas",
  ...overrides,
});

describe("event save → arrival areas (FR-014)", () => {
  it("moving the event to another place switches its areas off and drops stale hides, audited", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: existingEvent({ placeId: OTHER_PLACE_ID }),
      place: place(),
    });
    const { arrivalAreas, audit } = withArrivalAreas(ctx);

    await expect(saveEventForOrg(ctx.deps, input())).resolves.toMatchObject({
      eventId: DEFAULT_EVENT_ID,
    });

    expect(arrivalAreas.setDisabledForEvent).toHaveBeenCalledWith(
      DEFAULT_EVENT_ID,
      ctx.defaults.now,
    );
    expect(arrivalAreas.deleteHidesForEventNotInPlace).toHaveBeenCalledWith(
      DEFAULT_EVENT_ID,
      DEFAULT_PLACE_ID,
    );
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("arrival_areas.disabled_for_location_change");
    expect(actions).toContain("arrival_area_hides.removed_for_location_change");
    expect(
      audit.find((a) => a.action === "arrival_areas.disabled_for_location_change")?.data,
    ).toMatchObject({
      actorHumanId: DEFAULT_ACTOR_ID,
      arrivalAreaIds: [EVENT_AREA],
      from: { placeId: OTHER_PLACE_ID },
      to: { placeId: DEFAULT_PLACE_ID },
    });
  });

  it("a save that keeps the place touches no area and writes no area audit row", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: existingEvent({ placeId: DEFAULT_PLACE_ID }),
      place: place(),
    });
    const { arrivalAreas, audit } = withArrivalAreas(ctx);

    await saveEventForOrg(ctx.deps, input({ title: "Renamed" }));

    expect(arrivalAreas.listForEvent).not.toHaveBeenCalled();
    expect(arrivalAreas.setDisabledForEvent).not.toHaveBeenCalled();
    expect(arrivalAreas.deleteHidesForEventNotInPlace).not.toHaveBeenCalled();
    expect(audit.some((a) => a.action.startsWith("arrival_area"))).toBe(false);
  });
});
