import { describe, expect, it } from "vitest";

import { SUGGESTION_EDITABLE_FIELDS } from "@th/core/use-cases/events/_shared/suggestion-fields";

import {
  anchorCommunityFieldError,
  buildCommunityUpdateFields,
  communityIsLive,
  communityLocationIsPinned,
  communityLockedStatus,
  communityPlaceRefusalMessageKey,
  diffCommunityMaterialGroups,
  formatCommunityAddressLabel,
  isCommunityStewardship,
} from "../community-builder.helpers";
import type { LocationState } from "../LocationSection";
import en from "@/i18n/messages/en";
import es from "@/i18n/messages/es";
import { normalizeError } from "@/lib/errors/normalize-error";

const PINNED: LocationState = {
  addressText: "  1 Main St, Nashville, TN 37203  ",
  lat: 36.16,
  lng: -86.78,
  locality: " Nashville ",
  region: " TN ",
  countryCode: "us",
  postalCode: " 37203 ",
};

const DOC = { type: "doc" as const, content: [] };

const baseInput = {
  title: "  Tuesday open mic  ",
  startsAtLocal: "2026-10-01T19:00",
  endsAtLocal: "2026-10-01T22:00",
  timezone: "America/Chicago",
  location: PINNED,
  bodyContent: DOC,
  bodyBlockId: "blk-1",
  categoryId: null as string | null,
};

