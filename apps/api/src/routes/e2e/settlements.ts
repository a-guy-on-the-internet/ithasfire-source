/**
 * E2E settlement & refund routes.
 *
 * - GET  /e2e/orders/:orderId/splits
 * - POST /e2e/settlements/create-from-order
 * - POST /e2e/settlements/run-batch
 * - GET  /e2e/payouts/:payoutId/items
 * - GET  /e2e/payees/:payeeId/ledger
 * - GET  /e2e/settlements/:settlementId
 * - GET  /e2e/orders/:orderId/settlements
 * - POST /e2e/orders/:orderId/quote-refund
 * - POST /e2e/orders/:orderId/refund
 * - GET  /e2e/orders/:orderId/settlement-details
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@th/db";
import { listOrderSplits } from "@th/core/use-cases/splits/list-order-splits";
import { createCreditsFromOrder } from "@th/core/use-cases/settlements/create-credits-from-order";
import { runPayoutBatch } from "@th/core/use-cases/settlements/run-batch";
import { getSettlement } from "@th/core/use-cases/settlements/get-settlement";
import { quoteFullRefund } from "@th/core/use-cases/orders/quote-full-refund";
import { refundFullOrder } from "@th/core/use-cases/orders/refund-full-order";
import {
  assertE2eAuthorized,
  formatError,
  extractErrorCode,
} from "./_helpers.js";

const settlements: FastifyPluginAsync = async (app) => {
  // ── Order splits ──────────────────────────────────────────────────────
  app.get("/e2e/orders/:orderId/splits", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const result = await listOrderSplits(app.deps.trpc, { orderId });
      return reply.send({
        ok: true,
        orderId: result.orderId,
        splits: result.splits,
        totalCents: result.totalCents,
      });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_splits_failed", message });
    }
  });

  // ── Create ledger credits from order ──────────────────────────────────
  app.post("/e2e/settlements/create-from-order", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as {
      orderId?: string;
      instantPayouts?: boolean;
    };
    if (!body.orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const output = await createCreditsFromOrder(
        {
          ...app.deps.trpc,
          // MATURITY BRIDGE — load-bearing for every money e2e.
          //
          // The use case reads `instantPayouts`; the tRPC context carries
          // `devInstantPayouts` (the tRPC router bridges the two names at
          // routers/settlements.ts). Spreading the context alone leaves
          // `instantPayouts` UNDEFINED, so the credit matures at
          // computePayoutDate(event.endsAt, schedule) — and the seed's event
          // defaults to tomorrow, putting maturity ~2 weeks out on the
          // default TWO_WEEKS_AFTER. Pre-cutover that was harmless because
          // the specs drove `execute-transfer` directly and bypassed
          // scheduling entirely; now they run the REAL batch, which honours
          // maturity, so an unmatured credit means the batch pays nothing
          // and the spec fails with an empty payout.
          //
          // Default TRUE (this route is non-prod, secret-guarded, and exists
          // only to make the money path drivable); pass `instantPayouts:
          // false` explicitly to exercise the maturity gate.
          instantPayouts: body.instantPayouts ?? true,
        },
        {
          orderId: body.orderId,
        },
      );
      return reply.send({
        ok: true,
        orderId: output.orderId,
        credits: output.credits,
        skippedZeroAmount: output.skippedZeroAmount,
      });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_settlement_failed", message });
    }
  });

  // ── Run the payout batch ──────────────────────────────────────────────
  //
  // The REAL production entry point, invoked in-process. Post-cutover there is
  // no per-settlement transfer to drive: money moves only through the batch,
  // off `max(0, payable)`. An e2e spec that wants a payout must therefore run
  // the batch, exactly as the nightly cron does — which is a feature, since it
  // means the specs exercise the code that actually pays organisers.
  //
  // PROCESS SCOPE (mirrors refund-mutex.ts): idempotency adapters prefix keys
  // with the composition root's namespace — `api` here, `jobs` in the cron's
  // container — so THIS batch run's claims/probes are invisible to the
  // jobs-process nightly batch and vice versa. Money stays safe regardless
  // (Stripe idempotency keys + PAYOUT-entry uniqueness are namespace-blind),
  // but a payout item this in-process run claims and abandons mid-flight is
  // NOT recoverable by the jobs sweep — it lives under the `api` namespace
  // the cron never reads. E2e-only caveat: acceptable because e2e databases
  // are reset per suite; do not copy this pattern into a prod code path.
  app.post("/e2e/settlements/run-batch", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const body = (request.body ?? {}) as { limit?: number };

    try {
      const result = await runPayoutBatch(
        {
          ...app.deps.trpc,
          reportError: app.deps.trpc.reportError ?? undefined,
        },
        { limit: body.limit ?? 100 },
      );
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = formatError(err);
      const code = extractErrorCode(err);
      app.log.error({ err }, "e2e_run_payout_batch_failed");
      return reply.status(code === "invalid_input" ? 422 : 500).send({
        ok: false,
        error: "e2e_run_payout_batch_failed",
        message,
      });
    }
  });

  // ── Payout items for a batch run ──────────────────────────────────────
  // Read-only projection so a spec can assert on ITS payee's item rather than
  // on batch totals, which a shared dev database makes unstable.
  app.get("/e2e/payouts/:payoutId/items", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { payoutId } = request.params as { payoutId: string };
    if (!payoutId) {
      return reply.status(400).send({ ok: false, error: "missing_payout_id" });
    }

    try {
      const items = await prisma.payoutItem.findMany({
        where: { payoutId },
        orderBy: { createdAt: "asc" },
      });
      return reply.send({
        ok: true,
        items: items.map((item) => ({
          id: item.id,
          payeeId: item.payeeId,
          currency: item.currency,
          amountCents: item.amountCents,
          connectAccountFeeCents: item.connectAccountFeeCents,
          reserveHeldCents: item.reserveHeldCents,
          reserveReleasedCents: item.reserveReleasedCents,
          plannedCreditEntryIds: item.plannedCreditEntryIds,
          plannedOrderItemIds: item.plannedOrderItemIds,
          plannedNetCents: item.plannedNetCents,
          payoutLedgerKey: item.payoutLedgerKey,
          stripeTransferId: item.stripeTransferId,
          status: item.status,
          failureReason: item.failureReason,
        })),
      });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_payout_items_failed", message });
    }
  });

  // ── Payee ledger entries ──────────────────────────────────────────────
  // The money's source of truth post-cutover. A spec asserting "the organiser
  // got paid" asserts HERE: the credit is consumed, and a PAYOUT entry records
  // the payable claimed.
  app.get("/e2e/payees/:payeeId/ledger", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { payeeId } = request.params as { payeeId: string };
    const { currency } = request.query as { currency?: string };
    if (!payeeId) {
      return reply.status(400).send({ ok: false, error: "missing_payee_id" });
    }

    try {
      const entries = await prisma.payeeLedgerEntry.findMany({
        where: {
          payeeId,
          ...(currency ? { currency: currency.trim().toLowerCase() } : {}),
        },
        orderBy: { createdAt: "asc" },
      });
      return reply.send({
        ok: true,
        entries: entries.map((entry) => ({
          id: entry.id,
          idempotencyKey: entry.idempotencyKey,
          type: entry.type,
          amountCents: entry.amountCents,
          currency: entry.currency,
          orderId: entry.orderId,
          availableAt: entry.availableAt?.toISOString() ?? null,
          consumedByEntryId: entry.consumedByEntryId,
          metadata: entry.metadata,
        })),
      });
    } catch (err) {
      const message = formatError(err);
      return reply
        .status(500)
        .send({ ok: false, error: "e2e_payee_ledger_failed", message });
    }
  });

  // ── Get settlement ────────────────────────────────────────────────────
  app.get("/e2e/settlements/:settlementId", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { settlementId } = request.params as { settlementId: string };
    if (!settlementId) {
      return reply
        .status(400)
        .send({ ok: false, error: "missing_settlement_id" });
    }

    try {
      const data = await getSettlement(app.deps.trpc, { settlementId });
      return reply.send({
        ok: true,
        settlement: data.settlement,
        payee: data.payee,
        lines: data.lines,
      });
    } catch (err) {
      const message = formatError(err);
      return reply.status(500).send({
        ok: false,
        error: "e2e_settlement_get_failed",
        message,
      });
    }
  });

  // ── List settlements for order ────────────────────────────────────────
  app.get("/e2e/orders/:orderId/settlements", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const lines = await prisma.settlementLine.findMany({
        where: { orderId },
        include: {
          settlement: {
            include: { payee: true, payoutTerms: true, event: true },
          },
        },
      });

      const settlementsMap = new Map<
        string,
        {
          id: string;
          payeeId: string;
          scheduledPayoutDate: Date;
          amountCents: number;
          currency: string;
          status: string;
          stripeTransferId: string | null;
          payoutTermsId: string | null;
          eventId: string | null;
          lines: Array<{
            id: string;
            amountCents: number;
            orderSplitId: string;
          }>;
        }
      >();

      for (const line of lines) {
        const s = line.settlement;
        if (!settlementsMap.has(s.id)) {
          settlementsMap.set(s.id, {
            id: s.id,
            payeeId: s.payeeId,
            scheduledPayoutDate: s.scheduledPayoutDate,
            amountCents: s.amountCents,
            currency: s.currency,
            status: s.status,
            stripeTransferId: s.stripeTransferId,
            payoutTermsId: s.payoutTermsId,
            eventId: s.eventId,
            lines: [],
          });
        }
        settlementsMap.get(s.id)!.lines.push({
          id: line.id,
          amountCents: line.amountCents,
          orderSplitId: line.orderSplitId,
        });
      }

      return reply.send({
        ok: true,
        orderId,
        settlements: Array.from(settlementsMap.values()),
      });
    } catch (err) {
      const message = formatError(err);
      return reply.status(500).send({
        ok: false,
        error: "e2e_settlements_list_failed",
        message,
      });
    }
  });

  // ── Quote refund ──────────────────────────────────────────────────────
  app.post("/e2e/orders/:orderId/quote-refund", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    const body = (request.body ?? {}) as { actorHumanId?: string };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }
    if (!body.actorHumanId) {
      return reply
        .status(400)
        .send({ ok: false, error: "missing_actor_human_id" });
    }

    try {
      const quote = await quoteFullRefund(app.deps.trpc, {
        actorHumanId: body.actorHumanId,
        orderId,
      });
      return reply.send({
        ok: true,
        orderId: quote.orderId,
        currency: quote.currency,
        amountPaidCents: quote.amountPaidCents,
        stripeFeeCents: quote.stripeFeeCents,
        refundableCents: quote.refundableCents,
      });
    } catch (err) {
      const message = formatError(err);
      const code = extractErrorCode(err);
      let status = 500;
      if (code === "not_found") status = 404;
      if (code === "conflict") status = 409;
      app.log.error({ err, orderId }, "e2e_quote_refund_failed");
      return reply.status(status).send({
        ok: false,
        error: "e2e_quote_refund_failed",
        message,
      });
    }
  });

  // ── Execute full refund ───────────────────────────────────────────────
  app.post("/e2e/orders/:orderId/refund", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    const body = (request.body ?? {}) as {
      actorHumanId?: string;
      reason?: string;
    };

    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }
    if (!body.actorHumanId) {
      return reply
        .status(400)
        .send({ ok: false, error: "missing_actor_human_id" });
    }

    try {
      const result = await refundFullOrder(app.deps.trpc, {
        actorHumanId: body.actorHumanId,
        orderId,
        reason: body.reason as
          | "requested_by_customer"
          | "fraudulent"
          | "other"
          | undefined,
      });
      return reply.send({
        ok: true,
        orderId: result.orderId,
        refundId: result.refundId,
        currency: result.currency,
        amountPaidCents: result.amountPaidCents,
        stripeFeeCents: result.stripeFeeCents,
        refundedCents: result.refundedCents,
      });
    } catch (err) {
      const message = formatError(err);
      const code = extractErrorCode(err);
      let status = 500;
      if (code === "not_found") status = 404;
      if (code === "conflict") status = 409;
      app.log.error({ err, orderId }, "e2e_refund_failed");
      return reply.status(status).send({
        ok: false,
        error: "e2e_refund_failed",
        message,
      });
    }
  });

  // ── Settlement details (item-level) ───────────────────────────────────
  app.get("/e2e/orders/:orderId/settlement-details", async (request, reply) => {
    if (!assertE2eAuthorized(request, reply)) return;

    const { orderId } = request.params as { orderId: string };
    if (!orderId) {
      return reply.status(400).send({ ok: false, error: "missing_order_id" });
    }

    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            select: {
              id: true,
              kind: true,
              qty: true,
              amountCents: true,
              paidOutAt: true,
              refundedAt: true,
              transferredAt: true,
              status: true,
            },
          },
        },
      });

      if (!order) {
        return reply.status(404).send({ ok: false, error: "order_not_found" });
      }

      const itemIds = order.items.map((i) => i.id);
      const orderItemSettlementLines =
        await prisma.orderItemSettlementLine.findMany({
          where: { orderItemId: { in: itemIds } },
          include: {
            settlementLine: {
              include: {
                settlement: {
                  select: {
                    id: true,
                    status: true,
                    amountCents: true,
                    stripeTransferId: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                },
              },
            },
          },
        });

      const orderSplits = await prisma.orderSplit.findMany({
        where: { orderId },
        include: {
          settlementLines: {
            include: {
              settlement: {
                select: {
                  id: true,
                  status: true,
                  amountCents: true,
                  stripeTransferId: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });

      return reply.send({
        ok: true,
        order: { id: order.id, status: order.status },
        items: order.items,
        orderItemSettlementLines: orderItemSettlementLines.map((oisl) => ({
          id: oisl.id,
          orderItemId: oisl.orderItemId,
          settlementLineId: oisl.settlementLineId,
          amountCents: oisl.amountCents,
          settlement: oisl.settlementLine.settlement,
        })),
        orderSplits: orderSplits.map((split) => ({
          id: split.id,
          payeeId: split.payeeId,
          amountCents: split.amountCents,
          settlementLines: split.settlementLines.map(
            (sl: {
              id: string;
              amountCents: number;
              settlement: {
                id: string;
                status: string;
                amountCents: number;
                stripeTransferId: string | null;
              };
            }) => ({
              id: sl.id,
              amountCents: sl.amountCents,
              settlement: sl.settlement,
            }),
          ),
        })),
      });
    } catch (err) {
      const message = formatError(err);
      app.log.error({ err, orderId }, "e2e_get_settlement_details_failed");
      return reply.status(500).send({
        ok: false,
        error: "e2e_get_settlement_details_failed",
        message,
      });
    }
  });
};

export default settlements;
