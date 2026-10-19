import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import {
  CLAIM_REFUNDED_NOTICE_KEEP_SEC,
  claimRefundedNoticeKey,
  notifyClaimRefunded,
  notifyClaimRefundedForOrder,
  type ClaimRefundPaymentsReader,
} from "../notify-claim-refunded";

const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ITEM_ID = "iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii";
const BUYER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PI_ID = "pi_claim_123";
const NOW = new Date("2026-10-07T12:00:00Z");

const CLAIM_METADATA = { useCase: "reviewClaim", orderId: ORDER_ID };

const PARAMS = {
  claimId: CLAIM_ID,
  claimantId: BUYER_ID,
  orderId: ORDER_ID,
  eventId: EVENT_ID,
  currency: "usd",
  amount: { refundId: null, paymentIntentId: null, fallbackCents: 5500 },
};

const EN_BODY =
  "We refunded $55.00 for the Sunset Sessions resale ticket to the payment method you used. Your bank can take 5 to 10 business days to show it.";

function makeDeps(
  opts: {
    locale?: string | null;
    createThrows?: boolean;
    sendThrows?: boolean;
    reporterThrows?: boolean;
    loggerThrows?: boolean;
    order?: Record<string, unknown> | null;
    claim?: Record<string, unknown> | null;
    payments?: ClaimRefundPaymentsReader | null;
  } = {},
) {
  const create = vi.fn(async (_input: CreateNotificationInput) => {
    if (opts.createThrows) throw new Error("db down");
    return { id: "notif-1", createdAt: NOW };
  });
  const send = vi.fn(
    async (_m: { subject: string; text: string; idempotencyKey?: string }) => {
      if (opts.sendThrows) throw new Error("smtp down");
      return { result: { id: "m", status: "sent" } };
    },
  );
  const reportError = vi.fn(() => {
    if (opts.reporterThrows) throw new Error("reporter down");
  });
  const loggerFn = vi.fn(() => {
    if (opts.loggerThrows) throw new Error("logger down");
  });
  const logger = {
    info: loggerFn,
    warn: loggerFn,
    error: loggerFn,
    child: vi.fn(() => {
      if (opts.loggerThrows) throw new Error("logger down");
      return logger;
    }),
  } as unknown as LoggerPort;
  const order =
    opts.order === undefined
      ? {
          id: ORDER_ID,
          source: "RESALE",
          status: "REFUNDED",
          currency: "usd",
          stripePaymentIntentId: PI_ID,
          items: [{ id: ITEM_ID, kind: "ticket" }],
        }
      : opts.order;
  const claim =
    opts.claim === undefined
      ? {
          id: CLAIM_ID,
          status: "approved",
          claimantId: BUYER_ID,
          eventId: EVENT_ID,
        }
      : opts.claim;
  const getByOrderItemId = vi.fn(async () => claim);
  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Buyer", locale: opts.locale ?? null },
        identity: { email: "buyer@example.com" },
      })),
    },
    events: {
      getById: vi.fn(async () => ({ id: EVENT_ID, title: "Sunset Sessions" })),
    },
    orders: { getById: vi.fn(async () => order) },
    claims: { getByOrderItemId },
    notifications: { create },
  } as unknown as Repos;
  const idempotency = createFakeIdempotencyPort();
  const mailer = { send } as unknown as MailerPort;
  return {
    deps: {
      repos,
      idempotency,
      mailer,
      publicAppUrl: "https://ithas.fire/",
      payments: opts.payments ?? null,
      logger,
      reportError,
    },
    create,
    send,
    reportError,
    idempotency,
    getByOrderItemId,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("notifyClaimRefunded", () => {
  it("writes one in-app row and one email, then records that the buyer was told", async () => {
    const { deps, create, send, idempotency } = makeDeps();

    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe("sent");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      humanId: BUYER_ID,
      title: "We've refunded you",
      body: EN_BODY,
      kind: "SUCCESS",
      metadata: { variant: "resale.claim-refunded" },
      action: {
        label: "View order",
        href: `https://ithas.fire/my-tickets/${ORDER_ID}`,
      },
      template: expect.objectContaining({ key: "resale.claim-refunded" }),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: { to: "buyer@example.com" },
      subject: "We've refunded you for Sunset Sessions",
      text: [
        EN_BODY,
        "",
        `View your order: https://ithas.fire/my-tickets/${ORDER_ID}`,
        "",
        "Ithas Fire Support",
      ].join("\n"),
      idempotencyKey: `resale-claim-refunded:${CLAIM_ID}`,
    });
    expect(idempotency.__mocks.commit).toHaveBeenLastCalledWith(
      claimRefundedNoticeKey(CLAIM_ID),
      expect.objectContaining({ sentAt: expect.any(String) }),
      CLAIM_REFUNDED_NOTICE_KEEP_SEC,
    );
  });

  it("commits a long-kept `writing` record BEFORE the in-app write", async () => {
    const { deps, idempotency, create } = makeDeps();
    const order: string[] = [];
    idempotency.__mocks.commit.mockImplementation(
      async (_key: string, result: unknown) => {
        order.push(
          (result as { writing?: boolean }).writing ? "writing" : "sent",
        );
      },
    );
    create.mockImplementation(async () => {
      order.push("in-app");
      return { id: "notif-1", createdAt: NOW };
    });

    await notifyClaimRefunded(deps, PARAMS);

    expect(order).toEqual(["writing", "in-app", "sent"]);
    expect(idempotency.__mocks.commit).toHaveBeenNthCalledWith(
      1,
      claimRefundedNoticeKey(CLAIM_ID),
      { writing: true },
      CLAIM_REFUNDED_NOTICE_KEEP_SEC,
    );
  });

  it("a second trigger (webhook redelivery, staff retry) sends nothing", async () => {
    const { deps, create, send } = makeDeps();

    await notifyClaimRefunded(deps, PARAMS);
    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe(
      "already_sent",
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("two triggers racing send once", async () => {
    const { deps, create, send } = makeDeps();

    const outcomes = await Promise.all([
      notifyClaimRefunded(deps, PARAMS),
      notifyClaimRefunded(deps, PARAMS),
    ]);

    expect(outcomes.sort()).toEqual(["already_sent", "sent"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("emails a Spanish-speaking buyer in Spanish", async () => {
    const { deps, send, create } = makeDeps({ locale: "es-MX" });

    await notifyClaimRefunded(deps, PARAMS);

    // The stored in-app text stays English; the inbox re-renders it.
    expect(create.mock.calls[0]![0].title).toBe("We've refunded you");
    expect(send.mock.calls[0]![0]).toMatchObject({
      subject: "Te reembolsamos por Sunset Sessions",
      text: [
        "Te devolvimos $55.00 por la entrada de reventa para Sunset Sessions al mismo medio de pago que usaste. Tu banco puede tardar de 5 a 10 días hábiles en mostrarlo.",
        "",
        `Ver tu pedido: https://ithas.fire/my-tickets/${ORDER_ID}`,
        "",
        "Soporte de Ithas Fire",
      ].join("\n"),
    });
  });

  it("a failed in-app write reports, never throws, and frees the record for a later try", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { deps, create, send, reportError, idempotency } = makeDeps({
      createThrows: true,
      reporterThrows: true,
    });

    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe("failed");

    expect(send).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "failed" },
      }),
    );
    // The `writing` record is replaced by a short-lived `failed` one.
    expect(idempotency.__mocks.fail).toHaveBeenCalledWith(
      claimRefundedNoticeKey(CLAIM_ID),
      "in_app_write_failed",
      1,
    );

    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    create.mockImplementation(async () => ({ id: "notif-2", createdAt: NOW }));
    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a failed email is reported, and the in-app row is still never sent twice", async () => {
    const { deps, create, reportError } = makeDeps({ sendThrows: true });

    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe("sent");
    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe(
      "already_sent",
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "email_failed" },
      }),
    );
  });

  it("a throwing logger never throws out, and the failure is still reported", async () => {
    const { deps, reportError } = makeDeps({
      loggerThrows: true,
      createThrows: true,
    });

    await expect(notifyClaimRefunded(deps, PARAMS)).resolves.toBe("failed");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "failed" },
      }),
    );
  });
});

