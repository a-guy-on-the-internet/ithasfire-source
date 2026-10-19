import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { completePosSale } from "./complete-pos-sale";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";

function makeDeps(opts: {
  order?: any | null;
  event?: any | null;
  membership?: { role: "SCANNER" } | null;
  tickets?: Array<any>;
  ticketTypes?: Array<{ id: string; name: string }>;
  holds?: Array<any>;
}) {
  const repos = {
    // A real OrderRecord always carries these; the fixtures below set only
    // what each case is about.
    orders: {
      getById: vi.fn(async () =>
        opts.order
          ? { feesPlatformCents: 0, taxAmountCents: 0, items: [], ...opts.order }
          : null,
      ),
    },
    events: {
      getById: vi.fn(async () =>
        opts.event === undefined ? { id: EVENT_ID, orgId: ORG_ID } : opts.event,
      ),
      listTicketTypes: vi.fn(async () =>
        (opts.ticketTypes ?? [{ id: TT_GA, name: "GA" }]).map((tt) => ({
          ...tt,
          priceCents: 0,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 0,
          status: "ACTIVE" as const,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
        })),
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR, role: "SCANNER" as const }
          : opts.membership,
      ),
    },
    tickets: { listByOrderId: vi.fn(async () => opts.tickets ?? []) },
    promos: { listHoldsForOrder: vi.fn(async () => opts.holds ?? []) },
  } as unknown as Repos;
  return { repos };
}

