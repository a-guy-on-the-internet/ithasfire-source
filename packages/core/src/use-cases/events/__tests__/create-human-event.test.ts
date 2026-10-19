import { describe, expect, it, vi } from "vitest";

import { createHumanEvent } from "../create-human-event";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_PLACE_ID,
  DEFAULT_SAVED_LOCATION_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SavedLocationRecord } from "@th/types/repos/saved-locations";

const makeDeps = makeCreateEventTestContext;

type HumanInputOverrides = Partial<
  Record<"actorHumanId" | "title" | "clientKey", string> & {
    startsAt?: string;
    endsAt?: string;
    location?: Record<string, unknown>;
  }
>;

function makeHumanInput(overrides: HumanInputOverrides = {}) {
  return {
    actorHumanId: overrides.actorHumanId ?? DEFAULT_ACTOR_ID,
    title: overrides.title ?? "My Event",
    startsAt: overrides.startsAt ?? "2024-02-01T18:00:00.000Z",
    endsAt: overrides.endsAt ?? "2024-02-01T19:00:00.000Z",
    location: overrides.location ?? {},
    clientKey: overrides.clientKey ?? "idem-key-5678",
  };
}

describe("createHumanEvent", () => {
  it("creates a new draft tied to the human", async () => {
    const { deps, defaults, mocks } = makeDeps();

    const result = await createHumanEvent(
      deps,
      makeHumanInput({
        title: "  New Human Show  ",
        location: { placeId: DEFAULT_PLACE_ID },
      }),
    );

    expect(result).toMatchObject({
      eventId: defaults.eventId,
      status: "DRAFT",
    });
    const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(draftArg).toMatchObject({
      orgId: null,
      humanId: defaults.humanId,
      title: "New Human Show",
      location: { kind: "place", placeId: DEFAULT_PLACE_ID },
    });
    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: defaults.eventId,
      action: "created",
      data: {
        humanId: defaults.humanId,
        actorHumanId: defaults.humanId,
        title: "New Human Show",
      },
      at: defaults.now,
    });
  });

  it("requires the actor human to exist", async () => {
    const { deps } = makeDeps({ human: null });

    await expect(
      createHumanEvent(deps, makeHumanInput()),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("attaches a place the human does not own as a THIRD PARTY (venue-confirmation spec); a suspended one is refused", async () => {
    const inaccessiblePlace: PlaceRecord = {
      id: DEFAULT_PLACE_ID,
      name: "Test Place",
      formattedAddress: "123 Anywhere St",
      addressLine1: "123 Anywhere St",
      addressLine2: null,
      city: "Example City",
      region: "CA",
      postalCode: "94107",
      countryCode: "US",
      capacity: null,
      lat: null,
      lng: null,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
    };
    const { deps } = makeDeps({ place: inaccessiblePlace });

    await expect(
      createHumanEvent(
        deps,
        makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      ),
    ).resolves.toMatchObject({ status: "DRAFT" });

    const suspended = makeDeps({
      place: { ...inaccessiblePlace, status: "SUSPENDED" },
    });
    await expect(
      createHumanEvent(
        suspended.deps,
        makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      ),
    ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
  });

  it("passes a CUSTOM address reveal date (and timezone) through to the draft", async () => {
    const { deps, mocks } = makeDeps();
    const revealAt = "2024-01-20T18:00:00.000Z";

    await createHumanEvent(deps, {
      ...makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      locationMode: "OBSCURED",
      addressRevealPreset: "CUSTOM",
      addressRevealAt: revealAt,
      timezone: "America/New_York",
    });

    // Organiser intent survives: CUSTOM + explicit date must NOT silently
    // fall back to the DAY_BEFORE default (startsAt - 24h).
    const draftArg = vi.mocked(mocks.events.upsertDraft).mock.calls[0]![0];
    expect(draftArg.addressRevealPreset).toBe("CUSTOM");
    expect(draftArg.addressRevealAt).toEqual(new Date(revealAt));
    expect(draftArg.timezone).toBe("America/New_York");
  });

  it("is idempotent for matching payloads", async () => {
    const savedLocation: SavedLocationRecord = {
      id: DEFAULT_SAVED_LOCATION_ID,
      name: "Test Venue",
      address: "123 Main St",
      countryCode: "US",
      region: "TN",
      locality: "Nashville",
      postalCode: "37201",
      lat: null,
      lng: null,
      ownerType: "HUMAN",
      ownerId: DEFAULT_ACTOR_ID,
      usageCount: 0,
      admissionTaxRateBps: null,
      taxRateFetchedAt: null,
      taxRateSource: null,
    };
    const { deps, mocks, defaults } = makeDeps({ savedLocation });

    const input = makeHumanInput({
      location: { savedLocationId: DEFAULT_SAVED_LOCATION_ID },
    });
    const first = await createHumanEvent(deps, input);
    const second = await createHumanEvent(deps, input);

    expect(first).toMatchObject({ eventId: defaults.eventId, status: "DRAFT" });
    expect(second).toEqual(first);
    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(mocks.savedLocations.incrementUsage).toHaveBeenCalledTimes(1);
  });
  // ---------------------------------------------------------------------
  // Slug at CREATE
  // ---------------------------------------------------------------------
  describe("slug at create", () => {
    it("assigns a slug when the location resolves a country code", async () => {
      const { deps, mocks, defaults } = makeDeps({
        human: { id: DEFAULT_ACTOR_ID, name: "Ada Lovelace" },
      });

      await createHumanEvent(
        deps,
        makeHumanInput({
          title: "House Show",
          location: { placeId: DEFAULT_PLACE_ID },
        }),
      );

      expect(mocks.events.assignSlug).toHaveBeenCalledTimes(1);
      const assigned = vi.mocked(mocks.events.assignSlug).mock.calls[0]![0];
      expect(assigned).toMatchObject({
        eventId: defaults.eventId,
        assignedAt: defaults.now,
      });
      expect(assigned.slug).toMatch(
        // Person-owned: the host segment is the neutral `event`, never the
        // human's name (a name in a URL is an address-lookup lead).
        /^event\/us\/city\/house-show-2024-02-01-1200--[a-z0-9]{10}$/,
      );
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "event.slug_assigned" }),
      );
      // History holds SUPERSEDED slugs only.
      expect(mocks.events.recordSlugHistory).not.toHaveBeenCalled();
    });

    it("creates the event ANYWAY, slugless, when there is no location", async () => {
      const { deps, mocks, defaults } = makeDeps();

      const result = await createHumanEvent(
        deps,
        makeHumanInput({ location: {} }),
      );

      expect(result).toMatchObject({
        eventId: defaults.eventId,
        status: "DRAFT",
      });
      expect(mocks.events.assignSlug).not.toHaveBeenCalled();
      // Not an incident: no country code is an EXPECTED outcome.
      expect(deps.reportError).not.toHaveBeenCalled();
    });

    it("still creates the event when assignSlug fails, and REPORTS it", async () => {
      const { deps, mocks, defaults } = makeDeps();
      vi.mocked(mocks.events.assignSlug).mockRejectedValueOnce({
        code: "conflict",
      });

      const result = await createHumanEvent(
        deps,
        makeHumanInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      );

      expect(result).toMatchObject({ eventId: defaults.eventId });
      expect(deps.reportError).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(deps.reportError).mock.calls[0]![1]?.tags?.stage,
      ).toBe("assign_slug_on_create");
    });
  });
});