describe("buildCommunityUpdateFields", () => {
  it("only ever emits keys the FR-007 whitelist accepts", () => {
    // The anti-rot guard. `parseSuggestionFields` rejects the WHOLE payload
    // when it sees a non-whitelisted key, so a key added here that the server
    // does not know about turns every community save into a hard error.
    const fields = buildCommunityUpdateFields({
      ...baseInput,
      heroImageId: "11111111-1111-4111-8111-111111111111",
    });
    const allowed = new Set<string>(SUGGESTION_EDITABLE_FIELDS);
    expect(Object.keys(fields).filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("trims text, upper-cases the country, and converts the wall clock in the event zone", () => {
    const fields = buildCommunityUpdateFields(baseInput);

    expect(fields.title).toBe("Tuesday open mic");
    expect(fields.addressText).toBe("1 Main St, Nashville, TN 37203");
    expect(fields.countryCode).toBe("US");
    expect(fields.locality).toBe("Nashville");
    expect(fields.region).toBe("TN");
    expect(fields.postalCode).toBe("37203");
    expect(fields.timezone).toBe("America/Chicago");
    // 19:00 CDT === 00:00Z the next day.
    expect(fields.startsAt).toBe("2026-10-02T00:00:00.000Z");
    expect(fields.endsAt).toBe("2026-10-02T03:00:00.000Z");
  });

  it("carries the body as a single richText block under the default layout", () => {
    const fields = buildCommunityUpdateFields(baseInput);
    expect(fields.content).toEqual({
      layoutId: "default",
      blocks: [{ id: "blk-1", type: "richText", doc: DOC }],
    });
  });

  it("omits the whole geo group when the address has no pin", () => {
    // `parseSuggestionFields` rejects a diff carrying one of {lat, lng}
    // (`lat_lng_must_pair`), and a lone `addressText` would desync the stored
    // geohash from the visible address. Nothing geographic goes on the wire.
    const fields = buildCommunityUpdateFields({
      ...baseInput,
      location: { addressText: "Somewhere vague" },
    });

    for (const key of [
      "addressText",
      "countryCode",
      "region",
      "locality",
      "postalCode",
      "lat",
      "lng",
    ] as const) {
      expect(fields).not.toHaveProperty(key);
    }
  });

  it("omits endsAt rather than nulling it when the end time is blank", () => {
    // `endsAt` is non-nullable in the whitelist, so an empty field must leave
    // the stored value alone instead of proposing null.
    const fields = buildCommunityUpdateFields({
      ...baseInput,
      endsAtLocal: "",
    });
    expect(fields).not.toHaveProperty("endsAt");
    expect(fields.startsAt).toBeDefined();
  });

  it("sends categoryId: null for 'no category' and omits heroImageId when untouched", () => {
    const fields = buildCommunityUpdateFields(baseInput);
    expect(fields.categoryId).toBeNull();
    expect(fields).not.toHaveProperty("heroImageId");
  });

  it("sends heroImageId: null when the moderator removed the hero", () => {
    const fields = buildCommunityUpdateFields({
      ...baseInput,
      heroImageId: null,
    });
    expect(fields.heroImageId).toBeNull();
  });

  it("never produces an empty diff", () => {
    // `empty_diff` is a server rejection; title/timezone/content are
    // unconditional so it is unreachable from the builder.
    const fields = buildCommunityUpdateFields({
      ...baseInput,
      title: "",
      startsAtLocal: "",
      endsAtLocal: "",
      location: {},
    });
    expect(Object.keys(fields).length).toBeGreaterThan(0);
  });
});

describe("communityLocationIsPinned", () => {
  it("requires address text AND both coordinates", () => {
    expect(communityLocationIsPinned(PINNED)).toBe(true);
    expect(communityLocationIsPinned({ addressText: "x", lat: 1 })).toBe(false);
    expect(communityLocationIsPinned({ lat: 1, lng: 2 })).toBe(false);
    expect(communityLocationIsPinned({ addressText: "   ", lat: 1, lng: 2 })).toBe(
      false,
    );
  });

  it("does not accept a Ithas Fire Place as a pin", () => {
    // This check is for a TYPED address. A linked place is not a pin here:
    // the builder skips the check when `thPlaceId` is set and the server
    // copies the address from the place (or refuses it with its own reason).
    expect(
      communityLocationIsPinned({ thPlaceId: "p-1", thPlaceName: "The Venue" }),
    ).toBe(false);
  });
});

describe("stewardship predicates", () => {
  it("identifies community stewardship", () => {
    expect(isCommunityStewardship("COMMUNITY")).toBe(true);
    expect(isCommunityStewardship("OWNED")).toBe(false);
    expect(isCommunityStewardship(undefined)).toBe(false);
    expect(isCommunityStewardship(null)).toBe(false);
  });

  it("locks only the three END states, and names which one", () => {
    // PUBLISHED is EDITABLE as of 2026-09-16 — `community.updateListing`
    // takes a live listing. Only the states it still refuses lock the form,
    // and the notice prints the status, so the predicate returns it.
    expect(communityLockedStatus("COMMUNITY", "DRAFT")).toBeNull();
    expect(communityLockedStatus("COMMUNITY", "PUBLISHED")).toBeNull();
    expect(communityLockedStatus("COMMUNITY", "CANCELLED")).toBe("CANCELLED");
    expect(communityLockedStatus("COMMUNITY", "COMPLETED")).toBe("COMPLETED");
    expect(communityLockedStatus("COMMUNITY", "ARCHIVED")).toBe("ARCHIVED");
  });

  it("never locks an OWNED event, whatever its status", () => {
    // The guard must be inert on the ticketed path.
    for (const status of [
      "DRAFT",
      "PUBLISHED",
      "CANCELLED",
      "COMPLETED",
      "ARCHIVED",
    ]) {
      expect(communityLockedStatus("OWNED", status)).toBeNull();
    }
    expect(communityLockedStatus(undefined, undefined)).toBeNull();
  });

  it("calls only a PUBLISHED community listing live", () => {
    expect(communityIsLive("COMMUNITY", "PUBLISHED")).toBe(true);
    expect(communityIsLive("COMMUNITY", "DRAFT")).toBe(false);
    expect(communityIsLive("OWNED", "PUBLISHED")).toBe(false);
    expect(communityIsLive(undefined, undefined)).toBe(false);
  });
});

describe("diffCommunityMaterialGroups", () => {
  // What the builder would be saving over: the hydrated form, untouched.
  const saved = {
    startsAt: "2026-10-02T00:00:00.000Z", // 19:00 America/Chicago on Oct 1
    endsAt: "2026-10-02T03:00:00.000Z", // 22:00 America/Chicago
    addressText: "1 Main St, Nashville, TN 37203",
    lat: 36.16,
    lng: -86.78,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37203",
  };
  const pending = {
    startsAtLocal: "2026-10-01T19:00",
    endsAtLocal: "2026-10-01T22:00",
    timezone: "America/Chicago",
    location: PINNED,
  };

  it("reports NOTHING material when the form still matches the stored row", () => {
    // THE load-bearing case. The builder sends the whole form every save, and
    // the server reads materiality off the KEY SET it receives — so an
    // unchanged schedule and address riding along on a typo fix is what mails
    // every RSVPer that the event moved. Twice.
    expect(diffCommunityMaterialGroups({ ...pending, saved })).toEqual({
      schedule: false,
      venue: false,
      include: { schedule: false, venue: false },
    });
  });

  it("reports the schedule moved when the start moves", () => {
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        startsAtLocal: "2026-10-01T20:00",
        saved,
      }),
    ).toEqual({
      schedule: true,
      venue: false,
      include: { schedule: true, venue: false },
    });
  });

  it("reports the schedule moved when only the end moves", () => {
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        endsAtLocal: "2026-10-01T23:00",
        saved,
      }),
    ).toEqual({
      schedule: true,
      venue: false,
      include: { schedule: true, venue: false },
    });
  });

  it("reports the venue moved when the pin moves over 50 m", () => {
    // 0.01° of latitude is about 1.1 km.
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, lat: 36.17 },
        saved,
      }),
    ).toEqual({
      schedule: false,
      venue: true,
      include: { schedule: false, venue: true },
    });
  });

  it("SENDS a corrected postcode but reports no venue move (the server sends no notice)", () => {
    // The server's rule (`addressVenueChanged`) strips postcodes before it
    // compares street lines: a corrected postal code is saved, and tells
    // nobody. The confirm must not say it will.
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, postalCode: "37201" },
        saved,
      }),
    ).toEqual({
      schedule: false,
      venue: false,
      include: { schedule: false, venue: true },
    });
  });

  it("re-picking the SAME address (pin a few metres off, same street line reformatted, no postcode) is sent but is no venue move", () => {
    // THE reported bug: the suggestion list returns the same building with a
    // slightly different pin and its own formatting ("Street" for "St"). The
    // confirm used to show NOW and AFTER SAVING as identical strings, and
    // every RSVPer was mailed.
    // 0.0003° of latitude is about 33 m.
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: {
          addressText: "1 Main Street, Nashville, TN, USA",
          lat: 36.1603,
          lng: -86.78,
          locality: "Nashville",
          region: "TN",
          countryCode: "US",
        },
        saved,
      }),
    ).toEqual({
      schedule: false,
      venue: false,
      include: { schedule: false, venue: true },
    });
  });

  it("a pin under 50 m away is no move; over 50 m is", () => {
    // 0.0003° ≈ 33 m, 0.0006° ≈ 67 m — the server's threshold, not a copy.
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, lat: 36.1603 },
        saved,
      }).venue,
    ).toBe(false);
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, lat: 36.1606 },
        saved,
      }).venue,
    ).toBe(true);
  });

  it("a pin appearing where the stored listing had none is a venue move", () => {
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        saved: { ...saved, lat: null, lng: null },
      }),
    ).toEqual({
      schedule: false,
      venue: true,
      include: { schedule: false, venue: true },
    });
  });

  it("a schedule move with a sub-50 m re-pick of the same street reports the schedule only, and sends both", () => {
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        startsAtLocal: "2026-10-08T19:00",
        location: { ...PINNED, addressText: "1 Main Street, Nashville, TN", lat: 36.1603 },
        saved,
      }),
    ).toEqual({
      schedule: true,
      venue: false,
      include: { schedule: true, venue: true },
    });
  });

  it("a DIFFERENT street address at the same pin is a venue change", () => {
    // The pin cannot tell a building from its neighbour; the text can.
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, addressText: "2 Broadway, Nashville, TN" },
        saved,
      }),
    ).toEqual({
      schedule: false,
      venue: true,
      include: { schedule: false, venue: true },
    });
  });

  describe("the incident listing (Nashville, 2026-10-14)", () => {
    const incidentSaved = {
      ...saved,
      addressText:
        "211 27th Avenue North, Nashville, TN 37203, United States of America",
      lat: 36.1497,
      lng: -86.8126,
      postalCode: "37203",
    };
    // ~1 m of latitude in degrees.
    const METRE = 1 / 111_195;
    const at = (location: Partial<LocationState>): LocationState => ({
      lat: 36.1497,
      lng: -86.8126,
      locality: "Nashville",
      region: "TN",
      countryCode: "US",
      postalCode: "37203",
      ...location,
    });

    it("unlock then lock: the unchanged pin reverse-geocoded to another street address is a venue change", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: at({ addressText: "245 25th Avenue North, Nashville, TN 37203" }),
          saved: incidentSaved,
        }),
      ).toEqual({
        schedule: false,
        venue: true,
        include: { schedule: false, venue: true },
      });
    });

    it("the same street abbreviated, country dropped, postcode changed, pin 10 m off is QUIET", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: at({
            addressText: "211 27th Ave N, Nashville, TN 37209",
            postalCode: "37209",
            lat: 36.1497 + 10 * METRE,
          }),
          saved: incidentSaved,
        }),
      ).toEqual({
        schedule: false,
        venue: false,
        include: { schedule: false, venue: true },
      });
    });

    it("the next-door address with the pin within 30 m is a venue change", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: at({
            addressText: "213 27th Avenue North, Nashville, TN 37203",
            lat: 36.1497 + 25 * METRE,
          }),
          saved: incidentSaved,
        }).venue,
      ).toBe(true);
    });
  });

  it("reports both when both move", () => {
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        startsAtLocal: "2026-10-08T19:00",
        location: {
          ...PINNED,
          addressText: "2 Broadway, Nashville, TN",
          lat: 36.17,
        },
        saved,
      }),
    ).toEqual({
      schedule: true,
      venue: true,
      include: { schedule: true, venue: true },
    });
  });

  it("reports both changed when there is nothing to compare against", () => {
    // The edit read has not landed. Nothing is known, so the confirm opens —
    // the safe direction on a listing that may be live.
    expect(diffCommunityMaterialGroups({ ...pending, saved: null })).toEqual({
      schedule: true,
      venue: true,
      include: { schedule: true, venue: true },
    });
  });

  it("does not call an un-geocoded address a venue move", () => {
    // No pin means no geo fields on the wire at all, so nothing moved.
    expect(
      diffCommunityMaterialGroups({
        ...pending,
        location: { addressText: "somewhere" },
        saved,
      }),
    ).toEqual({
      schedule: false,
      venue: false,
      include: { schedule: false, venue: false },
    });
  });
});

