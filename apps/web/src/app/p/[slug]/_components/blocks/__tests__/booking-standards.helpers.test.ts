import { describe, expect, it } from "vitest";

import { BOOKING_STANDARDS_PLATFORM_DEFAULTS } from "@th/core/use-cases/booking-standards/platform-defaults";
import {
  BOOKING_STANDARD_FIELDS,
  isFieldSatisfied,
} from "@th/core/use-cases/booking-standards/standard-fields";
import { unmetRequiredStandards } from "@th/core/use-cases/booking-standards/resolve-booking-standards";
import { flattenCatalog } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";
import {
  buildStandardsChecklist,
  countOutlineBrackets,
  firstOutlineBracketRange,
  labelForSentence,
  normaliseOutline,
  resolveStandardsList,
  shouldOfferOutline,
  unmetRequiredFields,
  type BookingStandardsList,
} from "../booking-standards.helpers";
import type { BookingBillActDraft } from "../booking-bill.helpers";
import {
  buildBookingRequestPayloadWithBill,
  buildSpaceRequestPayload,
  mapCreateBookingRequestError,
  pitchStandardsPayload,
  readStandardsUnmet,
  spaceStandardsPayload,
  type BookingRequestFormValues,
} from "../request-to-play-form.helpers";

/**
 * venue-booking-standards FR-005: the rail's model, the live payload it reads,
 * and — the risk the spec names — that the client and the server agree on
 * "satisfied" and on "unmet REQUIRED" for the same pitch.
 */

const translate = (key: string) => `t:${key}`;

const MARROW: BookingStandardsList = {
  standards: [
    {
      source: "place",
      field: "LINK_MUSIC",
      requirement: "REQUIRED",
      label: "A link to your music",
      hint: "Bandcamp, Spotify, SoundCloud, or anywhere we can listen.",
    },
    {
      source: "place",
      field: "EXPECTED_DRAW",
      requirement: "SUGGESTED",
      label: "How many people you usually bring",
      hint: null,
    },
    {
      source: "place",
      field: "SET_LENGTH",
      requirement: "SUGGESTED",
      label: "How long you want to play",
      hint: "Openers play 30.",
    },
    {
      source: "place",
      field: "CUSTOM",
      requirement: "SUGGESTED",
      label: "No covers nights",
      hint: null,
    },
  ],
  examples: [
    { source: "place", title: "Our favourite pitch", body: "Hi, we are…" },
    {
      source: "platform",
      titleKey: "bookingStandards.platform.perform.exampleOne.title",
      bodyKey: "bookingStandards.platform.perform.exampleOne.body",
    },
  ],
};

const BASE: BookingRequestFormValues = {
  message: "Hello there, we would love a night.",
  preferredDates: ["2027-03-06"],
  expectedDraw: "",
  genre: "",
  actName: "",
  lineupSize: "",
  setLengthMinutes: "",
  contactPhone: "",
  techNeeds: "",
  feeType: "",
  feeAmountDollars: "",
  linkMusic: "",
  linkVideo: "",
  linkSocial: "",
  linkEpk: "",
  senderOwnerType: "human",
  senderOwnerId: "human-1",
  billIncludeSelf: true,
  billActs: [],
};

const EXTERNAL_ACT: BookingBillActDraft = {
  key: "a1",
  kind: "external",
  name: "The Openers",
  url: "",
  role: "PERFORMER",
  customRoleLabel: "",
};

