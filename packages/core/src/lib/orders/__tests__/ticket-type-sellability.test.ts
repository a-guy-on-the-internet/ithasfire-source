/**
 * FR-010 — per-ticket-type sellability composition, and Q-002's forward-only
 * price-change copy.
 *
 * Two invariants carry the whole feature and both are pinned here:
 *
 *   1. THE EVENT-LEVEL REFUSAL WINS. An ended event whose tier "opens Friday"
 *      must report `sales_closed`, never `not_yet_on_sale` — the read-side
 *      mirror of `ensureEventOnSale` running before `assertTicketTypeOnSale`.
 *   2. NFR-001. An unwindowed tier reports EXACTLY the event-level answer, for
 *      every one of the five event-level reasons. That is what makes this
 *      change invisible to the ~100% of rows with no window.
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-010,
 * Q-002, NFR-001.
 */
import { describe, expect, it } from "vitest";

import {
  EVENT_LEVEL_SELLABILITY_REASONS,
  resolveTicketTypeSellability,
  resolveUpcomingPriceChange,
  ticketTypeSellabilitySchema,
  type EventLevelSellability,
} from "../ticket-type-sellability";

const NOW = new Date("2026-10-01T20:00:00.000Z");
const EARLIER = new Date(NOW.getTime() - 3_600_000);
const LATER = new Date(NOW.getTime() + 3_600_000);

const OK: EventLevelSellability = { available: true, reason: "ok" };
const FREE: EventLevelSellability = { available: true, reason: "free" };
const CLOSED: EventLevelSellability = {
  available: false,
  reason: "sales_closed",
};
const NO_STRIPE: EventLevelSellability = {
  available: false,
  reason: "stripe_not_connected",
};

describe("resolveTicketTypeSellability — unwindowed rows (NFR-001)", () => {
  it("reports EXACTLY the event-level answer for every event-level reason", () => {
    for (const reason of EVENT_LEVEL_SELLABILITY_REASONS) {
      const available = reason === "ok" || reason === "free";
      expect(
        resolveTicketTypeSellability(
          { salesOpenAt: null, salesCloseAt: null },
          NOW,
          { available, reason },
        ),
        `event reason ${reason}`,
      ).toEqual({ available, reason, opensAt: null, closedAt: null });
    }
  });

  it("treats a projection with the fields absent entirely as unwindowed", () => {
    // A caller holding a pre-Phase-2a projection must not be silently refused.
    expect(resolveTicketTypeSellability({}, NOW, OK)).toEqual({
      available: true,
      reason: "ok",
      opensAt: null,
      closedAt: null,
    });
  });
});

describe("resolveTicketTypeSellability — window reasons", () => {
  it("reports not_yet_on_sale WITH the open instant before salesOpenAt", () => {
    expect(
      resolveTicketTypeSellability({ salesOpenAt: LATER }, NOW, OK),
    ).toEqual({
      available: false,
      reason: "not_yet_on_sale",
      opensAt: LATER,
      closedAt: null,
    });
  });

  it("reports sales_ended WITH the close instant at/after salesCloseAt", () => {
    expect(
      resolveTicketTypeSellability({ salesCloseAt: EARLIER }, NOW, OK),
    ).toEqual({
      available: false,
      reason: "sales_ended",
      opensAt: null,
      closedAt: EARLIER,
    });
  });

  it("carries ONLY the instant that explains the current refusal", () => {
    // A tier with both bounds, before it opens: `closedAt` stays null. Showing
    // "sales end at X" beside "opens at Y" is noise the buyer can do nothing
    // with, and FR-010 asks only for the open time to travel with the reason.
    const open = resolveTicketTypeSellability(
      { salesOpenAt: LATER, salesCloseAt: new Date(LATER.getTime() + 1_000) },
      NOW,
      OK,
    );
    expect(open.opensAt).toEqual(LATER);
    expect(open.closedAt).toBeNull();
  });

  it("honours the half-open boundary: open is INCLUSIVE, close is EXCLUSIVE", () => {
    // Inherited from resolveTicketTypeSaleState — asserted again here so a
    // future refactor of the composition cannot quietly change the boundary.
    expect(
      resolveTicketTypeSellability({ salesOpenAt: NOW }, NOW, OK).available,
    ).toBe(true);
    expect(
      resolveTicketTypeSellability({ salesCloseAt: NOW }, NOW, OK).available,
    ).toBe(false);
  });

  it("inherits a PERMITTING event reason when inside the window", () => {
    // A free event's open tier still says "free", not "ok" — the tier does not
    // invent a verdict, it narrows the event's.
    expect(
      resolveTicketTypeSellability(
        { salesOpenAt: EARLIER, salesCloseAt: LATER },
        NOW,
        FREE,
      ).reason,
    ).toBe("free");
  });
});

