import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

/**
 * `confirmPayment` takes the order from the PaymentIntent, not the client.
 *
 * A buyer returning from a redirect payment method (Amazon Pay, Cash App)
 * lands on a freshly mounted checkout page with no order id, or a stale
 * `resumeOrderId` for a cart `createCheckout` retired — so the client either
 * never confirmed or was refused with PAYMENT_INTENT_ORDER_MISMATCH. The PI's
 * server-written `metadata.orderId` is the authority; ownership is checked on
 * THAT order.
 *
 * `finalizePaymentIntent` is mocked: its own suite covers the finalize flow
 * (including the replay of an already-SUCCEEDED order). Here the question is
 * which order it is handed, and who is allowed to hand it.
 */
const finalizeMock = vi.hoisted(() => vi.fn());
vi.mock("../finalize-from-payment-intent", () => ({
  finalizePaymentIntent: finalizeMock,
}));

import {
  confirmPayment,
  confirmPaymentOutputSchema,
  confirmRetrievedPaymentIntent,
} from "../confirm-payment";

const BUYER = "11111111-1111-4111-8111-111111111111";
const OTHER_BUYER = "22222222-2222-4222-8222-222222222222";
const CURRENT_ORDER = "33333333-3333-4333-8333-333333333333";
const STALE_ORDER = "44444444-4444-4444-8444-444444444444";
const FOREIGN_ORDER = "55555555-5555-4555-8555-555555555555";
const PI_ID = "pi_redirectReturn1";

type OrderRow = {
  id: string;
  buyerHumanId: string;
  status: string;
  stripePaymentIntentId?: string | null;
};

function harness(opts: {
  orders: OrderRow[];
  piMetadata: Record<string, string>;
  piStatus?: string;
}) {
  const byId = new Map(opts.orders.map((o) => [o.id, o]));
  const orders = {
    getById: vi.fn(async (id: string) => byId.get(id) ?? null),
    markProcessing: vi.fn(async () => undefined),
    // CAS like the adapter: PENDING → PROCESSING only.
    markProcessingIfPending: vi.fn(async (id: string) => {
      const row = byId.get(id);
      if (!row || row.status !== "PENDING") return false;
      row.status = "PROCESSING";
      return true;
    }),
  };
  const retrievePaymentIntent = vi.fn(async () => ({
    id: PI_ID,
    status: opts.piStatus ?? "succeeded",
    amountReceived: 2500,
    currency: "usd",
    metadata: opts.piMetadata,
  }));
  const deps = {
    repos: { orders } as unknown as Repos,
    payments: { retrievePaymentIntent } as unknown as PaymentProcessorPort,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => new Date("2026-10-01T12:00:00Z") },
  };
  return { deps, orders, retrievePaymentIntent };
}

beforeEach(() => {
  finalizeMock.mockReset();
  finalizeMock.mockImplementation(
    async (_deps: unknown, input: { stripeEvent: { data: { object: { metadata: { orderId: string } } } } }) => ({
      ok: true,
      orderId: input.stripeEvent.data.object.metadata.orderId,
    }),
  );
});

// gitleaks:allow (fake test fixture)
const CLIENT_SECRET_FIXTURE = "pi_3Abc_secret_FakeFixtureNotReal";