describe("buildStandardsChecklist", () => {
  it("platform defaults: every item suggested, copy rendered from keys, nothing blocks", () => {
    const list: BookingStandardsList = {
      standards: BOOKING_STANDARDS_PLATFORM_DEFAULTS.PERFORM.items.map((item) => ({
        source: "platform" as const,
        ...item,
      })),
      examples: BOOKING_STANDARDS_PLATFORM_DEFAULTS.PERFORM.examples.map(
        (example) => ({ source: "platform" as const, ...example }),
      ),
    };
    const checklist = buildStandardsChecklist({
      list,
      intent: "PERFORM",
      payload: pitchStandardsPayload(BASE),
      translate,
    });
    expect(checklist.items.length).toBeGreaterThan(0);
    expect(checklist.items.every((item) => !item.required)).toBe(true);
    expect(checklist.items[0]!.label.startsWith("t:bookingStandards.platform.")).toBe(
      true,
    );
    expect(checklist.unmetRequired).toEqual([]);
    expect(checklist.total).toBe(checklist.items.length);
    expect(checklist.examples.every((e) => e.source === "platform")).toBe(true);
  });

  it("a place list: required unmet, suggested done, custom lines kept out of the count", () => {
    const checklist = buildStandardsChecklist({
      list: MARROW,
      intent: "PERFORM",
      payload: pitchStandardsPayload({ ...BASE, expectedDraw: "70" }),
      translate,
    });
    expect(checklist.items.map((i) => [i.field, i.required, i.satisfied])).toEqual([
      ["LINK_MUSIC", true, false],
      ["EXPECTED_DRAW", false, true],
      ["SET_LENGTH", false, false],
    ]);
    // "1 of 3 done": the custom line is not one of the three.
    expect(checklist.done).toBe(1);
    expect(checklist.total).toBe(3);
    expect(checklist.customLines).toEqual([
      { label: "No covers nights", hint: null },
    ]);
    expect(checklist.unmetRequired.map((i) => i.field)).toEqual(["LINK_MUSIC"]);
  });

  it("a required item met clears the block and counts as done", () => {
    const checklist = buildStandardsChecklist({
      list: MARROW,
      intent: "PERFORM",
      payload: pitchStandardsPayload({
        ...BASE,
        linkMusic: "https://lowporch.bandcamp.com",
      }),
      translate,
    });
    expect(checklist.unmetRequired).toEqual([]);
    expect(checklist.done).toBe(1);
  });

  it("a URL the builder would refuse does NOT tick (contract 1: never raw text)", () => {
    const checklist = buildStandardsChecklist({
      list: MARROW,
      intent: "PERFORM",
      payload: pitchStandardsPayload({ ...BASE, linkMusic: "bandcamp" }),
      translate,
    });
    expect(checklist.unmetRequired.map((i) => i.field)).toEqual(["LINK_MUSIC"]);
  });

  it("only CUSTOM lines: no count, nothing blocks", () => {
    const checklist = buildStandardsChecklist({
      list: { standards: [MARROW.standards[3]!], examples: [] },
      intent: "PERFORM",
      payload: pitchStandardsPayload(BASE),
      translate,
    });
    expect(checklist.total).toBe(0);
    expect(checklist.customLines).toHaveLength(1);
    expect(checklist.unmetRequired).toEqual([]);
  });

  it("REQUIRED on a field that can never be required (MESSAGE) is shown as suggested", () => {
    const checklist = buildStandardsChecklist({
      list: {
        standards: [
          {
            source: "place",
            field: "MESSAGE",
            requirement: "REQUIRED",
            label: "Tell us about you",
            hint: null,
          },
        ],
        examples: [],
      },
      intent: "PERFORM",
      payload: pitchStandardsPayload({ ...BASE, message: "" }),
      translate,
    });
    expect(checklist.items[0]!.required).toBe(false);
    expect(checklist.unmetRequired).toEqual([]);
  });

  it("drops unknown fields and fields this intent's form does not have", () => {
    const checklist = buildStandardsChecklist({
      list: {
        standards: [
          {
            source: "place",
            field: "FROM_THE_FUTURE" as never,
            requirement: "REQUIRED",
            label: "?",
            hint: null,
          },
          {
            source: "place",
            field: "PURPOSE",
            requirement: "SUGGESTED",
            label: "What the event is",
            hint: null,
          },
          MARROW.standards[0]!,
        ],
        examples: [],
      },
      intent: "PERFORM",
      payload: pitchStandardsPayload(BASE),
      translate,
    });
    expect(checklist.items.map((i) => i.field)).toEqual(["LINK_MUSIC"]);
  });

  it("BILL: the sender alone does not satisfy it; one other act does", () => {
    const list: BookingStandardsList = {
      standards: [
        {
          source: "calendar",
          field: "BILL",
          requirement: "REQUIRED",
          label: "The other acts on the night",
          hint: null,
        },
      ],
      examples: [],
    };
    const alone = buildStandardsChecklist({
      list,
      intent: "PERFORM",
      payload: pitchStandardsPayload(BASE),
      translate,
    });
    expect(alone.unmetRequired.map((i) => i.field)).toEqual(["BILL"]);
    const withAct = buildStandardsChecklist({
      list,
      intent: "PERFORM",
      payload: pitchStandardsPayload({ ...BASE, billActs: [EXTERNAL_ACT] }),
      translate,
    });
    expect(withAct.unmetRequired).toEqual([]);
    expect(withAct.items[0]!.satisfied).toBe(true);
  });

  it("examples keep the wire order (place first) and render platform keys", () => {
    const checklist = buildStandardsChecklist({
      list: MARROW,
      intent: "PERFORM",
      payload: pitchStandardsPayload(BASE),
      translate,
    });
    expect(checklist.examples.map((e) => [e.source, e.title])).toEqual([
      ["place", "Our favourite pitch"],
      ["platform", "t:bookingStandards.platform.perform.exampleOne.title"],
    ]);
  });
});