describe("notifyClaimRefunded — the amount comes from the claim's own Stripe refund", () => {
  const amount = { refundId: "re_claim", paymentIntentId: PI_ID, fallbackCents: 10500 };

  it("a part-refunded order shows what this refund returned, not the whole charge", async () => {
    // Charge was $105.00; an earlier refund returned $50.00, so the claim's
    // full-PaymentIntent refund returns the remaining $55.00.
    const getRefund = vi.fn(async () => ({
      refundId: "re_claim",
      status: "succeeded" as const,
      amountCents: 5500,
      paymentIntentId: PI_ID,
      metadata: CLAIM_METADATA,
    }));
    const { deps, create } = makeDeps({ payments: { getRefund } });

    await notifyClaimRefunded(deps, { ...PARAMS, amount });

    expect(getRefund).toHaveBeenCalledWith({ refundId: "re_claim" });
    expect(create.mock.calls[0]![0].body).toBe(EN_BODY);
  });

  it("without a refund id, finds the claim's refund among the PaymentIntent's refunds", async () => {
    const listRefundsForPaymentIntent = vi.fn(async () => [
      { refundId: "re_earlier", status: "succeeded" as const, amountCents: 5000, metadata: { useCase: "refundOrderItems", orderId: ORDER_ID } },
      { refundId: "re_claim", status: "succeeded" as const, amountCents: 5500, metadata: CLAIM_METADATA },
    ]);
    const { deps, create } = makeDeps({
      payments: { listRefundsForPaymentIntent },
    });

    await notifyClaimRefunded(deps, {
      ...PARAMS,
      amount: { ...amount, refundId: null },
    });

    expect(create.mock.calls[0]![0].body).toBe(EN_BODY);
  });

  it("a Stripe read failure is reported and the fallback amount shown", async () => {
    const getRefund = vi.fn(async () => {
      throw new Error("stripe down");
    });
    const { deps, create, reportError } = makeDeps({ payments: { getRefund } });

    await expect(
      notifyClaimRefunded(deps, { ...PARAMS, amount }),
    ).resolves.toBe("sent");

    expect(create.mock.calls[0]![0].body).toContain("$105.00");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          useCase: "resale.notifyClaimRefunded",
          reason: "amount_lookup_failed",
        },
      }),
    );
  });
});

