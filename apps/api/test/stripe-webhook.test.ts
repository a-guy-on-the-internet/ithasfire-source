import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Stripe from "stripe";

import Fastify from "fastify";

const finalizeMock = vi.fn(async () => ({
  orderId: "22222222-2222-4222-8222-222222222222",
}));

const openDisputeMock = vi.fn(async () => ({
  ok: true,
  disputeId: "dispute_1",
  stripeDisputeId: "dp_123",
  orderId: "22222222-2222-4222-8222-222222222222",
  status: "OPEN",
  triageReason: null,
}));
const refreshDisputeMock = vi.fn(async () => ({ ok: true }));
const recordFundsWithdrawnMock = vi.fn(async () => ({ ok: true }));
const closeDisputeMock = vi.fn(async () => ({ ok: true }));

vi.mock("@th/core/use-cases/orders/finalize-from-payment-intent", () => ({
  finalizePaymentIntent: (deps: unknown, input: unknown) =>
    finalizeMock(deps, input),
}));

const recordMembershipInvoicePaidMock = vi.fn(async () => ({
  ok: true as const,
  orderId: "33333333-3333-4333-8333-333333333333",
  membershipId: "66666666-6666-4666-8666-666666666666",
  alreadyRecorded: false,
}));
const recordMembershipPaymentFailedMock = vi.fn(async () => ({
  ok: true as const,
  membershipId: "66666666-6666-4666-8666-666666666666",
  status: "past_due",
}));
const syncMembershipFromStripeMock = vi.fn(async () => ({
  ok: true as const,
  membershipId: "66666666-6666-4666-8666-666666666666",
  applied: true,
  skippedReason: null,
  status: "canceled",
}));
const sendRenewalNoticeMock = vi.fn(async () => ({
  ok: true as const,
  sent: true,
  reason: null,
  membershipId: "66666666-6666-4666-8666-666666666666",
}));

const updateMemberBillingAddressMock = vi.fn(async () => ({
  ok: true as const,
  memberships: 1,
  updated: 1,
  unchanged: 0,
  skippedNotLive: 0,
  unpriceable: 0,
}));

/** Backs `trackedMembership` in the webhook. Null = a subscription not ours. */
const findMembershipBySubscriptionMock = vi.fn(
  async (_subscriptionId: string): Promise<unknown> => null,
);

/** Backs the `customer.updated` not-ours guard. Empty = customer not ours. */
const listMembershipsByCustomerMock = vi.fn(
  async (_customerId: string): Promise<unknown[]> => [],
);

vi.mock("@th/core/use-cases/memberships", () => ({
  recordMembershipInvoicePaid: (deps: unknown, input: unknown) =>
    recordMembershipInvoicePaidMock(deps, input),
  recordMembershipPaymentFailed: (deps: unknown, input: unknown) =>
    recordMembershipPaymentFailedMock(deps, input),
  syncMembershipFromStripe: (deps: unknown, input: unknown) =>
    syncMembershipFromStripeMock(deps, input),
  sendRenewalNotice: (deps: unknown, input: unknown) =>
    sendRenewalNoticeMock(deps, input),
  updateMemberBillingAddress: (deps: unknown, input: unknown) =>
    updateMemberBillingAddressMock(deps, input),
}));

vi.mock("@th/core/use-cases/disputes", () => ({
  openDispute: (deps: unknown, input: unknown) => openDisputeMock(deps, input),
  refreshDispute: (deps: unknown, input: unknown) =>
    refreshDisputeMock(deps, input),
  recordFundsWithdrawn: (deps: unknown, input: unknown) =>
    recordFundsWithdrawnMock(deps, input),
  closeDispute: (deps: unknown, input: unknown) =>
    closeDisputeMock(deps, input),
}));

/**
 * Smoke test for the Stripe webhook route.
 *
 * Verifies:
 * - Route is registered: POST /webhooks/stripe
 * - Raw body is preserved for signature verification
 * - Signature verification via stripe.webhooks.constructEvent works
 *
 * Does NOT hit real Stripe.
 */