describe("client and server agree (risk: client and server disagree on satisfied)", () => {
  const cases: [string, BookingRequestFormValues][] = [
    ["bare", BASE],
    [
      "everything filled",
      {
        ...BASE,
        expectedDraw: "45",
        genre: "Folk",
        lineupSize: "4",
        setLengthMinutes: "45",
        techNeeds: "Two vocal mics",
        feeType: "GUARANTEE",
        feeAmountDollars: "200",
        linkMusic: "https://example.com/music",
        linkVideo: "https://example.com/video",
        linkSocial: "https://example.com/social",
        linkEpk: "https://example.com/epk",
        billActs: [EXTERNAL_ACT],
      },
    ],
    ["whitespace only", { ...BASE, genre: "   ", techNeeds: "\n\t" }],
    ["negotiable fee, no amount", { ...BASE, feeType: "NEGOTIABLE" }],
    [
      "off the bill, one act",
      { ...BASE, billIncludeSelf: false, billActs: [EXTERNAL_ACT] },
    ],
  ];

  it.each(cases)("%s: isFieldSatisfied matches on the live and the built payload", (_name, values) => {
    const built = buildBookingRequestPayloadWithBill(values);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const live = pitchStandardsPayload(values);
    for (const field of BOOKING_STANDARD_FIELDS) {
      expect(
        isFieldSatisfied(field, live),
        `${field} live vs built`,
      ).toBe(isFieldSatisfied(field, built.payload));
    }
  });

  it.each(cases)("%s: the rail's unmet REQUIRED list is the server's", (_name, values) => {
    const built = buildBookingRequestPayloadWithBill(values);
    if (!built.ok) throw new Error("fixture must build");
    const everyRequired: BookingStandardsList = {
      standards: [
        "EXPECTED_DRAW",
        "GENRE",
        "LINEUP_SIZE",
        "SET_LENGTH",
        "TECH_NEEDS",
        "FEE",
        "LINK_MUSIC",
        "LINK_VIDEO",
        "LINK_SOCIAL",
        "LINK_EPK",
        "BILL",
      ].map((field) => ({
        source: "place" as const,
        field: field as never,
        requirement: "REQUIRED" as const,
        label: field,
        hint: null,
      })),
      examples: [],
    };
    const server = unmetRequiredStandards(everyRequired.standards, built.payload).map(
      (s) => s.field,
    );
    expect(unmetRequiredFields(everyRequired, built.payload)).toEqual(server);
    const rail = buildStandardsChecklist({
      list: everyRequired,
      intent: "PERFORM",
      payload: pitchStandardsPayload(values),
      translate,
    });
    expect(rail.unmetRequired.map((i) => i.field)).toEqual(server);
  });

  it("the space form's live payload agrees with its builder too", () => {
    const values = {
      date: "2027-03-06",
      startTime: "19:00",
      endTime: "01:00",
      purpose: "Album release",
      expectedAttendance: "120",
      contactPhone: "",
      timeZone: "America/Chicago",
    };
    const built = buildSpaceRequestPayload({
      ...values,
      intent: "RENT",
      calendarId: "cal-1",
    });
    if (!built.ok) throw new Error("fixture must build");
    const live = spaceStandardsPayload(values);
    for (const field of BOOKING_STANDARD_FIELDS) {
      expect(isFieldSatisfied(field, live), field).toBe(
        isFieldSatisfied(field, built.payload),
      );
    }
    expect(live.requestedEndsAt).toBe(built.payload.requestedEndsAt);
  });

  it("the window reads as not given until the place's zone loads", () => {
    const live = spaceStandardsPayload({
      date: "2027-03-06",
      startTime: "19:00",
      endTime: "23:00",
      purpose: "x",
      expectedAttendance: "",
      contactPhone: "",
      timeZone: null,
    });
    expect(isFieldSatisfied("REQUESTED_WINDOW", live)).toBe(false);
  });
});

