import { describe, it, expect, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";

import type { LoggerPort } from "@th/ports/logger";

import {
  sendBankPaymentFailedEmail,
  type SendBankPaymentFailedEmailDeps,
} from "../send-bank-payment-failed-email";

// A REAL uuid with a distinct head and tail: the displayed code is the 8-hex
// TAIL, so a repdigit id would pass whichever end was taken.
const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
const ORDER_CODE = "DB21B2C3";
const BUYER_ID = "buyer-uuid";
const EVENT_ID = "event-uuid";
const PUBLIC_APP_URL = "https://ithasfire.com/";

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    kind: "TICKETING",
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    status: "CANCELLED",
    source: "PRIMARY",
    items: [],
    ...overrides,
  };
}

function makeBuyer(email = "buyer@example.com") {
  return {
    human: { id: BUYER_ID, name: "Buyer Person" },
    identity: { authUserId: BUYER_ID, email },
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Test Concert",
    slug: "test-concert",
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    order?: unknown;
    buyer?: unknown;
    event?: unknown;
    mailerSend?: (...args: unknown[]) => unknown;
    reportError?: (...args: unknown[]) => unknown;
  } = {},
) {
  const send = vi.fn(
    overrides.mailerSend ??
      (async () => ({ result: { success: true, id: "msg-1" } })),
  );
  const reportError = vi.fn(overrides.reportError ?? (() => undefined));
  // `child` returns the same logger so the use case's lines can be read back.
  const logger = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTime: vi.fn(async (_n: string, f: () => unknown) => f()),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const deps: SendBankPaymentFailedEmailDeps = {
    repos: {
      orders: {
        getById: vi.fn(async () =>
          "order" in overrides ? overrides.order : makeOrder(),
        ),
      },
      humans: {
        getByIdWithIdentity: vi.fn(async () =>
          "buyer" in overrides ? overrides.buyer : makeBuyer(),
        ),
      },
      events: {
        getById: vi.fn(async () =>
          "event" in overrides ? overrides.event : makeEvent(),
        ),
      },
    } as unknown as Repos,
    mailer: { send, sendBatch: vi.fn(), health: vi.fn() } as unknown as MailerPort,
    logger: logger as unknown as LoggerPort,
    reportError,
  };
  return { deps, send, reportError, logger };
}

const params = { orderId: ORDER_ID, publicAppUrl: PUBLIC_APP_URL };

describe("sendBankPaymentFailedEmail", () => {
  it("emails the buyer with the event title, the order code (tail) and the event page", async () => {
    const { deps, send, reportError } = makeDeps();

    await sendBankPaymentFailedEmail(deps, params);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      to: { to: "buyer@example.com" },
      template: {
        key: "order.bank_payment_failed",
        variables: {
          eventTitle: "Test Concert",
          orderCode: ORDER_CODE,
          eventUrl: "https://ithasfire.com/events/test-concert",
        },
      },
      idempotencyKey: `bank-payment-failed:${ORDER_ID}`,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("sends for a resale order the same way", async () => {
    const { deps, send, reportError } = makeDeps({
      order: makeOrder({ source: "RESALE" }),
    });

    await sendBankPaymentFailedEmail(deps, params);

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0] as {
      template: { variables: Record<string, unknown> };
    };
    expect(input.template.variables.orderCode).toBe(ORDER_CODE);
    expect(input.template.variables.eventTitle).toBe("Test Concert");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("sends without a link when the event has no slug", async () => {
    const { deps, send } = makeDeps({ event: makeEvent({ slug: null }) });

    await sendBankPaymentFailedEmail(deps, params);

    const input = send.mock.calls[0]![0] as {
      template: { variables: Record<string, unknown> };
    };
    expect(input.template.variables.eventUrl).toBeNull();
  });

  it.each([
    ["order_not_found", { order: null }],
    ["not_a_ticketing_order", { order: makeOrder({ kind: "MEMBERSHIP" }) }],
    ["buyer_not_found", { buyer: null }],
    ["event_not_found", { event: null }],
  ] as const)(
    "%s: returns without sending or throwing, and reports",
    async (reason, overrides) => {
      const { deps, send, reportError, logger } = makeDeps(overrides);

      await expect(
        sendBankPaymentFailedEmail(deps, params),
      ).resolves.toBeUndefined();

      expect(send).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { useCase: "orders.sendBankPaymentFailedEmail", reason },
        extra: expect.objectContaining({ orderId: ORDER_ID }),
      });
      expect(logger.error).toHaveBeenCalledWith(
        "notify.bank_payment_failed_email.failed",
        expect.objectContaining({ reason, orderId: ORDER_ID }),
      );
    },
  );

  it("a mailer that declines without throwing logs skipped, not sent, and does not report", async () => {
    const { deps, send, reportError, logger } = makeDeps({
      mailerSend: async () => ({
        result: { success: false, errorCode: "dependency_failed" },
      }),
    });

    await expect(
      sendBankPaymentFailedEmail(deps, params),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "notify.bank_payment_failed_email.skipped",
      { orderId: ORDER_ID, errorCode: "dependency_failed" },
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "notify.bank_payment_failed_email.sent",
      expect.anything(),
    );
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a successful send logs sent", async () => {
    const { deps, logger } = makeDeps();

    await sendBankPaymentFailedEmail(deps, params);

    expect(logger.info).toHaveBeenCalledWith(
      "notify.bank_payment_failed_email.sent",
      expect.objectContaining({ orderId: ORDER_ID }),
    );
  });

  it("a throwing mailer is reported, not thrown", async () => {
    const boom = new Error("smtp down");
    const { deps, reportError } = makeDeps({
      mailerSend: async () => {
        throw boom;
      },
    });

    await expect(
      sendBankPaymentFailedEmail(deps, params),
    ).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "orders.sendBankPaymentFailedEmail", reason: "send_failed" },
      extra: { orderId: ORDER_ID },
    });
  });

  it("a throwing reportError changes nothing", async () => {
    const { deps, reportError } = makeDeps({
      mailerSend: async () => {
        throw new Error("smtp down");
      },
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    await expect(
      sendBankPaymentFailedEmail(deps, params),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing reportError on a missing order changes nothing", async () => {
    const { deps, send } = makeDeps({
      order: null,
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    await expect(
      sendBankPaymentFailedEmail(deps, params),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
