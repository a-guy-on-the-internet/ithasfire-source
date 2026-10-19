import { describe, expect, it, vi } from "vitest";

import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";
import { sendTicketIssuedEmail } from "../../orders/send-ticket-issued-email";
import { mintTicketsForOrder } from "../../tickets/mint-tickets";
import { DOOR_RECEIPT_SEND_BUDGET_MS } from "../_shared/door-buyer";
import {
  EVENT_ID,
  NASHVILLE,
  NOW,
  PHANTOM_ID,
  makeWorld,
  sellCard,
  sellCash,
  type Scenario,
  type World,
} from "./door-sale-world";

/**
 * Optional buyer email at the door (spec 2026-10-07 door-sales FR-011, owner
 * ruling R7): recorded the way guest checkout records a guest email, no
 * account and no consent; the ticket and an itemised receipt (every tax line)
 * are emailed AFTER the sale commits (cash) or finalises (card, from the
 * payment webhook's `sendTicketIssuedEmail`), once. A mail fault never fails
 * the sale: reported (ReporterPort), and a throwing reporter changes nothing.
 *
 * Same world as the parity suites: 2 × $25 GA + 1 × $40 VIP in Nashville
 * (TN 9.75%, buyer-total base). Cash total 9878 (9000 face + round(9.75% ×
 * 9000) = 878 tax; no platform fee and no processing fee, owner ruling
 * 2026-10-08), card 10917.
 */
const localTaxRules = vi.hoisted(() => ({
  rules: [] as LocalTaxImpositionRule[],
}));
vi.mock("../../../lib/pricing/tax-impositions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/pricing/tax-impositions")>();
  return {
    ...actual,
    resolveTaxImpositions: (
      args: Parameters<typeof actual.resolveTaxImpositions>[0],
    ) => actual.resolveTaxImpositions(args, localTaxRules.rules),
  };
});

const TN: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };
const CASH_TOTAL = 9878;
const CARD_TOTAL = 10917;

function templates(w: World): string[] {
  return w.sentMail.map((m) => m.template.key as string);
}

function receipt(w: World) {
  const mail = w.sentMail.find((m) => m.template.key === "order.receipt");
  return mail
    ? {
        to: mail.to,
        idempotencyKey: mail.idempotencyKey,
        variables: mail.template.variables as {
          lineItems: Array<{ label: string; amountCents: number }>;
          totalCents: number;
          paymentMethod: string;
          currency: string;
          buyerName?: string;
          viewOrderUrl?: string;
          complimentary?: boolean;
        },
      }
    : null;
}

