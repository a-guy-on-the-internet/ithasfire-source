import { describe, expect, it, vi } from "vitest";

import { saveEventForHuman } from "../save-event-for-human";
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

type HumanInputOverrides = Partial<
  Record<"actorHumanId" | "title" | "clientKey" | "eventId", string> & {
    startsAt?: string;
    endsAt?: string;
    location?: Record<string, unknown>;
  }
>;

function makeHumanInput(overrides: HumanInputOverrides = {}) {
  return {
    eventId: overrides.eventId,
    actorHumanId: overrides.actorHumanId ?? DEFAULT_ACTOR_ID,
    title: overrides.title ?? "My Event",
    startsAt: overrides.startsAt ?? "2024-02-01T18:00:00.000Z",
    endsAt: overrides.endsAt ?? "2024-02-01T19:00:00.000Z",
    location: overrides.location ?? {},
    clientKey: overrides.clientKey ?? "idem-key-1234",
  };
}

const OTHER_HUMAN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER_PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeExistingHumanEvent(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  const base: EventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: null,
    humanId: DEFAULT_ACTOR_ID,
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
    humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
  };
  return Object.assign(base, overrides);
}

describe("saveEventForHuman", () => {
  it("creates a draft event with place location", async () => {
    const { deps, mocks, defaults } = makeDeps();

    const input = makeHumanInput({
      title: "  Human Event  ",
      location: { placeId: DEFAULT_PLACE_ID },
    });

    const result = await saveEventForHuman(deps, input);

    expect(result).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });
    const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(draftArg).toMatchObject({
      orgId: null,
      humanId: defaults.humanId,
      title: "Human Event",
      location: { kind: "place", placeId: DEFAULT_PLACE_ID },
    });

    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: defaults.eventId,
      action: "created",
      data: {
        humanId: defaults.humanId,
        actorHumanId: defaults.humanId,
        title: "Human Event",
      },
      at: defaults.now,
    });
  });

  it("requires the human to exist", async () => {
    const { deps } = makeDeps({ human: null });

    await expect(
      saveEventForHuman(deps, makeHumanInput()),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("attaches a place the human does not own as a THIRD PARTY (venue-confirmation spec); a missing place is still PLACE_NOT_FOUND", async () => {
    const foreignPlace = makePlace({
      slug: "test-place",
      humanIdsWithAccess: [],
    });
    const { deps } = makeDeps({ place: foreignPlace });

    await expect(
      saveEventForHuman(
        deps,
        makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      ),
    ).resolves.toMatchObject({ status: "DRAFT" });

    const missing = makeDeps({ place: null });
    await expect(
      saveEventForHuman(
        missing.deps,
        makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      ),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("rejects when saved location is not accessible to the human", async () => {
    const { deps } = makeDeps({
      savedLocation: {
        id: DEFAULT_SAVED_LOCATION_ID,
        name: "Test Location",
        address: "123 Test St, City, ST 12345",
        countryCode: "US",
        region: "ST",
        locality: "City",
        postalCode: "12345",
        lat: null,
        lng: null,
        ownerType: "HUMAN",
        ownerId: "00000000-0000-4000-8000-000000000000",
        usageCount: 0,
        admissionTaxRateBps: null,
        taxRateFetchedAt: null,
        taxRateSource: null,
      },
    });

    await expect(
      saveEventForHuman(
        deps,
        makeHumanInput({
          location: { savedLocationId: DEFAULT_SAVED_LOCATION_ID },
        }),
      ),
    ).rejects.toMatchObject({ code: "SAVED_LOCATION_NOT_FOUND" });
  });

  it("replays the same result for identical idempotency requests", async () => {
    const { deps, mocks, defaults } = makeDeps();

    const input = makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } });

    const first = await saveEventForHuman(deps, input);
    const second = await saveEventForHuman(deps, input);

    expect(first).toEqual({ eventId: defaults.eventId, status: "DRAFT", bookingRequest: null });
    expect(second).toEqual(first);
    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(mocks.idempotency.__mocks.get).toHaveBeenCalled();
  });

  it("updates an existing human draft", async () => {
    const existingEvent = makeExistingHumanEvent({
      status: "DRAFT",
      placeId: null,
    });
    const { deps, mocks, defaults } = makeDeps({ existingEvent });

    const input = makeHumanInput({
      eventId: DEFAULT_EVENT_ID,
      title: "Updated Human Event",
      location: {},
    });

    const result = await saveEventForHuman(deps, input);

    expect(result).toEqual({ eventId: DEFAULT_EVENT_ID, status: "DRAFT", bookingRequest: null });
    expect(mocks.events.getById).toHaveBeenCalledWith(DEFAULT_EVENT_ID);
    const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(draftArg.createdAt).toBeUndefined();
    expect(draftArg).toMatchObject({
      eventId: DEFAULT_EVENT_ID,
      title: "Updated Human Event",
    });
    expect(mocks.savedLocations.incrementUsage).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: DEFAULT_EVENT_ID,
      action: "updated",
      data: {
        humanId: defaults.humanId,
        actorHumanId: defaults.humanId,
        title: "Updated Human Event",
      },
      at: defaults.now,
    });
  });

  // Owner ruling 2026-09-28: an edit-role delegate of the principal edits the
  // principal's personal events. OWNERSHIP NEVER MOVES — the save writes
  // `humanId = principal`, never the delegate — and the audit row names the
  // delegate as the actor.
  describe("a delegate saving the principal's event", () => {
    const PRINCIPAL_ID = OTHER_HUMAN_ID;
    const DELEGATE_ID = DEFAULT_ACTOR_ID;

    function setup(delegateRole: string | null) {
      const ctx = makeDeps({
        existingEvent: makeExistingHumanEvent({
          humanId: PRINCIPAL_ID,
          status: "DRAFT",
          placeId: null,
        }),
      });
      vi.mocked(ctx.mocks.authz.getHumanDelegation).mockImplementation(
        async () =>
          delegateRole
            ? ({
                orgId: PRINCIPAL_ID,
                humanId: DELEGATE_ID,
                role: delegateRole,
              } as never)
            : null,
      );
      return ctx;
    }

    it.each(["OWNER", "ADMIN", "EDITOR"])(
      "a %s delegate saves it, the owner stays the principal, and the audit actor is the delegate",
      async (role) => {
        const { deps, mocks, defaults } = setup(role);

        const result = await saveEventForHuman(
          deps,
          makeHumanInput({
            actorHumanId: DELEGATE_ID,
            eventId: DEFAULT_EVENT_ID,
            title: "Delegate Edit",
            location: {},
          }),
        );

        expect(result).toMatchObject({ eventId: DEFAULT_EVENT_ID });
        expect(mocks.authz.getHumanDelegation).toHaveBeenCalledWith({
          principalId: PRINCIPAL_ID,
          delegateId: DELEGATE_ID,
        });
        const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
        expect(draftArg).toMatchObject({
          eventId: DEFAULT_EVENT_ID,
          humanId: PRINCIPAL_ID,
          orgId: null,
        });
        expect(draftArg.humanId).not.toBe(DELEGATE_ID);
        expect(mocks.audit.log).toHaveBeenCalledWith({
          entity: "event",
          entityId: DEFAULT_EVENT_ID,
          action: "updated",
          data: {
            humanId: PRINCIPAL_ID,
            actorHumanId: DELEGATE_ID,
            title: "Delegate Edit",
          },
          at: defaults.now,
        });
      },
    );

    it.each([["VIEWER"], ["FINANCE"], ["SCANNER"], [null]])(
      "a %s delegate (or a stranger) is refused NOT_RESOURCE_OWNER and nothing is written",
      async (role) => {
        const { deps, mocks } = setup(role);

        await expect(
          saveEventForHuman(
            deps,
            makeHumanInput({
              actorHumanId: DELEGATE_ID,
              eventId: DEFAULT_EVENT_ID,
              title: "Nope",
              location: {},
            }),
          ),
        ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
        expect(mocks.events.upsertDraft).not.toHaveBeenCalled();
        expect(mocks.audit.log).not.toHaveBeenCalled();
      },
    );

    it("a NEW event by a delegate is the delegate's own — no delegation lookup", async () => {
      const { deps, mocks } = setup("EDITOR");

      await saveEventForHuman(
        deps,
        makeHumanInput({ actorHumanId: DELEGATE_ID, location: {} }),
      );

      expect(mocks.authz.getHumanDelegation).not.toHaveBeenCalled();
      const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
      expect(draftArg).toMatchObject({ humanId: DELEGATE_ID, orgId: null });
    });

    it("an ORG event is never reached through a delegation", async () => {
      const { deps, mocks } = makeDeps({
        existingEvent: makeExistingHumanEvent({
          orgId: DEFAULT_ORG_ID,
          humanId: PRINCIPAL_ID,
        }),
      });
      vi.mocked(mocks.authz.getHumanDelegation).mockResolvedValue({
        orgId: PRINCIPAL_ID,
        humanId: DELEGATE_ID,
        role: "OWNER",
      } as never);

      await expect(
        saveEventForHuman(
          deps,
          makeHumanInput({
            actorHumanId: DELEGATE_ID,
            eventId: DEFAULT_EVENT_ID,
            location: {},
          }),
        ),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.authz.getHumanDelegation).not.toHaveBeenCalled();
      expect(mocks.events.upsertDraft).not.toHaveBeenCalled();
    });
  });

  describe("place validation on existing events", () => {
    it("surfaces NOT_RESOURCE_OWNER (not PLACE_NOT_FOUND) when editing another human's event with their place", async () => {
      // Event owned by another human, at a place accessible only to them.
      // Event ownership must be validated first so the truthful error
      // surfaces instead of a masking PLACE_NOT_FOUND.
      const { deps } = makeDeps({
        existingEvent: makeExistingHumanEvent({ humanId: OTHER_HUMAN_ID }),
        place: makePlace({ humanIdsWithAccess: [OTHER_HUMAN_ID] }),
      });

      await expect(
        saveEventForHuman(
          deps,
          makeHumanInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });

    it("skips place re-validation when placeId is unchanged on an existing event", async () => {
      // The place is already attached: even if it is not accessible to the
      // acting human (or has since been suspended), an unchanged-place edit
      // must succeed.
      const { deps, mocks } = makeDeps({
        existingEvent: makeExistingHumanEvent(),
        place: makePlace({ humanIdsWithAccess: [], status: "SUSPENDED" }),
      });

      const result = await saveEventForHuman(
        deps,
        makeHumanInput({
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

    it("attaches a CHANGED placeId the acting human does not own as a THIRD PARTY", async () => {
      const { deps } = makeDeps({
        existingEvent: makeExistingHumanEvent({ placeId: OTHER_PLACE_ID }),
        place: makePlace({ humanIdsWithAccess: [OTHER_HUMAN_ID] }),
      });

      await expect(
        saveEventForHuman(
          deps,
          makeHumanInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).resolves.toMatchObject({ eventId: DEFAULT_EVENT_ID });
    });

    it("still rejects a CHANGED placeId when the place is not active", async () => {
      const { deps } = makeDeps({
        existingEvent: makeExistingHumanEvent({ placeId: OTHER_PLACE_ID }),
        place: makePlace({ status: "SUSPENDED" }),
      });

      await expect(
        saveEventForHuman(
          deps,
          makeHumanInput({
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
        existingEvent: makeExistingHumanEvent({ placeId: null }),
        place: makePlace({ humanIdsWithAccess: [OTHER_HUMAN_ID], status: "SUSPENDED" }),
      });

      await expect(
        saveEventForHuman(
          deps,
          makeHumanInput({
            eventId: DEFAULT_EVENT_ID,
            location: { placeId: DEFAULT_PLACE_ID },
          }),
        ),
      ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    });
  });

  it("rejects updates for drafts owned by another human", async () => {
    const existingEvent = makeExistingHumanEvent({
      status: "DRAFT",
      humanId: OTHER_HUMAN_ID,
      placeId: null,
    });
    const { deps } = makeDeps({ existingEvent });

    await expect(
      saveEventForHuman(deps, makeHumanInput({ eventId: DEFAULT_EVENT_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  describe("ageLimit", () => {
    it("forwards ageLimit to the draft", async () => {
      const { deps, mocks } = makeDeps();

      await saveEventForHuman(deps, {
        ...makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
        ageLimit: 18,
      });

      const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
      expect(draftArg.ageLimit).toBe(18);
    });

    it("accepts ageLimit: 0 (all ages)", async () => {
      const { deps, mocks } = makeDeps();

      await saveEventForHuman(deps, {
        ...makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
        ageLimit: 0,
      });

      const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
      expect(draftArg.ageLimit).toBe(0);
    });

    it("accepts ageLimit: null (no restriction)", async () => {
      const { deps, mocks } = makeDeps();

      await saveEventForHuman(deps, {
        ...makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
        ageLimit: null,
      });

      const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
      expect(draftArg.ageLimit).toBeNull();
    });

    it("rejects ageLimit > 99", async () => {
      const { deps } = makeDeps();

      await expect(
        saveEventForHuman(deps, {
          ...makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
          ageLimit: 100,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects negative ageLimit", async () => {
      const { deps } = makeDeps();

      await expect(
        saveEventForHuman(deps, {
          ...makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
          ageLimit: -1,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
  // ---------------------------------------------------------------------
  // Slug at CREATE
  // ---------------------------------------------------------------------
  describe("slug at create", () => {
    it("assigns a slug when the location resolves a country code", async () => {
      const { deps, mocks, defaults } = makeDeps({
        human: { id: DEFAULT_ACTOR_ID, name: "Ada Lovelace" },
      });

      await saveEventForHuman(
        deps,
        makeHumanInput({
          title: "Backyard Set",
          location: { placeId: DEFAULT_PLACE_ID },
        }),
      );

      expect(mocks.events.assignSlug).toHaveBeenCalledTimes(1);
      const assigned = vi.mocked(mocks.events.assignSlug).mock.calls[0]![0];
      expect(assigned).toMatchObject({
        eventId: defaults.eventId,
        assignedAt: defaults.now,
      });
      // Human-owned event: the host segment is the neutral `event`, never
      // the human's name.
      expect(assigned.slug).toMatch(
        /^event\/us\/city\/backyard-set-2024-02-01-1200--[a-z0-9]{10}$/,
      );
      expect(mocks.events.recordSlugHistory).not.toHaveBeenCalled();
    });

    it("creates the event ANYWAY, slugless, when there is no location", async () => {
      const { deps, mocks, defaults } = makeDeps();

      const result = await saveEventForHuman(
        deps,
        makeHumanInput({ location: {} }),
      );

      expect(result).toMatchObject({
        eventId: defaults.eventId,
        status: "DRAFT",
      });
      expect(mocks.events.assignSlug).not.toHaveBeenCalled();
      expect(deps.reportError).not.toHaveBeenCalled();
    });

    it("does NOT reassign a slug on a plain UPDATE", async () => {
      const existingEvent = makeExistingHumanEvent({
        status: "DRAFT",
        slug: "ada-lovelace/us/city/existing-2024-01-01-1800--aaaaaaaaaa",
        shortId: "aaaaaaaaaa",
      });
      const { deps, mocks } = makeDeps({ existingEvent });

      await saveEventForHuman(
        deps,
        makeHumanInput({
          eventId: DEFAULT_EVENT_ID,
          title: "Renamed",
          location: { placeId: DEFAULT_PLACE_ID },
        }),
      );

      expect(mocks.events.assignSlug).not.toHaveBeenCalled();
      expect(mocks.events.updateSlug).not.toHaveBeenCalled();
    });
  });
});