describe("completePosSale", () => {
  it("returns CASH order shape with auto-admitted tickets", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 6000,
    };
    const tickets = [
      {
        id: "00000000-0000-4000-8000-00000000a001",
        code: "CASH-001",
        ticketTypeId: TT_GA,
        status: "SCANNED",
        scannedAt: new Date("2026-04-26T20:00:00Z"),
      },
      {
        id: "00000000-0000-4000-8000-00000000a002",
        code: "CASH-002",
        ticketTypeId: TT_GA,
        status: "SCANNED",
        scannedAt: new Date("2026-04-26T20:00:00Z"),
      },
    ];
    const { repos } = makeDeps({ order, tickets });

    const result = await completePosSale(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.paymentChannel).toBe("CASH");
    expect(result.amountCents).toBe(6000);
    expect(result.isComp).toBe(false);
    expect(result.ticketCount).toBe(2);
    expect(result.tickets[0]?.ticketTypeName).toBe("GA");
    expect(result.tickets[0]?.code).toBe("CASH-001");
  });

  it("flags $0 cash orders as comp", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 0,
    };
    const { repos } = makeDeps({
      order,
      tickets: [
        {
          id: "00000000-0000-4000-8000-00000000a001",
          code: "CASH-COMP",
          ticketTypeId: TT_GA,
          status: "SCANNED",
          scannedAt: new Date(),
        },
      ],
    });

    const result = await completePosSale(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.isComp).toBe(true);
    expect(result.amountCents).toBe(0);
  });

  it("returns POS card order in PENDING state (webhook still in flight)", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "PENDING",
      paymentChannel: "POS",
      amountGrossCents: 3000,
    };
    const { repos } = makeDeps({ order, tickets: [] });

    const result = await completePosSale(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.status).toBe("PENDING");
    expect(result.paymentChannel).toBe("POS");
    expect(result.ticketCount).toBe(0);
    expect(result.isComp).toBe(false); // POS, not CASH
  });

  it("reports what a door CARD sale charged — fees and tax included, not the face", async () => {
    // Shape `startPosSale` writes since door card = online (spec 2026-10-07
    // FR-002): per-item buyer totals carry face + platform fee + processor
    // share, tax rides on the order.
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "POS",
      amountGrossCents: 5000,
      feesPlatformCents: 350,
      taxAmountCents: 556,
      items: [
        { kind: "ticket", amountCents: 2500, meta: { buyerTotalCents: 2787 } },
        { kind: "ticket", amountCents: 2500, meta: { buyerTotalCents: 2787 } },
      ],
    };
    const { repos } = makeDeps({ order, tickets: [] });

    const result = await completePosSale(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.amountCents).toBe(2787 + 2787 + 556);
    expect(result.isComp).toBe(false);
  });

  it("reports what a door CASH sale charged — face + platform fee + tax, no processing share", async () => {
    // Shape `recordCashSale` writes since door cash is priced (spec
    // 2026-10-07 FR-003): the TN cart from door-cash-parity.test.ts.
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 9000,
      feesPlatformCents: 600,
      taxAmountCents: 936,
      items: [
        { kind: "ticket", amountCents: 2500, meta: { buyerTotalCents: 2675 } },
        { kind: "ticket", amountCents: 2500, meta: { buyerTotalCents: 2675 } },
        { kind: "ticket", amountCents: 4000, meta: { buyerTotalCents: 4250 } },
      ],
    };
    const { repos } = makeDeps({ order, tickets: [] });

    const result = await completePosSale(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.amountCents).toBe(10_536);
    expect(result.isComp).toBe(false);
  });

  it("a cash order recorded before the door was priced reports its gross, and is not a comp", async () => {
    // Pre-pricing shape: no per-item buyer totals, no fee, no tax. The gross
    // is what the operator typed then.
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 2000,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      items: [{ kind: "ticket", amountCents: 2000, meta: {} }],
    };
    const { repos } = makeDeps({ order, tickets: [] });

    const result = await completePosSale(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, orderId: ORDER_ID },
    );

    expect(result.amountCents).toBe(2000);
    expect(result.isComp).toBe(false);
  });

  it("throws not_found when the order does not exist", async () => {
    const { repos } = makeDeps({ order: null });
    await expect(
      completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("throws forbidden when the actor lacks scanner role", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "CASH",
      amountGrossCents: 0,
    };
    const { repos } = makeDeps({ order, membership: null });
    await expect(
      completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects WEB orders — only POS / CASH belong on this endpoint", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      paymentChannel: "WEB",
      amountGrossCents: 5000,
    };
    const { repos } = makeDeps({ order });
    await expect(
      completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_A_POS_ORDER" });
  });

  it("treats missing paymentChannel as WEB (legacy rows are rejected)", async () => {
    const order = {
      id: ORDER_ID,
      eventId: EVENT_ID,
      status: "SUCCEEDED",
      amountGrossCents: 5000,
    };
    const { repos } = makeDeps({ order });
    await expect(
      completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_A_POS_ORDER" });
  });

  describe("promo codes and the comp rule (shared with the till and recordCashSale)", () => {
    const PROMO_A = "00000000-0000-4000-8000-0000000000b1";
    const PROMO_B = "00000000-0000-4000-8000-0000000000b2";
    const BENEFIT = "00000000-0000-4000-8000-0000000000b3";
    function hold(over: Record<string, unknown>) {
      return {
        id: `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
          .toString()
          .padStart(12, "0")}`,
        promoId: null,
        membershipBenefitId: null,
        orderId: ORDER_ID,
        humanId: ACTOR,
        idempotencyKey: "k",
        code: "X",
        amountDiscountCents: 0,
        status: "CONFIRMED",
        expiresAt: new Date("2026-04-26T21:00:00Z"),
        createdAt: new Date("2026-04-26T20:00:00Z"),
        updatedAt: new Date("2026-04-26T20:00:00Z"),
        ...over,
      };
    }
    // What `recordCashSale` writes for a priced line: `buyerTotalCents`.
    const pricedFreeItems = [
      { kind: "ticket", amountCents: 0, meta: { buyerTotalCents: 0 } },
      { kind: "ticket", amountCents: 0, meta: { buyerTotalCents: 0 } },
    ];

    it("a 100%-off code on a cash sale is a $0 SALE carrying its code, not a comp", async () => {
      const { repos } = makeDeps({
        order: {
          id: ORDER_ID,
          eventId: EVENT_ID,
          status: "SUCCEEDED",
          paymentChannel: "CASH",
          amountGrossCents: 0,
          items: pricedFreeItems,
        },
        holds: [
          hold({ promoId: PROMO_A, code: "FREEALL", amountDiscountCents: 6000 }),
        ],
      });

      const result = await completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      );

      expect(result.amountCents).toBe(0);
      expect(result.discountCents).toBe(6000);
      expect(result.promoCodes).toEqual(["FREEALL"]);
      expect(result.isComp).toBe(false);
    });

    it("an explicit comp (items stamped meta.comp) is a comp with no codes", async () => {
      const { repos } = makeDeps({
        order: {
          id: ORDER_ID,
          eventId: EVENT_ID,
          status: "SUCCEEDED",
          paymentChannel: "CASH",
          amountGrossCents: 0,
          items: [
            {
              kind: "ticket",
              amountCents: 0,
              meta: { comp: true, buyerTotalCents: 0 },
            },
          ],
        },
      });

      const result = await completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      );

      expect(result.isComp).toBe(true);
      expect(result.promoCodes).toEqual([]);
    });

    it("a priced $0 sale with no code (a free tier, comp: false) is not a comp", async () => {
      const { repos } = makeDeps({
        order: {
          id: ORDER_ID,
          eventId: EVENT_ID,
          status: "SUCCEEDED",
          paymentChannel: "CASH",
          amountGrossCents: 0,
          items: pricedFreeItems,
        },
      });

      const result = await completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      );

      expect(result.amountCents).toBe(0);
      expect(result.isComp).toBe(false);
    });

    it("lists typed codes oldest first; skips released holds and membership benefits", async () => {
      const { repos } = makeDeps({
        order: {
          id: ORDER_ID,
          eventId: EVENT_ID,
          status: "PENDING",
          paymentChannel: "POS",
          amountGrossCents: 4000,
        },
        holds: [
          hold({
            promoId: PROMO_B,
            code: "LATER",
            status: "PENDING",
            amountDiscountCents: 500,
            createdAt: new Date("2026-04-26T20:00:02Z"),
          }),
          hold({
            membershipBenefitId: BENEFIT,
            code: `benefit:${BENEFIT}`,
            status: "PENDING",
            amountDiscountCents: 300,
          }),
          hold({
            promoId: PROMO_A,
            code: "FIRST",
            status: "PENDING",
            amountDiscountCents: 200,
            createdAt: new Date("2026-04-26T20:00:01Z"),
          }),
          hold({ promoId: PROMO_A, code: "GONE", status: "RELEASED" }),
        ],
      });

      const result = await completePosSale(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, orderId: ORDER_ID },
      );

      expect(result.promoCodes).toEqual(["FIRST", "LATER"]);
      // The discount still counts the benefit; only the code list skips it.
      expect(result.discountCents).toBe(1000);
      expect(result.isComp).toBe(false); // POS is never a comp
    });
  });
});
