import { describe, expect, it, vi } from "vitest";

import { saveEventForOrg } from "../save-event-for-org";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  DEFAULT_SAVED_LOCATION_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EventRecord } from "@th/ports/repos/events";

const makeDeps = makeCreateEventTestContext;

type OrgInputOverrides = Partial<
  Record<
    "actorHumanId" | "orgId" | "title" | "clientKey" | "eventId",
    string
  > & {
    startsAt?: string;
    endsAt?: string;
    location?: Record<string, unknown>;
  }
>;

function makeOrgInput(overrides: OrgInputOverrides = {}) {
  return {
    eventId: overrides.eventId,
    actorHumanId: overrides.actorHumanId ?? DEFAULT_ACTOR_ID,
    orgId: overrides.orgId ?? DEFAULT_ORG_ID,
    title: overrides.title ?? "My Event",
    startsAt: overrides.startsAt ?? "2024-02-01T18:00:00.000Z",
    endsAt: overrides.endsAt ?? "2024-02-01T19:00:00.000Z",
    location: overrides.location ?? {},
    clientKey: overrides.clientKey ?? "idem-key-1234",
  };
}

const OTHER_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeExistingOrgEvent(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  const base: EventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "PUBLISHED",
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
    placeId: DEFAULT_PLACE_ID,
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
  };
  return Object.assign(base, overrides);
}

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  const base: PlaceRecord = {
    id: DEFAULT_PLACE_ID,
    name: "Test Venue",
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
  };
  return Object.assign(base, overrides);
}

