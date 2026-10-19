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
const recordEarlyFraudWarningMock = vi.fn(async () => ({
  ok: true as const,
  earlyFraudWarningId: "efw_1",
  stripeEfwId: "issfr_123",
  orderId: "22222222-2222-4222-8222-222222222222",
  ownerOrgId: "org_1",
  ownerHumanId: null,
  actionable: true,
  created: true,
  alerted: true,
}));
const resolveEarlyFraudWarningMock = vi.fn(async () => ({
  ok: true as const,
  resolved: true,
  earlyFraudWarningId: "efw_1",
  resolution: "DISPUTED",
  skippedReason: null,
}));
// `charge.refunded` reconciles through the real use case, which needs a full
// repo surface; the EFW auto-resolution tests only need the case to reach
// its tail, so the reconcile is stubbed at module level.
const reconcileStripeFullRefundMock = vi.fn(async () => ({
  ok: true as const,
  paymentIntentId: "pi_123",
  orderId: "22222222-2222-4222-8222-222222222222",
  outcome: "reconciled_primary",
}));

vi.mock("@th/core/use-cases/orders/reconcile-stripe-full-refund", () => ({
  reconcileStripeFullRefund: (deps: unknown, input: unknown) =>
    reconcileStripeFullRefundMock(deps, input),
}));

// The failed-payment harness points this at its per-test call log so the
// send's position relative to the tx commit can be asserted.
let bankEmailCallLog: string[] | null = null;
const sendBankPaymentFailedEmailMock = vi.fn(async () => {
  bankEmailCallLog?.push("sendBankPaymentFailedEmail");
});
vi.mock("@th/core/use-cases/orders/send-bank-payment-failed-email", () => ({
  sendBankPaymentFailedEmail: (deps: unknown, input: unknown) =>
    sendBankPaymentFailedEmailMock(deps, input),
}));

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
  recordEarlyFraudWarning: (deps: unknown, input: unknown) =>
    recordEarlyFraudWarningMock(deps, input),
  resolveEarlyFraudWarning: (deps: unknown, input: unknown) =>
    resolveEarlyFraudWarningMock(deps, input),
}));

const assembleDisputeEvidenceMock = vi.fn(async () => ({
  ok: true as const,
  disputeId: "dispute_1",
  skipped: null,
  evidence: { assembledVersion: 1 },
}));
const syncDisputeEvidenceDetailsMock = vi.fn(async () => ({
  ok: true as const,
  updated: true,
}));

