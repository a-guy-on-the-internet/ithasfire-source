import { describe, expect, it } from "vitest";

import { listEventCashSales } from "../list-event-cash-sales";
import { orgRefundCashSale } from "../org-refund-cash-sale";
import {
  ACTOR_ID,
  EVENT_ID,
  NOW,
  ORG_ID,
  OTHER_ORG_ID,
  PRICED,
  makeCashWorld,
  type CashWorld,
} from "./cash-refund-world";

/**
 * Owner ruling 2026-10-08: editors refund cash door sales from the Sell
 * screen, which lists every cash sale of the chosen event (time, tickets,
 * amount, promo code, status) with NO buyer PII. Owner/Admin/Editor see
 * Refund until event end + 7 days; a Scanner lists but cannot refund.
 *
 * Decision of 2026-10-10: a Finance member may refund a cash sale
 * (`orgRefundCashSale`), from Orders. This list's read gate did not change,
 * so Finance still cannot open it.
 */

const PRICED_ID = "c0000000-0000-4000-8000-00000000f001";
const COMP_ID = "c0000000-0000-4000-8000-00000000f002";
const LEGACY_ID = "c0000000-0000-4000-8000-00000000f003";
const FREE_CODE_ID = "c0000000-0000-4000-8000-00000000f004";
const CODED_ID = "c0000000-0000-4000-8000-00000000f005";
const CODE_DISCOUNT = 500;
const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;
const at = (minutesBeforeNow: number) =>
  new Date(NOW.getTime() - minutesBeforeNow * MINUTE);

function list(
  w: CashWorld,
  input: Record<string, unknown> = {},
) {
  return listEventCashSales(
    { repos: w.repos, authz: w.authz },
    { actorHumanId: ACTOR_ID, orgId: ORG_ID, eventId: EVENT_ID, ...input },
  );
}

function refund(w: CashWorld, orderId: string) {
  return orgRefundCashSale(
    { repos: w.repos, authz: w.authz, clock: w.clock },
    { actorHumanId: ACTOR_ID, orgId: ORG_ID, orderId },
  );
}

/** One of each kind of row, oldest (legacy) to newest (priced). */
async function seedMix(w: CashWorld) {
  w.addLegacyCashOrder(LEGACY_ID, 2000, { occurredAt: at(50) });
  w.addCompCashOrder(COMP_ID, { occurredAt: at(40) });
  // A 100%-off code: a priced sale whose buyer totals are 0. A $0 SALE.
  const free = await w.addPricedCashOrder(FREE_CODE_ID, { occurredAt: at(30) });
  free.amountGrossCents = 0;
  free.feesPlatformCents = 0;
  free.taxAmountCents = 0;
  for (const item of free.items) {
    item.amountCents = 0;
    item.meta = { buyerTotalCents: 0, buyerUnitTotalCents: 0 };
  }
  free.promoCodes = ["FREE100"];
  // A $5-off code, stored as `recordCashSale` stores it: a negative
  // discount item, and a gross net of the discount.
  const coded = await w.addPricedCashOrder(CODED_ID, { occurredAt: at(20) });
  coded.amountGrossCents -= CODE_DISCOUNT;
  coded.items.push({
    id: "c0000000-0000-4000-8000-0000000d15c0",
    orderId: CODED_ID,
    kind: "discount",
    qty: 1,
    unitPriceCents: -CODE_DISCOUNT,
    amountCents: -CODE_DISCOUNT,
    meta: { code: "save10", normalizedCode: "SAVE10" },
    refundedAt: null,
    status: "active",
  });
  coded.promoCodes = ["SAVE10", "LATER"];
  await w.addPricedCashOrder(PRICED_ID, { occurredAt: at(10) });
}