describe("buildCommunityUpdateFields — include", () => {
  it("omits the groups the caller excludes, and keeps the diff non-empty", () => {
    const fields = buildCommunityUpdateFields({
      ...baseInput,
      include: { schedule: false, venue: false },
    });

    expect(fields.startsAt).toBeUndefined();
    expect(fields.endsAt).toBeUndefined();
    expect(fields.addressText).toBeUndefined();
    expect(fields.lat).toBeUndefined();
    expect(fields.lng).toBeUndefined();
    // `empty_diff` must stay unreachable: the non-material fields always ride.
    expect(Object.keys(fields).sort()).toEqual([
      "categoryId",
      "content",
      "timezone",
      "title",
    ]);
  });

  it("a corrected postcode that notifies nobody still reaches the wire", () => {
    const diff = diffCommunityMaterialGroups({
      startsAtLocal: baseInput.startsAtLocal,
      endsAtLocal: baseInput.endsAtLocal,
      timezone: baseInput.timezone,
      location: { ...PINNED, postalCode: "37201" },
      saved: {
        startsAt: "2026-10-02T00:00:00.000Z",
        endsAt: "2026-10-02T03:00:00.000Z",
        addressText: "1 Main St, Nashville, TN 37203",
        lat: 36.16,
        lng: -86.78,
        locality: "Nashville",
        region: "TN",
        countryCode: "US",
        postalCode: "37203",
      },
    });
    expect(diff.venue).toBe(false);

    const fields = buildCommunityUpdateFields({
      ...baseInput,
      location: { ...PINNED, postalCode: "37201" },
      include: diff.include,
    });
    expect(fields.postalCode).toBe("37201");
    expect(fields.lat).toBe(36.16);
    expect(fields.startsAt).toBeUndefined();
  });

  it("sends both groups by default — the DRAFT payload is unchanged", () => {
    expect(buildCommunityUpdateFields(baseInput)).toEqual(
      buildCommunityUpdateFields({
        ...baseInput,
        include: { schedule: true, venue: true },
      }),
    );
  });
});

