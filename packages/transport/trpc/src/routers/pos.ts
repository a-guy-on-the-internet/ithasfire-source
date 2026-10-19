import { TRPCError } from "@trpc/server";
import {
  cancelPosReaderAction,
  cancelPosReaderActionInputSchema,
  cancelPosSale,
  cancelPosSaleInputSchema,
  getCashTillReport,
  getCashTillReportInputSchema,
  listEventCashSales,
  listEventCashSalesInputSchema,
  listEventCashSalesOutputSchema,
  completePosSale,
  completePosSaleInputSchema,
  listPosReaders,
  listPosReadersInputSchema,
  listSellableItems,
  listSellableItemsInputSchema,
  pairPosReader,
  pairPosReaderInputSchema,
  posMintConnectionToken,
  posMintConnectionTokenInputSchema,
  processPosSaleOnReader,
  processPosSaleOnReaderInputSchema,
  quotePosCart,
  quotePosCartInputSchema,
  recordCashSale,
  recordCashSaleInputSchema,
  refundCashSale,
  refundCashSaleInputSchema,
  refundPosSale,
  refundPosSaleInputSchema,
  startPosSale,
  startPosSaleInputSchema,
  unpairPosReader,
  unpairPosReaderInputSchema,
  updatePosReader,
  updatePosReaderInputSchema,
} from "@th/core/use-cases/pos";

import type { Ctx } from "../context";
import { authedProcedure, router } from "../init";
import { toTrpcError } from "../utils";

// Use cases throw `{ code, message }`; toTrpcError maps the standard codes.
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

