import { describe, expect, it } from "vitest";

import {
  assertTicketTypeOnSale,
  findUnparseableSalesWindowBounds,
  isEverPaidTicketType,
  isTicketTypeOnSale,
  resolveTicketTypeSaleState,
  resolveUnitPriceCents,
  type PriceResolvableTicketType,
  type SellableTicketType,
} from "./door-pricing";

/**
 * The one price resolver — time-based-ticket-pricing FR-003 / FR-005. Every
 * surface (online checkout, event page, POS card and cash) resolves through
 * it with no pricing mode: there is no separate door price
 * (door-sales-same-price-and-tax spec FR-012).
 */

// The flip instant. $12 before, $20 at-or-after.
const T = new Date("2026-03-06T02:00:00.000Z");
const BEFORE = new Date(T.getTime() - 1);
const AT = new Date(T.getTime());
const AFTER = new Date(T.getTime() + 60_000);

const PRICE = 1200;
const SCHEDULED = 2000;

function ticketType(
  overrides: Partial<PriceResolvableTicketType> = {},
): PriceResolvableTicketType {
  return {
    priceCents: PRICE,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    ...overrides,
  };
}

const scheduled = ticketType({
  scheduledPriceCents: SCHEDULED,
  scheduledPriceAt: T,
});

describe("the scheduled price governs", () => {
  it("before T → the pre-flip price", () => {
    expect(resolveUnitPriceCents(scheduled, { now: BEFORE })).toBe(PRICE);
  });

  it("after T → the post-flip price", () => {
    expect(resolveUnitPriceCents(scheduled, { now: AFTER })).toBe(SCHEDULED);
  });
});

describe("the flip boundary is inclusive at T", () => {
  it("charges the OLD price at T minus one millisecond", () => {
    expect(resolveUnitPriceCents(scheduled, { now: BEFORE })).toBe(PRICE);
  });

  it("charges the NEW price at exactly T", () => {
    expect(resolveUnitPriceCents(scheduled, { now: AT })).toBe(SCHEDULED);
  });
});

describe("scheduledPriceCents 0 is a real price, not an absent one", () => {
  const freeAfterT = ticketType({
    priceCents: PRICE,
    scheduledPriceCents: 0,
    scheduledPriceAt: T,
  });

  it("still charges the paid price before T", () => {
    expect(resolveUnitPriceCents(freeAfterT, { now: BEFORE })).toBe(PRICE);
  });

  it("charges 0 at or after T — NOT collapsed with null (a falsy check here would keep charging $12)", () => {
    expect(resolveUnitPriceCents(freeAfterT, { now: AT })).toBe(0);
    expect(resolveUnitPriceCents(freeAfterT, { now: AFTER })).toBe(0);
  });
});

describe("NFR-001 — an unscheduled row behaves exactly as it did before", () => {
  it("returns priceCents regardless of `now`", () => {
    const plain = ticketType();
    expect(resolveUnitPriceCents(plain, { now: BEFORE })).toBe(PRICE);
    expect(resolveUnitPriceCents(plain, { now: AFTER })).toBe(PRICE);
  });

  it("treats a projection that omits the schedule fields entirely as unscheduled", () => {
    const legacy = { priceCents: PRICE };
    expect(resolveUnitPriceCents(legacy, { now: AFTER })).toBe(PRICE);
  });
});

describe("a half-configured or unparseable schedule fails SAFE to priceCents", () => {
  it("price without an instant is inert", () => {
    const half = ticketType({ scheduledPriceCents: SCHEDULED });
    expect(resolveUnitPriceCents(half, { now: AFTER })).toBe(PRICE);
  });

  it("instant without a price is inert", () => {
    const half = ticketType({ scheduledPriceAt: T });
    expect(resolveUnitPriceCents(half, { now: AFTER })).toBe(PRICE);
  });

  it("an unparseable instant is inert rather than a silent mispricing", () => {
    const broken = ticketType({
      scheduledPriceCents: SCHEDULED,
      scheduledPriceAt: new Date("not-a-date"),
    });
    expect(resolveUnitPriceCents(broken, { now: AFTER })).toBe(PRICE);
  });
});

