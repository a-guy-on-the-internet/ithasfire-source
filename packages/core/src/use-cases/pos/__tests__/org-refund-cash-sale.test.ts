import { describe, expect, it } from "vitest";

import {
  ORG_CASH_REFUND_ROLES,
  orgRefundCashSale,
} from "../org-refund-cash-sale";
import { refundCashSale } from "../refund-cash-sale";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  OTHER_ORG_ID,
  PAYEE_ID,
  PRICED,
  makeCashWorld,
  type CashWorld,
} from "./cash-refund-world";

/**
 * Owner rulings 2026-10-07: an Owner, Admin or Editor can refund a door cash
 * sale ("Cancel + Editor action"), and the refund reverses the sale's
 * CASH_SALE_DEBIT — an organiser who gives people their money back should
 * not pay the fee + tax for it. The Editor's window runs until 7 days after
 * the event ends; past it only platform staff can, and the audit trail says
 * so. The till's gate refund keeps its 15-minute window; both run the same
 * refund core.
 *
 * Decision of 2026-10-10: money out is Finance's job, so a Finance member
 * refunds a cash sale too, held to the same window. Scanner and Viewer stay
 * refused.
 */

const PRICED_ID = "c0000000-0000-4000-8000-00000000f001";
const COMP_ID = "c0000000-0000-4000-8000-00000000f002";
const LEGACY_ID = "c0000000-0000-4000-8000-00000000f003";
const CARD_ID = "c0000000-0000-4000-8000-00000000f004";

/** Two hours before NOW: far outside the till's 15-minute window. */
const LONG_AGO = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
const DAY_MS = 24 * 60 * 60 * 1000;
/** The world's event ends at NOW. */
const afterEventEnds = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

function deps(w: CashWorld) {
  return { repos: w.repos, authz: w.authz, clock: w.clock };
}

function refund(w: CashWorld, orderId: string, orgId = ORG_ID) {
  return orgRefundCashSale(deps(w), {
    actorHumanId: ACTOR_ID,
    orgId,
    orderId,
  });
}

