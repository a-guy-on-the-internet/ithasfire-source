import { describe, expect, it } from "vitest";

import {
  deriveEventDetailMode,
  deriveTicketTierState,
  formatEventZonedInstant,
  isSuggestEditVisible,
} from "../event-detail.helpers";

describe("deriveEventDetailMode", () => {
  it("keeps the ticketed path for ticketed sellable events", () => {
    expect(
      deriveEventDetailMode({
        attendanceMode: "TICKETED",
        hideTicketCta: false,
        sellabilityReason: "ok",
      }),
    ).toEqual({
      isRsvp: false,
      hideTicketCta: false,
      showPaymentSetupNotice: false,
      showSalesClosedNotice: false,
    });
  });

  it("shows the payment-setup notice for ticketed no_payee events", () => {
    const mode = deriveEventDetailMode({
      attendanceMode: "TICKETED",
      hideTicketCta: true,
      sellabilityReason: "no_payee",
    });
    expect(mode.showPaymentSetupNotice).toBe(true);
    expect(mode.hideTicketCta).toBe(true);
  });

  it("shows the payment-setup notice for stripe_not_connected", () => {
    expect(
      deriveEventDetailMode({
        attendanceMode: "TICKETED",
        sellabilityReason: "stripe_not_connected",
      }).showPaymentSetupNotice,
    ).toBe(true);
  });

  it("shows the sales-closed notice for ticketed sales_closed events", () => {
    expect(
      deriveEventDetailMode({
        attendanceMode: "TICKETED",
        hideTicketCta: true,
        sellabilityReason: "sales_closed",
      }).showSalesClosedNotice,
    ).toBe(true);
  });

  // The critical correctness fix: RSVP events have no payee BY DESIGN, so
  // the organizer-facing "payment setup required" banner must never leak.
  it("never shows the payment-setup notice for RSVP events (no_payee by design)", () => {
    const mode = deriveEventDetailMode({
      attendanceMode: "RSVP",
      hideTicketCta: true,
      sellabilityReason: "no_payee",
    });
    expect(mode.isRsvp).toBe(true);
    expect(mode.showPaymentSetupNotice).toBe(false);
    expect(mode.showSalesClosedNotice).toBe(false);
  });

  it("suppresses every ticketed banner for RSVP regardless of reason", () => {
    for (const sellabilityReason of [
      "ok",
      "free",
      "no_payee",
      "stripe_not_connected",
      "sales_closed",
    ] as const) {
      const mode = deriveEventDetailMode({
        attendanceMode: "RSVP",
        sellabilityReason,
      });
      expect(mode.showPaymentSetupNotice).toBe(false);
      expect(mode.showSalesClosedNotice).toBe(false);
    }
  });

  it("always hides the ticket CTA for RSVP events, even when the caller did not", () => {
    expect(
      deriveEventDetailMode({ attendanceMode: "RSVP", hideTicketCta: false })
        .hideTicketCta,
    ).toBe(true);
  });

  it("defaults to the pre-community ticketed behavior", () => {
    expect(deriveEventDetailMode({}).isRsvp).toBe(false);
  });
});