describe("notifyClaimRefundedForOrder", () => {
  it("tells the buyer when a refunded resale order has an approved claim", async () => {
    const { deps, create } = makeDeps();

    await expect(
      notifyClaimRefundedForOrder(deps, {
        orderId: ORDER_ID,
        amountRefundedCents: 5500,
      }),
    ).resolves.toBe("sent");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a primary order", { order: { id: ORDER_ID, source: "PRIMARY", status: "REFUNDED", currency: "usd", items: [{ id: ITEM_ID, kind: "ticket" }] } }],
    ["a resale order not yet refunded", { order: { id: ORDER_ID, source: "RESALE", status: "PART_REFUNDED", currency: "usd", items: [{ id: ITEM_ID, kind: "ticket" }] } }],
    ["a resale order with no claim", { claim: null }],
    ["a resale order whose claim is undecided", { claim: { id: CLAIM_ID, status: "under_review", claimantId: BUYER_ID, eventId: EVENT_ID } }],
    ["a resale order whose claim was denied", { claim: { id: CLAIM_ID, status: "denied", claimantId: BUYER_ID, eventId: EVENT_ID } }],
  ])("sends nothing for %s", async (_name, opts) => {
    const { deps, create, send } = makeDeps(opts);

    await expect(
      notifyClaimRefundedForOrder(deps, {
        orderId: ORDER_ID,
        amountRefundedCents: 5500,
      }),
    ).resolves.toBe("not_a_claim_refund");
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed lookup is reported and never throws", async () => {
    const { deps, getByOrderItemId, reportError } = makeDeps({
      reporterThrows: true,
    });
    getByOrderItemId.mockRejectedValueOnce(new Error("db down"));

    await expect(
      notifyClaimRefundedForOrder(deps, {
        orderId: ORDER_ID,
        amountRefundedCents: 5500,
      }),
    ).resolves.toBe("failed");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "resale.notifyClaimRefunded", reason: "lookup_failed" },
      }),
    );
  });
});