describe("orgRefundCashSale — an Editor refunds a cash sale after the till's window", () => {
  it("two hours after the sale: full total back, one reversal, payable restored, items stamped, tickets voided", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    expect(w.netBalanceCents()).toBe(-PRICED.debitCents);

    const out = await refund(w, PRICED_ID);

    expect(out).toEqual({
      orderId: PRICED_ID,
      refundedTicketCount: 2,
      amountReturnedCents: PRICED.totalCents,
      feeAndTaxNoLongerOwedCents: PRICED.debitCents,
      alreadyRefunded: false,
    });

    const order = w.orders.get(PRICED_ID)!;
    expect(order.status).toBe("REFUNDED");
    expect(w.tickets.get(PRICED_ID)!.map((t) => t.status)).toEqual([
      "REFUNDED",
      "REFUNDED",
    ]);
    // Each ticket item says what it gave back; the stamps add up to the
    // order's fee and tax exactly.
    expect(
      order.items.map((i) => [
        i.status,
        i.refundedPlatformFeeCents,
        i.refundedTaxCents,
      ]),
    ).toEqual([
      ["refunded", 175, 261],
      ["refunded", 175, 261],
    ]);
    expect(w.tx.feeWaivers.release).toHaveBeenCalledWith(PRICED_ID);
    expect(w.tx.promos.releaseHoldsForOrder).toHaveBeenCalledWith(PRICED_ID);

    const reversals = w.reversalsFor(PRICED_ID);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      payeeId: PAYEE_ID,
      amountCents: PRICED.debitCents,
      idempotencyKey: `cash-sale-debit-reversal:${PRICED_ID}`,
      metadata: expect.objectContaining({ via: "org", actorHumanId: ACTOR_ID }),
    });
    // Debit + reversal net to zero: the next payout is no longer reduced.
    expect(w.netBalanceCents()).toBe(0);

    const audit = w.auditRows.filter((r) => r.action === "pos_cash_refund");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({
      via: "org",
      actorHumanId: ACTOR_ID,
      amountReturnedCents: PRICED.totalCents,
      cashSaleDebitReversedCents: PRICED.debitCents,
      moneyMoved: false,
    });
  });

  it("the till's gate refund still refuses the same sale after 15 minutes", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });

    await expect(
      refundCashSale(deps(w), { actorHumanId: ACTOR_ID, orderId: PRICED_ID }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "gate_refund_window_expired",
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
  });

  it("the roles that may refund are exactly Owner, Admin, Editor and Finance", () => {
    expect([...ORG_CASH_REFUND_ROLES].sort()).toEqual([
      "ADMIN",
      "EDITOR",
      "FINANCE",
      "OWNER",
    ]);
  });

  it.each(["OWNER", "ADMIN", "EDITOR", "FINANCE"] as const)(
    "%s may refund",
    async (role) => {
      const w = makeCashWorld();
      await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
      w.setRole(role);
      await expect(refund(w, PRICED_ID)).resolves.toMatchObject({
        alreadyRefunded: false,
      });
      // By membership: the platform is never asked inside the window.
      expect(w.authz.hasStaffRole).not.toHaveBeenCalled();
      expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({
        via: "org",
      });
    },
  );

  it.each(["SCANNER", "VIEWER", null] as const)(
    "%s is refused before the order is read, and nothing changes",
    async (role) => {
      const w = makeCashWorld();
      await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
      w.setRole(role);

      await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(w.tx.orders.getById).not.toHaveBeenCalled();
      // Not a member with the role: only the platform-staff override is
      // asked, and it says no.
      expect(w.authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN"],
      });
      expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
      expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
    },
  );

  it("a SCANNER is refused by the gate refund even inside the window", async () => {
    const w = makeCashWorld();
    // Sold just now: the window is open, so only the role refuses.
    await w.addPricedCashOrder(PRICED_ID);
    w.setRole("SCANNER");
    await expect(
      refundCashSale(deps(w), { actorHumanId: ACTOR_ID, orderId: PRICED_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("a second refund writes nothing: same totals, alreadyRefunded, one reversal, one audit row", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    await refund(w, PRICED_ID);
    const ledgerRows = w.ledger.entries.length;

    const again = await refund(w, PRICED_ID);

    expect(again).toEqual({
      orderId: PRICED_ID,
      refundedTicketCount: 2,
      amountReturnedCents: PRICED.totalCents,
      feeAndTaxNoLongerOwedCents: 0,
      alreadyRefunded: true,
    });
    expect(w.ledger.entries).toHaveLength(ledgerRows);
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(1);
    expect(w.auditRows.filter((r) => r.action === "pos_cash_refund")).toHaveLength(1);
    expect(w.netBalanceCents()).toBe(0);
  });

  it("a sale the gate already refunded is a no-op for the Editor too", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID);
    await refundCashSale(deps(w), {
      actorHumanId: ACTOR_ID,
      orderId: PRICED_ID,
    });

    const out = await refund(w, PRICED_ID);
    expect(out.alreadyRefunded).toBe(true);
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(1);
  });

  it("a comp refunds to $0 and writes nothing to the ledger", async () => {
    const w = makeCashWorld();
    w.addCompCashOrder(COMP_ID, { occurredAt: LONG_AGO });

    const out = await refund(w, COMP_ID);

    expect(out).toMatchObject({
      amountReturnedCents: 0,
      feeAndTaxNoLongerOwedCents: 0,
      refundedTicketCount: 1,
    });
    expect(w.orders.get(COMP_ID)!.status).toBe("REFUNDED");
    expect(w.tickets.get(COMP_ID)![0]!.status).toBe("REFUNDED");
    expect(w.ledger.entries).toHaveLength(0);
  });

  it("a cash order from before the door was priced refunds its gross and writes nothing to the ledger", async () => {
    const w = makeCashWorld();
    w.addLegacyCashOrder(LEGACY_ID, 3000, { occurredAt: LONG_AGO });

    const out = await refund(w, LEGACY_ID);

    expect(out).toMatchObject({
      amountReturnedCents: 3000,
      feeAndTaxNoLongerOwedCents: 0,
    });
    expect(w.orders.get(LEGACY_ID)!.status).toBe("REFUNDED");
    expect(w.ledger.entries).toHaveLength(0);
    // Nothing was charged, so the stamps are measured zeros.
    expect(w.orders.get(LEGACY_ID)!.items[0]).toMatchObject({
      refundedPlatformFeeCents: 0,
      refundedTaxCents: 0,
    });
  });

  it("refuses a card order (they refund through orgRefundFullOrder)", async () => {
    const w = makeCashWorld();
    await w.addCardOrder(CARD_ID);
    await expect(refund(w, CARD_ID)).rejects.toMatchObject({
      code: "NOT_A_CASH_ORDER",
    });
    expect(w.orders.get(CARD_ID)!.status).toBe("SUCCEEDED");
  });

  it("an order of another org's event is ORDER_NOT_FOUND (its existence is not leaked)", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID);
    // The actor is an Editor of OTHER_ORG_ID; the sale is ORG_ID's.
    w.tx.authz.getOrgMembership.mockImplementation(async (q: { orgId: string }) =>
      q.orgId === OTHER_ORG_ID
        ? { orgId: OTHER_ORG_ID, humanId: ACTOR_ID, role: "EDITOR" as const }
        : null,
    );

    await expect(refund(w, PRICED_ID, OTHER_ORG_ID)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
  });

  it("keeps an optional note on the audit trail, sanitized", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });

    await orgRefundCashSale(deps(w), {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: PRICED_ID,
      note: "Band no-show <b>at 9pm</b>",
    });

    const note = w.auditRows.find((r) => r.action === "org_cash_refund_note");
    expect(note?.data).toMatchObject({ orgId: ORG_ID, actorHumanId: ACTOR_ID });
    expect(note?.data.note).not.toContain("<b>");
  });

  it("rejects unknown input keys (strict)", async () => {
    const w = makeCashWorld();
    await expect(
      orgRefundCashSale(deps(w), {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        orderId: PRICED_ID,
        skipWindow: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("orgRefundCashSale — a Finance member refunds a cash sale (decision 2026-10-10)", () => {
  it("two hours after the sale: the same refund an Editor makes, attributed to the org", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole("FINANCE");

    const out = await refund(w, PRICED_ID);

    expect(out).toEqual({
      orderId: PRICED_ID,
      refundedTicketCount: 2,
      amountReturnedCents: PRICED.totalCents,
      feeAndTaxNoLongerOwedCents: PRICED.debitCents,
      alreadyRefunded: false,
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("REFUNDED");
    expect(w.tickets.get(PRICED_ID)!.map((t) => t.status)).toEqual([
      "REFUNDED",
      "REFUNDED",
    ]);
    const reversals = w.reversalsFor(PRICED_ID);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      payeeId: PAYEE_ID,
      amountCents: PRICED.debitCents,
      metadata: expect.objectContaining({ via: "org", actorHumanId: ACTOR_ID }),
    });
    expect(w.netBalanceCents()).toBe(0);
    const audit = w.auditRows.filter((r) => r.action === "pos_cash_refund");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ via: "org", actorHumanId: ACTOR_ID });
    // A member in the role set: the platform override is never consulted.
    expect(w.authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("6 days after the event ends may refund", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole("FINANCE");
    w.setNow(afterEventEnds(6));

    const out = await refund(w, PRICED_ID);

    expect(out.alreadyRefunded).toBe(false);
    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({ via: "org" });
  });

  it("8 days after the event ends is refused with CASH_REFUND_WINDOW_CLOSED like an Editor, and nothing changes", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole("FINANCE");
    w.setNow(afterEventEnds(8));

    await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
      code: "CASH_REFUND_WINDOW_CLOSED",
      meta: {
        eventEndedAt: NOW.toISOString(),
        windowClosedAt: afterEventEnds(7).toISOString(),
      },
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
    expect(w.netBalanceCents()).toBe(-PRICED.debitCents);
  });

  it("a Finance member of another org gets ORDER_NOT_FOUND for this org's sale", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.tx.authz.getOrgMembership.mockImplementation(async (q: { orgId: string }) =>
      q.orgId === OTHER_ORG_ID
        ? { orgId: OTHER_ORG_ID, humanId: ACTOR_ID, role: "FINANCE" as const }
        : null,
    );

    await expect(refund(w, PRICED_ID, OTHER_ORG_ID)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
  });

  it("refuses a card order for Finance too (they refund it through orgRefundFullOrder)", async () => {
    const w = makeCashWorld();
    await w.addCardOrder(CARD_ID);
    w.setRole("FINANCE");

    await expect(refund(w, CARD_ID)).rejects.toMatchObject({
      code: "NOT_A_CASH_ORDER",
    });
    expect(w.orders.get(CARD_ID)!.status).toBe("SUCCEEDED");
  });
});

describe("orgRefundCashSale — two refunds racing on one order", () => {
  it("the loser of the claim takes the already-refunded path: one reversal, one audit row", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    await refund(w, PRICED_ID);
    const ledgerRows = w.ledger.entries.length;

    // The second refund read the order before the first committed: it sees
    // SUCCEEDED, and only the compare-and-set tells it otherwise.
    const refunded = w.orders.get(PRICED_ID)!;
    w.tx.orders.getById.mockImplementationOnce(async () => ({
      ...refunded,
      status: "SUCCEEDED",
    }));

    const again = await refund(w, PRICED_ID);

    expect(w.tx.orders.markRefundedIfSucceeded).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({
      alreadyRefunded: true,
      amountReturnedCents: PRICED.totalCents,
      feeAndTaxNoLongerOwedCents: 0,
    });
    expect(w.ledger.entries).toHaveLength(ledgerRows);
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(1);
    expect(w.auditRows.filter((r) => r.action === "pos_cash_refund")).toHaveLength(1);
    expect(w.netBalanceCents()).toBe(0);
  });

  it("a claim lost to anything but a refund is refused, and nothing is written", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    const order = w.orders.get(PRICED_ID)!;
    // Read as SUCCEEDED; by the claim it is something else.
    w.tx.orders.getById.mockImplementationOnce(async () => ({ ...order }));
    order.status = "PART_REFUNDED" as typeof order.status;

    await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
      code: "invalid_input",
      message: "order_not_refundable",
    });
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
  });
});