describe("formatCommunityAddressLabel", () => {
  it("does not repeat parts the street line already carries", () => {
    expect(
      formatCommunityAddressLabel({
        addressText: "1 Main St, Nashville, TN 37203",
        locality: "Nashville",
        region: "TN",
        postalCode: "37203",
      }),
    ).toBe("1 Main St, Nashville, TN 37203");
  });

  it("appends the parts it does not, so a sub-part change is visible", () => {
    expect(
      formatCommunityAddressLabel({
        addressText: "1 Main St",
        locality: "Nashville",
        postalCode: "37201",
      }),
    ).toBe("1 Main St · Nashville · 37201");
  });

  it("is empty when there is nothing to show", () => {
    expect(formatCommunityAddressLabel({})).toBe("");
  });
});

describe("anchorCommunityFieldError", () => {
  const rejection = (meta: Record<string, unknown>) => ({ data: { meta } });

  it("anchors an ordering rejection on the end-time field", () => {
    expect(
      anchorCommunityFieldError(
        rejection({ reason: "ends_before_starts", fields: ["endsAt"] }),
      ),
    ).toEqual({ field: "endsAt", messageKey: "suggestEdit.errEndsBeforeStarts" });
  });

  it("anchors a blocked-content rejection on the named field", () => {
    expect(
      anchorCommunityFieldError(
        rejection({ reason: "blocked_content", fields: ["title"] }),
      ),
    ).toEqual({ field: "title", messageKey: "suggestEdit.errBlockedContent" });
  });

  it("returns null when the offending field has no builder anchor", () => {
    // The body, the geo group and the hero are reported in the form banner
    // instead — there is no single control to hang the message on.
    expect(
      anchorCommunityFieldError(
        rejection({ reason: "invalid_body", fields: ["content"] }),
      ),
    ).toBeNull();
    expect(
      anchorCommunityFieldError(
        rejection({ reason: "lat_lng_must_pair", fields: ["lat", "lng"] }),
      ),
    ).toBeNull();
  });

  it("returns null for an error carrying no structured meta", () => {
    expect(anchorCommunityFieldError(new Error("boom"))).toBeNull();
    expect(anchorCommunityFieldError(null)).toBeNull();
  });
});