vi.mock("@th/core/use-cases/disputes/evidence", () => ({
  assembleDisputeEvidence: (deps: unknown, input: unknown) =>
    assembleDisputeEvidenceMock(deps, input),
  syncDisputeEvidenceDetails: (deps: unknown, input: unknown) =>
    syncDisputeEvidenceDetailsMock(deps, input),
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
    assembleDisputeEvidenceMock.mockClear();
    assembleDisputeEvidenceMock.mockImplementation(async () => ({
      ok: true as const,
      disputeId: "dispute_1",
      skipped: null,
      evidence: { assembledVersion: 1 },
    }));
    syncDisputeEvidenceDetailsMock.mockClear();
    syncDisputeEvidenceDetailsMock.mockImplementation(async () => ({
      ok: true as const,
      updated: true,
    }));
    openDisputeMock.mockImplementation(async () => ({
      ok: true,
      disputeId: "dispute_1",
      stripeDisputeId: "dp_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      status: "OPEN",
      triageReason: null,
    }));
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

/**
 * Minimal ioredis surface used by `WebhookDlq`, so a test can assert that a
 * failed event reached the DLQ (mirrors stripe-webhook-dlq-coverage.test.ts).
 */
function makeFakeRedis() {
  const pushed: Array<Record<string, string>> = [];
  const multi = () => {
    const chain = {
      hset: (_key: string, value: Record<string, string>) => {
        pushed.push(value);
        return chain;
      },
      expire: () => chain,
      zadd: () => chain,
      zrem: () => chain,
      del: () => chain,
      exec: async () => [],
    };
    return chain;
  };
  const redis = {
    multi,
    zcard: async () => pushed.length,
    zrange: async () => [],
    zrevrange: async () => [],
    hgetall: async () => ({}),
  };
  return { redis, pushed };
}

async function makeWebhookApp(
  options: {
    mailer?: unknown;
    orders?: Record<string, unknown>;
    payments?: Record<string, unknown>;
    reportError?: unknown;
    /** Extra repo slices (e.g. `audit`, `disputes`) merged into `trpc.repos`. */
    repos?: Record<string, unknown>;
    /** A fake redis so the outer catch can push to the DLQ. */
    redis?: unknown;
  } = {},
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
    ...(options.redis ? { redis: options.redis } : {}),
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
        ...(options.repos ?? {}),
      },
      ...(options.payments ? { payments: options.payments } : {}),
      ...(options.reportError ? { reportError: options.reportError } : {}),
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

// ── Dispute evidence side effects (assemble + evidence_details mirror) ─────
describe("stripe webhook dispute evidence side effects", () => {
  // This describe is a sibling of the main one, so its beforeEach does not
  // apply here — reset the dispute mocks ourselves or calls leak across tests.
  beforeEach(() => {
    openDisputeMock.mockClear();
    refreshDisputeMock.mockClear();
    closeDisputeMock.mockClear();
    finalizeMock.mockClear();
    assembleDisputeEvidenceMock.mockClear();
    assembleDisputeEvidenceMock.mockImplementation(async () => ({
      ok: true as const,
      disputeId: "dispute_1",
      skipped: null,
      evidence: { assembledVersion: 1 },
    }));
    syncDisputeEvidenceDetailsMock.mockClear();
    syncDisputeEvidenceDetailsMock.mockImplementation(async () => ({
      ok: true as const,
      updated: true,
    }));
    openDisputeMock.mockImplementation(async () => ({
      ok: true,
      disputeId: "dispute_1",
      stripeDisputeId: "dp_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      status: "OPEN",
      triageReason: null,
    }));
  });

  const stripe = () =>
    new Stripe("stripe-mock", { apiVersion: "2025-08-27.basil" as any });

  function disputeEvent(
    type: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `evt_${type.replace(/\./g, "_")}`,
      type,
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          charge: { id: "ch_123", payment_intent: { id: "pi_123", metadata: {} } },
          evidence_details: {
            due_by: 1_779_604_800,
            has_evidence: false,
            past_due: false,
            submission_count: 0,
          },
          ...overrides,
        },
      },
    };
  }

  async function post(app: any, payloadObj: unknown) {
    const payload = JSON.stringify(payloadObj);
    const signature = stripe().webhooks.generateTestHeaderString({
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

  it("assembles evidence for a linked, formal dispute and mirrors evidence_details on created", async () => {
    const app = await makeWebhookApp();
    const res = await post(app, disputeEvent("charge.dispute.created"));

    expect(res.statusCode).toBe(200);
    expect(openDisputeMock).toHaveBeenCalledTimes(1);
    expect(assembleDisputeEvidenceMock).toHaveBeenCalledTimes(1);
    expect(assembleDisputeEvidenceMock.mock.calls[0]?.[1]).toEqual({
      disputeId: "dispute_1",
    });
    // The webhook shares the desk's per-dispute mutex.
    expect(assembleDisputeEvidenceMock.mock.calls[0]?.[0]).toMatchObject({
      idempotency: expect.anything(),
    });
    expect(syncDisputeEvidenceDetailsMock).toHaveBeenCalledTimes(1);
    expect(syncDisputeEvidenceDetailsMock.mock.calls[0]?.[1]).toEqual({
      stripeDisputeId: "dp_123",
      evidenceDetails: {
        dueBy: new Date(1_779_604_800 * 1000),
        hasEvidence: false,
        pastDue: false,
        submissionCount: 0,
      },
    });
    await app.close();
  });

  it("does not assemble for a NEEDS_TRIAGE (unlinked) dispute", async () => {
    openDisputeMock.mockImplementationOnce(async () => ({
      ok: true,
      disputeId: "dispute_1",
      stripeDisputeId: "dp_123",
      orderId: null,
      status: "NEEDS_TRIAGE",
      triageReason: "order_not_found",
    }));
    const app = await makeWebhookApp();
    const res = await post(app, disputeEvent("charge.dispute.created"));
    expect(res.statusCode).toBe(200);
    expect(assembleDisputeEvidenceMock).not.toHaveBeenCalled();
    // The mirror still syncs — the row exists even in triage.
    expect(syncDisputeEvidenceDetailsMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not assemble for a warning-only (inquiry) dispute", async () => {
    openDisputeMock.mockImplementationOnce(async () => ({
      ok: true,
      disputeId: "dispute_1",
      stripeDisputeId: "dp_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      status: "WARNING_OPEN",
      triageReason: null,
    }));
    const app = await makeWebhookApp();
    const res = await post(
      app,
      disputeEvent("charge.dispute.created", { status: "warning_needs_response" }),
    );
    expect(res.statusCode).toBe(200);
    expect(assembleDisputeEvidenceMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the webhook green and reports when assembly throws", async () => {
    assembleDisputeEvidenceMock.mockImplementationOnce(async () => {
      throw new Error("assembly exploded");
    });
    const reportError = vi.fn();
    const app = await makeWebhookApp({ reportError });
    // The route logs through the pino child of `app.deps.logger` (the harness
    // returns the same mock), never `app.log` (a no-op under `logger: false`)
    // — the live run's first assembly failure was invisible in the log file
    // for exactly that reason.
    const routeLogError = (app as any).deps.logger.error as ReturnType<typeof vi.fn>;
    routeLogError.mockClear();

    const res = await post(app, disputeEvent("charge.dispute.created"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(openDisputeMock).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "assemble_dispute_evidence" }),
      }),
    );
    expect(routeLogError).toHaveBeenCalledWith(
      "stripe_webhook_dispute_evidence_assemble_failed",
      expect.objectContaining({ disputeId: "dispute_1" }),
    );
    await app.close();
  });

  it("a failing evidence_details sync is logged through the route logger and reported, event still applied", async () => {
    syncDisputeEvidenceDetailsMock.mockImplementationOnce(async () => {
      throw new Error("mirror exploded");
    });
    const reportError = vi.fn();
    const app = await makeWebhookApp({ reportError });
    const routeLogError = (app as any).deps.logger.error as ReturnType<typeof vi.fn>;
    routeLogError.mockClear();

    const res = await post(app, disputeEvent("charge.dispute.updated", { status: "under_review" }));

    expect(res.statusCode).toBe(200);
    expect(refreshDisputeMock).toHaveBeenCalledTimes(1);
    expect(routeLogError).toHaveBeenCalledWith(
      "stripe_webhook_dispute_evidence_details_sync_failed",
      expect.objectContaining({ stripeDisputeId: "dp_123" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "sync_dispute_evidence_details" }),
      }),
    );
    await app.close();
  });

  it("mirrors evidence_details on updated and closed, and omits dueBy when Stripe nulls it", async () => {
    const app = await makeWebhookApp();
    await post(app, disputeEvent("charge.dispute.updated", {
      status: "under_review",
      evidence_details: {
        due_by: null,
        has_evidence: true,
        past_due: false,
        submission_count: 1,
      },
    }));
    await post(app, disputeEvent("charge.dispute.closed", { status: "won" }));

    expect(refreshDisputeMock).toHaveBeenCalledTimes(1);
    expect(closeDisputeMock).toHaveBeenCalledTimes(1);
    expect(assembleDisputeEvidenceMock).not.toHaveBeenCalled();
    expect(syncDisputeEvidenceDetailsMock).toHaveBeenCalledTimes(2);
    expect(syncDisputeEvidenceDetailsMock.mock.calls[0]?.[1]).toEqual({
      stripeDisputeId: "dp_123",
      evidenceDetails: { hasEvidence: true, pastDue: false, submissionCount: 1 },
    });
    await app.close();
  });

  it("captures card AVS/CVC checks on payment_intent.succeeded and never fails the event when the write throws", async () => {
    const setPaymentMethodType = vi.fn(async () => undefined);
    const setPaymentCardChecks = vi.fn(async () => {
      throw new Error("db hiccup");
    });
    const reportError = vi.fn();
    const app = await makeWebhookApp({
      reportError,
      orders: { setPaymentMethodType, setPaymentCardChecks },
      payments: {
        getPaymentMethodType: vi.fn(async () => ({
          methodType: "card",
          cardChecks: {
            addressLine1Check: "pass",
            addressPostalCodeCheck: "fail",
            cvcCheck: "pass",
          },
        })),
      },
    });

    const res = await post(app, {
      id: "evt_pi_checks",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_checks",
          status: "succeeded",
          amount_received: 1000,
          currency: "usd",
          metadata: { orderId: "22222222-2222-4222-8222-222222222222" },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(setPaymentMethodType).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "card",
    );
    expect(setPaymentCardChecks).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      { addressLine1Check: "pass", addressPostalCodeCheck: "fail", cvcCheck: "pass" },
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "set_payment_card_checks" }),
      }),
    );
    await app.close();
  });
});