describe("orgRefundCashSale — the window: until 7 days after the event ends (owner ruling 2026-10-07)", () => {
  it("an Editor 6 days after the event ends may refund", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setNow(afterEventEnds(6));

    const out = await refund(w, PRICED_ID);

    expect(out.alreadyRefunded).toBe(false);
    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({ via: "org" });
    // Inside the window nobody asks the platform.
    expect(w.authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("an Editor 8 days after the event ends is refused with CASH_REFUND_WINDOW_CLOSED, and nothing changes", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setNow(afterEventEnds(8));
    const ticketsBefore = w.tickets.get(PRICED_ID)!.map((t) => t.status);

    await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
      code: "CASH_REFUND_WINDOW_CLOSED",
      meta: {
        eventEndedAt: NOW.toISOString(),
        windowClosedAt: afterEventEnds(7).toISOString(),
      },
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
    expect(w.tickets.get(PRICED_ID)!.map((t) => t.status)).toEqual(
      ticketsBefore,
    );
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
    expect(w.netBalanceCents()).toBe(-PRICED.debitCents);
  });

  it("an Editor at exactly the window's close instant may refund", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole("EDITOR");
    // `cashRefundWindowClosesAt` — the instant `getOrgOrder` shows as
    // `cashRefundableUntil` — still counts as inside.
    w.setNow(afterEventEnds(7));

    const out = await refund(w, PRICED_ID);

    expect(out.alreadyRefunded).toBe(false);
    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({ via: "org" });
    expect(w.authz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("an Editor 1 ms after the window's close is refused with CASH_REFUND_WINDOW_CLOSED", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole("EDITOR");
    w.setNow(new Date(afterEventEnds(7).getTime() + 1));

    await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
      code: "CASH_REFUND_WINDOW_CLOSED",
      meta: { windowClosedAt: afterEventEnds(7).toISOString() },
    });
    expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
  });

  it("an event with no end time is measured from its start", async () => {
    const w = makeCashWorld();
    (w.event as { endsAt: Date | null }).endsAt = null;
    (w.event as { startsAt: Date }).startsAt = new Date(NOW.getTime() - DAY_MS);
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    // The window closes 7 days after the START, i.e. 6 days after NOW; a
    // minute past that it is closed.
    w.setNow(new Date(NOW.getTime() + 6 * DAY_MS + 60_000));

    await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
      code: "CASH_REFUND_WINDOW_CLOSED",
    });
  });

  it("platform staff 8 days after the event ends may refund; the ledger and the audit trail say via platform", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setNow(afterEventEnds(8));
    // Not a member of the org at all: the platform-staff override lets them in.
    w.setRole(null);
    w.setStaffAdmin(true);

    const out = await refund(w, PRICED_ID);

    expect(out).toMatchObject({
      alreadyRefunded: false,
      amountReturnedCents: PRICED.totalCents,
      feeAndTaxNoLongerOwedCents: PRICED.debitCents,
    });
    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({
      via: "platform",
      actorHumanId: ACTOR_ID,
    });
    const audit = w.auditRows.filter((r) => r.action === "pos_cash_refund");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ via: "platform", actorHumanId: ACTOR_ID });
    expect(w.netBalanceCents()).toBe(0);
  });

  it("platform staff with no membership inside the window may refund, recorded as platform", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole(null);
    w.setStaffAdmin(true);

    const out = await refund(w, PRICED_ID);

    expect(out.alreadyRefunded).toBe(false);
    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({
      via: "platform",
      actorHumanId: ACTOR_ID,
    });
    const audit = w.auditRows.filter((r) => r.action === "pos_cash_refund");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ via: "platform" });
  });

  it.each(["SCANNER", "VIEWER"] as const)(
    "a %s who is also platform staff refunds through the override, recorded as platform",
    async (role) => {
      const w = makeCashWorld();
      await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
      w.setRole(role);
      w.setStaffAdmin(true);

      await refund(w, PRICED_ID);

      expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({
        via: "platform",
      });
    },
  );

  it("a Finance member who is also platform staff is let through after the window, recorded as platform", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setRole("FINANCE");
    w.setNow(afterEventEnds(8));
    w.setStaffAdmin(true);

    await refund(w, PRICED_ID);

    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({ via: "platform" });
    const audit = w.auditRows.filter((r) => r.action === "pos_cash_refund");
    expect(audit[0]!.data).toMatchObject({ via: "platform" });
  });

  it("an org Editor who is also platform staff is let through after the window, recorded as platform", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    w.setNow(afterEventEnds(8));
    w.setStaffAdmin(true);

    await refund(w, PRICED_ID);

    expect(w.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN"],
    });
    expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({ via: "platform" });
  });

  it("a refunded sale replayed after the window is still the stored no-op, not a refusal", async () => {
    const w = makeCashWorld();
    await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
    await refund(w, PRICED_ID);
    w.setNow(afterEventEnds(30));

    const again = await refund(w, PRICED_ID);
    expect(again.alreadyRefunded).toBe(true);
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(1);
  });
});