describe("community place link (fields.placeId)", () => {
  const PLACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PLACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const GEO_KEYS = [
    "addressText",
    "lat",
    "lng",
    "countryCode",
    "region",
    "locality",
    "postalCode",
  ];
  const geoKeysIn = (fields: object) =>
    Object.keys(fields).filter((key) => GEO_KEYS.includes(key));

  // What the place handler puts in builder state: no country, and a postal
  // code only for an owned-list pick (none here).
  const PICKED_B: LocationState = {
    thPlaceId: PLACE_B,
    thPlaceName: "The Basement",
    addressText: "2 Other St, Nashville, TN",
    lat: 36.2,
    lng: -86.7,
    locality: "Nashville",
    region: "TN",
  };
  // A listing hydrated as linked to A: event columns plus the place id.
  const LINKED_A: LocationState = {
    ...PINNED,
    thPlaceId: PLACE_A,
    thPlaceName: "The Attic",
  };
  const savedLinkedA = {
    startsAt: "2026-10-02T00:00:00.000Z",
    endsAt: "2026-10-02T03:00:00.000Z",
    addressText: "1 Main St, Nashville, TN 37203",
    lat: 36.16,
    lng: -86.78,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37203",
    placeId: PLACE_A,
  };
  const pending = {
    startsAtLocal: "2026-10-01T19:00",
    endsAtLocal: "2026-10-01T22:00",
    timezone: "America/Chicago",
  };

  describe("buildCommunityUpdateFields", () => {
    it("a newly picked place sends placeId and NO address fields", () => {
      for (const savedPlaceId of [null, PLACE_A]) {
        const fields = buildCommunityUpdateFields({
          ...baseInput,
          location: PICKED_B,
          savedPlaceId,
        });
        expect(fields.placeId).toBe(PLACE_B);
        expect(geoKeysIn(fields)).toEqual([]);
      }
    });

    it("a new link rides even when the address group is excluded (live, same address)", () => {
      const fields = buildCommunityUpdateFields({
        ...baseInput,
        location: PICKED_B,
        savedPlaceId: PLACE_A,
        include: { schedule: false, venue: false },
      });
      expect(fields.placeId).toBe(PLACE_B);
      expect(geoKeysIn(fields)).toEqual([]);
    });

    it("the stored link, untouched, sends neither placeId nor address — on a DRAFT too", () => {
      // A DRAFT includes the venue group on every save. Sending the address
      // of a linked listing without `placeId: null` is REFUSED by the server
      // (`unsupported_fields`), so the linked case must send nothing at all.
      const fields = buildCommunityUpdateFields({
        ...baseInput,
        location: LINKED_A,
        savedPlaceId: PLACE_A,
      });
      expect("placeId" in fields).toBe(false);
      expect(geoKeysIn(fields)).toEqual([]);
    });

    it("leaving a link for a typed address sends placeId: null WITH the address", () => {
      const fields = buildCommunityUpdateFields({
        ...baseInput,
        location: PINNED,
        savedPlaceId: PLACE_A,
      });
      expect(fields.placeId).toBeNull();
      expect(fields.addressText).toBe("1 Main St, Nashville, TN 37203");
      expect(fields.lat).toBe(36.16);
      expect(fields.lng).toBe(-86.78);
    });

    it("leaving a link at the SAME address (venue group excluded) sends placeId: null alone", () => {
      const fields = buildCommunityUpdateFields({
        ...baseInput,
        location: PINNED,
        savedPlaceId: PLACE_A,
        include: { schedule: false, venue: false },
      });
      expect(fields.placeId).toBeNull();
      expect(geoKeysIn(fields)).toEqual([]);
    });

    it("an unlinked listing editing its typed address is unchanged: address, no placeId", () => {
      for (const savedPlaceId of [undefined, null]) {
        const fields = buildCommunityUpdateFields({
          ...baseInput,
          savedPlaceId,
        });
        expect("placeId" in fields).toBe(false);
        expect(fields).toEqual(buildCommunityUpdateFields(baseInput));
        expect(geoKeysIn(fields).sort()).toEqual([...GEO_KEYS].sort());
      }
    });

    it("an unlinked live listing with nothing moved sends no placeId and no address", () => {
      const fields = buildCommunityUpdateFields({
        ...baseInput,
        savedPlaceId: null,
        include: { schedule: false, venue: false },
      });
      expect("placeId" in fields).toBe(false);
      expect(geoKeysIn(fields)).toEqual([]);
    });
  });

  describe("diffCommunityMaterialGroups", () => {
    it("the stored link is no venue move", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: LINKED_A,
          saved: savedLinkedA,
        }).venue,
      ).toBe(false);
    });

    it("a new place at a different address is a venue move", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: PICKED_B,
          saved: savedLinkedA,
        }).venue,
      ).toBe(true);
    });

    it("a new place at the stored pin and the same street line is NOT a move", () => {
      // The server's rule (`addressVenueChanged`): the pin (> 50 m, or a pin
      // appearing) or the street line. The same street spelled differently
      // at the same spot sends no notice, so no confirm.
      const sameSpot: LocationState = {
        thPlaceId: PLACE_B,
        thPlaceName: "Same building, new name",
        addressText: "1 Main Street, Nashville TN",
        lat: 36.16,
        lng: -86.78,
        locality: "Nashville",
        region: "TN",
      };
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: sameSpot,
          saved: { ...savedLinkedA, placeId: null },
        }).venue,
      ).toBe(false);
    });

    it("a FIRST link (the listing was unlinked) at the same street line under 50 m away is NOT a move (no confirm)", () => {
      // 0.0003° of latitude is about 33 m.
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: {
            ...PICKED_B,
            addressText: "1 Main St, Nashville, TN",
            lat: 36.1603,
            lng: -86.78,
          },
          saved: { ...savedLinkedA, placeId: null },
        }).venue,
      ).toBe(false);
    });

    it("a FIRST link at the same street line with the pin 5 m off is quiet", () => {
      // 0.000045° of latitude is about 5 m.
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: {
            ...PICKED_B,
            addressText: "1 Main Street, Nashville, TN",
            lat: 36.160045,
            lng: -86.78,
          },
          saved: { ...savedLinkedA, placeId: null },
        }),
      ).toMatchObject({ venue: false });
    });

    it("moving from one place to ANOTHER at the same street line, pin 5 m off, IS a move (confirm)", () => {
      // Three rooms share 1 Cannery Row: the street line and the pin match,
      // and RSVPers still need to know which room. The server sends
      // VENUE_CHANGED for any change between two places.
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: {
            ...PICKED_B,
            addressText: "1 Main St, Nashville, TN 37203",
            postalCode: "37203",
            lat: 36.160045,
            lng: -86.78,
          },
          saved: savedLinkedA,
        }),
      ).toMatchObject({ venue: true, include: { venue: true } });
    });

    it("a new place NEXT DOOR (under 50 m, another street address) IS a move (confirm)", () => {
      // Two places 33 m apart are two venues: the street line says so, and
      // the server sends VENUE_CHANGED for it.
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: { ...PICKED_B, lat: 36.1603, lng: -86.78 },
          saved: savedLinkedA,
        }).venue,
      ).toBe(true);
    });

    it("a new place over 50 m away IS a move (confirm)", () => {
      // 0.0006° of latitude is about 67 m.
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: { ...PICKED_B, lat: 36.1606, lng: -86.78 },
          saved: savedLinkedA,
        }).venue,
      ).toBe(true);
    });

    it("a new place where the listing had no pin IS a move (a map appears)", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: PICKED_B,
          saved: { ...savedLinkedA, placeId: null, lat: null, lng: null },
        }).venue,
      ).toBe(true);
    });

    it("a new place with no pin counts as a move (over-warning is the safe side)", () => {
      expect(
        diffCommunityMaterialGroups({
          ...pending,
          location: { thPlaceId: PLACE_B, thPlaceName: "No pin" },
          saved: savedLinkedA,
        }).venue,
      ).toBe(true);
    });

    it("leaving a link: the typed address is sent when it differs, and moves when the pin or the street line does", () => {
      const same = diffCommunityMaterialGroups({
        ...pending,
        location: PINNED,
        saved: savedLinkedA,
      });
      expect(same.venue).toBe(false);
      expect(same.include.venue).toBe(false);

      const reformatted = diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, addressText: "1 Main Street, Nashville, TN, USA" },
        saved: savedLinkedA,
      });
      expect(reformatted.venue).toBe(false);
      expect(reformatted.include.venue).toBe(true);

      const newText = diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, addressText: "9 Elsewhere Ave" },
        saved: savedLinkedA,
      });
      expect(newText.venue).toBe(true);
      expect(newText.include.venue).toBe(true);

      const newPin = diffCommunityMaterialGroups({
        ...pending,
        location: { ...PINNED, addressText: "9 Elsewhere Ave", lat: 36.2 },
        saved: savedLinkedA,
      });
      expect(newPin.venue).toBe(true);
      expect(newPin.include.venue).toBe(true);
    });
  });
});

