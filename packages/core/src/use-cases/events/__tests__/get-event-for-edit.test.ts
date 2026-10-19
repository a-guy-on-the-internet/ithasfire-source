import { describe, expect, it, vi } from "vitest";

import {
  getEventForEdit,
  getEventForEditOutputSchema,
} from "../get-event-for-edit";
import type { GetEventForEditDeps } from "../get-event-for-edit";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { CategoryRecord } from "@th/ports/repos/categories";

const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const CATEGORY_ID = "44444444-4444-4444-8444-444444444444";
const CALENDAR_ID = "66666666-6666-4666-8666-666666666666";
const SPACE_ID = "77777777-7777-4777-8777-777777777777";

function makeCategory(overrides: Partial<CategoryRecord> = {}): CategoryRecord {
  return {
    id: CATEGORY_ID,
    slug: "music",
    name: "Music",
    active: true,
    sortOrder: 1,
    seoType: "MusicEvent",
    nameTranslations: {},
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    title: "Test Event",
    stewardship: "OWNED",
    status: "DRAFT",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2024-06-01T18:00:00Z"),
    endsAt: new Date("2024-06-01T22:00:00Z"),
    addressText: "123 Main St",
    lat: 40.7128,
    lng: -74.006,
    heroImageUrl: null,
    slug: null,
    shortId: null,
    publishedAt: null,
    orgId: ORG_ID,
    humanId: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    regionCode: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    defaultLocale: null,
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED" as const,
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    waiverTemplateId: null,
    currency: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Venue",
    slug: "the-venue",
    formattedAddress: "456 Venue Ave, NYC",
    addressLine1: "456 Venue Ave",
    addressLine2: null,
    city: "New York",
    region: "NY",
    postalCode: "10001",
    countryCode: "US",
    capacity: 200,
    lat: 40.75,
    lng: -73.99,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    // A venue that publishes its address. EXPLICIT because
    // `redactPlaceLocation` fails closed: a fake that omits this withholds.
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    event?: EventRecord | null;
    place?: PlaceRecord | null;
    membership?: OrgMembership | null;
    /**
     * Org memberships resolved for the PLACE's owner orgs — the address-privacy
     * gate. `[]` = the actor owns none of them, so a withheld venue's address
     * is redacted out of the builder.
     */
    placeOrgMemberships?: OrgMembership[];
    /**
     * The D5 manage bar. Defaults to what the real `canManagePlace` answers
     * for `placeOrgMemberships`: allowed iff one of them is OWNER/ADMIN/EDITOR.
     */
    canManagePlace?: boolean;
    category?: CategoryRecord | null;
  } = {},
): GetEventForEditDeps {
  const hasEventOverride = Object.prototype.hasOwnProperty.call(
    overrides,
    "event",
  );
  const event = hasEventOverride ? (overrides.event ?? null) : makeEvent();
  const place = overrides.place !== undefined ? overrides.place : null;
  const category =
    overrides.category !== undefined ? overrides.category : null;

  return {
    repos: {
      events: {
        getById: vi.fn(async () => event),
        getContent: vi.fn(async () => null),
        getPopularityStats: vi.fn(async () => [
          {
            eventId: event?.id ?? EVENT_ID,
            ticketsSold: 0,
            waitlistCount: 0,
            totalCapacity: 100,
          },
        ]),
      },
      places: {
        getById: vi.fn(async (id: string) =>
          place && place.id === id ? place : null,
        ),
      },
      categories: {
        getById: vi.fn(async (id: string) =>
          category && category.id === id ? category : null,
        ),
      },
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi.fn(async () =>
          overrides.membership !== undefined
            ? overrides.membership
            : { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" as const },
        ),
        // Address privacy: only a VERIFIED owner of the venue (directly, or
        // through an org they belong to) sees its real address in the builder.
        getOrgMemberships: vi.fn(async ({ orgIds }: { orgIds: string[] }) =>
          overrides.placeOrgMemberships !== undefined
            ? overrides.placeOrgMemberships
            : orgIds.map((orgId) => ({
                orgId,
                humanId: ACTOR_ID,
                role: "ADMIN" as const,
              })),
        ),
      },
      seriesOccurrences: {
        getCalendarInfoForEventIds: vi.fn().mockResolvedValue([]),
      },
    } as unknown as GetEventForEditDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
      canManagePlace: vi.fn(async () => ({
        allowed:
          overrides.canManagePlace ??
          (
            overrides.placeOrgMemberships ?? [
              { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" as const },
            ]
          ).some((m) => ["OWNER", "ADMIN", "EDITOR"].includes(m.role)),
      })),
    },
  };
}

