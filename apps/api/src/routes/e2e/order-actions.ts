/**
 * E2E order action routes — finalize, hold, create checkout, inspect, mark paid-out, etc.
 *
 * These wrap use-cases or Prisma queries that E2E tests call to manipulate
 * orders without going through the UI.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import { createPinoLoggerAdapter } from "@th/adapters/infra/logger";
import { createMailerFromConfig } from "@th/adapters/comms/mail";
import { finalizePaymentIntent } from "@th/core/use-cases/orders/finalize-from-payment-intent";
import { updateOrderItems } from "@th/core/use-cases/orders/update-order-items";
import { createCheckout } from "@th/core/use-cases/orders/create-checkout";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import { env } from "../../lib/env.js";
import {
  assertE2eAuthorized,
  formatError,
  resolveHumanId,
} from "./_helpers.js";

// ── Amount helpers ───────────────────────────────────────────────────────

function extractNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function computeExpectedAmount(order: {
  amountGrossCents: number;
  feesPlatformCents: number;
  items: Array<{ amountCents: number; meta: unknown }>;
}): number {
  let hasBuyerTotals = false;
  let total = 0;

  for (const item of order.items) {
    const buyerTotal = extractNumber(
      (item.meta as Record<string, unknown> | null)?.buyerTotalCents,
    );
    if (buyerTotal !== null) {
      total += buyerTotal;
      hasBuyerTotals = true;
    } else {
      total += item.amountCents;
    }
  }

  if (!hasBuyerTotals) {
    total = order.amountGrossCents + order.feesPlatformCents;
  }

  return total;
}

// ── Plugin ───────────────────────────────────────────────────────────────

const orderActions: FastifyPluginAsync = async (app) => {
  // ── Finalize order ────────────────────────────────────────────────────
  app.post("/e2e/finalize-order", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      orderId?: string;
      paymentIntentId?: string;
    };

    if (!body.orderId || typeof body.orderId !== "string") {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    const order = await prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        items: true,
        buyer: { include: { authUser: true } },
        event: { include: { place: true } },
      },
    });
    if (!order) {
      return reply.status(404).send({ ok: false, error: "order_not_found" });
    }
    // Order.eventId is nullable now that membership invoices are Orders. This
    // e2e helper drives the ticketing flow and dereferences the event below.
    if (!order.event) {
      return reply
        .status(400)
        .send({ ok: false, error: "order_has_no_event" });
    }
    const orderEvent = order.event;

    const paymentIntentId =
      (typeof body.paymentIntentId === "string" &&
      body.paymentIntentId.length > 0
        ? body.paymentIntentId
        : order.stripePaymentIntentId) ?? `pi_e2e_${Date.now()}`;
    const amountReceived = computeExpectedAmount(order);

    try {
      const finalizeDeps = {
        ...app.deps.trpc,
        onSettlementFailure: app.deps.trpc.onSettlementFailure ?? undefined,
      };
      await finalizePaymentIntent(finalizeDeps, {
        stripeEvent: {
          id: `evt_e2e_${Date.now()}`,
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: paymentIntentId,
              status: "succeeded",
              amount_received: amountReceived,
              currency: order.currency.toLowerCase(),
              metadata: {
                orderId: order.id,
                eventId: order.eventId,
                source: order.source.toLowerCase(),
              },
            },
          },
        },
      });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_finalize_failed", message });
    }

    const updatedOrder = await prisma.order.findUnique({
      where: { id: order.id },
    });
    const tickets = await prisma.ticket.findMany({
      where: { orderId: order.id },
      select: { id: true, code: true },
    });
    const ticketCount = tickets.length;

    const publicAppUrl =
      process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
    const manageUrl = `${publicAppUrl.replace(/\/+$/, "")}/orders/${order.id}`;
    // Order-aware support CTA: the buyer's ticket.issued email links to the
    // help section of their own order page, mirroring sendTicketIssuedEmail.
    const supportUrl = `${publicAppUrl.replace(/\/+$/, "")}/my-tickets/${order.id}#get-help`;
    const venueName =
      orderEvent.place?.name ?? orderEvent.addressText ?? "Venue TBA";
    const qrBaseUrl = `${publicAppUrl.replace(/\/+$/, "")}/tickets/qr`;
    const ticketAssets = tickets.map((t) => ({
      code: t.code,
      qrUrl: `${qrBaseUrl}/${t.code}`,
    }));

    const isPlaywrightE2E = process.env.PLAYWRIGHT_E2E === "1";
    const isPlainSmtp = isPlaywrightE2E || env.SMTP_SECURE === false;
    const mailer = createMailerFromConfig({
      resendApiKey: env.RESEND_API_KEY,
      defaultFromEmail: env.SMTP_DEFAULT_FROM_EMAIL,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUsername: env.SMTP_USERNAME,
      smtpPassword: env.SMTP_PASSWORD,
      appHeaderValue: env.SMTP_APP_HEADER,
      plainSmtp: isPlainSmtp,
      logger: createPinoLoggerAdapter(),
    });

    if (!mailer) {
      return reply
        .status(500)
        .send({ ok: false, error: "mailer_not_configured" });
    }

    await mailer.send({
      to: { to: order.buyer.authUser?.email ?? "" },
      template: {
        key: "ticket.issued",
        variables: {
          eventTitle: orderEvent.title,
          eventDateISO: orderEvent.startsAt.toISOString(),
          venueName,
          tickets: ticketAssets,
          orderId: order.id,
          manageUrl,
          supportUrl,
        },
      },
      idempotencyKey: `e2e-ticket-issued:${order.id}`,
    });

    return reply.send({
      ok: true,
      orderId: order.id,
      status: updatedOrder?.status ?? order.status,
      amountReceived,
      ticketCount,
      tickets: ticketAssets,
    });
  });

  // ── Hold (update order items) ─────────────────────────────────────────
  app.post("/e2e/checkout/hold", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      humanId?: string;
      eventId?: string;
      orderId?: string;
      items?: Array<{ ticketTypeId: string; qty: number }>;
    };

    const actorHumanId = await resolveHumanId(body);
    if (!actorHumanId) {
      return reply.status(400).send({ ok: false, error: "missing_human" });
    }
    if (
      !body.eventId ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    ) {
      return reply.status(400).send({ ok: false, error: "missing_items" });
    }

    try {
      const result = await updateOrderItems(app.deps.trpc, {
        actorHumanId,
        eventId: body.eventId,
        orderId: body.orderId,
        items: body.items,
      });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_hold_failed", message });
    }
  });

  // ── Inspect order ─────────────────────────────────────────────────────
  app.get("/e2e/orders/:id", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;
    const { id } = request.params as { id: string };
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return reply.status(404).send({ ok: false });
    return reply.send(order);
  });

  // ── Inspect event (geo) ───────────────────────────────────────────────
  app.get("/e2e/events/:id", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;
    const { id } = request.params as { id: string };
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        addressText: true,
        lat: true,
        lng: true,
        locality: true,
        region: true,
        countryCode: true,
        postalCode: true,
        placeId: true,
        savedLocationId: true,
      },
    });
    if (!event) return reply.status(404).send({ ok: false });
    return reply.send(event);
  });

  // ── Create checkout ───────────────────────────────────────────────────
  app.post("/e2e/checkout/create", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      email?: string;
      humanId?: string;
      eventId?: string;
      items?: Array<{ ticketTypeId: string; qty: number }>;
      currency?: string;
      clientKey?: string;
    };

    const actorHumanId = await resolveHumanId(body);
    if (!actorHumanId) {
      return reply.status(400).send({ ok: false, error: "missing_human" });
    }
    if (
      !body.eventId ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    ) {
      return reply.status(400).send({ ok: false, error: "missing_items" });
    }

    try {
      const stripeMode = env.E2E_STRIPE_MODE ?? "sandbox";
      if (stripeMode === "sandbox" && !env.STRIPE_SECRET_KEY) {
        return reply.status(500).send({
          ok: false,
          error: "missing_stripe_secret",
          message: "STRIPE_SECRET_KEY is required for sandbox E2E checkout.",
        });
      }
      if (stripeMode === "sandbox" && !env.STRIPE_WEBHOOK_SECRET) {
        return reply.status(500).send({
          ok: false,
          error: "missing_stripe_webhook_secret",
          message:
            "STRIPE_WEBHOOK_SECRET is required for sandbox E2E checkout. Run `stripe listen --forward-to http://localhost:3001/webhooks/stripe` and export the whsec_ value.",
        });
      }
      const shouldStub = stripeMode === "stub";

      const payments: PaymentProcessorPort = shouldStub
        ? {
            createPaymentIntent: async (input) => ({
              id: `pi_e2e_${Date.now()}`,
              clientSecret: `pi_e2e_secret_${input.amountCents}`,
            }),
            refundPaymentIntent: async () => ({
              refundId: `re_e2e_${Date.now()}`,
              status: "succeeded" as const,
            }),
            cancelPaymentIntent: async () => ({ canceled: true }),
            retrievePaymentIntent: async () => ({
              id: `pi_e2e_${Date.now()}`,
              status: "succeeded",
              amountReceived: 0,
              currency: "usd",
              metadata: {},
            }),
            getProcessingFeeForPaymentIntent: async () => ({
              feeCents: 0,
              currency: "usd",
            }),
            createTransfer: async () => ({
              id: `tr_e2e_${Date.now()}`,
            }),
            getChargeIdForPaymentIntent: async () => ({
              chargeId: `ch_e2e_${Date.now()}`,
            }),
            createConnectAccount: async () => ({
              accountId: `acct_e2e_${Date.now()}`,
            }),
            createAccountOnboardingLink: async () => ({
              url: "https://connect.stripe.com/setup/e2e_stub",
            }),
            createConnectLoginLink: async () => ({
              url: "https://connect.stripe.com/express/e2e_stub",
            }),
            getConnectAccountStatus: async () => ({
              chargesEnabled: false,
              payoutsEnabled: false,
              detailsSubmitted: false,
              requirements: {
                currentlyDue: [],
                eventuallyDue: [],
                pastDue: [],
              },
            }),
            calculateTax: async () => ({
              taxAmountCents: 0,
              calculationId: null,
            }),
            getPaymentMethodType: async () => ({ methodType: "card" }),
            reverseTransfer: async () => ({
              reversalId: `trr_e2e_${Date.now()}`,
            }),
            // Unbounded capacity: the stub never models prior reversals, so
            // the remaining-capacity pre-flight in reverseTransfersForItems
            // must never clamp under it.
            getTransfer: async () => ({
              amountCents: Number.MAX_SAFE_INTEGER,
              amountReversedCents: 0,
            }),
            // No prior reversals: with unbounded capacity above, the
            // recovery path in reverseTransfersForItems is never entered.
            listTransferReversals: async () => [],
            createTerminalConnectionToken: async () => ({
              secret: `pst_e2e_${Date.now()}`,
            }),
            createTerminalLocation: async () => ({
              locationId: `tml_e2e_${Date.now()}`,
            }),
            createCardPresentPaymentIntent: async (input) => ({
              paymentIntentId: `pi_cp_e2e_${Date.now()}`,
              clientSecret: `pi_cp_e2e_secret_${input.amountCents}`,
            }),
            // Terminal reader ops are out of scope for the e2e checkout stub.
            registerTerminalReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            getTerminalReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            deleteTerminalReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            processPaymentIntentOnReader: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
            cancelReaderAction: async () => {
              throw new Error("e2e stub: terminal readers unsupported");
            },
          }
        : app.deps.trpc.payments;

      const result = await createCheckout(
        {
          ...app.deps.trpc,
          payments,
          onSettlementFailure: app.deps.trpc.onSettlementFailure ?? undefined,
          // See the matching note in `routes/e2e.ts`: transport allows a null
          // reporter, the use-case convention does not. Normalise here.
          reportError: app.deps.trpc.reportError ?? undefined,
        },
        {
          actorHumanId,
          buyerHumanId: actorHumanId,
          eventId: body.eventId,
          clientKey: body.clientKey ?? `e2e-checkout-${Date.now()}`,
          currency: body.currency ?? "usd",
          items: body.items,
        },
      );
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_checkout_failed", message });
    }
  });

  // ── Mark order items as paid out ──────────────────────────────────────
  app.post("/e2e/orders/:orderId/mark-paid-out", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    const body = (request.body ?? {}) as {
      paidOutAt?: string;
      itemIds?: string[];
    };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const paidOutAt = body.paidOutAt ? new Date(body.paidOutAt) : new Date();

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: { select: { id: true } } },
      });

      if (!order) {
        return reply.status(404).send({ ok: false, error: "order_not_found" });
      }

      const itemIdsToMark = body.itemIds?.length
        ? body.itemIds
        : order.items.map((i) => i.id);

      await prisma.orderItem.updateMany({
        where: { id: { in: itemIdsToMark } },
        data: { paidOutAt },
      });

      const updatedItems = await prisma.orderItem.findMany({
        where: { id: { in: itemIdsToMark } },
        select: { id: true, paidOutAt: true, status: true },
      });

      return reply.send({ ok: true, items: updatedItems });
    } catch (err) {
      const message = formatError(err);
      app.log.error({ err, orderId }, "e2e_mark_paid_out_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_mark_paid_out_failed",
        message,
      });
    }
  });

  // ── Cancel event (with automatic refunds) ────────────────────────────
  app.post("/e2e/events/:eventId/cancel", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { eventId } = request.params as { eventId: string };
    const body = (request.body ?? {}) as { humanId?: string };

    try {
      // Find the event's org owner to use as actor
      const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { orgId: true, humanId: true },
      });
      if (!event) {
        return reply.status(404).send({ ok: false, error: "event_not_found" });
      }

      let actorHumanId = body.humanId;
      if (!actorHumanId && event.orgId) {
        const owner = await prisma.orgMember.findFirst({
          where: { orgId: event.orgId, role: "OWNER" },
          select: { humanId: true },
        });
        actorHumanId = owner?.humanId ?? undefined;
      }
      if (!actorHumanId) {
        actorHumanId = event.humanId ?? undefined;
      }
      if (!actorHumanId) {
        return reply.status(400).send({ ok: false, error: "no_actor_found" });
      }

      const { cancelEvent } =
        await import("@th/core/use-cases/events/cancel-event");
      const result = await cancelEvent(
        {
          repos: app.deps.trpc.repos,
          authz: app.deps.trpc.authz,
          payments: app.deps.trpc.payments,
          idempotency: app.deps.trpc.idempotency,
          clock: app.deps.trpc.clock,
          logger: app.deps.trpc.logger,
          search: app.deps.trpc.multiSearch ?? undefined,
          reportError: app.deps.trpc.reportError ?? undefined,
        },
        {
          actorHumanId,
          eventId,
          clientKey: `e2e-cancel-${Date.now()}`,
        },
      );

      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_cancel_event_failed", message });
    }
  });
};

export default orderActions;
