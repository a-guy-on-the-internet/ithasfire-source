import { describe, expect, it } from "vitest";

import {
  buildEmbedCalendarItems,
  buildVenueLabel,
  calendarThemeBridgeStyle,
  resolveCalendarEventClick,
  resolveEmbedPaintZone,
  type EmbedCalendarEvent,
  type EmbedCalendarThemeOverrides,
} from "./embed-calendar-helpers";
import { buildVenueLabel as buildListVenueLabel } from "./embed-helpers";
import type { EventItem } from "./embed-types";

const NO_OVERRIDES: EmbedCalendarThemeOverrides = {
  brandColor: null,
  bg: null,
  fontColor: null,
  accentColor: null,
};

describe("resolveCalendarEventClick", () => {
  it("routes an eligible event on a non-linkOut embed to the in-iframe checkout", () => {
    expect(
      resolveCalendarEventClick({
        linkOut: false,
        event: { checkoutEligible: true },
      }),
    ).toBe("checkout");
  });

  it("routes every click out when the embed is linkOut, even eligible events", () => {
    expect(
      resolveCalendarEventClick({
        linkOut: true,
        event: { checkoutEligible: true },
      }),
    ).toBe("linkOut");
  });

  it("routes an ineligible event out even on a non-linkOut embed", () => {
    expect(
      resolveCalendarEventClick({
        linkOut: false,
        event: { checkoutEligible: false },
      }),
    ).toBe("linkOut");
  });

  it("routes out when both linkOut and ineligible", () => {
    expect(
      resolveCalendarEventClick({
        linkOut: true,
        event: { checkoutEligible: false },
      }),
    ).toBe("linkOut");
  });

  it("fails safe to link-out when the clicked event is missing from the payload", () => {
    expect(
      resolveCalendarEventClick({ linkOut: false, event: undefined }),
    ).toBe("linkOut");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Theme bridge (FR-021). The `--hf-*` inputs are the frozen host contract; the
// semantic vars on the right are whatever the CURRENT engine paints with, so
// these assertions are the thing that catches an engine retarget.
// ─────────────────────────────────────────────────────────────────────────────

describe("calendarThemeBridgeStyle", () => {
  it("emits nothing when no knob is overridden (default palette preserved)", () => {
    expect(calendarThemeBridgeStyle(NO_OVERRIDES)).toEqual({});
  });

  it("maps accent → --accent/--accentSoft (today wash, now-line, published chips)", () => {
    const style = calendarThemeBridgeStyle({
      ...NO_OVERRIDES,
      accentColor: "FF0000",
    });
    expect(style).toEqual({
      "--accent": "var(--hf-accent)",
      "--accentSoft": "var(--hf-accent-soft)",
    });
    // Text links and the focus ring must stay AA / visible, so an arbitrary
    // host hex never reaches them.
    expect(style).not.toHaveProperty("--accentText");
    expect(style).not.toHaveProperty("--focus");
  });

  it("maps brand → the engine's structural rules, and NEVER --onStructure", () => {
    const style = calendarThemeBridgeStyle({
      ...NO_OVERRIDES,
      brandColor: "1A1A2E",
    });
    expect(style).toEqual({
      "--borderColor": "var(--hf-brand)",
      "--borderColorStrong": "var(--hf-brand)",
    });
    // The redesigned engine spends --onStructure on the TODAY square's numeral
    // over a fill made from --color. --hf-on-brand is picked against the
    // BRAND, so pointing it here could paint ink on ink — the brand knob stays
    // on the rules, where no text sits. The TEXT knob is the one that must
    // drive it (next test).
    expect(style).not.toHaveProperty("--onStructure");
  });

  it("maps fontColor → --color + the muted pair AND the --structure pair", () => {
    const style = calendarThemeBridgeStyle({
      ...NO_OVERRIDES,
      fontColor: "222222",
    });
    expect(style).toEqual({
      "--color": "var(--hf-text)",
      "--muted": "var(--hf-text-muted)",
      "--colorMuted": "var(--hf-text-muted)",
      "--structure": "var(--hf-text)",
      "--onStructure": "var(--hf-on-text)",
      "--accentText": "var(--hf-link)",
    });
    // --onStructure rides the TEXT knob, never the brand one: the TODAY square
    // and the selected dot-grid day fill a block with --color and print the
    // numeral on top, so the companion has to be picked against the FONT
    // colour. --hf-on-brand is picked against the brand and would paint ink on
    // ink (see the brand test above). Without this, ?bg=111111&fontColor=FFFFFF
    // gave a white block carrying the stub's near-white numeral, ~1.02:1.
    expect(style).not.toHaveProperty("--onStructure", "var(--hf-on-brand)");
    // Never --hf-bg either: with `bg` unset that property is never registered
    // and the declaration resolves to nothing.
    expect(style).not.toHaveProperty("--onStructure", "var(--hf-bg)");
  });

  /**
   * `.th-cal-action:hover` fills with --structure and labels in --onStructure.
   * Bridging only the foreground left `?fontColor=FFFFFF` with the stub's ink
   * fill (#211C16) under its own ink label (#181818) — 1.05:1 — safe only
   * because every action site happens to be internal-mode gated today. The
   * pair travels together instead (design-system-v2: migrate a fill and its
   * foreground as a unit), so no future public-mode action can inherit half of
   * it. --structure IS the ink on this surface, so it rides --hf-text and the
   * hover pair becomes #FFFFFF on #181818, 17.75:1.
   */
  it("bridges --structure WITH --onStructure — never one without the other", () => {
    for (const fontColor of ["FFFFFF", "222222", null]) {
      const style = calendarThemeBridgeStyle({ ...NO_OVERRIDES, fontColor });
      expect("--structure" in style).toBe("--onStructure" in style);
    }
    const white = calendarThemeBridgeStyle({ ...NO_OVERRIDES, fontColor: "FFFFFF" });
    expect(white).toMatchObject({
      "--structure": "var(--hf-text)",
      "--onStructure": "var(--hf-on-text)",
    });
    // Not the brand knob: --hf-on-brand is picked against the BRAND, so a
    // brand-only host would get a label chosen against a fill it never sits on.
    expect(calendarThemeBridgeStyle({ ...NO_OVERRIDES, brandColor: "1A1A2E" })).not.toHaveProperty(
      "--structure",
    );
  });

  it("maps bg → the wrapper fill AND --surface (the engine paints its own frame now)", () => {
    expect(calendarThemeBridgeStyle({ ...NO_OVERRIDES, bg: "FAFAFA" })).toEqual({
      "--surface": "var(--hf-bg)",
      background: "var(--hf-bg)",
    });
  });

  it("composes every active override at once", () => {
    expect(
      calendarThemeBridgeStyle({
        brandColor: "1A1A2E",
        bg: "FAFAFA",
        fontColor: "222222",
        accentColor: "FF0000",
      }),
    ).toEqual({
      "--borderColor": "var(--hf-brand)",
      "--borderColorStrong": "var(--hf-brand)",
      "--accent": "var(--hf-accent)",
      "--accentSoft": "var(--hf-accent-soft)",
      "--color": "var(--hf-text)",
      "--muted": "var(--hf-text-muted)",
      "--colorMuted": "var(--hf-text-muted)",
      "--structure": "var(--hf-text)",
      "--onStructure": "var(--hf-on-text)",
      "--accentText": "var(--hf-link)",
      "--surface": "var(--hf-bg)",
      background: "var(--hf-bg)",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payload → engine items
// ─────────────────────────────────────────────────────────────────────────────

const row = (over: Partial<EmbedCalendarEvent> = {}): EmbedCalendarEvent => ({
  id: "e1",
  title: "Doom Night",
  startsAt: new Date("2026-09-05T01:00:00.000Z"),
  endsAt: null,
  status: "PUBLISHED",
  slug: "doom-night",
  location: "The Cobra",
  city: "Nashville",
  region: "TN",
  timezone: "America/Chicago",
  occurrence: null,
  checkoutEligible: true,
  ...over,
});

/** A List-view card for the same event (only the place fields vary). */
const LIST_EVENT: EventItem = {
  id: "e1",
  title: "Doom Night",
  slug: "doom-night",
  startsAt: new Date("2026-09-05T01:00:00.000Z"),
  endsAt: null,
  currency: "usd",
  heroImageUrl: null,
  addressText: null,
  locality: null,
  region: null,
  lowestPriceCents: null,
  paidTierCount: 0,
  hasFreeTier: false,
  lowestBuyerTotalCents: null,
};

describe("buildVenueLabel: the List view's place line", () => {
  it("prefers the place label over the address and the city", () => {
    expect(
      buildVenueLabel({
        placeLabel: "The Paramount Theatre",
        location: "713 Congress Ave",
        city: "Austin",
        region: "TX",
      }),
    ).toBe("The Paramount Theatre");
    expect(
      buildVenueLabel({
        placeLabel: "  The Basement ",
        location: "123 Main St",
        city: "Nashville",
        region: "TN",
      }),
    ).toBe("The Basement");
  });

  it("falls through a whitespace-only, null or absent place label to the address", () => {
    const base = { location: "The Cobra", city: "Nashville", region: "TN" };
    expect(buildVenueLabel({ ...base, placeLabel: "   " })).toBe("The Cobra");
    expect(buildVenueLabel({ ...base, placeLabel: null })).toBe("The Cobra");
    // A cached payload from before the field shipped.
    expect(buildVenueLabel(base)).toBe("The Cobra");
  });

  it("falls back to city, region", () => {
    expect(
      buildVenueLabel({ location: null, city: "Nashville", region: "TN" }),
    ).toBe("Nashville, TN");
  });

  it("uses the city alone; a region alone is no place, as on the List card", () => {
    expect(buildVenueLabel({ location: null, city: "Nashville", region: null })).toBe(
      "Nashville",
    );
    // Was "TN"; the List card reads "Place TBA" for this row, so the
    // calendar omits the line rather than print a state code.
    expect(buildVenueLabel({ location: null, city: null, region: "TN" })).toBeNull();
  });

  it("returns null when the data has no place at all (line omitted)", () => {
    expect(buildVenueLabel({ location: null, city: null, region: null })).toBeNull();
    expect(
      buildVenueLabel({ placeLabel: null, location: "  ", city: null, region: null }),
    ).toBeNull();
  });

  it("agrees with the List card for the same event in every case", () => {
    const rows = [
      { placeLabel: "The Basement", location: "123 Main St", city: "Nashville", region: "TN" },
      { placeLabel: null, location: "123 Main St", city: "Nashville", region: "TN" },
      { placeLabel: null, location: null, city: "Nashville", region: "TN" },
      { placeLabel: null, location: null, city: "Nashville", region: null },
      { placeLabel: null, location: null, city: null, region: "TN" },
      { placeLabel: null, location: null, city: null, region: null },
    ];
    for (const r of rows) {
      const listCard = buildListVenueLabel({
        ...LIST_EVENT,
        placeLabel: r.placeLabel,
        addressText: r.location,
        locality: r.city,
        region: r.region,
      });
      // The calendar omits the line where the card says "Place TBA".
      expect(buildVenueLabel(r) ?? "Place TBA").toBe(listCard);
    }
  });

  it("feeds the engine's venueName from the place label", () => {
    const { items } = buildEmbedCalendarItems(
      [row({ placeLabel: "The Basement" })],
      { untitledLabel: "Untitled" },
    );
    expect(items[0]?.venueName).toBe("The Basement");
  });
});

describe("resolveEmbedPaintZone", () => {
  it("returns the fallback for an empty payload", () => {
    expect(resolveEmbedPaintZone([], "America/Chicago")).toBe("America/Chicago");
  });

  it("returns the majority zone, not the first one", () => {
    expect(
      resolveEmbedPaintZone(
        [
          { timezone: "America/New_York" },
          { timezone: "America/Chicago" },
          { timezone: "America/Chicago" },
        ],
        "UTC",
      ),
    ).toBe("America/Chicago");
  });

  it("breaks a tie on the first-seen zone (payload is soonest-first)", () => {
    expect(
      resolveEmbedPaintZone(
        [{ timezone: "America/New_York" }, { timezone: "America/Chicago" }],
        "UTC",
      ),
    ).toBe("America/New_York");
  });
});

describe("buildEmbedCalendarItems", () => {
  const opts = { untitledLabel: "Untitled event" };

  it("maps a published row onto an engine item, venue line and all", () => {
    const { items, sources } = buildEmbedCalendarItems([row()], opts);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "event",
      id: "e1",
      eventId: "e1",
      title: "Doom Night",
      status: "PUBLISHED",
      timezone: "America/Chicago",
      venueName: "The Cobra",
      occurrence: null,
    });
    expect(items[0]!.startsAt).toEqual(new Date("2026-09-05T01:00:00.000Z"));
    expect(sources.get("e1")).toBeDefined();
  });

  // PUBLISHED only (NFR-001). The belt is exactly as narrow as every leg of
  // the read, COMPLETED included — it is a backstop, not the gate, and a
  // backstop that admits more than the gate is not one.
  it("never paints a non-public status on an unauthenticated surface", () => {
    const { items } = buildEmbedCalendarItems(
      [
        row({ id: "draft", status: "DRAFT" }),
        row({ id: "cancelled", status: "CANCELLED" }),
        row({ id: "unknown", status: "PRIVATE" }),
        row({ id: "done", status: "COMPLETED" }),
        row({ id: "live", status: "PUBLISHED" }),
      ],
      opts,
    );
    expect(items.map((i) => i.id)).toEqual(["live"]);
  });

  it("drops a row with no start (there is no cell to paint it in)", () => {
    expect(buildEmbedCalendarItems([row({ startsAt: null })], opts).items).toEqual([]);
  });

  it("accepts ISO strings as well as revived Dates", () => {
    const { items } = buildEmbedCalendarItems(
      [row({ startsAt: "2026-09-05T01:00:00.000Z", endsAt: "2026-09-05T04:00:00.000Z" })],
      opts,
    );
    expect(items[0]!.startsAt).toEqual(new Date("2026-09-05T01:00:00.000Z"));
    expect(items[0]!.endsAt).toEqual(new Date("2026-09-05T04:00:00.000Z"));
  });

  it("gives every EventDate occurrence its own chip id while eventId stays the parent's", () => {
    const { items, sources } = buildEmbedCalendarItems(
      [
        row({
          startsAt: new Date("2026-09-05T01:00:00.000Z"),
          occurrence: { index: 1, total: 2, eventDateId: "d1" },
          checkoutEligible: false,
        }),
        row({
          startsAt: new Date("2026-09-06T01:00:00.000Z"),
          occurrence: { index: 2, total: 2, eventDateId: "d2" },
          checkoutEligible: true,
        }),
      ],
      opts,
    );
    expect(items.map((i) => i.id)).toEqual(["e1:d1", "e1:d2"]);
    expect(items.every((i) => i.eventId === "e1")).toBe(true);
    expect(items.map((i) => i.occurrence)).toEqual([
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ]);
    // Per-occurrence eligibility survives the round trip — the click resolver
    // must see the night that was pressed, not the event's first night.
    expect(sources.get("e1:d1")!.checkoutEligible).toBe(false);
    expect(sources.get("e1:d2")!.checkoutEligible).toBe(true);
  });

  it("falls back to the untitled label rather than an empty accessible name", () => {
    const { items } = buildEmbedCalendarItems([row({ title: null })], opts);
    expect(items[0]!.title).toBe("Untitled event");
  });

  it("leaves soldOut and href unset (the payload carries neither)", () => {
    const { items } = buildEmbedCalendarItems([row()], opts);
    expect(items[0]!.soldOut).toBeUndefined();
    expect(items[0]!.href).toBeUndefined();
  });
});

describe("buildEmbedCalendarItems: soldOut + priceLabel (FR-022 / FR-023)", () => {
  const build = (over: Partial<EmbedCalendarEvent>) =>
    buildEmbedCalendarItems([row(over)], { untitledLabel: "Untitled event" }).items[0]!;

  it("passes the server's sold-out flag straight through", () => {
    expect(build({ soldOut: true }).soldOut).toBe(true);
    expect(build({ soldOut: false }).soldOut).toBe(false);
  });

  it("leaves soldOut UNDEFINED on a payload that predates the core widening", () => {
    // Not `false`: undefined lets the engine's sold/capacity derivation run,
    // where an asserted `false` would claim tickets are available.
    expect(build({}).soldOut).toBeUndefined();
  });

  it("passes the price label through, and normalizes absence to null", () => {
    expect(build({ priceLabel: "From $15" }).priceLabel).toBe("From $15");
    expect(build({ priceLabel: null }).priceLabel).toBeNull();
    expect(build({}).priceLabel).toBeNull();
  });

  it("never invents sold/capacity counts for an unauthenticated surface", () => {
    const item = build({ soldOut: true });
    expect(item.ticketsSold).toBeUndefined();
    expect(item.totalCapacity).toBeUndefined();
  });

  it("carries both onto every occurrence of a multi-date listing", () => {
    const { items } = buildEmbedCalendarItems(
      [
        row({ occurrence: { index: 1, total: 2, eventDateId: "d1" }, soldOut: true, priceLabel: "$25" }),
        row({
          startsAt: new Date("2026-09-12T01:00:00.000Z"),
          occurrence: { index: 2, total: 2, eventDateId: "d2" },
          soldOut: false,
          priceLabel: "$30",
        }),
      ],
      { untitledLabel: "Untitled event" },
    );
    expect(items.map((i) => i.soldOut)).toEqual([true, false]);
    expect(items.map((i) => i.priceLabel)).toEqual(["$25", "$30"]);
  });
});

describe("buildEmbedCalendarItems: the price line in the viewer's language (F3)", () => {
  const SPANISH = {
    free: "Gratis",
    freePlus: "Gratis+",
    payWhatYouWant: "Paga lo que quieras",
    fromPrice: (amount: string) => `Desde ${amount}`,
  };
  const build = (over: Partial<EmbedCalendarEvent>, priceWords = SPANISH) =>
    buildEmbedCalendarItems([row(over)], {
      untitledLabel: "Untitled event",
      priceWords,
    }).items[0]!;

  it("words the structured price instead of printing the English label", () => {
    expect(
      build({
        priceLabel: "From $15",
        listingPrice: { kind: "amount", cents: 1500, currency: "USD", from: true },
      }).priceLabel,
    ).toBe("Desde $15");
    expect(
      build({ priceLabel: "Free", listingPrice: { kind: "free" } }).priceLabel,
    ).toBe("Gratis");
    expect(
      build({ priceLabel: "Free+", listingPrice: { kind: "freePlus" } })
        .priceLabel,
    ).toBe("Gratis+");
    expect(
      build({
        priceLabel: "Pay what you want",
        listingPrice: { kind: "payWhatYouWant" },
      }).priceLabel,
    ).toBe("Paga lo que quieras");
  });

  it("null listingPrice is no price line; an older payload keeps its English label", () => {
    expect(build({ priceLabel: null, listingPrice: null }).priceLabel).toBeNull();
    expect(build({ priceLabel: "From $15" }).priceLabel).toBe("From $15");
  });

  it("defaults to English words when the mount passes none", () => {
    const item = buildEmbedCalendarItems(
      [row({ listingPrice: { kind: "payWhatYouWant" }, priceLabel: "x" })],
      { untitledLabel: "Untitled event" },
    ).items[0]!;
    expect(item.priceLabel).toBe("Pay what you want");
  });
});