describe("resolveStandardsList", () => {
  const place = { PERFORM: { standards: [], examples: [] } };
  it("the routed calendar's own list wins", () => {
    expect(
      resolveStandardsList({
        calendar: { standards: { PERFORM: MARROW } },
        placeStandards: place,
        intent: "PERFORM",
      }),
    ).toBe(MARROW);
  });
  it("an unrouted pitch is held to the place-wide list", () => {
    expect(
      resolveStandardsList({ calendar: null, placeStandards: place, intent: "PERFORM" }),
    ).toBe(place.PERFORM);
  });
  it("null when nothing carries a list", () => {
    expect(
      resolveStandardsList({ calendar: {}, placeStandards: null, intent: "RENT" }),
    ).toBeNull();
  });
});

describe("STANDARDS_UNMET", () => {
  const err = {
    message: "STANDARDS_UNMET",
    data: {
      appCode: "STANDARDS_UNMET",
      meta: {
        items: [
          { field: "LINK_MUSIC", label: "A link to your music" },
          { field: "BILL", label: "  " },
          { nonsense: true },
        ],
      },
    },
  };

  it("reads the place's labels off the refusal, skipping unusable entries", () => {
    expect(readStandardsUnmet(err)).toEqual([
      { field: "LINK_MUSIC", label: "A link to your music" },
    ]);
  });

  it("is null for any other error", () => {
    expect(
      readStandardsUnmet({ data: { appCode: "DUPLICATE_OPEN_REQUEST" } }),
    ).toBeNull();
  });

  it("an empty meta is still a STANDARDS_UNMET (the form falls back to the generic copy)", () => {
    expect(readStandardsUnmet({ data: { appCode: "STANDARDS_UNMET" } })).toEqual([]);
  });

  it("maps to its own copy, not the generic 'Couldn't send'", () => {
    expect(mapCreateBookingRequestError(err)).toBe("admin.bkErrStandardsUnmet");
  });
});

describe("pitch outline (FR-010)", () => {
  const en = flattenCatalog(enMessages) as Record<string, string>;
  const es = flattenCatalog(esMessages) as Record<string, string>;
  const KEY = "bookingStandards.platform.perform.outline";

  it("the catalog outline is five bracketed prompts, one per line, in en and es", () => {
    for (const catalog of [en, es]) {
      const outline = normaliseOutline(catalog[KEY]!);
      expect(outline.split("\n")).toHaveLength(5);
      expect(countOutlineBrackets(outline)).toBe(5);
    }
    expect(normaliseOutline(en[KEY]!).split("\n")[0]).toBe("[Who you are, in a line]");
  });

  it("counts what is left as prompts are replaced; empty brackets are not prompts", () => {
    const outline = normaliseOutline(en[KEY]!);
    const one = outline.replace("[Why this room]", "Your sound system is the best in town.");
    expect(countOutlineBrackets(one)).toBe(4);
    expect(countOutlineBrackets("a [] b [ ] c")).toBe(0);
    expect(countOutlineBrackets("no prompts")).toBe(0);
  });

  it("selects the first prompt to type over", () => {
    expect(firstOutlineBracketRange("Hi\n[Why this room]\n[x]")).toEqual({
      start: 3,
      end: 18,
    });
    expect(firstOutlineBracketRange("done")).toBeNull();
  });

  it("is offered only while the message is empty", () => {
    expect(shouldOfferOutline("")).toBe(true);
    expect(shouldOfferOutline("  \n ")).toBe(true);
    expect(shouldOfferOutline("Hi, we are Low Porch")).toBe(false);
  });
});

describe("labelForSentence", () => {
  it("drops a trailing period so the sentence frame adds exactly one", () => {
    expect(labelForSentence("A link to your music.")).toBe("A link to your music");
    expect(labelForSentence("  No covers nights ")).toBe("No covers nights");
  });
});
