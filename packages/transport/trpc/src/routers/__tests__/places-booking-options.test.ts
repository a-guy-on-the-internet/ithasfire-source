import { describe, expect, it, vi } from "vitest";

import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";
import type { BookingStandardsRepo } from "@th/ports/repos/booking-standards";

import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";
import type { Ctx } from "../../context";

// Transport coverage for `places.getBookingOptions` — the place-page request
// dialog's read (venue-confirmation-and-booking-intents spec).
//
// PUBLIC, unauthenticated, `.strict()` output: what is pinned here is that a
// hidden rental rate and the reserved `rentalMode` cannot reach the wire, and
// that an anonymous caller is served.

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";
const CALENDAR_ID = "ca1e0da1-1111-4111-8111-111111111111";
const SPACE_ID = "5face000-1111-4111-8111-111111111111";

function buildRepos(
  options: { claimed?: boolean; bookingStandards?: BookingStandardsRepo } = {},
): Ctx["repos"] {
  return {
    bookingStandards: options.bookingStandards ?? createFakeBookingStandards(),
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        verificationStatus: options.claimed === false ? "UNVERIFIED" : "VERIFIED",
        acceptsBookingRequests: true,
        humanIdsWithAccess: options.claimed === false ? [] : ["11111111-1111-4111-8111-111111111111"],
        orgIdsWithAccess: [],
      })),
    },
    calendars: {
      listByPlace: vi.fn(async () => [
        {
          id: CALENDAR_ID,
          placeId: PLACE_ID,
          name: "Main Stage",
          slug: "main-stage",
          description: null,
          isDefault: true,
          defaultStartTime: null,
          defaultCategoryId: null,
          eventTemplate: null,
          acceptsPerform: true,
          acceptsRent: true,
          acceptsUse: false,
          rentalRateCents: 75_000,
          rentalRateCurrency: "usd",
          rentalRateVisible: false,
          rentalMode: "REQUEST",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          updatedAt: new Date("2026-08-01T00:00:00.000Z"),
          spaces: [
            {
              id: SPACE_ID,
              placeId: PLACE_ID,
              name: "Main Stage",
              capacity: 300,
              sortOrder: 0,
              status: "ACTIVE",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
              updatedAt: new Date("2026-08-01T00:00:00.000Z"),
            },
          ],
        },
      ]),
    },
  } as unknown as Ctx["repos"];
}

describe("places.getBookingOptions", () => {
  it("serves an anonymous caller; hidden rate and rentalMode never reach the wire", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildRepos(), actorHumanId: null },
    );

    const out = await caller.places.getBookingOptions({ placeId: PLACE_ID });

    expect(out).toEqual({
      placeId: PLACE_ID,
      isClaimed: true,
      acceptsBookingRequests: true,
      calendars: [
        {
          id: CALENDAR_ID,
          name: "Main Stage",
          isDefault: true,
          acceptsPerform: true,
          acceptsRent: true,
          acceptsUse: false,
          rentalRateCents: null,
          rentalRateCurrency: null,
          rentalRateVisible: false,
          spaces: [{ id: SPACE_ID, name: "Main Stage" }],
          // FR-004: keyed by the intents it takes; nothing configured here.
          standards: {
            PERFORM: {
              standards: expect.arrayContaining([
                expect.objectContaining({ source: "platform", requirement: "SUGGESTED" }),
              ]),
              examples: expect.any(Array),
            },
            RENT: expect.objectContaining({ standards: expect.any(Array) }),
          },
        },
      ],
      viewer: { authority: "none" },
      // The no-calendar resolution (place default → platform), every intent.
      placeStandards: {
        PERFORM: expect.objectContaining({ standards: expect.any(Array) }),
        RENT: expect.objectContaining({ standards: expect.any(Array) }),
        USE: expect.objectContaining({ standards: expect.any(Array) }),
      },
    });
    expect(JSON.stringify(out)).not.toContain("75000");
    expect(JSON.stringify(out)).not.toContain("rentalMode");
  });

  it("reports an unclaimed place as such", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildRepos({ claimed: false }), actorHumanId: null },
    );
    const out = await caller.places.getBookingOptions({ placeId: PLACE_ID });
    expect(out.isClaimed).toBe(false);
  });

  it("puts the venue's standards on the wire (FR-004) for an anonymous caller", async () => {
    const bookingStandards = createFakeBookingStandards();
    await bookingStandards.replaceItems({
      ownerType: "CALENDAR",
      ownerId: CALENDAR_ID,
      intent: "PERFORM",
      items: [{ field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED" }],
    });
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildRepos({ bookingStandards }), actorHumanId: null },
    );

    const out = await caller.places.getBookingOptions({ placeId: PLACE_ID });

    expect(out.calendars[0].standards.PERFORM.standards).toEqual([
      { source: "calendar", field: "LINK_MUSIC", requirement: "REQUIRED", label: "A music link", hint: null },
    ]);
  });

  it("threads ctx.reportError: a failed standards read is reported and the read still serves", async () => {
    const readFailure = new Error('relation "BookingStandardItem" does not exist');
    const bookingStandards = createFakeBookingStandards();
    vi.spyOn(bookingStandards, "listForOwners").mockRejectedValue(readFailure);
    const reportError = vi.fn();
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildRepos({ bookingStandards }), actorHumanId: null, reportError },
    );

    const out = await caller.places.getBookingOptions({ placeId: PLACE_ID });

    expect(out.calendars).toHaveLength(1);
    expect(
      out.calendars[0].standards.PERFORM.standards.every(
        (s: { source: string }) => s.source === "platform",
      ),
    ).toBe(true);
    expect(reportError).toHaveBeenCalledWith(
      readFailure,
      expect.objectContaining({ tags: { useCase: "loadEffectiveBookingStandards" } }),
    );
  });

  it("rejects a malformed id with BAD_REQUEST", async () => {
    const { caller } = createCaller(
      { places: placesRouter },
      { repos: buildRepos(), actorHumanId: null },
    );
    await expect(caller.places.getBookingOptions({ placeId: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