describe("door buyer email: validation", () => {
  it("is trimmed and lowercased (sign-up stores addresses lowercased)", async () => {
    const w = makeWorld(TN);
    await sellCash(w, TN, CASH_TOTAL, { buyerEmail: "  Walk.Up@Example.COM " });
    expect(w.tx.humans.ensureGuestHuman).toHaveBeenCalledWith({
      email: "walk.up@example.com",
    });
    expect(w.sentMail[0]!.to).toEqual({ to: "walk.up@example.com" });
  });

  it.each(["not-an-email", "a@", `${"a".repeat(320)}@x.io`])(
    "%j is refused before anything runs",
    async (buyerEmail) => {
      const w = makeWorld(TN);
      await expect(
        sellCash(w, TN, CASH_TOTAL, { buyerEmail }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(w.callLog).not.toContain("tx");
      expect(w.idempotency.begin).not.toHaveBeenCalled();
    },
  );

  it("is refused on the card sale too", async () => {
    await expect(sellCard(TN, { buyerEmail: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it.each(["", "   "])(
    "%j (the till's blank field) is no email: a phantom buyer, no mail, the same sale as no field",
    async (buyerEmail) => {
      const w = makeWorld(TN);
      const result = await sellCash(w, TN, CASH_TOTAL, { buyerEmail });
      expect(w.order()!.buyerHumanId).toBe(PHANTOM_ID);
      expect(w.tx.humans.ensureGuestHuman).not.toHaveBeenCalled();
      expect(w.mailer.send).not.toHaveBeenCalled();
      expect(w.reportError).not.toHaveBeenCalled();
      // Hashed as no email: a retry without the field replays, not conflicts.
      const replay = await sellCash(w, TN, CASH_TOTAL);
      expect(replay.orderId).toBe(result.orderId);
    },
  );

  it("a blank field on the card sale is no email too", async () => {
    const w = await sellCard(TN, { buyerEmail: "  " });
    expect(w.order()!.buyerHumanId).toBe(PHANTOM_ID);
    expect(w.tx.humans.ensureGuestHuman).not.toHaveBeenCalled();
  });
});

describe("door buyer email: cash", () => {
  it("records the order against the guest Human, sends the ticket + receipt AFTER the commit, once", async () => {
    const w = makeWorld(TN);
    const result = await sellCash(w, TN, 11000, {
      buyerEmail: "walkup@example.com",
    });
    expect(result.amountCents).toBe(CASH_TOTAL);
    // 11000 handed over − 9878 due.
    expect(result.changeCents).toBe(1122);

    // The guest mechanism, not a phantom; no name written, no account.
    const order = w.order()!;
    const guestId = w.guestHumans.get("walkup@example.com");
    expect(guestId).toBeDefined();
    expect(order.buyerHumanId).toBe(guestId);
    expect(w.tx.humans.create).not.toHaveBeenCalled();
    expect(w.tx.humans.update).not.toHaveBeenCalled();
    expect(w.tx.humans.ensureGuestHuman).toHaveBeenCalledTimes(1);

    // After the commit: the sale's (one) transaction ran before any mail,
    // and the idempotency record was committed before it too.
    expect(w.callLog.filter((c) => c === "tx")).toHaveLength(1);
    expect(w.callLog.indexOf("tx")).toBeLessThan(w.callLog.indexOf("mail"));
    expect(w.idempotency.commit).toHaveBeenCalledTimes(1);
    expect(w.mailer.send).toHaveBeenCalledTimes(2);
    expect(templates(w)).toEqual(["ticket.issued", "order.receipt"]);
    const ticketMail = w.sentMail[0]!;
    expect(ticketMail.idempotencyKey).toBe(`ticket-issued:${order.id}`);
    expect(ticketMail.template.variables.tickets).toHaveLength(3);
    // A guest with no account is invited to claim the ticket.
    expect(ticketMail.template.variables.accountCompletionUrl).toBe(
      "https://ithasfire.test/auth/complete?email=walkup%40example.com&src=guest-checkout",
    );

    const r = receipt(w)!;
    expect(r.to).toEqual({ to: "walkup@example.com" });
    expect(r.idempotencyKey).toBe(`door-sale-receipt:${order.id}`);
    expect(r.variables.lineItems).toEqual([
      { label: "General admission × 2", amountCents: 5000 },
      { label: "VIP × 1", amountCents: 4000 },
      // No platform fee and no processing fee on cash (owner ruling
      // 2026-10-08), so no fee line; tax re-solved on the face.
      { label: "Sales tax (9.75%)", amountCents: 878 },
    ]);
    expect(r.variables.totalCents).toBe(CASH_TOTAL);
    expect(r.variables.paymentMethod).toBe("Cash");
    expect(r.variables.currency).toBe("usd");
    expect(r.variables.buyerName).toBeUndefined();
    // A guest cannot sign in yet: no order-page link (a dead end behind
    // sign-in); the ticket email above carries the claim link.
    expect(r.variables).not.toHaveProperty("viewOrderUrl");
    expect(r.variables).not.toHaveProperty("complimentary");
    expect(w.reportError).not.toHaveBeenCalled();

    // A replay of the same sale (same key) returns the stored result and
    // sends nothing more.
    const replay = await sellCash(w, TN, 11000, {
      buyerEmail: "walkup@example.com",
    });
    expect(replay.orderId).toBe(result.orderId);
    expect(w.mailer.send).toHaveBeenCalledTimes(2);
  });

  it("no email: a phantom buyer and no mail at all", async () => {
    const w = makeWorld(TN);
    await sellCash(w, TN, CASH_TOTAL);
    expect(w.order()!.buyerHumanId).toBe(PHANTOM_ID);
    expect(w.tx.humans.ensureGuestHuman).not.toHaveBeenCalled();
    expect(w.mailer.send).not.toHaveBeenCalled();
  });

  it("an address with an account gets the ticket on that account", async () => {
    const existing = "99999999-0000-4000-8000-000000000001";
    const scenario: Scenario = {
      ...TN,
      existingAccounts: { "regular@example.com": existing },
    };
    const w = makeWorld(scenario);
    await sellCash(w, scenario, CASH_TOTAL, { buyerEmail: "regular@example.com" });
    expect(w.order()!.buyerHumanId).toBe(existing);
    // A real account: no claim link.
    expect(w.sentMail[0]!.template.variables.accountCompletionUrl).toBeUndefined();
    expect(receipt(w)!.variables.totalCents).toBe(CASH_TOTAL);
    // ...and their receipt links to the order page they can sign in to.
    expect(receipt(w)!.variables.viewOrderUrl).toBe(
      `https://ithasfire.test/my-tickets/${w.order()!.id}`,
    );
  });

  it("a different email on the same clientKey conflicts instead of replaying someone else's sale", async () => {
    const w = makeWorld(TN);
    await sellCash(w, TN, CASH_TOTAL, { buyerEmail: "a@example.com" });
    await expect(
      sellCash(w, TN, CASH_TOTAL, { buyerEmail: "b@example.com" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("a comp with an email gets the ticket and a $0 receipt (no fee, no tax)", async () => {
    const w = makeWorld(TN);
    const result = await sellCash(w, TN, 0, {
      comp: true,
      buyerEmail: "guest-list@example.com",
    });
    expect(result.isComp).toBe(true);
    expect(w.order()!.buyerHumanId).toBe(w.guestHumans.get("guest-list@example.com"));
    expect(templates(w)).toEqual(["ticket.issued", "order.receipt"]);
    const r = receipt(w)!;
    expect(r.variables.lineItems).toEqual([
      { label: "General admission × 2", amountCents: 0 },
      { label: "VIP × 1", amountCents: 0 },
    ]);
    expect(r.variables.totalCents).toBe(0);
    expect(r.variables.paymentMethod).toBe("Complimentary");
    // Worded as a gift, not "Thanks for your purchase".
    expect(r.variables.complimentary).toBe(true);
  });
});

describe("door buyer email: a mail fault never fails the sale (deliberate swallow → reportError)", () => {
  it("the mailer throws: the sale stands, reported once, logged at error", async () => {
    const w = makeWorld(TN);
    w.mailer.send.mockRejectedValue(new Error("ses down"));
    const result = await sellCash(w, TN, CASH_TOTAL, {
      buyerEmail: "walkup@example.com",
    });
    expect(result.amountCents).toBe(CASH_TOTAL);
    expect(w.order()!.status).toBe("SUCCEEDED");
    expect(w.ledger.entries).toHaveLength(1);

    const reports = w.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags?: { step?: string } }).tags?.step === "sendDoorReceipt",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "recordCashSale", step: "sendDoorReceipt" },
      extra: { orderId: result.orderId, eventId: EVENT_ID },
    });
    expect(w.logger.error).toHaveBeenCalledWith(
      "pos.door_receipt.send_failed",
      expect.objectContaining({ orderId: result.orderId }),
    );
    // The idempotency record committed: a retry replays, it does not sell again.
    const replay = await sellCash(w, TN, CASH_TOTAL, {
      buyerEmail: "walkup@example.com",
    });
    expect(replay.orderId).toBe(result.orderId);
    expect(w.tx.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("…and a THROWING reporter changes nothing", async () => {
    const w = makeWorld(TN);
    w.mailer.send.mockRejectedValue(new Error("ses down"));
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const result = await sellCash(w, TN, CASH_TOTAL, {
      buyerEmail: "walkup@example.com",
      reportError,
    });
    expect(result.amountCents).toBe(CASH_TOTAL);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a mailer that never answers: the till gets the sale back within the cap, reported once", async () => {
    const w = makeWorld(TN);
    w.mailer.send.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const result = await sellCash(w, TN, CASH_TOTAL, {
      buyerEmail: "walkup@example.com",
      receiptMail: { ...w.receiptMail, sendBudgetMs: 50 },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.amountCents).toBe(CASH_TOTAL);
    expect(w.order()!.status).toBe("SUCCEEDED");
    expect(w.idempotency.commit).toHaveBeenCalledTimes(1);
    expect(w.mailer.send).toHaveBeenCalledTimes(1);
    const reports = w.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags?: { step?: string } }).tags?.step === "sendDoorReceipt",
    );
    expect(reports).toHaveLength(1);
    expect((reports[0]![0] as Error).message).toBe("door_receipt_send_timed_out");
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "recordCashSale", step: "sendDoorReceipt" },
      extra: { orderId: result.orderId, eventId: EVENT_ID },
    });
  });

  it("the default cap is 3 s of wall time", async () => {
    expect(DOOR_RECEIPT_SEND_BUDGET_MS).toBe(3_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const w = makeWorld(TN);
      w.mailer.send.mockImplementation(() => new Promise(() => {}));
      let settled = false;
      const sale = sellCash(w, TN, CASH_TOTAL, {
        buyerEmail: "walkup@example.com",
      }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(DOOR_RECEIPT_SEND_BUDGET_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await sale;
      expect(result.amountCents).toBe(CASH_TOTAL);
      expect(w.reportError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no mailer configured: the sale stands and the missing receipt is reported", async () => {
    const w = makeWorld(TN);
    const result = await sellCash(w, TN, CASH_TOTAL, {
      buyerEmail: "walkup@example.com",
      receiptMail: null,
    });
    expect(result.amountCents).toBe(CASH_TOTAL);
    expect(w.mailer.send).not.toHaveBeenCalled();
    const reports = w.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags?: { step?: string } }).tags?.step === "sendDoorReceipt",
    );
    expect(reports).toHaveLength(1);
    expect((reports[0]![0] as Error).message).toBe(
      "door_receipt_mail_not_configured",
    );
  });
});

describe("door buyer email: card (receipt after the order finalises)", () => {
  /** What `finalizePaymentIntent` does to the order before the webhook mails. */
  async function finalise(w: World, orderId: string) {
    await w.tx.orders.markSucceeded(orderId);
    const order = await w.tx.orders.getById(orderId);
    await mintTicketsForOrder(w.tx as never, {
      order: order as never,
      issuedAt: NOW,
      actor: { kind: "system", reason: "test_finalize" },
    });
  }

  /** The payment webhook's call after a finalise (stripe/webhook.ts). */
  function webhookSend(w: World, orderId: string) {
    return sendTicketIssuedEmail(
      { repos: w.repos, mailer: w.mailer as never },
      {
        orderId,
        publicAppUrl: "https://ithasfire.test",
        supportUrl: "https://ithasfire.test/support",
      },
    );
  }

  it("starting the sale records the guest buyer and sends nothing; the finalised order's webhook send itemises card fees + tax", async () => {
    const w = makeWorld(TN);
    await sellCard(TN, { world: w, buyerEmail: "tap@example.com" });
    const order = w.order()!;
    expect(order.buyerHumanId).toBe(w.guestHumans.get("tap@example.com"));
    expect(order.paymentChannel).toBe("POS");
    expect(w.tx.humans.create).not.toHaveBeenCalled();
    // Nothing is mailed before the payment succeeds.
    expect(w.mailer.send).not.toHaveBeenCalled();

    await finalise(w, order.id);
    const out = await webhookSend(w, order.id);
    expect(out).toMatchObject({
      ok: true,
      recipientEmail: "tap@example.com",
      ticketCount: 3,
      receiptSent: true,
    });
    expect(templates(w)).toEqual(["ticket.issued", "order.receipt"]);
    const r = receipt(w)!;
    expect(r.variables.lineItems).toEqual([
      { label: "General admission × 2", amountCents: 5000 },
      { label: "VIP × 1", amountCents: 4000 },
      { label: "Platform fee", amountCents: 600 },
      { label: "Processing fee", amountCents: 347 },
      { label: "Sales tax (9.75%)", amountCents: 970 },
    ]);
    // The receipt total IS the card charge.
    expect(r.variables.totalCents).toBe(CARD_TOTAL);
    expect(w.paymentIntent!.amountCents).toBe(CARD_TOTAL);
    expect(r.variables.paymentMethod).toBe("Card");
    // A redelivered webhook sends under the same idempotency keys.
    await webhookSend(w, order.id);
    expect(w.sentMail.map((m) => m.idempotencyKey)).toEqual([
      `ticket-issued:${order.id}`,
      `door-sale-receipt:${order.id}`,
      `ticket-issued:${order.id}`,
      `door-sale-receipt:${order.id}`,
    ]);
  });

  it("a promo shows as its own line and the lines still add up to the charge", async () => {
    const scenario: Scenario = { ...TN, promo: { value: 500 } };
    const w = makeWorld(scenario);
    await sellCard(scenario, { world: w, buyerEmail: "tap@example.com" });
    const order = w.order()!;
    await finalise(w, order.id);
    await webhookSend(w, order.id);
    const r = receipt(w)!;
    expect(r.variables.lineItems).toEqual([
      { label: "General admission × 2", amountCents: 5000 },
      { label: "VIP × 1", amountCents: 4000 },
      { label: "Discount", amountCents: -500 },
      { label: "Platform fee", amountCents: 600 },
      { label: "Processing fee", amountCents: 331 },
      { label: "Sales tax (9.75%)", amountCents: 920 },
    ]);
    expect(r.variables.totalCents).toBe(10351);
    expect(w.paymentIntent!.amountCents).toBe(10351);
  });

  it("no email: the webhook's send is skipped (NO_RECIPIENT) instead of throwing into the dead-letter queue", async () => {
    const w = makeWorld(TN);
    await sellCard(TN, { world: w });
    const order = w.order()!;
    expect(order.buyerHumanId).toBe(PHANTOM_ID);
    await finalise(w, order.id);
    const out = await webhookSend(w, order.id);
    expect(out).toEqual({
      ok: true,
      orderId: order.id,
      recipientEmail: null,
      ticketCount: 0,
      skipped: "NO_RECIPIENT",
    });
    expect(w.mailer.send).not.toHaveBeenCalled();
  });
});