describe("resolveTicketTypeSellability — precedence", () => {
  it("the EVENT-level refusal wins over not_yet_on_sale", () => {
    // The failure this prevents: an event that already ended telling a buyer to
    // come back on Friday for a tier that will never sell.
    expect(
      resolveTicketTypeSellability({ salesOpenAt: LATER }, NOW, CLOSED),
    ).toEqual({
      available: false,
      reason: "sales_closed",
      opensAt: null,
      closedAt: null,
    });
  });

  it("the EVENT-level refusal wins over sales_ended", () => {
    expect(
      resolveTicketTypeSellability({ salesCloseAt: EARLIER }, NOW, NO_STRIPE)
        .reason,
    ).toBe("stripe_not_connected");
  });

  it("never permits a tier the event level refused", () => {
    // The composition can only ever narrow. Exhaustive over both window states
    // so no combination can widen an event-wide refusal.
    for (const window of [
      {},
      { salesOpenAt: EARLIER },
      { salesOpenAt: LATER },
      { salesCloseAt: EARLIER },
      { salesCloseAt: LATER },
      { salesOpenAt: EARLIER, salesCloseAt: LATER },
    ]) {
      expect(
        resolveTicketTypeSellability(window, NOW, CLOSED).available,
      ).toBe(false);
    }
  });
});

describe("ticketTypeSellabilitySchema", () => {
  it("accepts every shape the resolver can produce", () => {
    for (const [window, eventLevel] of [
      [{}, OK],
      [{ salesOpenAt: LATER }, OK],
      [{ salesCloseAt: EARLIER }, OK],
      [{}, CLOSED],
    ] as const) {
      expect(() =>
        ticketTypeSellabilitySchema.parse(
          resolveTicketTypeSellability(window, NOW, eventLevel),
        ),
      ).not.toThrow();
    }
  });

  it("is strict — a stray spread cannot leak an extra field through it", () => {
    expect(() =>
      ticketTypeSellabilitySchema.parse({
        available: true,
        reason: "ok",
        opensAt: null,
        closedAt: null,
        salesOpenAt: LATER,
      }),
    ).toThrow();
  });
});

describe("resolveUpcomingPriceChange (Q-002)", () => {
  const scheduled = { scheduledPriceCents: 2000, scheduledPriceAt: LATER };

  it("offers the pending change BEFORE the flip", () => {
    expect(resolveUpcomingPriceChange(scheduled, NOW)).toEqual({
      toPriceCents: 2000,
      at: LATER,
    });
  });

  it("returns null AT the flip — the same >= boundary as the price resolver", () => {
    // The honesty requirement: the instant `priceCents` becomes the post-flip
    // number is the instant "until" copy must stop being offered.
    expect(
      resolveUpcomingPriceChange(
        { scheduledPriceCents: 2000, scheduledPriceAt: NOW },
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null AFTER the flip", () => {
    expect(
      resolveUpcomingPriceChange(
        { scheduledPriceCents: 2000, scheduledPriceAt: EARLIER },
        NOW,
      ),
    ).toBeNull();
  });

  it("treats a HALF-configured row as inert, like the price resolver does", () => {
    expect(
      resolveUpcomingPriceChange({ scheduledPriceCents: 2000 }, NOW),
    ).toBeNull();
    expect(
      resolveUpcomingPriceChange({ scheduledPriceAt: LATER }, NOW),
    ).toBeNull();
  });

  it("treats an UNPARSEABLE instant as inert", () => {
    expect(
      resolveUpcomingPriceChange(
        { scheduledPriceCents: 2000, scheduledPriceAt: "not-a-date" },
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps a scheduled price of 0 (a real 'free after T' tier)", () => {
    // `== null`, never falsy — 0 is a legitimate schedule and dropping it would
    // hide the most surprising price change there is.
    expect(
      resolveUpcomingPriceChange(
        { scheduledPriceCents: 0, scheduledPriceAt: LATER },
        NOW,
      ),
    ).toEqual({ toPriceCents: 0, at: LATER });
  });

  it("accepts an ISO string instant (adapters hand back either)", () => {
    expect(
      resolveUpcomingPriceChange(
        { scheduledPriceCents: 2000, scheduledPriceAt: LATER.toISOString() },
        NOW,
      ),
    ).toEqual({ toPriceCents: 2000, at: LATER });
  });

  it("NFR-001: an unscheduled tier offers nothing", () => {
    expect(resolveUpcomingPriceChange({}, NOW)).toBeNull();
  });
});