describe("isSuggestEditVisible", () => {
  // Suggest-edits are COMMUNITY-listings-only as of 2026-07-20 (FR-006's
  // universality reversed; the backend rejects OWNED suggestions too).
  it("is visible on COMMUNITY published public ungated events", () => {
    expect(
      isSuggestEditVisible({ status: "PUBLISHED", stewardship: "COMMUNITY" }),
    ).toBe(true);
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        gateType: "NONE",
        stewardship: "COMMUNITY",
      }),
    ).toBe(true);
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        gateType: null,
        stewardship: "COMMUNITY",
      }),
    ).toBe(true);
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        visibility: "PUBLIC",
        gateType: "NONE",
        stewardship: "COMMUNITY",
      }),
    ).toBe(true);
    // Legacy payloads without the field keep the pre-visibility behavior.
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        visibility: null,
        stewardship: "COMMUNITY",
      }),
    ).toBe(true);
  });

  it("is hidden on OWNED events, even otherwise-identical published public ones", () => {
    expect(
      isSuggestEditVisible({ status: "PUBLISHED", stewardship: "OWNED" }),
    ).toBe(false);
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        visibility: "PUBLIC",
        gateType: "NONE",
        stewardship: "OWNED",
      }),
    ).toBe(false);
  });

  it("is hidden for drafts and cancelled events", () => {
    expect(
      isSuggestEditVisible({ status: "DRAFT", stewardship: "COMMUNITY" }),
    ).toBe(false);
    expect(
      isSuggestEditVisible({ status: "CANCELLED", stewardship: "COMMUNITY" }),
    ).toBe(false);
  });

  it("is hidden for PRIVATE published events (submission would dead-end)", () => {
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        visibility: "PRIVATE",
        stewardship: "COMMUNITY",
      }),
    ).toBe(false);
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        visibility: "PRIVATE",
        gateType: "NONE",
        stewardship: "COMMUNITY",
      }),
    ).toBe(false);
  });

  it("is hidden for gated events even when the viewer can see the page", () => {
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        gateType: "PASSWORD",
        stewardship: "COMMUNITY",
      }),
    ).toBe(false);
    expect(
      isSuggestEditVisible({
        status: "PUBLISHED",
        gateType: "APPLICATION",
        stewardship: "COMMUNITY",
      }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-010 — per-tier sale state, and Q-002's scheduled-price copy
// ─────────────────────────────────────────────────────────────────────────────

const OPENS_AT = new Date("2026-10-09T15:00:00.000Z"); // 10:00 AM CDT, Oct 9
const CLOSED_AT = new Date("2026-09-01T15:00:00.000Z");
const FLIPS_AT = new Date("2026-10-03T20:00:00.000Z");

describe("deriveTicketTierState", () => {
  it("NFR-001: an omitted sellability renders exactly as before FR-010", () => {
    // A cached payload, a story, or any caller that hasn't threaded it yet.
    // Buyable, no notice — today's render.
    expect(deriveTicketTierState({})).toEqual({
      isBuyable: true,
      availability: null,
      priceChange: null,
    });
  });

  it("NFR-001: an unwindowed tier core reported as ok is buyable and silent", () => {
    expect(
      deriveTicketTierState({
        sellability: {
          available: true,
          reason: "ok",
          opensAt: null,
          closedAt: null,
        },
      }),
    ).toEqual({ isBuyable: true, availability: null, priceChange: null });
  });

  it("surfaces not_yet_on_sale WITH the open instant", () => {
    expect(
      deriveTicketTierState({
        sellability: {
          available: false,
          reason: "not_yet_on_sale",
          opensAt: OPENS_AT,
        },
      }),
    ).toEqual({
      isBuyable: false,
      availability: { reason: "not_yet_on_sale", opensAt: OPENS_AT },
      priceChange: null,
    });
  });

  it("surfaces sales_ended", () => {
    const state = deriveTicketTierState({
      sellability: {
        available: false,
        reason: "sales_ended",
        closedAt: CLOSED_AT,
      },
    });
    expect(state.isBuyable).toBe(false);
    expect(state.availability).toEqual({
      reason: "sales_ended",
      closedAt: CLOSED_AT,
    });
  });

  it("accepts ISO-string instants as well as Dates", () => {
    const state = deriveTicketTierState({
      sellability: {
        available: false,
        reason: "not_yet_on_sale",
        opensAt: OPENS_AT.toISOString(),
      },
    });
    expect(state.availability).toEqual({
      reason: "not_yet_on_sale",
      opensAt: OPENS_AT,
    });
  });

  it("renders NO per-row notice for an event-WIDE refusal", () => {
    // The page already banners each of these once via deriveEventDetailMode.
    // Repeating "Sales ended" on four rows reads as four separate problems.
    for (const reason of [
      "no_payee",
      "stripe_not_connected",
      "sales_closed",
    ] as const) {
      const state = deriveTicketTierState({
        sellability: { available: false, reason },
      });
      expect(state.availability, reason).toBeNull();
      // …but the row still knows it cannot be bought.
      expect(state.isBuyable, reason).toBe(false);
    }
  });

  it("never renders a not-yet-on-sale row as buyable, even with a broken instant", () => {
    // The one wrong answer would be to fall through to "buyable" because the
    // date could not be read.
    const state = deriveTicketTierState({
      sellability: {
        available: false,
        reason: "not_yet_on_sale",
        opensAt: "nonsense",
      },
    });
    expect(state.isBuyable).toBe(false);
    expect(state.availability).toEqual({
      reason: "sales_ended",
      closedAt: null,
    });
  });

  it("carries the pending price change alongside the availability state", () => {
    const state = deriveTicketTierState({
      sellability: {
        available: false,
        reason: "not_yet_on_sale",
        opensAt: OPENS_AT,
      },
      upcomingPriceChange: { toPriceCents: 2000, at: FLIPS_AT },
    });
    expect(state.priceChange).toEqual({ toPriceCents: 2000, at: FLIPS_AT });
    expect(state.availability).toEqual({
      reason: "not_yet_on_sale",
      opensAt: OPENS_AT,
    });
  });

  it("offers NOTHING once the flip has passed — core sends null, and null it stays", () => {
    // The "keep it honest" requirement. This helper never re-derives the flip
    // from the browser clock, so after the flip there is simply nothing to say.
    expect(
      deriveTicketTierState({ upcomingPriceChange: null }).priceChange,
    ).toBeNull();
    expect(deriveTicketTierState({}).priceChange).toBeNull();
  });
});

describe("formatEventZonedInstant", () => {
  // The real Intl, with a fixed locale so assertions are stable.
  const fmt = (value: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", options).format(value);

  it("renders on the EVENT's clock, not the reader's", () => {
    const label = formatEventZonedInstant(OPENS_AT, "America/Chicago", fmt);
    expect(label).toContain("Oct 9");
    expect(label).toContain("10:00");
    // `timeZoneName: short` is load-bearing: without it "10:00 AM" is
    // unfalsifiable to a reader in another zone.
    expect(label).toContain("CDT");
  });

  it("renders the SAME instant differently for a different event zone", () => {
    const chicago = formatEventZonedInstant(OPENS_AT, "America/Chicago", fmt);
    const london = formatEventZonedInstant(OPENS_AT, "Europe/London", fmt);
    expect(chicago).not.toEqual(london);
    // en-US only carries "short" ABBREVIATIONS for US zones; everything else
    // renders as a GMT offset, which is exactly as unambiguous. Asserted as
    // the offset rather than "BST" so this pins the behaviour ICU actually
    // has rather than the one it would be nice for it to have.
    expect(london).toContain("4:00");
    expect(london).toContain("GMT+1");
  });

  it("DST, fall back: an instant after the transition reads CST, not CDT", () => {
    // 2026-11-01T08:00Z is 2:00 AM CST in Chicago — one hour AFTER the 01:00
    // fall-back. A single-probe resolver (the builder's own `toIsoInTimeZone`
    // bug) would call this 3:00 AM CDT. Intl-per-instant gets it right.
    const label = formatEventZonedInstant(
      new Date("2026-11-01T08:00:00.000Z"),
      "America/Chicago",
      fmt,
    );
    expect(label).toContain("2:00");
    expect(label).toContain("CST");
  });

  it("DST, spring forward: an instant after the transition reads CDT", () => {
    // 2026-03-08T08:00:00Z → 3:00 AM CDT (the 2 AM hour does not exist).
    const label = formatEventZonedInstant(
      new Date("2026-03-08T08:00:00.000Z"),
      "America/Chicago",
      fmt,
    );
    expect(label).toContain("3:00");
    expect(label).toContain("CDT");
  });

  it("DST in the SOUTHERN hemisphere, where the transitions run the other way", () => {
    // Sydney falls back at 03:00 on 2026-04-05. Two instants exactly 24h apart
    // in UTC, straddling it, must land 23 hours apart on the WALL clock —
    // AEDT (GMT+11) before, AEST (GMT+10) after. A resolver that probed one
    // offset and reused it would put them a flat 24h apart.
    const before = formatEventZonedInstant(
      new Date("2026-04-04T13:00:00.000Z"),
      "Australia/Sydney",
      fmt,
    );
    const after = formatEventZonedInstant(
      new Date("2026-04-05T13:00:00.000Z"),
      "Australia/Sydney",
      fmt,
    );
    expect(before).toContain("Apr 5");
    expect(before).toContain("12:00 AM");
    expect(before).toContain("GMT+11");
    expect(after).toContain("Apr 5");
    expect(after).toContain("11:00 PM");
    expect(after).toContain("GMT+10");
  });

  it("REFUSES rather than rendering on the READER's clock when the event has no zone", () => {
    // Phase 1c: refuse, don't degrade. Without `timeZone` the option set also
    // drops `timeZoneName`, so a London reader would see "Fri, Oct 9, 4:00 PM"
    // for a 10:00 AM CDT window with nothing in the string admitting the
    // substitution. Callers fall back to the zone-free copy they already have.
    expect(formatEventZonedInstant(OPENS_AT, null, fmt)).toBeNull();
    expect(formatEventZonedInstant(OPENS_AT, undefined, fmt)).toBeNull();
    expect(formatEventZonedInstant(OPENS_AT, "", fmt)).toBeNull();
  });

  it("returns null rather than throwing on an unknown zone id", () => {
    // `Intl` throws RangeError on these, and `Event.timezone` is a bare
    // z.string() server-side. A missing label beats a crashed ticket list.
    expect(
      formatEventZonedInstant(OPENS_AT, "Mars/Olympus_Mons", fmt),
    ).toBeNull();
  });

  it("returns null for an invalid instant", () => {
    expect(
      formatEventZonedInstant(new Date("nonsense"), "America/Chicago", fmt),
    ).toBeNull();
  });
});