describe("confirmPayment — the order comes from the PaymentIntent", () => {
  it("PI-only: no client order id → confirms the order the PI metadata names", async () => {
    const { deps, retrievePaymentIntent } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" }],
      piMetadata: { orderId: CURRENT_ORDER, source: "primary" },
    });

    const out = await confirmPayment(deps, {
      actorHumanId: BUYER,
      paymentIntentId: PI_ID,
    });

    expect(out).toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "confirmed" });
    expect(retrievePaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: PI_ID,
    });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(
      finalizeMock.mock.calls[0]![1].stripeEvent.data.object.metadata.orderId,
    ).toBe(CURRENT_ORDER);
    // The synthetic event id is keyed on the PI, so a retried confirm hits
    // finalize's idempotency record rather than finalizing twice.
    expect(finalizeMock.mock.calls[0]![1].stripeEvent.id).toBe(
      `client_confirm_${PI_ID}`,
    );
  });

  it("regression: a STALE order id (a retired cart of the same buyer) confirms the PI's order instead of failing PAYMENT_INTENT_ORDER_MISMATCH", async () => {
    const { deps } = harness({
      orders: [
        { id: STALE_ORDER, buyerHumanId: BUYER, status: "CANCELLED" },
        { id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" },
      ],
      piMetadata: { orderId: CURRENT_ORDER },
    });

    const out = await confirmPayment(deps, {
      actorHumanId: BUYER,
      orderId: STALE_ORDER,
      paymentIntentId: PI_ID,
    });

    expect(out).toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "confirmed" });
    expect(
      finalizeMock.mock.calls[0]![1].stripeEvent.data.object.metadata.orderId,
    ).toBe(CURRENT_ORDER);
  });

  it("a stale order id that no longer exists is ignored; the PI's order is confirmed", async () => {
    const { deps } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" }],
      piMetadata: { orderId: CURRENT_ORDER },
    });

    await expect(
      confirmPayment(deps, {
        actorHumanId: BUYER,
        orderId: STALE_ORDER,
        paymentIntentId: PI_ID,
      }),
    ).resolves.toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "confirmed" });
  });

  it("a PI whose metadata names ANOTHER buyer's order is refused — with or without the caller's own order id", async () => {
    const { deps, orders } = harness({
      orders: [
        { id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" },
        { id: FOREIGN_ORDER, buyerHumanId: OTHER_BUYER, status: "PENDING" },
      ],
      piMetadata: { orderId: FOREIGN_ORDER },
    });

    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      confirmPayment(deps, {
        actorHumanId: BUYER,
        orderId: CURRENT_ORDER,
        paymentIntentId: PI_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(finalizeMock).not.toHaveBeenCalled();
    expect(orders.markProcessingIfPending).not.toHaveBeenCalled();
  });

  it("a foreign order id as the hint is refused even when the PI is the caller's (never weaker than before)", async () => {
    const { deps } = harness({
      orders: [
        { id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" },
        { id: FOREIGN_ORDER, buyerHumanId: OTHER_BUYER, status: "PENDING" },
      ],
      piMetadata: { orderId: CURRENT_ORDER },
    });

    await expect(
      confirmPayment(deps, {
        actorHumanId: BUYER,
        orderId: FOREIGN_ORDER,
        paymentIntentId: PI_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("a PI with no order metadata is refused with PAYMENT_INTENT_ORDER_MISMATCH", async () => {
    for (const piMetadata of [{}, { orderId: "" }, { orderId: "not-a-uuid" }]) {
      const { deps, orders } = harness({
        orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" }],
        piMetadata,
      });
      await expect(
        confirmPayment(deps, {
          actorHumanId: BUYER,
          orderId: CURRENT_ORDER,
          paymentIntentId: PI_ID,
        }),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
      expect(orders.markProcessingIfPending).not.toHaveBeenCalled();
    }
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("a PI that has not succeeded is refused with PAYMENT_NOT_SUCCEEDED", async () => {
    const { deps } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" }],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "requires_action",
    });
    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_SUCCEEDED" });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it.each(["requires_action", "requires_payment_method", "canceled"])(
    "PAYMENT_NOT_SUCCEEDED carries the PI status (%s) so a redirect return can tell dead from pending",
    async (piStatus) => {
      const { deps } = harness({
        orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" }],
        piMetadata: { orderId: CURRENT_ORDER },
        piStatus,
      });
      await expect(
        confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
      ).rejects.toMatchObject({
        code: "PAYMENT_NOT_SUCCEEDED",
        meta: { status: piStatus },
      });
    },
  );

  it("processing (delayed methods): marks the PI's order PROCESSING — not the stale hint", async () => {
    const { deps, orders } = harness({
      orders: [
        { id: STALE_ORDER, buyerHumanId: BUYER, status: "PENDING" },
        { id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" },
      ],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "processing",
    });

    const out = await confirmPayment(deps, {
      actorHumanId: BUYER,
      orderId: STALE_ORDER,
      paymentIntentId: PI_ID,
    });

    expect(out).toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "processing" });
    expect(orders.markProcessingIfPending).toHaveBeenCalledTimes(1);
    expect(orders.markProcessingIfPending).toHaveBeenCalledWith(CURRENT_ORDER);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("an already-finalized order returns finalize's answer (its replay), unchanged", async () => {
    const { deps } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "SUCCEEDED" }],
      piMetadata: { orderId: CURRENT_ORDER },
    });
    finalizeMock.mockResolvedValueOnce({ ok: true, orderId: CURRENT_ORDER });

    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).resolves.toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "confirmed" });
  });

  it.each(["", "pi_", "pi_abc def", "pi_abc/../x", "pi_a.b", "pi_a\tb", "cs_test_123", CLIENT_SECRET_FIXTURE])(
    "a malformed PaymentIntent id (%s) is refused as invalid_input with NO Stripe call",
    async (paymentIntentId) => {
      const { deps, retrievePaymentIntent, orders } = harness({
        orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "PENDING" }],
        piMetadata: { orderId: CURRENT_ORDER },
      });
      await expect(
        confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(retrievePaymentIntent).not.toHaveBeenCalled();
      expect(orders.getById).not.toHaveBeenCalled();
    },
  );

  it("an id with underscores (pi_3Abc_def) is still a valid PaymentIntent id", async () => {
    const { deps, retrievePaymentIntent } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "SUCCEEDED" }],
      piMetadata: { orderId: CURRENT_ORDER },
    });
    finalizeMock.mockResolvedValueOnce({ ok: true, orderId: CURRENT_ORDER });
    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: "pi_3Abc_def" }),
    ).resolves.toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "confirmed" });
    expect(retrievePaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_3Abc_def",
    });
  });

  it("processing: an order already tied to a DIFFERENT PaymentIntent is refused PAYMENT_INTENT_MISMATCH and not flipped to PROCESSING", async () => {
    const { deps, orders } = harness({
      orders: [
        {
          id: CURRENT_ORDER,
          buyerHumanId: BUYER,
          status: "PENDING",
          stripePaymentIntentId: "pi_someOtherIntent",
        },
      ],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "processing",
    });
    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_MISMATCH" });
    expect(orders.markProcessingIfPending).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("processing: an order tied to THIS PaymentIntent is marked PROCESSING", async () => {
    const { deps, orders } = harness({
      orders: [
        {
          id: CURRENT_ORDER,
          buyerHumanId: BUYER,
          status: "PENDING",
          stripePaymentIntentId: PI_ID,
        },
      ],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "processing",
    });
    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).resolves.toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "processing" });
    expect(orders.markProcessingIfPending).toHaveBeenCalledWith(CURRENT_ORDER);
  });

  it("processing: a stale PENDING read cannot flip a CANCELLED order back to PROCESSING — refused loudly", async () => {
    // Belt-and-braces: a retire / release / reaper commits CANCELLED right
    // after confirmPayment read the order (and handed back its credit and
    // seats). The CAS loses; the order stays CANCELLED and the call fails.
    const row = {
      id: CURRENT_ORDER,
      buyerHumanId: BUYER,
      status: "PENDING",
      stripePaymentIntentId: PI_ID,
    };
    const { deps, orders } = harness({
      orders: [row],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "processing",
    });
    let reads = 0;
    orders.getById.mockImplementation(async (id: string) => {
      if (id !== CURRENT_ORDER) return null;
      reads++;
      const snapshot = { ...row };
      if (reads === 1) row.status = "CANCELLED";
      return snapshot;
    });

    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });
    expect(orders.markProcessingIfPending).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("CANCELLED");
    expect(orders.markProcessing).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("processing: a lost CAS because another path already advanced the order is a no-op success", async () => {
    const row = {
      id: CURRENT_ORDER,
      buyerHumanId: BUYER,
      status: "PENDING",
      stripePaymentIntentId: PI_ID,
    };
    const { deps, orders } = harness({
      orders: [row],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "processing",
    });
    let reads = 0;
    orders.getById.mockImplementation(async (id: string) => {
      if (id !== CURRENT_ORDER) return null;
      reads++;
      const snapshot = { ...row };
      // The processing webhook got there first.
      if (reads === 1) row.status = "PROCESSING";
      return snapshot;
    });

    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).resolves.toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "processing" });
    expect(row.status).toBe("PROCESSING");
  });

  it("processing: a lost CAS to an order now advanced under a DIFFERENT PaymentIntent is refused loudly", async () => {
    // Read with no PI; by the CAS the order is PROCESSING for another
    // payment. That is not this payment's no-op.
    const row: {
      id: string;
      buyerHumanId: string;
      status: string;
      stripePaymentIntentId: string | null;
    } = {
      id: CURRENT_ORDER,
      buyerHumanId: BUYER,
      status: "PENDING",
      stripePaymentIntentId: null,
    };
    const { deps, orders } = harness({
      orders: [row],
      piMetadata: { orderId: CURRENT_ORDER },
      piStatus: "processing",
    });
    let reads = 0;
    orders.getById.mockImplementation(async (id: string) => {
      if (id !== CURRENT_ORDER) return null;
      reads++;
      const snapshot = { ...row };
      if (reads === 1) {
        row.status = "PROCESSING";
        row.stripePaymentIntentId = "pi_someone_else";
      }
      return snapshot;
    });

    await expect(
      confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });
  });
});