describe("listEventCashSales — the rows", () => {
  it("lists every cash sale newest first, classified, with what a refund hands back", async () => {
    const w = makeCashWorld();
    await seedMix(w);

    const out = await list(w);

    expect(out.items).toEqual([
      {
        orderId: PRICED_ID,
        soldAt: at(10),
        ticketCount: 2,
        amountPaidCents: PRICED.totalCents,
        promoCode: null,
        isComp: false,
        isFreeWithCode: false,
        status: "SUCCEEDED",
        refundedAt: null,
      },
      {
        orderId: CODED_ID,
        soldAt: at(20),
        ticketCount: 2,
        amountPaidCents: PRICED.totalCents - CODE_DISCOUNT,
        // The first code in redemption order.
        promoCode: "SAVE10",
        isComp: false,
        isFreeWithCode: false,
        status: "SUCCEEDED",
        refundedAt: null,
      },
      {
        orderId: FREE_CODE_ID,
        soldAt: at(30),
        ticketCount: 2,
        amountPaidCents: 0,
        promoCode: "FREE100",
        isComp: false,
        isFreeWithCode: true,
        status: "SUCCEEDED",
        refundedAt: null,
      },
      {
        orderId: COMP_ID,
        soldAt: at(40),
        ticketCount: 1,
        amountPaidCents: 0,
        promoCode: null,
        isComp: true,
        isFreeWithCode: false,
        status: "SUCCEEDED",
        refundedAt: null,
      },
      {
        orderId: LEGACY_ID,
        soldAt: at(50),
        ticketCount: 1,
        // Recorded before the door was priced: what the operator typed.
        amountPaidCents: 2000,
        promoCode: null,
        isComp: false,
        isFreeWithCode: false,
        status: "SUCCEEDED",
        refundedAt: null,
      },
    ]);
    expect(out.nextCursor).toBeNull();
    // The world's event ends at NOW: the window closes 7 days later.
    expect(out.refundableUntil).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
  });

  it("each row's amount is exactly what orgRefundCashSale hands back for it", async () => {
    const w = makeCashWorld();
    await seedMix(w);
    const before = await list(w);
    w.setNow(new Date(NOW.getTime() + DAY_MS));

    for (const row of before.items) {
      const out = await refund(w, row.orderId);
      expect(out.amountReturnedCents).toBe(row.amountPaidCents);
    }
  });

  it("a refunded sale stays on the list as REFUNDED, with when it was refunded", async () => {
    const w = makeCashWorld();
    await seedMix(w);
    const refundedAt = new Date(NOW.getTime() + 2 * 60 * MINUTE);
    w.setNow(refundedAt);
    await refund(w, CODED_ID);

    const out = await list(w);

    expect(out.items).toHaveLength(5);
    const row = out.items.find((r) => r.orderId === CODED_ID)!;
    expect(row).toMatchObject({
      status: "REFUNDED",
      refundedAt,
      amountPaidCents: PRICED.totalCents - CODE_DISCOUNT,
      ticketCount: 2,
      promoCode: "SAVE10",
    });
    expect(
      out.items.filter((r) => r.orderId !== CODED_ID).map((r) => r.refundedAt),
    ).toEqual([null, null, null, null]);
  });

  it("carries no buyer fields even when the repo hands some over", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: at(10) });
    const real = w.tx.orders.listCashSalesForEvent.getMockImplementation()!;
    w.tx.orders.listCashSalesForEvent.mockImplementationOnce(async (input) => {
      const page = await real(input);
      return {
        ...page,
        items: page.items.map((row) => ({
          ...row,
          buyerHumanId: "leak",
          buyerEmail: "buyer@example.com",
          billingAddressLine1: "1 Main St",
        })),
      };
    });

    const out = await list(w);

    expect(Object.keys(out.items[0]!).sort()).toEqual(
      [
        "amountPaidCents",
        "isComp",
        "isFreeWithCode",
        "orderId",
        "promoCode",
        "refundedAt",
        "soldAt",
        "status",
        "ticketCount",
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toMatch(/leak|buyer@example|Main St/);
  });
});