describe("stripe webhook route", () => {
  const webhookSecret = "whsec_test_local";

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    // Needed by our webhook route to initialize Stripe.
    // Intentionally not a real-looking key to avoid scanners.
    process.env.STRIPE_SECRET_KEY = "stripe-mock";
    process.env.STRIPE_API_VERSION = "2025-08-27.basil";
  });

  beforeEach(() => {
    finalizeMock.mockClear();
    openDisputeMock.mockClear();
    refreshDisputeMock.mockClear();
    recordFundsWithdrawnMock.mockClear();
    closeDisputeMock.mockClear();
    recordMembershipInvoicePaidMock.mockClear();
    recordMembershipPaymentFailedMock.mockClear();
    syncMembershipFromStripeMock.mockClear();
    sendRenewalNoticeMock.mockClear();
    updateMemberBillingAddressMock.mockClear();
    findMembershipBySubscriptionMock.mockReset();
    findMembershipBySubscriptionMock.mockResolvedValue(null);
    listMembershipsByCustomerMock.mockReset();
    listMembershipsByCustomerMock.mockResolvedValue([]);
  });

  afterAll(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_API_VERSION;
  });

  // Explicit timeout: this case dynamically imports the raw-body plugin and
  // the webhook route (pulling a large module graph through Vite's transform on
  // first hit) and then does real Stripe signature verification. It lands around
  // 3s in isolation but exceeds vitest's 5s default when the rest of the suite
  // is running alongside it. Scoped to this test rather than raised globally, so
  // a genuinely slow test elsewhere still surfaces at the default.
  //
  // Raised 20s → 45s on 2026-08-19. The old margin was fictional: MEASURED at
  // 18.6s in a solo file run against a 20s cap, i.e. one bad scheduling slice
  // from red — which is most of why this file is CI-quarantined in
  // deploy-dev.yml for "hanging". Adding a container-backed suite
  // (auth-atomic-rate-limit-concurrency.test.ts) to the same parallel runner
  // was enough to tip it over. The number is contention headroom on a shared
  // box, NOT a claim that the assertion needs 45 seconds.
  it("accepts a signed payment_intent.succeeded event", async () => {
    // Import after env vars are set, since the route's env module may read env at import time.
    const { default: rawBody } = await import("../src/plugins/raw-body");
    const { default: stripeWebhook } =
      await import("../src/routes/stripe/webhook");

    const app = Fastify({ logger: false });

    app.decorate("deps", {
      logger: {
        child: vi.fn(() => app.deps.logger),
        withTime: vi.fn(async (_name: unknown, f: () => unknown) => f()),
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      trpc: {
        idempotency: {
          begin: vi.fn(async () => ({ ok: true as const, attempt: 1 })),
        },
      },
    });

    await app.register(rawBody);
    await app.register(stripeWebhook);

    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_test_webhook",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_123456789",
          status: "succeeded",
          amount_received: 1000,
          currency: "usd",
          metadata: {
            orderId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(finalizeMock).toHaveBeenCalledTimes(1);

    await app.close();
  }, 45_000);

  it("handles charge.refund.updated (failed) — writes audit log and error-level log", async () => {
    const { default: rawBody } = await import("../src/plugins/raw-body");
    const { default: stripeWebhook } =
      await import("../src/routes/stripe/webhook");

    const auditLogMock = vi.fn(async () => {});
    const findByPIMock = vi.fn(async () => ({
      id: "order_abc",
      status: "REFUNDED",
    }));

    const logErrorSpy = vi.fn();
    const logInfoSpy = vi.fn();
    const logWarnSpy = vi.fn();

    const app = Fastify({ logger: false });

    // Spy on the Fastify-level logger that the webhook uses (app.log.*)
    const origError = app.log.error.bind(app.log);
    app.log.error = ((...args: unknown[]) => {
      logErrorSpy(...args);
      origError(...args);
    }) as any;
    const origInfo = app.log.info.bind(app.log);
    app.log.info = ((...args: unknown[]) => {
      logInfoSpy(...args);
      origInfo(...args);
    }) as any;

    app.decorate("deps", {
      trpc: {
        repos: {
          audit: { log: auditLogMock },
          orders: { findByPaymentIntent: findByPIMock },
        },
      },
      logger: {
        child: vi.fn(() => app.deps.logger),
        withTime: vi.fn(async (_name: unknown, f: () => unknown) => f()),
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any);

    await app.register(rawBody);
    await app.register(stripeWebhook);

    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_refund_failed",
      type: "charge.refund.updated",
      data: {
        object: {
          id: "re_fail_123",
          object: "refund",
          status: "failed",
          amount: 5000,
          currency: "usd",
          charge: "ch_abc",
          payment_intent: "pi_xyz",
          failure_reason: "expired_or_canceled_card",
          reason: "requested_by_customer",
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });

    // Adapter handler should have written an audit log for the money anomaly
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "refund_anomaly",
        entityId: "re_fail_123",
        action: "async_refund_failed",
        data: expect.objectContaining({
          chargeId: "ch_abc",
          paymentIntentId: "pi_xyz",
          amountCents: 5000,
          failureReason: "expired_or_canceled_card",
        }),
      }),
    );

    // Webhook should have looked up the order for the error log
    expect(findByPIMock).toHaveBeenCalledWith("pi_xyz");

    // Webhook-level error log (app.log.error) should include orderId
    const errorCall = logErrorSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "stripe_webhook_async_refund_failed",
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).toMatchObject({
      refundId: "re_fail_123",
      orderId: "order_abc",
      orderStatus: "REFUNDED",
      failureReason: "expired_or_canceled_card",
    });

    await app.close();
  });

  it("handles charge.refund.updated (succeeded) — info log only, no audit", async () => {
    const { default: rawBody } = await import("../src/plugins/raw-body");
    const { default: stripeWebhook } =
      await import("../src/routes/stripe/webhook");

    const auditLogMock = vi.fn(async () => {});
    const logInfoSpy = vi.fn();

    const app = Fastify({ logger: false });

    app.decorate("deps", {
      trpc: {
        repos: {
          audit: { log: auditLogMock },
          orders: { findByPaymentIntent: vi.fn() },
        },
      },
      logger: {
        child: vi.fn(() => app.deps.logger),
        withTime: vi.fn(async (_name: unknown, f: () => unknown) => f()),
        log: vi.fn(),
        info: logInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any);

    await app.register(rawBody);
    await app.register(stripeWebhook);

    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_refund_ok",
      type: "charge.refund.updated",
      data: {
        object: {
          id: "re_ok_456",
          object: "refund",
          status: "succeeded",
          amount: 3000,
          currency: "usd",
          charge: "ch_def",
          payment_intent: "pi_ghi",
          failure_reason: null,
          reason: null,
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });

    // Audit log should NOT be written for successful refunds
    expect(auditLogMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("dispatches charge.dispute.created to dispute intake", async () => {
    const { default: rawBody } = await import("../src/plugins/raw-body");
    const { default: stripeWebhook } =
      await import("../src/routes/stripe/webhook");

    const app = Fastify({ logger: false });

    app.decorate("deps", {
      trpc: {
        repos: {},
        idempotency: {},
        clock: { now: () => new Date("2026-05-15T12:00:00.000Z") },
      },
      logger: {
        child: vi.fn(() => app.deps.logger),
        withTime: vi.fn(async (_name: unknown, f: () => unknown) => f()),
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any);

    await app.register(rawBody);
    await app.register(stripeWebhook);

    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_dispute_created",
      type: "charge.dispute.created",
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          charge: {
            id: "ch_123",
            payment_intent: {
              id: "pi_123",
              metadata: {
                orderId: "22222222-2222-4222-8222-222222222222",
                eventId: "33333333-3333-4333-8333-333333333333",
              },
            },
          },
          evidence_details: { due_by: 1_779_604_800 },
          metadata: { source: "stripe_cli" },
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(openDisputeMock).toHaveBeenCalledTimes(1);
    expect(openDisputeMock.mock.calls[0]?.[1]).toMatchObject({
      stripeEventId: "evt_dispute_created",
      stripeDisputeId: "dp_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      metadataOrderId: "22222222-2222-4222-8222-222222222222",
      metadataEventId: "33333333-3333-4333-8333-333333333333",
      amountCents: 5000,
      currency: "usd",
      reason: "fraudulent",
      stripeStatus: "needs_response",
      isWarning: false,
      evidenceDueBy: new Date(1_779_604_800 * 1000),
    });

    await app.close();
  });

  it("dispatches charge.dispute.created with warning status as informational warning intake", async () => {
    const app = await makeWebhookApp();
    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_dispute_warning_created",
      type: "charge.dispute.created",
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_warning_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "warning_needs_response",
          charge: {
            id: "ch_123",
            payment_intent: {
              id: "pi_123",
              metadata: {
                orderId: "22222222-2222-4222-8222-222222222222",
                eventId: "33333333-3333-4333-8333-333333333333",
              },
            },
          },
          evidence_details: { due_by: 1_779_604_800 },
          metadata: { source: "stripe_cli" },
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(openDisputeMock).toHaveBeenCalledTimes(1);
    expect(refreshDisputeMock).not.toHaveBeenCalled();
    expect(openDisputeMock.mock.calls[0]?.[1]).toMatchObject({
      stripeEventId: "evt_dispute_warning_created",
      stripeDisputeId: "dp_warning_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      metadataOrderId: "22222222-2222-4222-8222-222222222222",
      metadataEventId: "33333333-3333-4333-8333-333333333333",
      amountCents: 5000,
      currency: "usd",
      reason: "fraudulent",
      stripeStatus: "warning_needs_response",
      isWarning: true,
      evidenceDueBy: new Date(1_779_604_800 * 1000),
    });

    await app.close();
  });

  it("dispatches charge.dispute.closed with warning status as warning closure intake", async () => {
    const app = await makeWebhookApp();
    const stripe = new Stripe("stripe-mock", {
      apiVersion: "2025-08-27.basil" as any,
    });

    const payloadObj = {
      id: "evt_dispute_warning_closed",
      type: "charge.dispute.closed",
      created: 1_779_000_123,
      data: {
        object: {
          id: "dp_warning_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "warning_closed",
          charge: "ch_123",
          payment_intent: "pi_123",
          metadata: {
            orderId: "22222222-2222-4222-8222-222222222222",
            eventId: "33333333-3333-4333-8333-333333333333",
          },
        },
      },
    };

    const payload = JSON.stringify(payloadObj);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(closeDisputeMock).toHaveBeenCalledTimes(1);
    expect(closeDisputeMock.mock.calls[0]?.[1]).toMatchObject({
      stripeEventId: "evt_dispute_warning_closed",
      stripeDisputeId: "dp_warning_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      metadataOrderId: "22222222-2222-4222-8222-222222222222",
      metadataEventId: "33333333-3333-4333-8333-333333333333",
      amountCents: 5000,
      currency: "usd",
      reason: "fraudulent",
      stripeStatus: "warning_closed",
      isWarning: true,
      closedAt: new Date(1_779_000_123 * 1000),
      outcome: "warning_closed",
    });
    expect(openDisputeMock).not.toHaveBeenCalled();

    await app.close();
  });

  // ── payment_intent.succeeded guards (Stripe Billing PIs) ──────────────
  it("ignores a Billing/orphan payment_intent.succeeded (no orderId, no order) without finalizing", async () => {
    // Billing-created PIs carry no metadata.orderId. Handing them to
    // finalizePaymentIntent used to throw per member per month — a DLQ storm
    // that evicted real failures from the 500-item queue.
    const app = await makeWebhookApp(); // default: findByPaymentIntent → null

    const res = await postStripeEvent(app, {
      id: "evt_billing_pi",
      type: "payment_intent.succeeded",
      data: {
        object: { id: "pi_billing", status: "succeeded", metadata: {} },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(finalizeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("skips finalize for a PI that resolves to a MEMBERSHIP order", async () => {
    // Post-invoice-handler world: recordMembershipInvoicePaid stored the
    // stripePaymentIntentId, so the PI is no longer an orphan — but the
    // invoice handler owns membership orders, finalize must not touch them.
    const app = await makeWebhookApp({
      orders: {
        findByPaymentIntent: vi.fn(async () => ({
          id: "order_membership",
          status: "SUCCEEDED",
        })),
        getById: vi.fn(async () => ({
          id: "order_membership",
          kind: "MEMBERSHIP",
        })),
      },
    });

    const res = await postStripeEvent(app, {
      id: "evt_membership_pi",
      type: "payment_intent.succeeded",
      data: {
        object: { id: "pi_membership", status: "succeeded", metadata: {} },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(finalizeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("still finalizes a metadata-less PI that resolves to a TICKETING order", async () => {
    // The membership skip must not widen into swallowing ticketing PIs.
    const app = await makeWebhookApp({
      orders: {
        findByPaymentIntent: vi.fn(async () => ({
          id: "order_ticketing",
          status: "PENDING",
        })),
        getById: vi.fn(async () => ({
          id: "order_ticketing",
          kind: "TICKETING",
        })),
      },
    });

    const res = await postStripeEvent(app, {
      id: "evt_ticketing_pi_no_meta",
      type: "payment_intent.succeeded",
      data: {
        object: { id: "pi_ticketing", status: "succeeded", metadata: {} },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(finalizeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  // ── Recurring memberships ─────────────────────────────────────────────
  it("dispatches invoice.payment_succeeded for a subscription we track", async () => {
    findMembershipBySubscriptionMock.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      stripeSubscriptionId: "sub_ours",
      stripeCustomerId: "cus_fallback",
    });
    const app = await makeWebhookApp();

    const res = await postStripeEvent(app, {
      id: "evt_membership_paid",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_ours",
          object: "invoice",
          currency: "usd",
          subtotal: 1000,
          amount_paid: 1098,
          amount_due: 1098,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          customer: "cus_1",
          // One exclusive line plus one inclusive line: only the exclusive
          // amount may be added, or the inclusive tax is counted twice
          // (it is already inside `subtotal`).
          total_taxes: [
            { amount: 98, tax_behavior: "exclusive" },
            { amount: 7, tax_behavior: "inclusive" },
          ],
          parent: {
            subscription_details: { subscription: "sub_ours" },
          },
          payments: {
            data: [{ payment: { payment_intent: "pi_membership" } }],
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(recordMembershipInvoicePaidMock).toHaveBeenCalledTimes(1);
    const input = recordMembershipInvoicePaidMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      stripeInvoiceId: "in_ours",
      stripeSubscriptionId: "sub_ours",
      stripeCustomerId: "cus_1",
      stripePaymentIntentId: "pi_membership",
      amountPaidCents: 1098,
      subtotalCents: 1000,
      taxAmountCents: 98,
      currency: "usd",
      stripeEventId: "evt_membership_paid",
    });
    expect(input.periodEnd).toEqual(new Date(1_782_000_000 * 1000));

    await app.close();
  });

  it("ignores an invoice for a subscription we do not track", async () => {
    // The platform account bills things that are not ours. DLQ-ing them would
    // evict genuine failures from a queue that trims the oldest.
    const app = await makeWebhookApp();

    const res = await postStripeEvent(app, {
      id: "evt_membership_foreign",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_theirs",
          object: "invoice",
          currency: "usd",
          subtotal: 5000,
          amount_paid: 5000,
          amount_due: 5000,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          parent: { subscription_details: { subscription: "sub_theirs" } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(recordMembershipInvoicePaidMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("threads the instant-payouts dev seam into recordMembershipInvoicePaid", async () => {
    // Without this key the payout path is unreachable in dev/e2e — the
    // settlement always lands on the next month boundary. `false` here (test
    // env, flag unset) still proves the seam is WIRED.
    findMembershipBySubscriptionMock.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      stripeSubscriptionId: "sub_ours",
      stripeCustomerId: "cus_1",
    });
    const app = await makeWebhookApp();

    await postStripeEvent(app, {
      id: "evt_membership_paid_seam",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_seam",
          object: "invoice",
          currency: "usd",
          subtotal: 1000,
          amount_paid: 1000,
          amount_due: 1000,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          parent: { subscription_details: { subscription: "sub_ours" } },
        },
      },
    });

    const deps = recordMembershipInvoicePaidMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(deps).toHaveProperty("instantPayouts");
    expect(typeof deps.instantPayouts).toBe("boolean");

    await app.close();
  });

  it("a metadata-STAMPED invoice with no Membership row does NOT terminal-200 as 'not ours'", async () => {
    // First-invoice race: Stripe pays a no-trial first invoice inside
    // subscriptions.create, so this event can beat our memberships.create
    // commit. The subscription metadata stamp (tierId + memberHumanId) marks
    // it as ours; swallowing it with an info log would drop paid money with
    // no retry. It must NOT reach the use case (no row yet) — it throws to
    // the DLQ instead (the DLQ push itself is asserted in
    // stripe-webhook-dlq-coverage.test.ts).
    const app = await makeWebhookApp(); // membership lookup → null

    const res = await postStripeEvent(app, {
      id: "evt_membership_race",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_race",
          object: "invoice",
          currency: "usd",
          subtotal: 1000,
          amount_paid: 1098,
          amount_due: 1098,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          parent: {
            subscription_details: {
              subscription: "sub_racing",
              metadata: {
                tierId: "33333333-3333-4333-8333-333333333333",
                memberHumanId: "44444444-4444-4444-8444-444444444444",
              },
            },
          },
        },
      },
    });

    // Still 200 to Stripe (the DLQ owns the retry), but never recorded and
    // never treated as foreign.
    expect(res.statusCode).toBe(200);
    expect(recordMembershipInvoicePaidMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("dispatches invoice.payment_failed for a subscription we track", async () => {
    findMembershipBySubscriptionMock.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      stripeSubscriptionId: "sub_ours",
      stripeCustomerId: "cus_1",
    });
    const app = await makeWebhookApp();

    const res = await postStripeEvent(app, {
      id: "evt_membership_failed",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_ours",
          object: "invoice",
          currency: "usd",
          subtotal: 1000,
          amount_paid: 0,
          amount_due: 1098,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          attempt_count: 2,
          next_payment_attempt: 1_780_500_000,
          parent: { subscription_details: { subscription: "sub_ours" } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(recordMembershipPaymentFailedMock).toHaveBeenCalledTimes(1);
    expect(
      recordMembershipPaymentFailedMock.mock.calls[0]![1],
    ).toMatchObject({
      stripeInvoiceId: "in_ours",
      stripeSubscriptionId: "sub_ours",
      amountDueCents: 1098,
      attemptCount: 2,
      stripeEventId: "evt_membership_failed",
    });

    await app.close();
  });

  it("dispatches invoice.upcoming for a subscription we track — the payload has NO invoice id", async () => {
    findMembershipBySubscriptionMock.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      stripeSubscriptionId: "sub_ours",
      stripeCustomerId: "cus_1",
    });
    const app = await makeWebhookApp({ mailer: { send: vi.fn() } });

    const res = await postStripeEvent(app, {
      id: "evt_membership_upcoming",
      type: "invoice.upcoming",
      data: {
        object: {
          // Deliberately NO `id`: the invoice does not exist yet. The strict
          // MembershipInvoiceZ guard would reject this payload outright.
          object: "invoice",
          currency: "usd",
          subtotal: 1000,
          amount_paid: 0,
          amount_due: 1098,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          next_payment_attempt: 1_782_000_000,
          parent: { subscription_details: { subscription: "sub_ours" } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(sendRenewalNoticeMock).toHaveBeenCalledTimes(1);
    const input = sendRenewalNoticeMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      stripeSubscriptionId: "sub_ours",
      amountDueCents: 1098,
      currency: "usd",
      stripeEventId: "evt_membership_upcoming",
    });
    expect(input.nextPaymentAttempt).toEqual(new Date(1_782_000_000 * 1000));

    await app.close();
  });

  it("ignores invoice.upcoming for a subscription we do not track", async () => {
    const app = await makeWebhookApp({ mailer: { send: vi.fn() } });

    const res = await postStripeEvent(app, {
      id: "evt_upcoming_foreign",
      type: "invoice.upcoming",
      data: {
        object: {
          object: "invoice",
          currency: "usd",
          subtotal: 5000,
          amount_paid: 0,
          amount_due: 5000,
          created: 1_780_000_000,
          period_start: 1_780_000_000,
          period_end: 1_782_000_000,
          parent: { subscription_details: { subscription: "sub_theirs" } },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(sendRenewalNoticeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("dispatches customer.subscription.deleted, reading the period off items[0]", async () => {
    // Basil moved current_period_* off Subscription onto SubscriptionItem.
    const app = await makeWebhookApp();

    const res = await postStripeEvent(app, {
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_ours",
          object: "subscription",
          status: "canceled",
          cancel_at_period_end: false,
          canceled_at: 1_781_000_000,
          items: {
            data: [
              {
                current_period_start: 1_780_000_000,
                current_period_end: 1_782_000_000,
              },
            ],
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(syncMembershipFromStripeMock).toHaveBeenCalledTimes(1);
    expect(syncMembershipFromStripeMock.mock.calls[0]![1]).toMatchObject({
      stripeSubscriptionId: "sub_ours",
      status: "canceled",
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(1_780_000_000 * 1000),
      currentPeriodEnd: new Date(1_782_000_000 * 1000),
      canceledAt: new Date(1_781_000_000 * 1000),
      stripeEventId: "evt_sub_deleted",
    });

    await app.close();
  });

  it("dispatches customer.subscription.updated through the same sync path", async () => {
    const app = await makeWebhookApp();

    const res = await postStripeEvent(app, {
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_ours",
          object: "subscription",
          // Deliberately a status our code does not branch on: the guard must
          // not reject unknown Stripe statuses (see MembershipSubscriptionZ).
          status: "paused",
          items: { data: [] },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(syncMembershipFromStripeMock).toHaveBeenCalledTimes(1);
    expect(syncMembershipFromStripeMock.mock.calls[0]![1]).toMatchObject({
      status: "paused",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });

    await app.close();
  });

  // ── customer.updated — billing-address change ──────────────────────────
  const customerUpdatedEvent = (
    id: string,
    object: Record<string, unknown>,
  ) => ({ id, type: "customer.updated", data: { object } });

  const trackedMembershipRow = (overrides: Record<string, unknown> = {}) => ({
    id: "66666666-6666-4666-8666-666666666666",
    stripeSubscriptionId: "sub_ours",
    stripeCustomerId: "cus_member",
    status: "active",
    billingPostalCode: "37206",
    billingCountryCode: "US",
    ...overrides,
  });

  it("dispatches customer.updated for a TRACKED customer whose address changed", async () => {
    listMembershipsByCustomerMock.mockResolvedValue([trackedMembershipRow()]);
    const app = await makeWebhookApp();

    const res = await postStripeEvent(
      app,
      customerUpdatedEvent("evt_cust_moved", {
        id: "cus_member",
        object: "customer",
        address: {
          line1: "500 SE Division St",
          city: "Portland",
          state: "OR",
          postal_code: "97202",
          country: "us",
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMemberBillingAddressMock).toHaveBeenCalledTimes(1);
    expect(updateMemberBillingAddressMock.mock.calls[0]![1]).toMatchObject({
      stripeCustomerId: "cus_member",
      billingCountryCode: "US",
      billingPostalCode: "97202",
      stripeEventId: "evt_cust_moved",
    });

    await app.close();
  });

  it("ignores customer.updated for a customer we do NOT track", async () => {
    // Fires for every customer on the platform account, for many reasons —
    // dispatching foreign ones would DLQ ordinary traffic on any failure.
    const app = await makeWebhookApp(); // listByStripeCustomerId → []

    const res = await postStripeEvent(
      app,
      customerUpdatedEvent("evt_cust_foreign", {
        id: "cus_theirs",
        object: "customer",
        address: { postal_code: "97202", country: "US" },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMemberBillingAddressMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("ignores customer.updated with NO usable billing address", async () => {
    // Payment-method attach / email edit fire this event with the address
    // untouched or absent; the rows keep their last known-good jurisdiction.
    listMembershipsByCustomerMock.mockResolvedValue([trackedMembershipRow()]);
    const app = await makeWebhookApp();

    const res = await postStripeEvent(
      app,
      customerUpdatedEvent("evt_cust_no_addr", {
        id: "cus_member",
        object: "customer",
        address: null,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMemberBillingAddressMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("short-circuits customer.updated when the postal code is UNCHANGED — the hot path", async () => {
    // This is the guard that keeps ZipTax volume flat: the event fires for
    // many non-address reasons and must cost nothing when nothing moved.
    // Case-insensitive on purpose — rows store the address as typed.
    listMembershipsByCustomerMock.mockResolvedValue([
      trackedMembershipRow({ billingCountryCode: "us" }),
    ]);
    const app = await makeWebhookApp();

    const res = await postStripeEvent(
      app,
      customerUpdatedEvent("evt_cust_same", {
        id: "cus_member",
        object: "customer",
        address: { postal_code: "37206", country: "US" },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMemberBillingAddressMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("re-dispatches when ANY of the customer's memberships is on the old address", async () => {
    // One customer backs every membership the member holds; a partial
    // migration (one row updated, one missed by a past failure) must not
    // read as "unchanged".
    listMembershipsByCustomerMock.mockResolvedValue([
      trackedMembershipRow({ billingPostalCode: "97202" }),
      trackedMembershipRow({
        id: "77777777-7777-4777-8777-777777777777",
        stripeSubscriptionId: "sub_second",
        billingPostalCode: "37206",
      }),
    ]);
    const app = await makeWebhookApp();

    const res = await postStripeEvent(
      app,
      customerUpdatedEvent("evt_cust_partial", {
        id: "cus_member",
        object: "customer",
        address: { postal_code: "97202", country: "US" },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(updateMemberBillingAddressMock).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

/** Signs and posts a Stripe event payload at the webhook route. */
async function postStripeEvent(
  app: Awaited<ReturnType<typeof makeWebhookApp>>,
  payloadObj: Record<string, unknown>,
) {
  const stripe = new Stripe("stripe-mock", {
    apiVersion: "2025-08-27.basil" as any,
  });
  const payload = JSON.stringify(payloadObj);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_test_local",
  });
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "stripe-signature": signature,
      "content-type": "application/json",
    },
    payload,
  });
}

async function makeWebhookApp(
  options: { mailer?: unknown; orders?: Record<string, unknown> } = {},
) {
  const { default: rawBody } = await import("../src/plugins/raw-body");
  const { default: stripeWebhook } =
    await import("../src/routes/stripe/webhook");

  const app = Fastify({ logger: false });

  app.decorate("deps", {
    // Only set for cases that exercise a mail-sending path; adding a mailer
    // unconditionally would route payment_intent.succeeded into the REAL
    // (unmocked) sendTicketIssuedEmail.
    ...(options.mailer ? { mailer: options.mailer } : {}),
    trpc: {
      repos: {
        // The membership webhook cases pre-check whether we track the
        // subscription at all before dispatching (see `trackedMembership`).
        memberships: {
          findByStripeSubscriptionId: findMembershipBySubscriptionMock,
          // Backs the customer.updated not-ours / unchanged guards.
          listByStripeCustomerId: listMembershipsByCustomerMock,
        },
        // Backs `isOrphanPaymentIntent` + the membership-order kind check on
        // payment_intent.succeeded. Default: no order references the PI.
        orders: {
          findByPaymentIntent: vi.fn(async () => null),
          getById: vi.fn(async () => null),
          ...(options.orders ?? {}),
        },
      },
      idempotency: {},
      clock: { now: () => new Date("2026-05-15T12:00:00.000Z") },
      // Truthy stubs so the customer.updated handler's not-configured guard
      // passes; the use case behind them is mocked at module level.
      membershipBilling: {},
      taxRateLookup: {},
    },
    logger: {
      child: vi.fn(() => app.deps.logger),
      withTime: vi.fn(async (_name: unknown, f: () => unknown) => f()),
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any);

  await app.register(rawBody);
  await app.register(stripeWebhook);

  return app;
}