describe("confirmPayment — a processing PaymentIntent on an order that is not PENDING on the first read", () => {
  it.each([["CANCELLED"], ["REFUNDED"], ["DISPUTED"]])(
    "a %s order is refused with ORDER_NOT_PROCESSABLE instead of answered as processing",
    async (status) => {
      const { deps, orders } = harness({
        orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status }],
        piMetadata: { orderId: CURRENT_ORDER },
        piStatus: "processing",
      });

      await expect(
        confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
      ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });

      expect(orders.markProcessingIfPending).not.toHaveBeenCalled();
      expect(finalizeMock).not.toHaveBeenCalled();
    },
  );

  it.each([["PROCESSING"], ["SUCCEEDED"]])(
    "a %s order (the webhook or another confirm got there first) is still answered ok, as processing",
    async (status) => {
      const { deps, orders } = harness({
        orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status }],
        piMetadata: { orderId: CURRENT_ORDER },
        piStatus: "processing",
      });

      await expect(
        confirmPayment(deps, { actorHumanId: BUYER, paymentIntentId: PI_ID }),
      ).resolves.toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "processing" });
      expect(orders.markProcessingIfPending).not.toHaveBeenCalled();
    },
  );
});

// The embed's guest confirm adds the payer's ticket codes to ITS answer
// (`confirmEmbedGuestPayment`, 2026-10-12). They are added there, after this
// shared function returns: the signed-in answer, and the shared one, carry no
// ticket. `harness` wires `repos.orders` only, so a ticket read from in here
// would throw.
describe("confirmPayment — no ticket codes on the signed-in path", () => {
  it("the signed-in answer is exactly { ok, orderId, outcome } for a SUCCEEDED order", async () => {
    const { deps } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "SUCCEEDED" }],
      piMetadata: { orderId: CURRENT_ORDER },
    });

    const out = await confirmPayment(deps, {
      actorHumanId: BUYER,
      paymentIntentId: PI_ID,
    });

    expect(out).toEqual({ ok: true, orderId: CURRENT_ORDER, outcome: "confirmed" });
    expect(Object.keys(confirmPaymentOutputSchema.shape).sort()).toEqual([
      "ok",
      "orderId",
      "outcome",
    ]);
  });

  it("the shared confirm's `confirmed` answer is exactly { outcome, orderId }", async () => {
    const { deps, retrievePaymentIntent } = harness({
      orders: [{ id: CURRENT_ORDER, buyerHumanId: BUYER, status: "SUCCEEDED" }],
      piMetadata: { orderId: CURRENT_ORDER },
    });

    const out = await confirmRetrievedPaymentIntent(deps, {
      actorHumanId: BUYER,
      paymentIntentId: PI_ID,
      paymentIntent: await retrievePaymentIntent(),
    });

    expect(out).toEqual({ outcome: "confirmed", orderId: CURRENT_ORDER });
  });
});

// A US bank debit Stripe reports `processing` can still fail days later, so
// the client must be able to tell it from a paid order without a second read
// (owner, 2026-10-14).
describe("confirmPayment — the outcome rides out", () => {
  it("the output schema carries confirmed and processing, and nothing else", () => {
    const base = { ok: true, orderId: CURRENT_ORDER };
    expect(
      confirmPaymentOutputSchema.safeParse({ ...base, outcome: "confirmed" })
        .success,
    ).toBe(true);
    expect(
      confirmPaymentOutputSchema.safeParse({ ...base, outcome: "processing" })
        .success,
    ).toBe(true);
    expect(
      confirmPaymentOutputSchema.safeParse({ ...base, outcome: "not_paid" })
        .success,
    ).toBe(false);
    expect(confirmPaymentOutputSchema.safeParse(base).success).toBe(false);
  });
});
