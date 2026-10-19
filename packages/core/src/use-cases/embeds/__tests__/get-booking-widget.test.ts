import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  getBookingWidget,
  type GetBookingWidgetDeps,
} from "../get-booking-widget";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";

const EMBED_ID = "00000000-0000-4000-8000-0000000000c0";
const PLACE_ID = "00000000-0000-4000-8000-0000000000c1";

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

const basePlace = {
  id: PLACE_ID,
  name: "The Basement",
  city: "Nashville",
  region: "TN",
  verificationStatus: "VERIFIED",
  acceptsBookingRequests: true,
  humanIdsWithAccess: [],
  orgIdsWithAccess: [],
} as unknown as PlaceRecord;

function makeDeps(
  opts: {
    embed?: EmbedRecord | null;
    place?: PlaceRecord | null;
    /** Availability-onboarding FR-005: rows the accepting fold counts. Default = configured. */
    availabilityRowCount?: number;
  } = {},
): GetBookingWidgetDeps {
  const { embed = baseEmbed, place = basePlace } = opts;
  return {
    repos: {
      embeds: { getById: vi.fn(async () => embed) },
      places: { getById: vi.fn(async () => place) },
      calendars: {
        countAvailabilityForPlace: vi.fn(
          async () => opts.availabilityRowCount ?? 1,
        ),
      },
    } as unknown as GetBookingWidgetDeps["repos"],
    publicAppUrl: PUBLIC_APP_URL,
    logger: createTestLogger(),
  };
}

describe("getBookingWidget", () => {
  it("returns embed + place summary + accepting for an allowlisted origin", async () => {
    const result = await getBookingWidget(makeDeps(), {
      embedId: EMBED_ID,
      hostOrigin: MATCHING_ORIGIN,
    });
    expect(result).toEqual({
      embed: { id: EMBED_ID, subjectType: "place", domain: DOMAIN },
      // `toEqual` on the WHOLE payload is the contract pin: the widget
      // carries no `slug`. `Place.slug` was a directory key nothing routed on
      // and it is deprecated; the widget links by `id`.
      place: {
        id: PLACE_ID,
        name: "The Basement",
        city: "Nashville",
        region: "TN",
      },
      accepting: true,
    });
  });

  it("allows our own web origin (admin preview / direct view)", async () => {
    const result = await getBookingWidget(makeDeps(), {
      embedId: EMBED_ID,
      hostOrigin: PUBLIC_APP_URL,
    });
    expect(result.accepting).toBe(true);
  });

  it("rejects a mismatched host origin before loading the place (fail closed)", async () => {
    const deps = makeDeps();
    await expect(
      getBookingWidget(deps, { embedId: EMBED_ID, hostOrigin: WRONG_ORIGIN }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
  });

  it("rejects a null host origin (fail closed)", async () => {
    await expect(
      getBookingWidget(makeDeps(), { embedId: EMBED_ID, hostOrigin: null }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
  });

  it("rejects a REVOKED embed as not found", async () => {
    const deps = makeDeps({ embed: { ...baseEmbed, status: "REVOKED" } });
    await expect(
      getBookingWidget(deps, {
        embedId: EMBED_ID,
        hostOrigin: MATCHING_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "EMBED_NOT_FOUND" });
  });

  it("rejects a non-place subject type", async () => {
    const deps = makeDeps({ embed: { ...baseEmbed, subjectType: "event" } });
    await expect(
      getBookingWidget(deps, {
        embedId: EMBED_ID,
        hostOrigin: MATCHING_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SUBJECT_TYPE" });
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
  });

  it("rejects a missing place", async () => {
    const deps = makeDeps({ place: null });
    await expect(
      getBookingWidget(deps, {
        embedId: EMBED_ID,
        hostOrigin: MATCHING_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("returns accepting:false (NOT an error) for an unverified place, keeping the name", async () => {
    const deps = makeDeps({
      place: {
        ...basePlace,
        verificationStatus: "PENDING",
      } as PlaceRecord,
    });
    const result = await getBookingWidget(deps, {
      embedId: EMBED_ID,
      hostOrigin: MATCHING_ORIGIN,
    });
    expect(result.accepting).toBe(false);
    expect(result.place.name).toBe("The Basement");
  });

  it("returns accepting:false for an UNCONFIGURED place (zero availability rows) — same calm state, no why", async () => {
    // Availability-onboarding FR-005: the embed fails closed with the main
    // site — an hours-less venue must not render a form its create path
    // (`booking_requests_unconfigured`) will refuse.
    const deps = makeDeps({ availabilityRowCount: 0 });
    const result = await getBookingWidget(deps, {
      embedId: EMBED_ID,
      hostOrigin: MATCHING_ORIGIN,
    });
    expect(result.accepting).toBe(false);
    expect(result.place.name).toBe("The Basement");
  });

  it("returns accepting:false when the place has paused booking requests", async () => {
    const deps = makeDeps({
      place: {
        ...basePlace,
        acceptsBookingRequests: false,
      } as PlaceRecord,
    });
    const result = await getBookingWidget(deps, {
      embedId: EMBED_ID,
      hostOrigin: MATCHING_ORIGIN,
    });
    expect(result.accepting).toBe(false);
    expect(result.place.name).toBe("The Basement");
  });
});