/**
 * The staff probe refuses a platform ADMIN who has no passkey or TOTP
 * (`{ allowed: false, secondFactorRequired: true }`). Such an actor gets
 * nothing from the platform role here: what their org membership allows, and
 * no more. Where only the override could have let them in, the refusal is
 * SECOND_FACTOR_REQUIRED, so they know what to fix.
 */
describe("orgRefundCashSale — a platform ADMIN with no second factor enrolled", () => {
  function unenrolledAdminWorld() {
    const w = makeCashWorld();
    w.setStaffAdmin(true);
    w.setStaffSecondFactor(false);
    return w;
  }

  it.each(["OWNER", "ADMIN", "EDITOR", "FINANCE"] as const)(
    "as a %s member inside the window refunds by membership, attributed to the org",
    async (role) => {
      const w = unenrolledAdminWorld();
      await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
      w.setRole(role);

      const out = await refund(w, PRICED_ID);

      expect(out.alreadyRefunded).toBe(false);
      expect(w.reversalsFor(PRICED_ID)[0]!.metadata).toMatchObject({ via: "org" });
      const audit = w.auditRows.filter((r) => r.action === "pos_cash_refund");
      expect(audit[0]!.data).toMatchObject({ via: "org" });
    },
  );

  it.each(["OWNER", "ADMIN", "EDITOR", "FINANCE"] as const)(
    "as a %s member past the window is refused with CASH_REFUND_WINDOW_CLOSED, and nothing changes",
    async (role) => {
      const w = unenrolledAdminWorld();
      await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
      w.setRole(role);
      w.setNow(afterEventEnds(8));

      await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
        code: "CASH_REFUND_WINDOW_CLOSED",
        meta: { windowClosedAt: afterEventEnds(7).toISOString() },
      });
      // The platform was asked, and its refusal did not open the window.
      expect(w.authz.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: ACTOR_ID,
        requiredRoles: ["ADMIN"],
      });
      expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
      expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
      expect(w.auditRows).toHaveLength(0);
    },
  );

  it.each(["SCANNER", "VIEWER", null] as const)(
    "as %s is refused with SECOND_FACTOR_REQUIRED before the order is read, inside or past the window",
    async (role) => {
      const w = unenrolledAdminWorld();
      await w.addPricedCashOrder(PRICED_ID, { occurredAt: LONG_AGO });
      w.setRole(role);

      await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
        code: "SECOND_FACTOR_REQUIRED",
      });
      w.setNow(afterEventEnds(8));
      await expect(refund(w, PRICED_ID)).rejects.toMatchObject({
        code: "SECOND_FACTOR_REQUIRED",
      });

      expect(w.tx.orders.getById).not.toHaveBeenCalled();
      expect(w.orders.get(PRICED_ID)!.status).toBe("SUCCEEDED");
      expect(w.reversalsFor(PRICED_ID)).toHaveLength(0);
      expect(w.auditRows).toHaveLength(0);
    },
  );
});

describe("refundCashSale (the till) — a replay after its 15-minute window", () => {
  it("returns the stored result instead of refusing, and writes nothing", async () => {
    const w = makeCashWorld();
    // Sold just now: inside the till's window.
    await w.addPricedCashOrder(PRICED_ID);
    const first = await refundCashSale(deps(w), {
      actorHumanId: ACTOR_ID,
      orderId: PRICED_ID,
    });
    expect(first.amountReturnedCents).toBe(PRICED.totalCents);
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(1);
    const ledgerRows = w.ledger.entries.length;

    // The till retries 20 minutes later (a dropped response, a reconnect).
    w.setNow(new Date(NOW.getTime() + 20 * 60 * 1000));
    const replay = await refundCashSale(deps(w), {
      actorHumanId: ACTOR_ID,
      orderId: PRICED_ID,
    });

    // Not gate_refund_window_expired: the refund already happened, so the
    // till gets back what it was told the first time.
    expect(replay).toEqual(first);
    expect(w.ledger.entries).toHaveLength(ledgerRows);
    expect(w.reversalsFor(PRICED_ID)).toHaveLength(1);
    expect(w.auditRows.filter((r) => r.action === "pos_cash_refund")).toHaveLength(1);
  });
});