describe("getEventForEdit", () => {
  it("returns placeId=null and place=null when event has no place", async () => {
    const deps = makeDeps({ event: makeEvent({ placeId: null }) });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.placeId).toBeNull();
    expect(result.place).toBeNull();
  });

  it("returns place summary when event is linked to a place", async () => {
    const place = makePlace();
    const deps = makeDeps({
      event: makeEvent({ placeId: PLACE_ID }),
      place,
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.placeId).toBe(PLACE_ID);
    expect(result.place).toEqual({
      id: PLACE_ID,
      name: "The Venue",
      formattedAddress: "456 Venue Ave, NYC",
      city: "New York",
      region: "NY",
      lat: 40.75,
      lng: -73.99,
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
    });
  });

  it("round-trips the real verification status for a VERIFIED place", async () => {
    const place = makePlace({
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      city: "Nashville",
      region: "TN",
    });
    const deps = makeDeps({
      event: makeEvent({ placeId: PLACE_ID }),
      place,
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    // Regression: the summary DTO used to drop verificationStatus, so the
    // frontend hardcoded "UNVERIFIED" and showed a false "verify this place"
    // banner even for verified places. It must now round-trip the real value.
    expect(result.place?.verificationStatus).toBe("VERIFIED");
    expect(result.place?.status).toBe("ACTIVE");
    expect(result.place?.city).toBe("Nashville");
    expect(result.place?.region).toBe("TN");
  });

  it("returns place=null when event references a deleted place", async () => {
    const deps = makeDeps({
      event: makeEvent({ placeId: PLACE_ID }),
      place: null,
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.placeId).toBe(PLACE_ID);
    expect(result.place).toBeNull();
  });

  it("throws not_found for missing event", async () => {
    const deps = makeDeps({ event: null });

    await expect(
      getEventForEdit(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden for human-owned event if actor doesn't match", async () => {
    const deps = makeDeps({
      event: makeEvent({ orgId: null, humanId: "other-human-id" }),
      membership: null,
    });

    await expect(
      getEventForEdit(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // Owner ruling 2026-09-28: an edit-role delegate opens the builder on the
  // principal's personal event.
  describe("a delegate of the human owner", () => {
    const PRINCIPAL_ID = "99999999-9999-4999-8999-999999999999";
    const delegateDeps = (role: string | null) => {
      const deps = makeDeps({
        event: makeEvent({ orgId: null, humanId: PRINCIPAL_ID }),
        membership: null,
      });
      vi.mocked(deps.repos.authz.getHumanDelegation).mockResolvedValue(
        role
          ? ({ orgId: PRINCIPAL_ID, humanId: ACTOR_ID, role } as never)
          : null,
      );
      return deps;
    };

    it.each(["OWNER", "ADMIN", "EDITOR"])(
      "a %s delegate hydrates the builder, and the owner reads back as the principal",
      async (role) => {
        const deps = delegateDeps(role);
        await expect(
          getEventForEdit(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
        ).resolves.toMatchObject({ id: EVENT_ID, humanId: PRINCIPAL_ID });
        expect(deps.repos.authz.getHumanDelegation).toHaveBeenCalledWith({
          principalId: PRINCIPAL_ID,
          delegateId: ACTOR_ID,
        });
      },
    );

    it.each([["VIEWER"], ["FINANCE"], ["SCANNER"]])(
      "a %s delegate is refused NOT_RESOURCE_OWNER",
      async (role) => {
        await expect(
          getEventForEdit(delegateDeps(role), {
            actorHumanId: ACTOR_ID,
            eventId: EVENT_ID,
          }),
        ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      },
    );
  });

  it("returns all standard fields", async () => {
    const deps = makeDeps({
      event: makeEvent({
        title: "My Concert",
        status: "PUBLISHED",
        visibility: "PRIVATE",
        gateType: "APPLICATION",
        slug: "my-concert",
        shortId: "abc123",
        publishedAt: new Date("2024-02-15"),
      }),
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.title).toBe("My Concert");
    expect(result.status).toBe("PUBLISHED");
    expect(result.visibility).toBe("PRIVATE");
    expect(result.gateType).toBe("APPLICATION");
    expect(result.slug).toBe("my-concert");
    expect(result.shortId).toBe("abc123");
    expect(result.publishedAt).toEqual(new Date("2024-02-15"));
    expect(result.orgId).toBe(ORG_ID);
    expect(result.humanId).toBeNull();
    expect(result.addressText).toBe("123 Main St");
    expect(result.lat).toBe(40.7128);
    expect(result.lng).toBe(-74.006);
  });

  it("returns the joined category summary for an active category", async () => {
    const deps = makeDeps({
      event: makeEvent({ categoryId: CATEGORY_ID }),
      category: makeCategory(),
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.categoryId).toBe(CATEGORY_ID);
    expect(result.category).toEqual({
      id: CATEGORY_ID,
      slug: "music",
      name: "Music",
      names: { en: "Music" },
      active: true,
    });
  });

  it("still returns the category summary when the category is INACTIVE (deactivated)", async () => {
    // Regression: `categories.list` only exposes active categories, so the
    // event builder had no source for a deactivated category's name and the
    // Category field hydrated blank. getEventForEdit must resolve the join
    // includes-inactive.
    const deps = makeDeps({
      event: makeEvent({ categoryId: CATEGORY_ID }),
      category: makeCategory({
        active: false,
        slug: "vaudeville",
        name: "Vaudeville",
      }),
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.category).toEqual({
      id: CATEGORY_ID,
      slug: "vaudeville",
      name: "Vaudeville",
      names: { en: "Vaudeville" },
      active: false,
    });
  });

  it("carries every name of an INACTIVE category, so the editor can show it in the organiser's language", async () => {
    // `categories.list` holds only active rows, so for a deactivated category
    // this summary is the editor's only source of its translated names.
    const deps = makeDeps({
      event: makeEvent({ categoryId: CATEGORY_ID }),
      category: makeCategory({
        active: false,
        nameTranslations: { es: "Música" },
      }),
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.category).toEqual({
      id: CATEGORY_ID,
      slug: "music",
      name: "Music",
      names: { en: "Music", es: "Música" },
      active: false,
    });
    // The output schema (what the tRPC procedure validates against) keeps it.
    expect(getEventForEditOutputSchema.parse(result).category?.names).toEqual({
      en: "Music",
      es: "Música",
    });
  });

  it("returns category=null when the event has no category", async () => {
    const deps = makeDeps({ event: makeEvent({ categoryId: null }) });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.categoryId).toBeNull();
    expect(result.category).toBeNull();
  });

  it("returns category=null when the event references a hard-deleted category", async () => {
    const deps = makeDeps({
      event: makeEvent({ categoryId: CATEGORY_ID }),
      category: null,
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.categoryId).toBe(CATEGORY_ID);
    expect(result.category).toBeNull();
  });

  it("returns the stored calendarId + spaceId so the editor can hydrate placement", async () => {
    // Regression: the read used to omit venue placement, so the builder fell
    // back to derived defaults and a touch-the-calendar re-save rewrote
    // `spaceId` to null. The stored values must round-trip verbatim.
    const deps = makeDeps({
      event: makeEvent({
        placeId: PLACE_ID,
        calendarId: CALENDAR_ID,
        spaceId: SPACE_ID,
      }),
      place: makePlace(),
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.calendarId).toBe(CALENDAR_ID);
    expect(result.spaceId).toBe(SPACE_ID);
  });

  it("returns calendarId=null and spaceId=null when the event has no placement", async () => {
    // Both explicit-null (freeform address) and absent-from-record
    // (pre-hierarchy projection) must read as null, never undefined — the
    // output schema is required-nullable.
    const explicit = makeDeps({
      event: makeEvent({ calendarId: null, spaceId: null }),
    });
    const explicitResult = await getEventForEdit(explicit, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });
    expect(explicitResult.calendarId).toBeNull();
    expect(explicitResult.spaceId).toBeNull();

    const absent = makeDeps({ event: makeEvent() });
    const absentResult = await getEventForEdit(absent, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });
    expect(absentResult.calendarId).toBeNull();
    expect(absentResult.spaceId).toBeNull();
    expect("calendarId" in absentResult).toBe(true);
    expect("spaceId" in absentResult).toBe(true);
  });

  it("returns the direct human owner for human-owned events", async () => {
    const deps = makeDeps({
      event: makeEvent({ orgId: null, humanId: ACTOR_ID }),
      membership: null,
    });

    const result = await getEventForEdit(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.orgId).toBeNull();
    expect(result.humanId).toBe(ACTOR_ID);
  });
});

// ── Address privacy in the builder (place-address-withholding) ──────────────
//
// Editing an event AT a venue does not entitle the organizer to that venue's
// address. A performer booked into somebody's house is exactly the person the
// feature hides it from, and the builder is a surface they legitimately reach.
describe("getEventForEdit — the venue's address", () => {
  const WITHHELD = () =>
    makePlace({
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      locationLabel: "Midtown",
    });

  it("withholds a non-owned venue's street address and pin", async () => {
    const deps = makeDeps({
      event: makeEvent({ placeId: PLACE_ID }),
      place: WITHHELD(),
      // The actor belongs to none of the PLACE's owner orgs.
      placeOrgMemberships: [],
    });

    const result = await getEventForEdit(deps, {
      eventId: EVENT_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result.place).toMatchObject({
      id: PLACE_ID,
      // The SELECTION still restores — that is all the builder needs the row
      // for, and it is keyed on the id.
      name: "The Venue",
      formattedAddress: null,
      lat: null,
      lng: null,
    });
    expect(JSON.stringify(result.place)).not.toContain("456 Venue Ave");
  });

  it("shows the venue's OWNER the real address", async () => {
    const deps = makeDeps({
      event: makeEvent({ placeId: PLACE_ID }),
      place: WITHHELD(),
    });

    const result = await getEventForEdit(deps, {
      eventId: EVENT_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result.place).toMatchObject({
      formattedAddress: "456 Venue Ave, NYC",
      lat: 40.75,
    });
  });

  it("changes NOTHING for a venue that publishes its address", async () => {
    const deps = makeDeps({
      event: makeEvent({ placeId: PLACE_ID }),
      place: makePlace(),
      placeOrgMemberships: [],
    });

    const result = await getEventForEdit(deps, {
      eventId: EVENT_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result.place).toMatchObject({
      formattedAddress: "456 Venue Ave, NYC",
      lat: 40.75,
    });
  });
});