// ── Radar early fraud warnings + funds_reinstated ──────────────────────────
describe("stripe webhook early fraud warnings", () => {
  beforeEach(() => {
    openDisputeMock.mockClear();
    assembleDisputeEvidenceMock.mockClear();
    syncDisputeEvidenceDetailsMock.mockClear();
    recordEarlyFraudWarningMock.mockClear();
    recordEarlyFraudWarningMock.mockImplementation(async () => ({
      ok: true as const,
      earlyFraudWarningId: "efw_1",
      stripeEfwId: "issfr_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      ownerOrgId: "org_1",
      ownerHumanId: null,
      actionable: true,
      created: true,
      alerted: true,
    }));
    resolveEarlyFraudWarningMock.mockClear();
    resolveEarlyFraudWarningMock.mockImplementation(async () => ({
      ok: true as const,
      resolved: true,
      earlyFraudWarningId: "efw_1",
      resolution: "DISPUTED",
      skippedReason: null,
    }));
    reconcileStripeFullRefundMock.mockClear();
    openDisputeMock.mockImplementation(async () => ({
      ok: true,
      disputeId: "dispute_1",
      stripeDisputeId: "dp_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      status: "OPEN",
      triageReason: null,
    }));
  });

  const stripe = () =>
    new Stripe("stripe-mock", { apiVersion: "2025-08-27.basil" as any });

  async function post(app: any, payloadObj: unknown) {
    const payload = JSON.stringify(payloadObj);
    const signature = stripe().webhooks.generateTestHeaderString({
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

  const efwEvent = (
    type: "radar.early_fraud_warning.created" | "radar.early_fraud_warning.updated",
    overrides: Record<string, unknown> = {},
  ) => ({
    id: `evt_${type.replace(/\./g, "_")}`,
    type,
    created: 1_779_000_000,
    data: {
      object: {
        id: "issfr_123",
        object: "radar.early_fraud_warning",
        actionable: true,
        charge: "ch_123",
        payment_intent: "pi_123",
        fraud_type: "made_with_stolen_card",
        created: 1_778_999_000,
        livemode: false,
        ...overrides,
      },
    },
  });

  const chargeRefundedEvent = (
    refunded: boolean,
    amountRefunded = refunded ? 5129 : 4933,
    id = `evt_charge_refunded_${refunded ? "full" : "partial"}`,
  ) => ({
    id,
    type: "charge.refunded",
    created: 1_779_000_000,
    data: {
      object: {
        id: "ch_123",
        object: "charge",
        refunded,
        payment_intent: "pi_123",
        amount_refunded: amountRefunded,
        refunds: { data: [{ id: "re_123" }] },
      },
    },
  });

  /**
   * Drives the REAL `resolveEarlyFraudWarning` through the webhook against
   * in-memory repos, so the "is the platform refund full?" decision is
   * exercised end to end rather than asserted on a mock's arguments.
   */
  async function makeRefundApp(orderStatus: "REFUNDED" | "PART_REFUNDED") {
    const actual = await vi.importActual<
      typeof import("@th/core/use-cases/disputes")
    >("@th/core/use-cases/disputes");
    resolveEarlyFraudWarningMock.mockImplementation((deps: any, input: any) =>
      actual.resolveEarlyFraudWarning(deps, input),
    );
    const warning = {
      id: "efw_1",
      stripeEfwId: "issfr_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      ownerOrgId: "org_1",
      ownerHumanId: null,
      fraudType: "made_with_stolen_card",
      actionable: true,
      stripeCreatedAt: new Date("2026-09-01T10:00:00.000Z"),
      resolvedAt: null,
      resolution: null,
      createdAt: new Date("2026-09-01T10:00:00.000Z"),
      updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    };
    const markResolved = vi.fn(async (input: any) => ({
      ...warning,
      resolvedAt: input.resolvedAt,
      resolution: input.resolution,
    }));
    const auditLog = vi.fn(async () => undefined);
    const repos: Record<string, unknown> = {
      earlyFraudWarnings: {
        findActiveByStripeChargeId: vi.fn(async () => warning),
        markResolved,
      },
      audit: { log: auditLog },
    };
    repos.tx = async (fn: (tx: unknown) => Promise<unknown>) =>
      fn((app as any).deps.trpc.repos);
    const app = await makeWebhookApp({
      repos,
      orders: {
        getById: vi.fn(async () => ({ id: warning.orderId, status: orderStatus })),
        findByPaymentIntent: vi.fn(async () => ({ id: warning.orderId, status: orderStatus })),
      },
    });
    return { app, markResolved, auditLog };
  }

  it("dispatches radar.early_fraud_warning.created to intake with the parsed shape", async () => {
    const app = await makeWebhookApp();

    const res = await post(app, efwEvent("radar.early_fraud_warning.created"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(recordEarlyFraudWarningMock).toHaveBeenCalledTimes(1);
    expect(recordEarlyFraudWarningMock.mock.calls[0]?.[1]).toEqual({
      stripeEventId: "evt_radar_early_fraud_warning_created",
      stripeEventType: "radar.early_fraud_warning.created",
      stripeEfwId: "issfr_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      metadataOrderId: null,
      metadataEventId: null,
      fraudType: "made_with_stolen_card",
      actionable: true,
      stripeCreatedAt: new Date(1_778_999_000 * 1000),
    });
    // The use case gets the full trpc deps (repos, clock, discordAlert...).
    expect(recordEarlyFraudWarningMock.mock.calls[0]?.[0]).toMatchObject({
      repos: expect.anything(),
      clock: expect.anything(),
    });
    await app.close();
  });

  it("accepts expanded charge / payment_intent objects and lifts metadata.orderId", async () => {
    const app = await makeWebhookApp();

    const res = await post(
      app,
      efwEvent("radar.early_fraud_warning.updated", {
        actionable: false,
        charge: { id: "ch_123", metadata: {} },
        payment_intent: {
          id: "pi_123",
          metadata: {
            orderId: "22222222-2222-4222-8222-222222222222",
            eventId: "33333333-3333-4333-8333-333333333333",
          },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(recordEarlyFraudWarningMock.mock.calls[0]?.[1]).toMatchObject({
      stripeEventType: "radar.early_fraud_warning.updated",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      metadataOrderId: "22222222-2222-4222-8222-222222222222",
      metadataEventId: "33333333-3333-4333-8333-333333333333",
      actionable: false,
    });
    await app.close();
  });

  it("a malformed EFW payload is NOT applied: the parse guard throws and the event lands in the DLQ (still 200)", async () => {
    const { redis, pushed } = makeFakeRedis();
    const app = await makeWebhookApp({ redis });

    const res = await post(
      app,
      efwEvent("radar.early_fraud_warning.created", { charge: 42 }),
    );

    expect(res.statusCode).toBe(200);
    expect(recordEarlyFraudWarningMock).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      stripeEventId: "evt_radar_early_fraud_warning_created",
      eventType: "radar.early_fraud_warning.created",
    });
    expect(pushed[0]?.error).toContain("[radar.early_fraud_warning.created:parse]");
    await app.close();
  });

  it("a DLQ write that Redis aborts is reported (step dlq_store), not silently treated as stored", async () => {
    const { redis } = makeFakeRedis();
    const brokenRedis = {
      ...redis,
      multi: () => {
        const chain = redis.multi();
        chain.exec = async () => null as never;
        return chain;
      },
    };
    const reportError = vi.fn();
    const app = await makeWebhookApp({ redis: brokenRedis, reportError });

    const res = await post(
      app,
      efwEvent("radar.early_fraud_warning.created", { charge: 42 }),
    );

    // Same response as a stored DLQ write: only the report is new.
    expect(res.statusCode).toBe(200);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/^redis webhook dlq push aborted \(keyHash=[0-9a-f]{12}\)$/),
      }),
      expect.objectContaining({
        tags: { webhook: "stripe", step: "dlq_store" },
      }),
    );
    await app.close();
  });

  it("a failing intake write DLQs the EFW event for replay rather than dropping the warning", async () => {
    recordEarlyFraudWarningMock.mockImplementationOnce(async () => {
      throw new Error("efw_write_failed");
    });
    const { redis, pushed } = makeFakeRedis();
    const app = await makeWebhookApp({ redis });

    const res = await post(app, efwEvent("radar.early_fraud_warning.created"));

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.error).toContain("efw_write_failed");
    await app.close();
  });

  it("charge.dispute.created closes the charge's active warning as DISPUTED after the lifecycle write", async () => {
    const app = await makeWebhookApp();

    const res = await post(app, {
      id: "evt_dp_created",
      type: "charge.dispute.created",
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          charge: "ch_123",
          payment_intent: "pi_123",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(openDisputeMock).toHaveBeenCalledTimes(1);
    expect(resolveEarlyFraudWarningMock).toHaveBeenCalledTimes(1);
    expect(resolveEarlyFraudWarningMock.mock.calls[0]?.[1]).toEqual({
      stripeChargeId: "ch_123",
      resolution: "DISPUTED",
      stripeEventId: "evt_dp_created",
      stripeEventType: "charge.dispute.created",
      sourceId: "dp_123",
    });
    await app.close();
  });

  it("a failing auto-resolution never fails the dispute event: swallowed, logged, reported", async () => {
    resolveEarlyFraudWarningMock.mockImplementationOnce(async () => {
      throw new Error("efw table on fire");
    });
    const reportError = vi.fn();
    const app = await makeWebhookApp({ reportError });
    // The route logs through `app.deps.logger.child(...)` (which the harness
    // returns as the same mock), NOT `app.log` — Fastify boots with
    // `logger: false`, so `app.log` is a no-op that Sentry never sees.
    const routeLogError = (app as any).deps.logger.error as ReturnType<typeof vi.fn>;
    routeLogError.mockClear();

    const res = await post(app, {
      id: "evt_dp_created_efw_fail",
      type: "charge.dispute.created",
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          charge: "ch_123",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(openDisputeMock).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "resolve_early_fraud_warning" }),
      }),
    );
    expect(routeLogError).toHaveBeenCalledWith(
      "stripe_webhook_early_fraud_warning_resolve_failed",
      expect.objectContaining({ stripeChargeId: "ch_123", resolution: "DISPUTED" }),
    );
    // No DLQ-path error log: the event was applied.
    expect(routeLogError).not.toHaveBeenCalledWith(
      "stripe_webhook_unhandled_error_dlq",
      expect.anything(),
    );
    await app.close();
  });

  it("charge.refunded hands the refund facts to the resolver whenever money went back; nothing for amount_refunded 0", async () => {
    const app = await makeWebhookApp();

    const full = await post(app, chargeRefundedEvent(true));
    expect(full.statusCode).toBe(200);
    expect(reconcileStripeFullRefundMock).toHaveBeenCalledTimes(1);
    expect(resolveEarlyFraudWarningMock).toHaveBeenCalledTimes(1);
    expect(resolveEarlyFraudWarningMock.mock.calls[0]?.[1]).toEqual({
      stripeChargeId: "ch_123",
      resolution: "REFUNDED",
      stripeEventId: "evt_charge_refunded_full",
      stripeEventType: "charge.refunded",
      sourceId: "re_123",
      refund: { stripeFullyRefunded: true, amountRefundedCents: 5129 },
    });

    const partial = await post(app, chargeRefundedEvent(false));
    expect(partial.statusCode).toBe(200);
    expect(resolveEarlyFraudWarningMock).toHaveBeenCalledTimes(2);
    expect(resolveEarlyFraudWarningMock.mock.calls[1]?.[1]).toMatchObject({
      refund: { stripeFullyRefunded: false, amountRefundedCents: 4933 },
    });

    const nothing = await post(app, chargeRefundedEvent(false, 0, "evt_charge_refunded_zero"));
    expect(nothing.statusCode).toBe(200);
    expect(resolveEarlyFraudWarningMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("a platform refund (Stripe: refunded=false, fee withheld) with the local order REFUNDED resolves the warning", async () => {
    // Observed live: $51.29 charge, platform refunded $49.33 (processing fee
    // withheld by design) → Stripe sends refunded:false, amount_refunded:4933.
    const { app, markResolved, auditLog } = await makeRefundApp("REFUNDED");

    const res = await post(app, chargeRefundedEvent(false, 4933));

    expect(res.statusCode).toBe(200);
    expect(markResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: "efw_1", resolution: "REFUNDED" }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "early_fraud_warning.resolved",
        data: expect.objectContaining({
          resolution: "REFUNDED",
          refund: { stripeFullyRefunded: false, amountRefundedCents: 4933 },
        }),
      }),
    );
    await app.close();
  });

  it("a platform PARTIAL refund (local order PART_REFUNDED) leaves the warning open", async () => {
    const { app, markResolved, auditLog } = await makeRefundApp("PART_REFUNDED");

    const res = await post(app, chargeRefundedEvent(false, 1000));

    expect(res.statusCode).toBe(200);
    expect(resolveEarlyFraudWarningMock).toHaveBeenCalledTimes(1);
    expect(markResolved).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it("a replay refused by a still-held idempotency claim explains the marker instead of a bare code", async () => {
    openDisputeMock.mockImplementationOnce(async () => {
      throw { code: "IDEMPOTENCY_LOCK_IN_PROGRESS", message: "IDEMPOTENCY_LOCK_IN_PROGRESS" };
    });
    const app = await makeWebhookApp();
    const replay = (app as any).deps.trpc.replayStripeEvent as (
      raw: string,
    ) => Promise<{ ok: boolean; error?: string }>;

    const result = await replay(
      JSON.stringify({
        id: "evt_replay_locked",
        type: "charge.dispute.created",
        created: 1_779_000_000,
        data: {
          object: {
            id: "dp_123",
            amount: 5000,
            currency: "usd",
            reason: "fraudulent",
            status: "needs_response",
            charge: "ch_123",
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("IDEMPOTENCY_LOCK_IN_PROGRESS");
    // Leads with the common case (an attempt in flight, 300 s claims) and
    // names the deterministic-rejection marker only as the tail.
    expect(result.error).toContain("in flight");
    expect(result.error).toContain("300 s");
    expect(result.error).toContain("15-minute marker");
    expect(result.error).toContain("reproduce that rejection");
    await app.close();
  });

  it("charge.dispute.funds_reinstated writes an audit row and a warn log, and touches no lifecycle use case", async () => {
    const auditLog = vi.fn(async () => undefined);
    const findByStripeDisputeId = vi.fn(async () => ({
      id: "dispute_local_1",
      orderId: "22222222-2222-4222-8222-222222222222",
    }));
    const app = await makeWebhookApp({
      repos: { audit: { log: auditLog }, disputes: { findByStripeDisputeId } },
    });
    const routeLogWarn = (app as any).deps.logger.warn as ReturnType<typeof vi.fn>;
    routeLogWarn.mockClear();

    const res = await post(app, {
      id: "evt_funds_reinstated",
      type: "charge.dispute.funds_reinstated",
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_123",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "won",
          charge: "ch_123",
          payment_intent: "pi_123",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true });
    expect(findByStripeDisputeId).toHaveBeenCalledWith("dp_123");
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "dispute",
        entityId: "dispute_local_1",
        action: "dispute.funds_reinstated",
        at: new Date(1_779_000_000 * 1000),
        data: expect.objectContaining({
          stripeEventId: "evt_funds_reinstated",
          stripeDisputeId: "dp_123",
          stripeChargeId: "ch_123",
          orderId: "22222222-2222-4222-8222-222222222222",
          amountCents: 5000,
          stripeStatus: "won",
        }),
      }),
    );
    expect(routeLogWarn).toHaveBeenCalledWith(
      "stripe_webhook_dispute_funds_reinstated",
      expect.objectContaining({ stripeDisputeId: "dp_123", disputeId: "dispute_local_1" }),
    );
    // Informational only: no ledger-bearing lifecycle call.
    expect(openDisputeMock).not.toHaveBeenCalled();
    expect(refreshDisputeMock).not.toHaveBeenCalled();
    expect(recordFundsWithdrawnMock).not.toHaveBeenCalled();
    expect(closeDisputeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("charge.dispute.funds_reinstated with a failing audit write reaches the DLQ, not a silent 200", async () => {
    const { redis, pushed } = makeFakeRedis();
    const app = await makeWebhookApp({
      redis,
      repos: {
        audit: {
          log: vi.fn(async () => {
            throw new Error("audit down");
          }),
        },
        disputes: { findByStripeDisputeId: vi.fn(async () => null) },
      },
    });
    const res = await post(app, {
      id: "evt_funds_reinstated_fail",
      type: "charge.dispute.funds_reinstated",
      created: 1_779_000_000,
      data: {
        object: {
          id: "dp_123",
          amount: 5000,
          currency: "usd",
          status: "won",
          charge: "ch_123",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.error).toContain("[charge.dispute.funds_reinstated:audit]");
    expect(pushed[0]?.error).toContain("audit down");
    await app.close();
  });
});

// ── payment_intent.payment_failed: cancel + release EVERY hold ─────────────
describe("stripe webhook payment_intent.payment_failed", () => {
  const ORDER_ID = "44444444-4444-4444-8444-444444444444";
  const PI_ID = "pi_failed_1";

  const failedEvent = (overrides: Record<string, unknown> = {}) => ({
    id: "evt_pi_failed",
    type: "payment_intent.payment_failed",
    created: 1_779_000_000,
    data: {
      object: {
        id: PI_ID,
        object: "payment_intent",
        status: "requires_payment_method",
        metadata: { orderId: ORDER_ID },
        last_payment_error: { message: "Your card was declined." },
        ...overrides,
      },
    },
  });

  /**
   * One repo surface shared by the root `repos` and the `tx` handle, with a
   * call log so the ORDER of Stripe-vs-DB writes can be asserted: the PI has
   * to be proven dead BEFORE the order is cancelled, or a still-confirmable
   * PI finalises into a CANCELLED order (charge, no ticket).
   */
  function makeFailedPaymentApp(opts: {
    status: "PENDING" | "PROCESSING" | "CANCELLED" | "SUCCEEDED";
    /** What `cancelPaymentIntent` answers. Default: cancelled cleanly. */
    cancelResult?: { canceled: boolean };
    /** What `retrievePaymentIntent` reports when the cancel was a no-op. */
    retrievedStatus?: string;
    /** Whether the CAS cancel of the order wins. Default true. */
    casWins?: boolean;
    /** Make `cancelPaymentIntent` reject (Stripe unreachable). */
    cancelRejects?: boolean;
    /** The PI the order row is linked to. Default: the event's PI. */
    linkedPaymentIntentId?: string;
    /** A RESALE order holding this listing until `holdExpiresAt`. */
    resale?: { listingId: string; holdExpiresAt: string };
    /** `credits.releaseForOrder` throws inside the tx. */
    releaseCreditsRejects?: boolean;
    /** Wire a mailer (the bank-payment-failed email needs one). Default true. */
    withMailer?: boolean;
  }) {
    sendBankPaymentFailedEmailMock.mockClear();
    const calls: string[] = [];
    bankEmailCallLog = calls;
    const orders = {
      getById: vi.fn(async () => ({
        id: ORDER_ID,
        status: opts.status,
        stripePaymentIntentId: opts.linkedPaymentIntentId ?? PI_ID,
        source: opts.resale ? "RESALE" : "PRIMARY",
        buyerHumanId: "buyer-1",
        items: opts.resale
          ? [
              {
                id: "item-1",
                resaleListingId: opts.resale.listingId,
                meta: {
                  holdExpiresAt: opts.resale.holdExpiresAt,
                  resaleListingId: opts.resale.listingId,
                },
              },
            ]
          : [],
      })),
      findByPaymentIntent: vi.fn(async () => ({
        id: ORDER_ID,
        status: opts.status,
      })),
      cancelPendingOrder: vi.fn(async () => {
        calls.push("cancelPendingOrder");
        return opts.casWins ?? true;
      }),
      cancelProcessingOrder: vi.fn(async () => {
        calls.push("cancelProcessingOrder");
        return opts.casWins ?? true;
      }),
    };
    const promos = {
      releaseHoldsForOrder: vi.fn(async () => {
        calls.push("promos.releaseHoldsForOrder");
      }),
    };
    const feeWaivers = {
      release: vi.fn(async () => {
        calls.push("feeWaivers.release");
        return { releasedTickets: 0 };
      }),
    };
    const credits = {
      releaseForOrder: vi.fn(async () => {
        calls.push("credits.releaseForOrder");
        if (opts.releaseCreditsRejects) throw new Error("credits_release_failed");
        return { releasedCents: 0, creditIds: [] };
      }),
    };
    const resaleListings = {
      releaseHold: vi.fn(async () => {
        calls.push("resaleListings.releaseHold");
        return { released: true, listingStatus: "ACTIVE" };
      }),
    };
    const txRepos = { orders, promos, feeWaivers, credits, resaleListings };
    const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      const out = await fn(txRepos);
      // Only reached when `fn` resolved: a throw inside never "commits".
      calls.push("tx:committed");
      return out;
    });
    const payments = {
      cancelPaymentIntent: vi.fn(async () => {
        calls.push("cancelPaymentIntent");
        if (opts.cancelRejects) throw new Error("stripe_unreachable");
        return opts.cancelResult ?? { canceled: true };
      }),
      retrievePaymentIntent: vi.fn(async () => {
        calls.push("retrievePaymentIntent");
        return {
          id: PI_ID,
          status: opts.retrievedStatus ?? "canceled",
          amountReceived: 0,
          currency: "usd",
          metadata: { orderId: ORDER_ID },
        };
      }),
    };
    const reportError = vi.fn();
    const { redis, pushed } = makeFakeRedis();
    return {
      calls,
      orders,
      promos,
      feeWaivers,
      credits,
      resaleListings,
      tx,
      payments,
      reportError,
      pushed,
      app: makeWebhookApp({
        orders,
        repos: { promos, feeWaivers, credits, tx },
        payments,
        reportError,
        redis,
        ...((opts.withMailer ?? true) ? { mailer: { send: vi.fn() } } : {}),
      }),
    };
  }

  // ── Buyer email on a failed BANK payment (owner, 2026-10-14) ───────────
  it.each([false, true])(
    "(m1) PROCESSING cancelled here emails the buyer once (resale=%s)",
    async (isResale) => {
      const t = makeFailedPaymentApp({
        status: "PROCESSING",
        ...(isResale
          ? {
              resale: {
                listingId: "listing-1",
                holdExpiresAt: "2026-10-04T12:15:00.000Z",
              },
            }
          : {}),
      });
      const app = await t.app;

      const res = await postStripeEvent(app, failedEvent());
      expect(res.statusCode).toBe(200);
      expect(t.pushed).toHaveLength(0);

      expect(sendBankPaymentFailedEmailMock).toHaveBeenCalledTimes(1);
      const [deps, input] = sendBankPaymentFailedEmailMock.mock
        .calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
      expect(input).toEqual({
        orderId: ORDER_ID,
        publicAppUrl: expect.any(String),
      });
      expect(deps.mailer).toBeDefined();
      expect(deps.reportError).toBe(t.reportError);
      // Sent only after the cancel committed.
      expect(t.calls).toContain("cancelProcessingOrder");
      expect(t.calls).toContain("tx:committed");
      expect(t.calls.indexOf("sendBankPaymentFailedEmail")).toBeGreaterThan(
        t.calls.indexOf("tx:committed"),
      );

      await app.close();
    },
    45_000,
  );

  it("(m1b) a throw inside the cancel tx sends no email and DLQs the event once", async () => {
    const t = makeFailedPaymentApp({
      status: "PROCESSING",
      releaseCreditsRejects: true,
    });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.credits.releaseForOrder).toHaveBeenCalled();
    expect(t.calls).not.toContain("tx:committed");
    expect(sendBankPaymentFailedEmailMock).not.toHaveBeenCalled();
    expect(t.pushed).toHaveLength(1);
    expect(t.pushed[0]).toMatchObject({
      eventType: "payment_intent.payment_failed",
    });
    expect(t.pushed[0]?.error).toContain("credits_release_failed");

    await app.close();
  }, 45_000);

  it("(m2) a PENDING failure (a decline the buyer saw) sends no email", async () => {
    const t = makeFailedPaymentApp({ status: "PENDING" });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.orders.cancelPendingOrder).toHaveBeenCalled();
    expect(sendBankPaymentFailedEmailMock).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(m3) PROCESSING whose cancel CAS lost (a redelivery, or it finalised) sends no email", async () => {
    const t = makeFailedPaymentApp({ status: "PROCESSING", casWins: false });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.orders.cancelProcessingOrder).toHaveBeenCalled();
    expect(sendBankPaymentFailedEmailMock).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(m4) an already-CANCELLED order (redelivered event) sends no email", async () => {
    const t = makeFailedPaymentApp({ status: "CANCELLED" });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(sendBankPaymentFailedEmailMock).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(m5) PROCESSING cancelled with no mailer: logs at error level, still 200, no DLQ", async () => {
    const t = makeFailedPaymentApp({ status: "PROCESSING", withMailer: false });
    const app = await t.app;
    const error = vi.spyOn(app.log, "error");

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.pushed).toHaveLength(0);
    expect(t.orders.cancelProcessingOrder).toHaveBeenCalled();
    expect(sendBankPaymentFailedEmailMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      "stripe_webhook_bank_payment_failed_email_no_mailer",
    );

    await app.close();
  }, 45_000);

  it.each(["PENDING", "PROCESSING"] as const)(
    "(G1) a %s RESALE order cancelled here gives its listing hold back, fenced, after the cancel, in the same tx",
    async (status) => {
      const holdExpiresAt = "2026-10-04T12:15:00.000Z";
      const t = makeFailedPaymentApp({
        status,
        resale: { listingId: "listing-1", holdExpiresAt },
      });
      const app = await t.app;

      const res = await postStripeEvent(app, failedEvent());
      expect(res.statusCode).toBe(200);

      expect(t.resaleListings.releaseHold).toHaveBeenCalledWith(
        "listing-1",
        { buyerHumanId: "buyer-1", heldUntil: new Date(holdExpiresAt) },
        { now: expect.any(Date) },
      );
      expect(t.tx).toHaveBeenCalledTimes(1);
      const cancelCall =
        status === "PENDING" ? "cancelPendingOrder" : "cancelProcessingOrder";
      expect(t.calls.indexOf(cancelCall)).toBeLessThan(
        t.calls.indexOf("resaleListings.releaseHold"),
      );

      await app.close();
    },
    45_000,
  );

  it("(G1) a RESALE order whose cancel CAS loses keeps its listing hold", async () => {
    const t = makeFailedPaymentApp({
      status: "PENDING",
      casWins: false,
      resale: { listingId: "listing-1", holdExpiresAt: "2026-10-04T12:15:00.000Z" },
    });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.orders.cancelPendingOrder).toHaveBeenCalled();
    expect(t.resaleListings.releaseHold).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(a) PENDING + PI still confirmable: settles the PI FIRST, then cancels and releases promo, fee-waiver and credit holds in one tx", async () => {
    const t = makeFailedPaymentApp({ status: "PENDING" });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.pushed).toHaveLength(0);

    expect(t.orders.cancelPendingOrder).toHaveBeenCalledWith(ORDER_ID, {
      expectedPaymentIntentId: PI_ID,
    });
    expect(t.orders.cancelProcessingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(t.feeWaivers.release).toHaveBeenCalledWith(ORDER_ID);
    expect(t.credits.releaseForOrder).toHaveBeenCalledTimes(1);
    expect(t.credits.releaseForOrder.mock.calls[0]![0]).toBe(ORDER_ID);
    // The DB writes ran inside a transaction, not on the root repos.
    expect(t.tx).toHaveBeenCalledTimes(1);

    // Order of operations is the load-bearing part.
    expect(t.calls.indexOf("cancelPaymentIntent")).toBeGreaterThanOrEqual(0);
    expect(t.calls.indexOf("cancelPaymentIntent")).toBeLessThan(
      t.calls.indexOf("cancelPendingOrder"),
    );
    expect(t.calls.indexOf("cancelPendingOrder")).toBeLessThan(
      t.calls.indexOf("promos.releaseHoldsForOrder"),
    );
    expect(t.reportError).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(b) PENDING but the PI actually SUCCEEDED: refuses — order untouched, nothing released, refusal reported", async () => {
    const t = makeFailedPaymentApp({
      status: "PENDING",
      cancelResult: { canceled: false },
      retrievedStatus: "succeeded",
    });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    // A refusal is not a handler failure: finalize owns a succeeded PI.
    expect(t.pushed).toHaveLength(0);

    expect(t.payments.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(t.payments.retrievePaymentIntent).toHaveBeenCalledTimes(1);
    expect(t.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(t.orders.cancelProcessingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(t.feeWaivers.release).not.toHaveBeenCalled();
    expect(t.credits.releaseForOrder).not.toHaveBeenCalled();

    // Reported ONCE, by the helper, tagged with this caller.
    expect(t.reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = t.reportError.mock.calls[0] as [Error, any];
    expect(err.message).toBe("carried_over_cart_pi_terminal_not_canceled:succeeded");
    expect(ctx.tags.caller).toBe("stripe-webhook:payment_failed");

    await app.close();
  }, 45_000);

  it("(c) PROCESSING (ACH return): cancels via the processing CAS and releases the same three holds, in a tx", async () => {
    const t = makeFailedPaymentApp({ status: "PROCESSING" });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.pushed).toHaveLength(0);

    expect(t.orders.cancelProcessingOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(t.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(t.feeWaivers.release).toHaveBeenCalledWith(ORDER_ID);
    expect(t.credits.releaseForOrder.mock.calls[0]![0]).toBe(ORDER_ID);
    expect(t.tx).toHaveBeenCalledTimes(1);
    // An ACH return puts the PI back in `requires_payment_method`, where it
    // is STILL confirmable with another bank account — so it is settled
    // before the order is cancelled, exactly like the PENDING path.
    expect(t.calls.indexOf("cancelPaymentIntent")).toBeGreaterThanOrEqual(0);
    expect(t.calls.indexOf("cancelPaymentIntent")).toBeLessThan(
      t.calls.indexOf("cancelProcessingOrder"),
    );
    expect(t.calls.indexOf("cancelProcessingOrder")).toBeLessThan(
      t.calls.indexOf("promos.releaseHoldsForOrder"),
    );
    expect(t.reportError).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(c2) PROCESSING but the PI actually SUCCEEDED: refuses — nothing cancelled, nothing released, one report, no DLQ", async () => {
    const t = makeFailedPaymentApp({
      status: "PROCESSING",
      cancelResult: { canceled: false },
      retrievedStatus: "succeeded",
    });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    // Finalize owns a succeeded PI; a stale failed event is not a failure.
    expect(t.pushed).toHaveLength(0);

    expect(t.orders.cancelProcessingOrder).not.toHaveBeenCalled();
    expect(t.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(t.feeWaivers.release).not.toHaveBeenCalled();
    expect(t.credits.releaseForOrder).not.toHaveBeenCalled();
    expect(t.tx).not.toHaveBeenCalled();
    expect(t.reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = t.reportError.mock.calls[0] as [Error, any];
    expect(ctx.tags.caller).toBe("stripe-webhook:payment_failed");

    await app.close();
  }, 45_000);

  it("(c4) PROCESSING and the PI is itself `processing` (buyer mid-retry): refuses — nothing cancelled, no DLQ, one report", async () => {
    const t = makeFailedPaymentApp({
      status: "PROCESSING",
      cancelResult: { canceled: false },
      retrievedStatus: "processing",
    });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    // Not ours to act on: Stripe will send another payment_failed or a
    // succeeded, and either one settles it. Not a failure, so no DLQ.
    expect(t.pushed).toHaveLength(0);

    expect(t.orders.cancelProcessingOrder).not.toHaveBeenCalled();
    expect(t.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(t.feeWaivers.release).not.toHaveBeenCalled();
    expect(t.credits.releaseForOrder).not.toHaveBeenCalled();
    expect(t.tx).not.toHaveBeenCalled();
    expect(t.reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = t.reportError.mock.calls[0] as [Error, any];
    expect(err.message).toBe(
      "carried_over_cart_pi_terminal_not_canceled:processing",
    );
    expect(ctx.tags.caller).toBe("stripe-webhook:payment_failed");

    await app.close();
  }, 45_000);

  it("(c3) PROCESSING and Stripe is unreachable: NOT cancelled, and the event lands in the DLQ — no reaper ever revisits a PROCESSING order", async () => {
    const t = makeFailedPaymentApp({ status: "PROCESSING", cancelRejects: true });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    // Still 200 to Stripe (the sink owns retries via the DLQ), but preserved.
    expect(res.statusCode).toBe(200);
    expect(t.pushed).toHaveLength(1);
    // The sink prefixes the DLQ row with `[stage]`. Pin the SPECIFIC stage:
    // the handler's inner catch must rethrow a WebhookStageError untouched,
    // not re-wrap it under the generic `:apply` stage.
    expect(t.pushed[0]!.error).toContain(
      "[payment_intent.payment_failed:settle_pi]",
    );
    expect(t.pushed[0]!.error).not.toContain(
      "[payment_intent.payment_failed:apply]",
    );

    expect(t.orders.cancelProcessingOrder).not.toHaveBeenCalled();
    expect(t.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(t.tx).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(d) already CANCELLED: a no-op — no Stripe call, no cancel, no release", async () => {
    const t = makeFailedPaymentApp({ status: "CANCELLED" });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.pushed).toHaveLength(0);

    expect(t.calls).toEqual([]);
    expect(t.tx).not.toHaveBeenCalled();
    expect(t.reportError).not.toHaveBeenCalled();

    await app.close();
  }, 45_000);

  it("(e) PENDING but the CAS loses (finalised between settle and cancel): releases nothing", async () => {
    const t = makeFailedPaymentApp({ status: "PENDING", casWins: false });
    const app = await t.app;
    const info = vi.spyOn(app.log, "info");

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    expect(t.pushed).toHaveLength(0);

    expect(t.orders.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(t.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(t.feeWaivers.release).not.toHaveBeenCalled();
    expect(t.credits.releaseForOrder).not.toHaveBeenCalled();
    // The lost CAS is visible in the logs, not silent.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, from: "PENDING" }),
      "stripe_webhook_payment_failed_cancel_cas_lost",
    );

    await app.close();
  }, 45_000);

  it("(f) PENDING and Stripe is unreachable: leaves the order to the cart reaper — 200, no DLQ, no cancel, one report", async () => {
    const t = makeFailedPaymentApp({ status: "PENDING", cancelRejects: true });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);
    // A PENDING order with its hold intact is exactly what the expired-cart
    // reaper reads, so nothing is lost by answering 200 here.
    expect(t.pushed).toHaveLength(0);

    expect(t.tx).not.toHaveBeenCalled();
    expect(t.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(t.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(t.reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = t.reportError.mock.calls[0] as [Error, any];
    expect(err.message).toBe("stripe_unreachable");
    expect(ctx.tags.caller).toBe("stripe-webhook:payment_failed");

    await app.close();
  }, 45_000);

  it("(g) the order is linked to a DIFFERENT PI than the event's: logs the anomaly and settles the LINKED one", async () => {
    const t = makeFailedPaymentApp({
      status: "PENDING",
      linkedPaymentIntentId: "pi_linked_other",
    });
    const app = await t.app;

    const res = await postStripeEvent(app, failedEvent());
    expect(res.statusCode).toBe(200);

    expect(t.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_linked_other",
    });
    expect(t.orders.cancelPendingOrder).toHaveBeenCalledWith(ORDER_ID, {
      expectedPaymentIntentId: "pi_linked_other",
    });
    expect((app as any).deps.logger.error).toHaveBeenCalledWith(
      "stripe_webhook_payment_failed_pi_mismatch",
      expect.objectContaining({
        orderId: ORDER_ID,
        linkedPaymentIntentId: "pi_linked_other",
        eventPaymentIntentId: PI_ID,
      }),
    );

    await app.close();
  }, 45_000);
});