describe("communityPlaceRefusalMessageKey", () => {
  const refusal = (reason: string, appCode = "INVALID_INPUT") => ({
    message: "this place cannot be linked",
    data: { appCode, meta: { placeId: "p-1", reason } },
  });
  const lookup = (catalog: unknown, key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        catalog,
      );

  it.each([
    ["PLACE_WITHHOLDS_ADDRESS", "communityBuilder.errPlaceWithholdsAddress"],
    ["PLACE_LOCATION_INCOMPLETE", "communityBuilder.errPlaceLocationIncomplete"],
  ])("%s → %s, a real sentence in en and es that the toast shows as is", (reason, key) => {
    expect(communityPlaceRefusalMessageKey(refusal(reason))).toBe(key);
    for (const catalog of [en, es]) {
      const copy = lookup(catalog, key);
      expect(typeof copy).toBe("string");
      // `reportError` runs `{ message }` through `normalizeError`; a sentence
      // (capital + space) must come back untouched, not humanized.
      expect(normalizeError({ message: copy as string }).formError).toBe(copy);
    }
  });

  it("ignores other reasons, other codes, and errors with no meta", () => {
    expect(communityPlaceRefusalMessageKey(refusal("SOMETHING_ELSE"))).toBeNull();
    expect(
      communityPlaceRefusalMessageKey(
        refusal("PLACE_WITHHOLDS_ADDRESS", "PLACE_NOT_FOUND"),
      ),
    ).toBeNull();
    expect(
      communityPlaceRefusalMessageKey({ data: { appCode: "INVALID_INPUT" } }),
    ).toBeNull();
    expect(communityPlaceRefusalMessageKey(null)).toBeNull();
  });
});

describe("the other place refusals already have copy (no new keys)", () => {
  it.each([
    ["PLACE_NOT_FOUND", "placeNotFound"],
    ["PLACE_ARCHIVED", "placeArchived"],
    ["PLACE_NOT_ACTIVE", "placeNotActive"],
  ])("%s resolves to errors.%s", (appCode, leaf) => {
    const t = (key: string): string => {
      const value = lookup(en, key);
      return typeof value === "string" ? value : key;
    };
    const copy = (en as unknown as { errors: Record<string, string> }).errors[leaf];
    expect(typeof copy).toBe("string");
    expect(
      normalizeError({ message: "x", data: { appCode } }, t).formError,
    ).toBe(copy);
  });

  function lookup(catalog: unknown, key: string): unknown {
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        catalog,
      );
  }
});