describe("saveEventForOrg", () => {
  it("creates a draft event with place location", async () => {
    const { deps, mocks, defaults } = makeDeps();

    const input = makeOrgInput({
      title: "  Opening Night  ",
      location: { placeId: DEFAULT_PLACE_ID },
    });

    const result = await saveEventForOrg(deps, input);

    expect(result).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });

    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
    const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(draftArg).toMatchObject({
      orgId: defaults.orgId,
      humanId: null,
      title: "Opening Night",
      status: "DRAFT",
      location: { kind: "place", placeId: DEFAULT_PLACE_ID },
      createdAt: defaults.now,
    });

    expect(mocks.savedLocations.incrementUsage).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: defaults.eventId,
      action: "created",
      data: { orgId: defaults.orgId, title: "Opening Night" },
      at: defaults.now,
    });
  });

  it("increments saved location usage when provided", async () => {
    const { deps, mocks, defaults } = makeDeps();

    const input = makeOrgInput({
      location: { savedLocationId: DEFAULT_SAVED_LOCATION_ID },
    });

    const result = await saveEventForOrg(deps, input);
    expect(result).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });

    expect(mocks.savedLocations.incrementUsage).toHaveBeenCalledWith(
      DEFAULT_SAVED_LOCATION_ID,
    );
    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0].location,
    ).toEqual({
      kind: "saved-location",
      savedLocationId: DEFAULT_SAVED_LOCATION_ID,
    });
  });

  it("supports freeform location", async () => {
    const { deps, mocks } = makeDeps();

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({
        location: { addressText: "123 Main St", lat: 40.0, lng: -70.0 },
      }),
    );

    expect(result.status).toBe("DRAFT");
    const call = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(call.location).toEqual({
      kind: "freeform",
      addressText: "123 Main St",
      lat: 40,
      lng: -70,
      locality: null,
      region: null,
      countryCode: null,
      postalCode: null,
    });
  });

  it("allows no location to be provided", async () => {
    const { deps, mocks } = makeDeps();
    await saveEventForOrg(deps, makeOrgInput({ location: {} }));
    expect(
      vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0].location,
    ).toEqual({ kind: "none" });
  });

  it("rejects actors without sufficient role", async () => {
    const { deps } = makeDeps({ membershipRole: "VIEWER" });

    await expect(saveEventForOrg(deps, makeOrgInput())).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when endsAt is before startsAt", async () => {
    const { deps } = makeDeps();

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({
          startsAt: "2024-02-01T18:00:00.000Z",
          endsAt: "2024-02-01T17:00:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("allows owners to use their own unverified places", async () => {
    const unverifiedPlace = makePlace({
      verificationStatus: "UNVERIFIED",
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps } = makeDeps({ place: unverifiedPlace });

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );
    expect(result).toMatchObject({ status: "DRAFT" });
  });

  it("rejects suspended places even for owners", async () => {
    const suspendedPlace = makePlace({
      status: "SUSPENDED",
      humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    });
    const { deps } = makeDeps({ place: suspendedPlace });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      ),
    ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
  });

  it("replays the same result for identical idempotency requests", async () => {
    const { deps, mocks, defaults } = makeDeps();

    const input = makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } });

    const first = await saveEventForOrg(deps, input);
    const second = await saveEventForOrg(deps, input);

    expect(first).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });
    expect(second).toEqual(first);

    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
    // Two entries per create — "created" plus "event.slug_assigned" (a draft
    // is slugged at birth now) — but ONE of each: the replay must not re-enter
    // the transaction. Counting the "created" entries is the assertion that
    // actually says that; a bare total would move with every future audit line.
    const createdEntries = vi
      .mocked(mocks.audit.log)
      .mock.calls.filter(([entry]) => entry.action === "created");
    expect(createdEntries).toHaveLength(1);
    expect(mocks.idempotency.__mocks.get).toHaveBeenCalled();
  });

  it("throws conflict when idempotency key reused with different payload", async () => {
    const { deps } = makeDeps();

    await saveEventForOrg(deps, makeOrgInput({ title: "Original" }));

    await expect(
      saveEventForOrg(deps, makeOrgInput({ title: "Modified" })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("returns transient when idempotency lock is held", async () => {
    const { deps } = makeDeps({ idempotencyBeginSequence: [false] });

    await expect(saveEventForOrg(deps, makeOrgInput())).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
  });

  it("updates an existing draft event for an org", async () => {
    const existingEvent = makeExistingOrgEvent({
      status: "DRAFT",
      placeId: null,
      savedLocationId: DEFAULT_SAVED_LOCATION_ID,
    });
    const { deps, mocks, defaults } = makeDeps({ existingEvent });

    const input = makeOrgInput({
      eventId: DEFAULT_EVENT_ID,
      title: "Updated Title",
      location: { savedLocationId: DEFAULT_SAVED_LOCATION_ID },
    });

    const result = await saveEventForOrg(deps, input);

    expect(result).toEqual({ eventId: DEFAULT_EVENT_ID, status: "DRAFT", bookingRequest: null });
    expect(mocks.events.getById).toHaveBeenCalledWith(DEFAULT_EVENT_ID);
    const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(draftArg.createdAt).toBeUndefined();
    expect(draftArg).toMatchObject({
      eventId: DEFAULT_EVENT_ID,
      title: "Updated Title",
    });
    expect(mocks.savedLocations.incrementUsage).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: DEFAULT_EVENT_ID,
      action: "updated",
      data: { orgId: defaults.orgId, title: "Updated Title" },
      at: defaults.now,
    });
  });

  it("throws not_found when updating a missing org draft", async () => {
    const { deps } = makeDeps({ existingEvent: null });

    await expect(
      saveEventForOrg(deps, makeOrgInput({ eventId: DEFAULT_EVENT_ID })),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects updates for non-editable org events (e.g. CANCELLED)", async () => {
    const existingEvent = makeExistingOrgEvent({
      status: "CANCELLED",
      placeId: null,
    });
    const { deps } = makeDeps({ existingEvent });

    await expect(
      saveEventForOrg(deps, makeOrgInput({ eventId: DEFAULT_EVENT_ID })),
    ).rejects.toMatchObject({ code: "EVENT_NOT_EDITABLE" });
  });

  describe("place validation on existing events", () => {
    it("surfaces NOT_RESOURCE_OWNER (not PLACE_NOT_FOUND) when editing another org's event with its place", async () => {
      // Event owned by another org, at a place accessible only to that org.
      // Acting as DEFAULT_ORG_ID: event ownership must be checked first so
      // the truthful error surfaces instead of a masking PLACE_NOT_FOUND.
      const { deps } = makeDeps({
        existingEvent: makeExistingOrgEvent({ orgId: OTHER_ORG_ID }),
        place: makePlace({ orgIdsWithAccess: [OTHER_ORG_ID] }),
      });

      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });

    it("skips place re-validation when placeId is unchanged on an existing event", async () => {
      // The place is already attached: even if it is not accessible to the
      // acting scope (or has since been suspended), an unchanged-place edit
      // must succeed.
      const { deps, mocks } = makeDeps({
        existingEvent: makeExistingOrgEvent(),
        place: makePlace({ orgIdsWithAccess: [OTHER_ORG_ID], status: "SUSPENDED" }),
      });

      const result = await saveEventForOrg(
        deps,
        makeOrgInput({
          eventId: DEFAULT_EVENT_ID,
          title: "Legit Edit",
          location: { placeId: DEFAULT_PLACE_ID },
        }),
      );

      // Succeeding at all proves the accessibility check was skipped — the
      // configured place would fail both the access and the ACTIVE check.
      // (places.getById may still be read by the tax-stamp path, so we do not
      // assert on call counts.)
      expect(result).toMatchObject({ eventId: DEFAULT_EVENT_ID });
      expect(vi.mocked(mocks.events.upsertDraft)).toHaveBeenCalledTimes(1);
    });

    it("attaches a CHANGED placeId the acting org does not own as a THIRD PARTY (venue-confirmation spec: address-only until the venue confirms)", async () => {
      const { deps, mocks } = makeDeps({
        existingEvent: makeExistingOrgEvent({ placeId: OTHER_PLACE_ID }),
        place: makePlace({ orgIdsWithAccess: [OTHER_ORG_ID] }),
      });

      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).resolves.toMatchObject({ eventId: DEFAULT_EVENT_ID });
      expect(vi.mocked(mocks.events.upsertDraft)).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { kind: "place", placeId: DEFAULT_PLACE_ID },
        }),
      );
    });

    it("a CHANGED placeId that does not exist is still PLACE_NOT_FOUND (owner or not)", async () => {
      const { deps } = makeDeps({
        existingEvent: makeExistingOrgEvent({ placeId: OTHER_PLACE_ID }),
        place: null,
      });

      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    });

    it("still rejects a CHANGED placeId when the place is not active", async () => {
      const { deps } = makeDeps({
        existingEvent: makeExistingOrgEvent({ placeId: OTHER_PLACE_ID }),
        place: makePlace({ status: "SUSPENDED" }),
      });

      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    });

    it("validates a placeId newly set on an event that previously had none", async () => {
      // null → set must never count as "unchanged" — guards against a
      // truthiness rewrite of the equality creating a silent bypass. A
      // third party may attach an ACTIVE place; a suspended one is refused.
      const { deps } = makeDeps({
        existingEvent: makeExistingOrgEvent({ placeId: null }),
        place: makePlace({ orgIdsWithAccess: [OTHER_ORG_ID], status: "SUSPENDED" }),
      });

      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    });

    it("creates a NEW event at a place the org does not own (third party), and still refuses a suspended one", async () => {
      const { deps } = makeDeps({
        place: makePlace({ orgIdsWithAccess: [OTHER_ORG_ID] }),
      });
      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
        ),
      ).resolves.toMatchObject({ status: "DRAFT" });

      const suspended = makeDeps({
        place: makePlace({ orgIdsWithAccess: [OTHER_ORG_ID], status: "SUSPENDED" }),
      });
      await expect(
        saveEventForOrg(
          suspended.deps,
          makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
        ),
      ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    });
  });

  // ---------------------------------------------------------------------
  // Slug at CREATE
  // ---------------------------------------------------------------------
  describe("slug at create", () => {
    it("assigns a slug when the location resolves a country code", async () => {
      const { deps, mocks, defaults } = makeDeps();

      await saveEventForOrg(
        deps,
        makeOrgInput({
          title: "Opening Night",
          location: { placeId: DEFAULT_PLACE_ID },
        }),
      );

      expect(mocks.events.assignSlug).toHaveBeenCalledTimes(1);
      const assigned = vi.mocked(mocks.events.assignSlug).mock.calls[0]![0];
      expect(assigned).toMatchObject({
        eventId: defaults.eventId,
        assignedAt: defaults.now,
      });
      // host / country / region / title-date--shortId
      expect(assigned.slug).toMatch(
        /^org\/us\/city\/opening-night-2024-02-01-1200--[a-z0-9]{10}$/,
      );
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "event.slug_assigned" }),
      );
    });

    it("assigns the slug AFTER the create transaction has committed", async () => {
      // The ordering IS the fix. While this ran inside the save transaction, a
      // failed slug write aborted that transaction — and Postgres answers the
      // subsequent COMMIT with ROLLBACK and NO error, which Prisma does not
      // surface. So `repos.tx()` resolved, `saveEventForOrg` returned an
      // eventId for a row that was never written, and the idempotency record
      // cached that response for 120 seconds. There was an ownership asymmetry
      // nobody chose, too: for HUMAN-owned events the slug write was the LAST
      // statement in the tx so the loss was silent, while ORG-owned events ran
      // `incrementResourceUsage` after it and blew up loudly instead.
      const { deps, mocks } = makeDeps();

      await saveEventForOrg(
        deps,
        makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      );

      const commitOrder =
        mocks.idempotency.__mocks.commit.mock.invocationCallOrder[0]!;
      const assignOrder = vi.mocked(mocks.events.assignSlug).mock
        .invocationCallOrder[0]!;
      const draftOrder = vi.mocked(mocks.events.upsertDraft).mock
        .invocationCallOrder[0]!;

      expect(draftOrder).toBeLessThan(commitOrder);
      expect(assignOrder).toBeGreaterThan(commitOrder);
    });

    it("does NOT write an EventSlugHistory row at create", async () => {
      // History means SUPERSEDED slugs only — and the column is globally
      // unique, so a row for the current slug breaks the first later
      // `regenerateEventSlug` on P2002.
      const { deps, mocks } = makeDeps();

      await saveEventForOrg(
        deps,
        makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      );

      expect(mocks.events.recordSlugHistory).not.toHaveBeenCalled();
    });

    it("creates the event ANYWAY, slugless, when no country code resolves", async () => {
      // Location is optional at create, and even a linked Place may have no
      // country. The create must not fail for the want of a pretty URL.
      const { deps, mocks, defaults } = makeDeps();

      const result = await saveEventForOrg(deps, makeOrgInput({ location: {} }));

      expect(result).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });
      expect(mocks.events.assignSlug).not.toHaveBeenCalled();
      expect(deps.reportError).not.toHaveBeenCalled();
    });

    it("creates the event slugless when the linked place has no country", async () => {
      const { deps, mocks } = makeDeps({
        place: makePlace({ countryCode: null }),
      });

      await expect(
        saveEventForOrg(
          deps,
          makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
        ),
      ).resolves.toMatchObject({ status: "DRAFT" });

      expect(mocks.events.assignSlug).not.toHaveBeenCalled();
      expect(deps.reportError).not.toHaveBeenCalled();
    });

    it("does NOT reassign a slug on a plain UPDATE", async () => {
      // Re-deriving on every save would churn the URL under anyone already
      // holding the draft link. Renames are `regenerateEventSlug`'s job.
      const existingEvent = makeExistingOrgEvent({
        status: "DRAFT",
        slug: "org/us/city/existing-2024-01-01-1800--aaaaaaaaaa",
        shortId: "aaaaaaaaaa",
      });
      const { deps, mocks } = makeDeps({ existingEvent });

      await saveEventForOrg(
        deps,
        makeOrgInput({
          eventId: DEFAULT_EVENT_ID,
          title: "Renamed",
          location: { placeId: DEFAULT_PLACE_ID },
        }),
      );

      expect(mocks.events.assignSlug).not.toHaveBeenCalled();
      expect(mocks.events.updateSlug).not.toHaveBeenCalled();
    });

    it("still creates the event when assignSlug fails, and REPORTS it", async () => {
      const { deps, mocks, defaults } = makeDeps();
      const conflict = { code: "conflict" };
      vi.mocked(mocks.events.assignSlug).mockRejectedValueOnce(conflict);

      const result = await saveEventForOrg(
        deps,
        makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      );

      expect(result).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });
      expect(deps.reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = vi.mocked(deps.reportError).mock.calls[0]!;
      expect(reported).toBe(conflict);
      expect(context?.tags?.stage).toBe("assign_slug_on_create");
      expect(context?.tags?.useCase).toBe("saveEvent");
    });
  });

  it("rejects updates for drafts owned by another org", async () => {
    const existingEvent = makeExistingOrgEvent({
      status: "DRAFT",
      orgId: OTHER_ORG_ID,
      placeId: null,
    });
    const { deps } = makeDeps({ existingEvent });

    await expect(
      saveEventForOrg(deps, makeOrgInput({ eventId: DEFAULT_EVENT_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});