describe("listEventCashSales — who may list, and who may refund", () => {
  it.each(["OWNER", "ADMIN", "EDITOR"] as const)(
    "%s lists and may refund, held to the window",
    async (role) => {
      const w = makeCashWorld();
      w.setRole(role);
      await w.addPricedCashOrder(PRICED_ID);

      const out = await list(w);

      expect(out.items).toHaveLength(1);
      expect(out.canRefund).toBe(true);
      expect(out.refundWindowApplies).toBe(true);
    },
  );

  it("a Scanner lists but may not refund", async () => {
    const w = makeCashWorld();
    w.setRole("SCANNER");
    await w.addPricedCashOrder(PRICED_ID);

    const out = await list(w);

    expect(out.items).toHaveLength(1);
    expect(out.canRefund).toBe(false);
    expect(out.refundWindowApplies).toBe(true);
  });

  it("a Scanner who is also platform ADMIN may refund, not held to the window", async () => {
    // orgRefundCashSale's ORG_CASH_REFUND_ROLES gate refuses the SCANNER
    // membership and falls through to the platform-ADMIN override.
    const w = makeCashWorld();
    w.setRole("SCANNER");
    w.setStaffAdmin(true);

    const out = await list(w);

    expect(out.canRefund).toBe(true);
    expect(out.refundWindowApplies).toBe(false);
  });

  // FINANCE may refund a cash sale (from Orders) but still may not read this
  // list: the read gate is the till's ORG_SCAN_ROLES.
  it.each(["FINANCE", null] as const)(
    "%s is refused before anything is read",
    async (role) => {
      const w = makeCashWorld();
      w.setRole(role);

      await expect(list(w)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(w.tx.events.getById).not.toHaveBeenCalled();
      expect(w.tx.orders.listCashSalesForEvent).not.toHaveBeenCalled();
    },
  );

  it("a Finance member who is also platform ADMIN lists through the override and may refund", async () => {
    const w = makeCashWorld();
    w.setRole("FINANCE");
    w.setStaffAdmin(true);

    const out = await list(w);

    expect(out.canRefund).toBe(true);
    expect(out.refundWindowApplies).toBe(false);
  });

  it("another org's id is refused: the actor is not a member there", async () => {
    const w = makeCashWorld();

    await expect(list(w, { orgId: OTHER_ORG_ID })).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(w.tx.orders.listCashSalesForEvent).not.toHaveBeenCalled();
  });

  it("an event that is not this org's answers EVENT_NOT_FOUND, like an unknown one", async () => {
    const w = makeCashWorld();
    (w.event as { orgId: string }).orgId = OTHER_ORG_ID;

    await expect(list(w)).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    await expect(
      list(w, { eventId: "c0000000-0000-4000-8000-0000000000e9" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(w.tx.orders.listCashSalesForEvent).not.toHaveBeenCalled();
  });

  it("a platform admin with no membership lists, may refund, and is not held to the window", async () => {
    const w = makeCashWorld();
    w.setRole(null);
    w.setStaffAdmin(true);

    const out = await list(w);

    expect(out.canRefund).toBe(true);
    expect(out.refundWindowApplies).toBe(false);
  });

  it("an Editor who is also platform ADMIN is not held to the window either", async () => {
    const w = makeCashWorld();
    w.setStaffAdmin(true);

    const out = await list(w);

    expect(out.canRefund).toBe(true);
    expect(out.refundWindowApplies).toBe(false);
  });
});

describe("listEventCashSales — a caller the list admits is offered Refund exactly when orgRefundCashSale accepts it", () => {
  const roles = [
    "OWNER",
    "ADMIN",
    "EDITOR",
    "SCANNER",
    "FINANCE",
    "VIEWER",
    null,
  ] as const;
  // Platform staff: not staff; ADMIN; ADMIN with no passkey or TOTP, whom
  // the staff probe refuses (`secondFactorRequired`).
  const staffStates = ["none", "admin", "admin without a second factor"] as const;
  const cases = roles.flatMap((role) =>
    staffStates.flatMap((staff) =>
      [
        ["inside the window", 1],
        ["after the window", 8],
      ].map(([when, days]) => ({ role, staff, when, days: days as number })),
    ),
  );

  it.each(cases)(
    "role $role, platform staff: $staff, $when",
    async ({ role, staff, days }) => {
      const w = makeCashWorld();
      w.setRole(role);
      w.setStaffAdmin(staff !== "none");
      w.setStaffSecondFactor(staff !== "admin without a second factor");
      await w.addPricedCashOrder(PRICED_ID);
      // The world's event ends at NOW.
      const now = new Date(NOW.getTime() + days * DAY_MS);
      w.setNow(now);
      // What a caller with no usable role is told.
      const noRoleCode =
        staff === "admin without a second factor"
          ? "SECOND_FACTOR_REQUIRED"
          : "INSUFFICIENT_ROLE";

      // The UI's rule, from the list's own fields; null when the list
      // refuses the caller, who then has no Sell-screen button at all.
      const offered = await list(w).then(
        (out) =>
          out.items[0]!.status === "SUCCEEDED" &&
          out.canRefund &&
          (!out.refundWindowApplies ||
            now.getTime() <= out.refundableUntil.getTime()),
        (err: { code?: string }) => {
          expect(err.code).toBe(noRoleCode);
          return null;
        },
      );

      const accepted = await refund(w, PRICED_ID).then(
        () => true,
        (err: { code?: string }) => {
          expect([noRoleCode, "CASH_REFUND_WINDOW_CLOSED"]).toContain(err.code);
          return false;
        },
      );

      if (offered === null) {
        // Refused by the list (ORG_SCAN_ROLES, and no usable platform
        // override): a non-member, a Viewer, or a Finance member. The refund
        // still accepts the Finance member inside the window; their button
        // is on Orders.
        expect(staff).not.toBe("admin");
        expect(accepted).toBe(role === "FINANCE" && days <= 7);
        return;
      }
      expect(offered).toBe(accepted);
    },
  );
});

/**
 * The staff probe refuses a platform ADMIN who has no passkey or TOTP
 * (`{ allowed: false, secondFactorRequired: true }`). The list then answers
 * from their org membership alone, as `orgRefundCashSale` does.
 */
describe("listEventCashSales — a platform ADMIN with no second factor enrolled", () => {
  function unenrolledAdminWorld() {
    const w = makeCashWorld();
    w.setStaffAdmin(true);
    w.setStaffSecondFactor(false);
    return w;
  }

  it.each(["OWNER", "ADMIN", "EDITOR"] as const)(
    "as a %s member may refund and IS held to the window",
    async (role) => {
      const w = unenrolledAdminWorld();
      w.setRole(role);
      await w.addPricedCashOrder(PRICED_ID);

      const out = await list(w);

      expect(out.canRefund).toBe(true);
      expect(out.refundWindowApplies).toBe(true);
    },
  );

  it("as a SCANNER member lists but may not refund", async () => {
    const w = unenrolledAdminWorld();
    w.setRole("SCANNER");
    await w.addPricedCashOrder(PRICED_ID);

    const out = await list(w);

    expect(out.items).toHaveLength(1);
    expect(out.canRefund).toBe(false);
    expect(out.refundWindowApplies).toBe(true);
  });

  it.each(["FINANCE", "VIEWER", null] as const)(
    "as %s is refused the list with SECOND_FACTOR_REQUIRED before anything is read",
    async (role) => {
      const w = unenrolledAdminWorld();
      w.setRole(role);

      await expect(list(w)).rejects.toMatchObject({
        code: "SECOND_FACTOR_REQUIRED",
      });
      expect(w.tx.events.getById).not.toHaveBeenCalled();
      expect(w.tx.orders.listCashSalesForEvent).not.toHaveBeenCalled();
    },
  );
});

describe("listEventCashSales — paging", () => {
  /** Six sales; two share an instant so the id tiebreak is exercised. */
  async function seedSix(w: CashWorld) {
    const ids = [1, 2, 3, 4, 5, 6].map(
      (n) => `c0000000-0000-4000-8000-00000000a00${n}`,
    );
    const minutes = [60, 50, 40, 40, 20, 10];
    for (const [i, id] of ids.entries()) {
      await w.addPricedCashOrder(id, { occurredAt: at(minutes[i]!) });
    }
    return ids;
  }

  it("walks every sale exactly once, newest first, through the cursor", async () => {
    const w = makeCashWorld();
    const ids = await seedSix(w);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out = await list(w, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(out.items.length).toBeLessThanOrEqual(2);
      seen.push(...out.items.map((r) => r.orderId));
      cursor = out.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    // Same instant (a003, a004): the higher id first.
    expect(seen).toEqual([ids[5], ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(pages).toBe(3);
  });

  it("passes the cursor through and asks for the requested page size", async () => {
    const w = makeCashWorld();
    await seedSix(w);

    await list(w, { limit: 3, cursor: "opaque|cursor" });

    expect(w.tx.orders.listCashSalesForEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      cursor: "opaque|cursor",
      limit: 3,
    });
  });

  it("defaults to 25 and caps a larger limit at 50", async () => {
    const w = makeCashWorld();

    await list(w);
    await list(w, { limit: 500 });

    expect(
      w.tx.orders.listCashSalesForEvent.mock.calls.map(([i]) => i.limit),
    ).toEqual([25, 50]);
  });

  it.each([
    ["a zero limit", { limit: 0 }],
    ["a fractional limit", { limit: 2.5 }],
    ["an empty cursor", { cursor: "" }],
    ["an unknown key", { buyerEmail: "x@example.com" }],
  ])("refuses %s as invalid input", async (_label, extra) => {
    const w = makeCashWorld();

    await expect(list(w, extra)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(w.tx.orders.listCashSalesForEvent).not.toHaveBeenCalled();
  });
});