describe("an ISO string instant resolves identically to a Date", () => {
  // Some transport/JSON boundaries hand back a serialized instant. Treating
  // that as unscheduled would be a silent revert to the pre-flip price.
  const fromString = ticketType({
    scheduledPriceCents: SCHEDULED,
    scheduledPriceAt: T.toISOString(),
  });

  it("before T", () => {
    expect(resolveUnitPriceCents(fromString, { now: BEFORE })).toBe(PRICE);
  });

  it("at T", () => {
    expect(resolveUnitPriceCents(fromString, { now: AT })).toBe(SCHEDULED);
  });
});

/**
 * The gate predicate. Every "is this event paid?" check is time-INDEPENDENT —
 * it runs once, before money moves — so it must answer "could money EVER move
 * through this type", not "is it priced above zero at this instant".
 */
describe("isEverPaidTicketType", () => {
  it("false for a genuinely free tier — the case that must keep working", () => {
    expect(isEverPaidTicketType({ priceCents: 0 })).toBe(false);
    expect(
      isEverPaidTicketType({
        priceCents: 0,
        scheduledPriceCents: null,
        pricingMode: "FIXED",
      }),
    ).toBe(false);
  });

  it("true for a priced tier", () => {
    expect(isEverPaidTicketType({ priceCents: 1 })).toBe(true);
  });

  it("true for $0 now / $20 at T — the newly expressible case these gates were blind to", () => {
    expect(
      isEverPaidTicketType({ priceCents: 0, scheduledPriceCents: 2000 }),
    ).toBe(true);
  });

  it("true for ADJUSTABLE regardless of price", () => {
    expect(
      isEverPaidTicketType({ priceCents: 0, pricingMode: "ADJUSTABLE" }),
    ).toBe(true);
  });

  it("a scheduled price of 0 does NOT make a free tier paid", () => {
    // "free now, still free at T" is free. Only a POSITIVE scheduled price
    // arms the gate — otherwise every free-after-T tier would demand Stripe.
    expect(
      isEverPaidTicketType({ priceCents: 0, scheduledPriceCents: 0 }),
    ).toBe(false);
  });

  it("a tier that flips DOWN to free is still paid (it takes money before T)", () => {
    expect(
      isEverPaidTicketType({ priceCents: 2000, scheduledPriceCents: 0 }),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sales windows — ticket-type-packs FR-014, adopted by FR-009.
//
// The boundaries are written out at BOTH ends and at the exact instant,
// deliberately not generated from a table: half-open `[open, close)` is the
// asymmetry that makes two back-to-back tiers neither overlap nor gap, and a
// reader must be able to see every cell without executing anything in their
// head. The same reasoning as the FR-006 matrix above.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_AT = new Date("2026-09-01T17:00:00.000Z");
const CLOSE_AT = new Date("2026-09-20T17:00:00.000Z");

const before = (d: Date) => new Date(d.getTime() - 1);
const at = (d: Date) => new Date(d.getTime());
const after = (d: Date) => new Date(d.getTime() + 1);

function windowed(
  overrides: Partial<SellableTicketType> = {},
): SellableTicketType {
  return { salesOpenAt: null, salesCloseAt: null, ...overrides };
}

describe("resolveTicketTypeSaleState — boundaries (FR-014)", () => {
  const both = windowed({ salesOpenAt: OPEN_AT, salesCloseAt: CLOSE_AT });

  it("BEFORE open: refused as not_yet_on_sale, carrying the open instant", () => {
    const state = resolveTicketTypeSaleState(both, before(OPEN_AT));
    expect(state).toEqual({
      onSale: false,
      reason: "not_yet_on_sale",
      opensAt: OPEN_AT,
    });
  });

  it("EXACTLY at open: ON SALE — the open bound is INCLUSIVE", () => {
    // Mirrors the scheduled-price flip, which is live at exactly T. An
    // organizer who types "10:00" gets the same answer from both features at
    // 10:00:00.000.
    expect(resolveTicketTypeSaleState(both, at(OPEN_AT))).toEqual({
      onSale: true,
    });
  });

  it("BETWEEN: on sale", () => {
    const mid = new Date((OPEN_AT.getTime() + CLOSE_AT.getTime()) / 2);
    expect(resolveTicketTypeSaleState(both, mid)).toEqual({ onSale: true });
  });

  it("one millisecond BEFORE close: still on sale", () => {
    expect(resolveTicketTypeSaleState(both, before(CLOSE_AT))).toEqual({
      onSale: true,
    });
  });

  it("EXACTLY at close: REFUSED — the close bound is EXCLUSIVE", () => {
    const state = resolveTicketTypeSaleState(both, at(CLOSE_AT));
    expect(state).toEqual({
      onSale: false,
      reason: "sales_ended",
      closedAt: CLOSE_AT,
    });
  });

  it("AFTER close: refused as sales_ended", () => {
    expect(resolveTicketTypeSaleState(both, after(CLOSE_AT))).toMatchObject({
      onSale: false,
      reason: "sales_ended",
    });
  });

  it("back-to-back tiers neither overlap nor gap at the shared instant", () => {
    // The single reason the boundaries are asymmetric. At exactly 17:00 on the
    // 20th, ADVANCE is closed and DOOR is open — exactly one tier sells.
    const advance = windowed({ salesCloseAt: CLOSE_AT });
    const door = windowed({ salesOpenAt: CLOSE_AT });
    expect(isTicketTypeOnSale(advance, at(CLOSE_AT))).toBe(false);
    expect(isTicketTypeOnSale(door, at(CLOSE_AT))).toBe(true);
  });
});

describe("resolveTicketTypeSaleState — single bound and no bound", () => {
  it("NO bounds: always on sale — NFR-001 holds by construction", () => {
    const unbounded = windowed();
    expect(isTicketTypeOnSale(unbounded, new Date(0))).toBe(true);
    expect(isTicketTypeOnSale(unbounded, new Date(8.64e15))).toBe(true);
  });

  it("OPEN only: refused before, on sale from the instant onward, forever", () => {
    const openOnly = windowed({ salesOpenAt: OPEN_AT });
    expect(isTicketTypeOnSale(openOnly, before(OPEN_AT))).toBe(false);
    expect(isTicketTypeOnSale(openOnly, at(OPEN_AT))).toBe(true);
    expect(
      isTicketTypeOnSale(openOnly, new Date(OPEN_AT.getTime() + 3.15e10)),
    ).toBe(true);
  });

  it("CLOSE only: on sale from the epoch, refused from the instant onward", () => {
    const closeOnly = windowed({ salesCloseAt: CLOSE_AT });
    expect(isTicketTypeOnSale(closeOnly, new Date(0))).toBe(true);
    expect(isTicketTypeOnSale(closeOnly, before(CLOSE_AT))).toBe(true);
    expect(isTicketTypeOnSale(closeOnly, at(CLOSE_AT))).toBe(false);
  });

  it("REJECTS a string bound at the type level (the hazard is unrepresentable)", () => {
    // An ISO string with no offset parses as LOCAL time under ES semantics, so
    // a string bound under a money gate would open the window an hour early or
    // late depending on the container's TZ. `SellableTicketType` is `Date |
    // null` so this cannot be written; the @ts-expect-error IS the assertion —
    // it fails the build if the type is ever widened back.
    // @ts-expect-error a string bound must not type-check
    const asString: SellableTicketType = { salesOpenAt: OPEN_AT.toISOString() };
    expect(asString).toBeDefined();
  });

  it("an UNPARSEABLE bound is inert, not a refusal", () => {
    // Deliberate fail-OPEN on exactly this axis, and only on data the write
    // boundary cannot produce: a corrupt column must not silently close every
    // sale on an event with no diagnosable cause.
    expect(
      isTicketTypeOnSale({ salesOpenAt: new Date("nope") }, at(OPEN_AT)),
    ).toBe(true);
    expect(
      isTicketTypeOnSale({ salesCloseAt: new Date("nope") }, at(CLOSE_AT)),
    ).toBe(true);
  });

  it("an INVERTED window refuses everywhere — fails CLOSED", () => {
    // Rejected at the write boundary, but if one ever exists it must not sell.
    const inverted = windowed({ salesOpenAt: CLOSE_AT, salesCloseAt: OPEN_AT });
    expect(isTicketTypeOnSale(inverted, before(OPEN_AT))).toBe(false);
    expect(isTicketTypeOnSale(inverted, at(OPEN_AT))).toBe(false);
    expect(isTicketTypeOnSale(inverted, at(CLOSE_AT))).toBe(false);
    expect(isTicketTypeOnSale(inverted, after(CLOSE_AT))).toBe(false);
  });
});

describe("assertTicketTypeOnSale — the enforcement call", () => {
  it("returns silently when on sale", () => {
    expect(() => assertTicketTypeOnSale(windowed(), at(OPEN_AT))).not.toThrow();
  });

  it("throws TICKET_TYPE_NOT_YET_ON_SALE with the open instant in meta", () => {
    try {
      assertTicketTypeOnSale(
        windowed({ salesOpenAt: OPEN_AT }),
        before(OPEN_AT),
        { meta: { ticketTypeId: "tt-1" } },
      );
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        "TICKET_TYPE_NOT_YET_ON_SALE",
      );
      expect((error as { meta?: Record<string, unknown> }).meta).toEqual({
        ticketTypeId: "tt-1",
        salesOpenAt: OPEN_AT.toISOString(),
      });
    }
  });

  it("throws TICKET_TYPE_SALES_ENDED with the close instant in meta", () => {
    try {
      assertTicketTypeOnSale(windowed({ salesCloseAt: CLOSE_AT }), at(CLOSE_AT));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("TICKET_TYPE_SALES_ENDED");
      expect((error as { meta?: Record<string, unknown> }).meta).toMatchObject({
        salesCloseAt: CLOSE_AT.toISOString(),
      });
    }
  });

  it("reports an unparseable bound BEFORE deciding, on the fail-OPEN path", () => {
    // The whole point: the case worth seeing is the one that does NOT throw.
    // A report fired only on the refusal path would miss it entirely.
    const seen: string[] = [];

    expect(() =>
      assertTicketTypeOnSale(
        { salesOpenAt: new Date("nope"), salesCloseAt: new Date("nope") },
        at(OPEN_AT),
        {
          meta: { ticketTypeId: "tt-1" },
          onUnparseableBound: ({ field, meta }) => {
            seen.push(`${field}:${String(meta?.ticketTypeId)}`);
          },
        },
      ),
    ).not.toThrow();

    expect(seen).toEqual(["salesOpenAt:tt-1", "salesCloseAt:tt-1"]);
  });

  it("does NOT report when both bounds are absent or valid", () => {
    const seen: string[] = [];
    const onUnparseableBound = ({ field }: { field: string }) => {
      seen.push(field);
    };

    assertTicketTypeOnSale(windowed(), at(OPEN_AT), { onUnparseableBound });
    assertTicketTypeOnSale(
      windowed({ salesOpenAt: OPEN_AT, salesCloseAt: CLOSE_AT }),
      at(OPEN_AT),
      { onUnparseableBound },
    );

    expect(seen).toEqual([]);
  });

  it("a THROWING reporter never turns an allowed sale into a failed one", () => {
    // ReporterPort is best-effort by contract; this pins that the guard holds
    // even when the wiring misbehaves.
    expect(() =>
      assertTicketTypeOnSale({ salesOpenAt: new Date("nope") }, at(OPEN_AT), {
        onUnparseableBound: () => {
          throw new Error("sentry exploded");
        },
      }),
    ).not.toThrow();
  });

  it("findUnparseableSalesWindowBounds names exactly the bad bounds", () => {
    expect(findUnparseableSalesWindowBounds(windowed())).toEqual([]);
    expect(
      findUnparseableSalesWindowBounds({
        salesOpenAt: OPEN_AT,
        salesCloseAt: CLOSE_AT,
      }),
    ).toEqual([]);
    expect(
      findUnparseableSalesWindowBounds({ salesCloseAt: new Date("nope") }),
    ).toEqual(["salesCloseAt"]);
  });

  it("the two reasons stay DISTINCT — the buyer copy differs", () => {
    // "opens Friday" is an invitation to come back; "ended" is not. Collapsing
    // them into one code would make that copy impossible downstream (FR-010).
    const notYet = () =>
      assertTicketTypeOnSale(windowed({ salesOpenAt: OPEN_AT }), new Date(0));
    const ended = () =>
      assertTicketTypeOnSale(
        windowed({ salesCloseAt: CLOSE_AT }),
        after(CLOSE_AT),
      );
    expect(notYet).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_NOT_YET_ON_SALE" }),
    );
    expect(ended).toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SALES_ENDED" }),
    );
  });
});