function requireActor(ctx: { actorHumanId: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return ctx.actorHumanId;
}

// Strip actorHumanId from inputs — it is injected from ctx so clients
// cannot mint a token / sell / refund as another operator.
const connectionTokenInput = posMintConnectionTokenInputSchema.omit({
  actorHumanId: true,
});
const startSaleInput = startPosSaleInputSchema.omit({ actorHumanId: true });
const quoteCartInput = quotePosCartInputSchema.omit({ actorHumanId: true });
const completeSaleInput = completePosSaleInputSchema.omit({
  actorHumanId: true,
});
const refundRecentSaleInput = refundPosSaleInputSchema.omit({
  actorHumanId: true,
});
const recordCashSaleInput = recordCashSaleInputSchema.omit({
  actorHumanId: true,
});
const refundCashSaleInput = refundCashSaleInputSchema.omit({
  actorHumanId: true,
});
const listSellableItemsInput = listSellableItemsInputSchema.omit({
  actorHumanId: true,
});
const pairReaderInput = pairPosReaderInputSchema.omit({ actorHumanId: true });
const listReadersInput = listPosReadersInputSchema.omit({ actorHumanId: true });
const updateReaderInput = updatePosReaderInputSchema.omit({
  actorHumanId: true,
});
const unpairReaderInput = unpairPosReaderInputSchema.omit({
  actorHumanId: true,
});
const processOnReaderInput = processPosSaleOnReaderInputSchema.omit({
  actorHumanId: true,
});
const cancelReaderActionInput = cancelPosReaderActionInputSchema.omit({
  actorHumanId: true,
});
const cancelSaleInput = cancelPosSaleInputSchema.omit({ actorHumanId: true });
const cashTillReportInput = getCashTillReportInputSchema.omit({
  actorHumanId: true,
});
const eventCashSalesInput = listEventCashSalesInputSchema.omit({
  actorHumanId: true,
});

/**
 * The mail config a door cash sale needs to email a buyer their ticket and
 * receipt (`buyerEmail`), or null when this deployment has no mailer or no
 * public URL. Same sources and same support-URL fallback the volunteer comp
 * email uses (volunteer.ts).
 */
function doorReceiptMail(ctx: Ctx) {
  if (!ctx.mailer || !ctx.publicAppUrl) return null;
  const publicAppUrl = ctx.publicAppUrl.replace(/\/+$/, "");
  return {
    mailer: ctx.mailer,
    publicAppUrl,
    supportUrl: `${publicAppUrl}/support`,
    tileServerUrl: ctx.tileServerUrl ?? null,
  };
}

export const posRouter = {
  /**
   * Lists the TicketTypes a scanner-role operator may sell at the door
   * for this event. Empty result → the Sell tab hides itself client-side
   * (FR-001). Read-only; safe to refetch on tab focus.
   */
  listSellableItems: authedProcedure
    .input(listSellableItemsInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listSellableItems(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Server-side helper that mints a short-lived Stripe Terminal connection
   * token bound to the event's org Connect account. Mutation (not query)
   * so it never gets cached and so client devtools don't show it in
   * query history. See spec contracts.transport.pos.connectionToken.
   */
  connectionToken: authedProcedure
    .input(connectionTokenInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        posMintConnectionToken(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            payments: ctx.payments,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Begin a Tap to Pay sale — creates a PENDING Order + card-present
   * PaymentIntent on the platform account (D-2026-04-26 SCT model) and
   * returns the clientSecret for the Terminal SDK to confirm on-device.
   */
  startSale: authedProcedure
    .input(startSaleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        startPosSale(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
            reportError: ctx.reportError ?? undefined,
            // The same tax provider online checkout gets (createCheckout in
            // orders.ts): a door card sale is taxed by the same mechanism.
            taxRateLookup: ctx.taxRateLookup ?? null,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * The Sell screen's totals for a cart, card AND cash, before the operator
   * charges (spec 2026-10-07 door-sales FR-010): ticket, discount, platform
   * fee, processing fee, tax lines and total, from the same pricing the sale
   * charges. Read-only: no order, hold or reservation. A failed tax lookup
   * refuses with TAX_RATE_UNAVAILABLE (`meta.canEnterManualTaxRate`), as the
   * sale does.
   */
  quoteCart: authedProcedure
    .input(quoteCartInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        quotePosCart(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
            // The same tax provider the sales get, so the quote shows the tax
            // the sale charges.
            taxRateLookup: ctx.taxRateLookup ?? null,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Read-only finaliser — returns current Order state + minted tickets
   * for the SaleResultView. Safe to poll while the PaymentIntent
   * webhook is in flight.
   */
  completeSale: authedProcedure
    .input(completeSaleInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        completePosSale(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Record an in-person cash sale (FR-015). Priced by the server exactly as
   * the card till prices it, minus the processing fee (spec 2026-10-07
   * door-sales FR-003): `amountCollectedCents` only works out change, and
   * below the total the sale is refused with CASH_AMOUNT_SHORT
   * (`meta.requiredTotalCents`). `comp: true` (or 0 collected, comp unset)
   * records a $0 comp. No Stripe call, no Settlement, auto-admit inline.
   */
  recordCashSale: authedProcedure
    .input(recordCashSaleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        recordCashSale(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
            // The till has no event-level sales close, so the per-type window
            // is its only gate — its fail-open branch must be reportable.
            reportError: ctx.reportError ?? undefined,
            // The same tax provider online checkout and the card till get: a
            // door cash sale is taxed by the same mechanism.
            taxRateLookup: ctx.taxRateLookup ?? null,
            // Emails the buyer's ticket + receipt after the commit when the
            // sale carries `buyerEmail` (a card sale's goes out from the
            // payment webhook).
            receiptMail: doorReceiptMail(ctx),
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * What the door took in cash for this event — the drawer-reconciliation
   * read. Cash orders never touch Settlement, so this is the ONLY surface
   * that can answer "how much should be in the box". Read-only and cheap;
   * safe to poll while a door is running.
   */
  cashTillReport: authedProcedure
    .input(cashTillReportInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getCashTillReport(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Every cash sale of one event, newest first, keyset-paged: the Sell
   * screen's refund list (owner ruling 2026-10-08). The till's gate
   * (ORG_SCAN_ROLES); no buyer PII on a row. `canRefund` and
   * `refundableUntil` say whether to offer `orders.orgRefundCashSale`.
   */
  eventCashSales: authedProcedure
    .input(eventCashSalesInput)
    .output(listEventCashSalesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listEventCashSales(
          { repos: ctx.repos, authz: ctx.authz },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Gate refund for a POS card sale (last 15 minutes). Wraps
   * `refundFullOrder`; ORG_EDIT_ROLES required.
   */
  refundRecentSale: authedProcedure
    .input(refundRecentSaleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        refundPosSale(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
            // Refund-debit swallows must reach Sentry (Step C review).
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Gate refund for a CASH sale (last 15 minutes). No platform money moves;
   * the operator hands back what the buyer paid (ticket + tax; plus the
   * platform fee on a sale before 2026-10-08), and the sale's cash-sale
   * ledger debit is reversed as recorded. ORG_EDIT_ROLES required.
   */
  refundCashSale: authedProcedure
    .input(refundCashSaleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        refundCashSale(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Void an in-flight sale — the operator's "never mind". Cancels the order
   * AND its PaymentIntent and releases the stock, unlike `cancelReaderAction`
   * which only clears the prompt so the cart can be re-dispatched.
   */
  cancelSale: authedProcedure
    .input(cancelSaleInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        cancelPosSale(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  // ── Server-driven smart readers ───────────────────────────────────────────

  /**
   * Claims a countertop reader for an org from the code shown on its screen.
   * ORG_ADMIN_ROLES — pairing binds money-collection hardware to the org.
   */
  pairReader: authedProcedure
    .input(pairReaderInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        pairPosReader(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Reader inventory for an org. ORG_SCAN_ROLES — anyone who can run a door
   * needs the picker. `includeStatus` costs a Stripe call per reader.
   */
  listReaders: authedProcedure
    .input(listReadersInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listPosReaders(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /** Rename a reader or move its venue pin. Local metadata only. */
  updateReader: authedProcedure
    .input(updateReaderInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        updatePosReader(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /** Deregister at Stripe and drop our ownership row. ORG_ADMIN_ROLES. */
  unpairReader: authedProcedure
    .input(unpairReaderInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        unpairPosReader(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Push a started sale's PaymentIntent to a reader. The org is derived from
   * the ORDER's event, never from client input — see the use case's security
   * note.
   */
  processOnReader: authedProcedure
    .input(processOnReaderInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        processPosSaleOnReader(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            clock: ctx.clock,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /** Clear an in-flight reader prompt. Leaves the order PENDING. */
  cancelReaderAction: authedProcedure
    .input(cancelReaderActionInput)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        cancelPosReaderAction(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            payments: ctx.payments,
            logger: ctx.logger,
            metrics: ctx.metrics ?? undefined,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
};

export type PosRouter = typeof posRouter;

export const posRouterDef = router(posRouter);
