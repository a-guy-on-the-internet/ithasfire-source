import { TRPCError } from "@trpc/server";
import {
  createCheckout,
  createCheckoutInputSchema,
  createCheckoutOutputSchema,
} from "@th/core/use-cases/orders/create-checkout";
import { EMBED_CHECKOUT_CLIENT_KEY_PREFIX } from "@th/core/use-cases/embeds";
import {
  updateOrderItems,
  updateOrderItemsInputSchema,
  updateOrderItemsOutputSchema,
} from "@th/core/use-cases/orders/update-order-items";
import {
  listMyEventOrders,
  listMyEventOrdersInputSchema,
  listMyEventOrdersOutputSchema,
} from "@th/core/use-cases/orders/list-my-event-orders";
import {
  listMyOrders,
  listMyOrdersInputSchema,
  listMyOrdersOutputSchema,
} from "@th/core/use-cases/orders/list-my-orders";
import {
  listOrgOrders,
  listOrgOrdersInputSchema,
  listOrgOrdersOutputSchema,
} from "@th/core/use-cases/orders/list-org-orders";
import {
  staffRefundOrder,
  staffRefundOrderInputSchema,
  staffRefundOrderOutputSchema,
} from "@th/core/use-cases/orders/staff-refund-order";
import {
  getMyOrder,
  getMyOrderInputSchema,
  getMyOrderOutputSchema,
} from "@th/core/use-cases/orders/get-my-order";
import {
  listMyOrderTickets,
  listMyOrderTicketsInputSchema,
  listMyOrderTicketsOutputSchema,
} from "@th/core/use-cases/orders/list-my-order-tickets";
import {
  quoteFullRefund,
  quoteFullRefundInputSchema,
  quoteFullRefundOutputSchema,
} from "@th/core/use-cases/orders/quote-full-refund";
import {
  refundFullOrder,
  refundFullOrderInputSchema,
  refundFullOrderOutputSchema,
} from "@th/core/use-cases/orders/refund-full-order";
import {
  getRefundEligibility,
  getRefundEligibilityInputSchema,
  getRefundEligibilityOutputSchema,
} from "@th/core/use-cases/orders/get-refund-eligibility";
import {
  getActiveCartHolds,
  getActiveCartHoldsInputSchema,
  getActiveCartHoldsOutputSchema,
} from "@th/core/use-cases/orders/get-active-cart-holds";
import {
  releaseCartHold,
  releaseCartHoldInputSchema,
  releaseCartHoldOutputSchema,
} from "@th/core/use-cases/orders/release-cart-hold";
import {
  searchEventAttendees,
  searchEventAttendeesInputSchema,
  searchEventAttendeesOutputSchema,
} from "@th/core/use-cases/orders/search-event-attendees";
import {
  exportEventAttendees,
  exportEventAttendeesInputSchema,
  exportEventAttendeesOutputSchema,
} from "@th/core/use-cases/orders/export-event-attendees";
import {
  quoteItemRefund,
  quoteItemRefundInputSchema,
  quoteItemRefundOutputSchema,
} from "@th/core/use-cases/orders/quote-item-refund";
import {
  refundOrderItems,
  refundOrderItemsInputSchema,
  refundOrderItemsOutputSchema,
} from "@th/core/use-cases/orders/refund-order-items";
import {
  orgQuoteItemRefund,
  orgQuoteItemRefundInputSchema,
  orgQuoteItemRefundOutputSchema,
} from "@th/core/use-cases/orders/org-quote-item-refund";
import {
  orgRefundOrderItems,
  orgRefundOrderItemsInputSchema,
  orgRefundOrderItemsOutputSchema,
} from "@th/core/use-cases/orders/org-refund-order-items";
import {
  orgRefundFullOrder,
  orgRefundFullOrderInputSchema,
  orgRefundFullOrderOutputSchema,
} from "@th/core/use-cases/orders/org-refund-full-order";
import {
  orgRefundCashSale,
  orgRefundCashSaleInputSchema,
  orgRefundCashSaleOutputSchema,
} from "@th/core/use-cases/pos/org-refund-cash-sale";
import {
  getOrgOrder,
  getOrgOrderInputSchema,
  getOrgOrderOutputSchema,
} from "@th/core/use-cases/orders/get-org-order";
import {
  getOwnerPayoutSummary,
  getOwnerPayoutSummaryInputSchema,
  getOwnerPayoutSummaryOutputSchema,
} from "@th/core/use-cases/orders/get-owner-payout-summary";
import {
  confirmPayment,
  confirmPaymentInputSchema,
  confirmPaymentOutputSchema,
} from "@th/core/use-cases/orders/confirm-payment";
import {
  requestAdminExport,
  requestAdminExportInputSchema,
  requestAdminExportOutputSchema,
} from "@th/core/use-cases/exports/request-admin-export";
import {
  migrateEventOrders,
  migrateEventOrdersInputSchema,
  migrateEventOrdersOutputSchema,
} from "@th/core/use-cases/orders/migrate-event-orders";
import {
  sendMigrationNotification,
  sendMigrationNotificationInputSchema,
  sendMigrationNotificationOutputSchema,
} from "@th/core/use-cases/orders/send-migration-notification";
import { ensureEmailVerified } from "@th/core/use-cases/_helpers/ensure-email-verified";
import {
  recordApplicationGrantUnlock,
  recordInviteGrantUnlock,
  recordVerifiedEventPasswordUnlock,
} from "@th/core/use-cases/events";

import { authedProcedure, verifiedEmailProcedure } from "../init";
import { isActorEmailVerified } from "../verified-email";
import { rateLimit } from "../guard";
import { toTrpcError } from "../utils";
import { postJobToJobsService } from "../jobs-service-request";
import {
  readEventApplicationGrantCookie,
  readEventInviteGrantCookie,
  verifyEventUnlockCookie,
} from "../event-unlock-cookie";
import type { Ctx } from "../context";

const createCheckoutInput = createCheckoutInputSchema.omit({
  actorHumanId: true,
  buyerHumanId: true,
  // Internal-only payment surface policy. Normal clients must not toggle the
  // redirect-method set or bank debit; embed checkout pins both server-side
  // instead.
  allowRedirectPaymentMethods: true,
  allowBankDebit: true,
  // Internal-only credit policy: the main checkout always applies the
  // buyer's credit (the default); only the embed guest checkout turns it
  // off, server-side. A client must not choose.
  applyPlatformCredit: true,
  // Internal-only server-observed client IP / user agent for acceptance
  // evidence (Order stamps + AcceptanceRecord ledger rows).
  requestIp: true,
  requestUserAgent: true,
}).extend({
  // `embed:` is the embed checkout's idempotency namespace
  // (create-embed-guest-checkout.ts). The guest is resolved by email, so it
  // can be the same human as a signed-in buyer; a main-site key in that
  // namespace could replay or block the embed's stored checkout. Web and
  // mobile send a UUID.
  clientKey: createCheckoutInputSchema.shape.clientKey.refine(
    (key) => !key.startsWith(EMBED_CHECKOUT_CLIENT_KEY_PREFIX),
    { message: "clientKey uses a reserved prefix" },
  ),
});
const updateOrderItemsInput = updateOrderItemsInputSchema.omit({
  actorHumanId: true,
});
const listOrgOrdersInput = listOrgOrdersInputSchema.omit({
  actorHumanId: true,
});
const listMyEventOrdersInput = listMyEventOrdersInputSchema.omit({
  actorHumanId: true,
});
const listMyOrdersInput = listMyOrdersInputSchema.omit({ actorHumanId: true });
const staffRefundOrderInput = staffRefundOrderInputSchema.omit({
  actorHumanId: true,
});
const getMyOrderInput = getMyOrderInputSchema.omit({ actorHumanId: true });
const listMyOrderTicketsInput = listMyOrderTicketsInputSchema.omit({
  actorHumanId: true,
});
const quoteFullRefundInput = quoteFullRefundInputSchema.omit({
  actorHumanId: true,
});
const refundFullOrderInput = refundFullOrderInputSchema.omit({
  actorHumanId: true,
});
const getRefundEligibilityInput = getRefundEligibilityInputSchema.omit({
  actorHumanId: true,
});
const getActiveCartHoldsInput = getActiveCartHoldsInputSchema.omit({
  actorHumanId: true,
});
const releaseCartHoldInput = releaseCartHoldInputSchema.omit({
  actorHumanId: true,
});
const searchEventAttendeesInput = searchEventAttendeesInputSchema.omit({
  actorHumanId: true,
});
const exportEventAttendeesInput = exportEventAttendeesInputSchema.omit({
  actorHumanId: true,
});
const quoteItemRefundInput = quoteItemRefundInputSchema.omit({
  actorHumanId: true,
});
const refundOrderItemsInput = refundOrderItemsInputSchema.omit({
  actorHumanId: true,
});
const orgQuoteItemRefundInput = orgQuoteItemRefundInputSchema.omit({
  actorHumanId: true,
});
const orgRefundOrderItemsInput = orgRefundOrderItemsInputSchema.omit({
  actorHumanId: true,
});
const orgRefundFullOrderInput = orgRefundFullOrderInputSchema.omit({
  actorHumanId: true,
});
const orgRefundCashSaleInput = orgRefundCashSaleInputSchema.omit({
  actorHumanId: true,
});
const getOrgOrderInput = getOrgOrderInputSchema.omit({ actorHumanId: true });
const getOwnerPayoutSummaryInput = getOwnerPayoutSummaryInputSchema.omit({
  actorHumanId: true,
});
const confirmPaymentInput = confirmPaymentInputSchema.omit({
  actorHumanId: true,
});
const requestAdminExportInput = requestAdminExportInputSchema.omit({
  actorHumanId: true,
});
const migrateEventOrdersInput = migrateEventOrdersInputSchema.omit({
  actorHumanId: true,
});
const sendMigrationNotificationInput =
  sendMigrationNotificationInputSchema.omit({
    actorHumanId: true,
    publicAppUrl: true,
  });

/**
 * Converts a signed anonymous gate cookie into the buyer's durable unlock so
 * `ensureEventAccessible` passes. The cookies only reach this API when web and
 * API share a host (local dev); in prod the web `sync-unlock` route does the
 * same thing before the buyer's checkout calls.
 *
 * Application grant first, through core: it persists only for the subject of
 * a still-APPROVED submission on an APPLICATION-gated event and otherwise
 * returns `persisted: false` without throwing — checkout's own gate then
 * refuses with FORBIDDEN.
 *
 * Then the invite grant (`th_ei_`), through core's
 * `recordInviteGrantUnlock`, on either gate type, with the same
 * `persisted: false` contract.
 *
 * When the grant did not persist (or there was none), a valid password cookie
 * is tried next, but ONLY on a PASSWORD-gated event. The grant itself is never
 * handed to the password path: that path reads only `th_eu_`. On any other
 * gate a stale `th_eu_` is ignored, so the buyer gets checkout's clean
 * FORBIDDEN rather than `recordVerifiedEventPasswordUnlock`'s
 * EVENT_NOT_PASSWORD_GATED. On a PASSWORD event the path is unchanged.
 */
async function persistSignedEventUnlockIfPresent(
  ctx: Ctx,
  eventId: string,
  actorHumanId: string,
): Promise<void> {
  const grant = readEventApplicationGrantCookie(ctx, eventId);
  if (grant) {
    const result = await recordApplicationGrantUnlock(
      {
        repos: ctx.repos,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      },
      {
        eventId,
        submissionId: grant.submissionId,
        approvedAtMs: grant.approvedAtMs,
        humanId: actorHumanId,
      },
    );
    if (result.persisted) return;
  }

  // Invite grant (`th_ei_`, gated-event invite links R3): the durable grant
  // the buyer would have got redeeming the link signed in. Core applies the
  // cookie's rule (SHARED survives a reset, PERSONAL dies on revoke, both
  // die at event end) and returns `persisted: false` instead of throwing.
  const inviteGrant = readEventInviteGrantCookie(ctx, eventId);
  if (inviteGrant) {
    const result = await recordInviteGrantUnlock(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      { eventId, viewerHumanId: actorHumanId, inviteGrant },
    );
    if (result.persisted) return;
  }

  if (!verifyEventUnlockCookie(ctx, eventId)) return;

  const event = await ctx.repos.events.getById(eventId);
  if (event?.gateType !== "PASSWORD") return;

  await recordVerifiedEventPasswordUnlock(
    { repos: ctx.repos, logger: ctx.logger },
    { eventId, humanId: actorHumanId },
  );
}

export const ordersRouter = {
  createCheckout: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `order:createCheckout:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "creating checkouts",
      }),
    )
    .input(createCheckoutInput)
    .output(createCheckoutOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.enableBuyTickets === false) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Ticket purchasing is currently disabled",
        });
      }

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Free claims + fully credit-covered orders complete inline (no Stripe
        // webhook), so the buyer in-app confirmation is fired from the use case
        // rather than the finalize/webhook path.
        notify: ctx.notify,
        // Fully credit-covered orders create settlements directly (no Stripe
        // webhook). Thread the dev instant-payout flag through exactly as the
        // finalize-from-payment-intent path does.
        devInstantPayouts: ctx.devInstantPayouts,
        // ...and surface the same settlement-failure alerter the webhook
        // finalize path uses. The credit-covered path has no webhook DLQ
        // backstop, so a settlement-creation failure here would otherwise be
        // invisible to operators.
        onSettlementFailure: ctx.onSettlementFailure ?? undefined,
        // Last-chance admission-tax lookup when the event was never stamped at
        // publish time. Self-heals the event; non-blocking.
        taxRateLookup: ctx.taxRateLookup ?? null,
        // The tax resolver's deliberate swallows report through this. Without
        // it they are invisible — and one of them decides what the buyer pays.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createCheckout>[0];

      try {
        await ensureEmailVerified(ctx.repos, actorHumanId);
        await persistSignedEventUnlockIfPresent(
          ctx,
          input.eventId,
          actorHumanId,
        );
        // Hard-pin buyerHumanId to the authenticated actor to prevent
        // impersonation. The client must never control who the order is
        // attributed to.
        return await createCheckout(deps, {
          ...input,
          actorHumanId,
          buyerHumanId: actorHumanId,
          requestIp: ctx.clientIp,
          requestUserAgent: ctx.userAgent,
        });
      } catch (err) {
        ctx.logger?.error("createCheckout.failed", {
          actorHumanId,
          eventId: input.eventId,
          error: err instanceof Error ? err.message : JSON.stringify(err),
        });
        throw toTrpcError(err);
      }
    }),

  updateOrderItems: authedProcedure
    .input(updateOrderItemsInput)
    .output(updateOrderItemsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.enableBuyTickets === false) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Ticket purchasing is currently disabled",
        });
      }

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Last-chance admission-tax lookup when the event was never stamped at
        // publish time. Self-heals the event; non-blocking, 0 on failure.
        taxRateLookup: ctx.taxRateLookup ?? null,
        // Reaches the sales-window guard, whose ONE fail-open branch (an
        // unparseable window bound) would otherwise be invisible.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof updateOrderItems>[0];

      try {
        await ensureEmailVerified(ctx.repos, actorHumanId);
        await persistSignedEventUnlockIfPresent(
          ctx,
          input.eventId,
          actorHumanId,
        );
        return await updateOrderItems(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listOrgOrders: authedProcedure
    .input(listOrgOrdersInput)
    .output(listOrgOrdersOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listOrgOrders>[0];

      try {
        return await listOrgOrders(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listMyEventOrders: authedProcedure
    .input(listMyEventOrdersInput)
    .output(listMyEventOrdersOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listMyEventOrders>[0];

      try {
        return await listMyEventOrders(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getMyOrder: verifiedEmailProcedure
    .input(getMyOrderInput)
    .output(getMyOrderOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
      } satisfies Parameters<typeof getMyOrder>[0];

      try {
        return await getMyOrder(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listMyOrders: verifiedEmailProcedure
    .input(listMyOrdersInput)
    .output(listMyOrdersOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
      } satisfies Parameters<typeof listMyOrders>[0];

      try {
        return await listMyOrders(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listMyOrderTickets: verifiedEmailProcedure
    .input(listMyOrderTicketsInput)
    .output(listMyOrderTicketsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
      } satisfies Parameters<typeof listMyOrderTickets>[0];

      try {
        return await listMyOrderTickets(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  staffRefundOrder: authedProcedure
    .input(staffRefundOrderInput)
    .output(staffRefundOrderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        authz: ctx.authz,
        logger: ctx.logger,
        notify: ctx.notify,
        publicAppUrl: ctx.publicAppUrl,
        // Refund-debit swallows must reach Sentry (Step C review, BLOCKING).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof staffRefundOrder>[0];

      try {
        return await staffRefundOrder(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Quote what a buyer would receive if they request a refund for their order.
   * Returns the original amount paid and the refundable amount (after Stripe fee deduction).
   */
  quoteFullRefund: verifiedEmailProcedure
    .meta({ description: "Preview refund amount for buyer's own order" })
    .input(quoteFullRefundInput)
    .output(quoteFullRefundOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        // Refund-window check judges "now" on the injected clock, same as
        // the refundFullOrder mutation below.
        clock: ctx.clock,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof quoteFullRefund>[0];

      try {
        return await quoteFullRefund(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Execute a refund for the buyer's own order.
   * The buyer receives their payment minus Stripe's processing fee.
   */
  refundFullOrder: verifiedEmailProcedure
    .meta({ description: "Request refund for buyer's own order" })
    .input(refundFullOrderInput)
    .output(refundFullOrderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        notify: ctx.notify,
        publicAppUrl: ctx.publicAppUrl,
        // Refund-debit swallows (no_credits_for_order / clamp drift) must
        // reach Sentry — a refund with no ledger debit is a live revenue-
        // accounting gap (Step C review, BLOCKING).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof refundFullOrder>[0];

      try {
        return await refundFullOrder(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Get comprehensive refund eligibility info for a buyer's order.
   * Includes event timing, refund window, fee breakdown, and explanation.
   */
  getRefundEligibility: verifiedEmailProcedure
    .meta({
      description:
        "Check refund eligibility with full details for buyer's order",
    })
    .input(getRefundEligibilityInput)
    .output(getRefundEligibilityOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getRefundEligibility>[0];

      try {
        return await getRefundEligibility(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Get active cart holds for the current user.
   * Returns pending orders with non-expired ticket holds for cart recovery.
   */
  getActiveCartHolds: authedProcedure
    .meta({ description: "Get active cart holds for cart recovery" })
    .input(getActiveCartHoldsInput)
    .output(getActiveCartHoldsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof getActiveCartHolds>[0];

      try {
        // Ambient (cart recovery on every page): an unverified account cannot
        // check out, so any held cart on it is a guest's embed checkout
        // attached by email (B2). Answer "no carts" rather than throw.
        if (!(await isActorEmailVerified(ctx, actorHumanId))) {
          return { carts: [] };
        }
        return await getActiveCartHolds(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Release a cart hold explicitly.
   * Used by sendBeacon on page close to immediately release ticket holds.
   */
  releaseCartHold: verifiedEmailProcedure
    .meta({ description: "Release a cart hold (cancel pending order)" })
    .input(releaseCartHoldInput)
    .output(releaseCartHoldOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // REQUIRED in practice. Without a processor this use case refuses to
        // release any cart that carries a PaymentIntent, because it cannot
        // prove the PI is dead and de-holding under a live one is a
        // charge-with-no-ticket. It was omitted here until now, so the PI was
        // never cancelled on this path at all.
        payments: ctx.payments,
        // The refusal branches swallow; `logger.warn` is not captured.
        reportError: ctx.reportError,
      } satisfies Parameters<typeof releaseCartHold>[0];

      try {
        return await releaseCartHold(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Search ticket buyers for a specific event by name or email.
   * Used by organizers to verify attendees at the door or look up orders.
   */
  searchEventAttendees: authedProcedure
    .meta({ description: "Search event attendees by name or email" })
    .input(searchEventAttendeesInput)
    .output(searchEventAttendeesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof searchEventAttendees>[0];

      try {
        return await searchEventAttendees(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * CSV-shaped export of the attendee list for one event.
   *
   * Separate from `searchEventAttendees` on purpose: the paged read is
   * edit-or-finance, this is FINANCE ONLY, and it writes an audit entry.
   * Taking a copy of buyer names and emails is a narrower right than reading
   * the same rows on screen, and it is one we record.
   */
  exportEventAttendees: authedProcedure
    .meta({ description: "Export event attendees as rows for CSV" })
    .input(exportEventAttendeesInput)
    .output(exportEventAttendeesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof exportEventAttendees>[0];

      try {
        return await exportEventAttendees(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Quote the refund for specific order items (per-ticket granularity).
   * Returns a per-item breakdown with eligibility, fees, and refundable amounts.
   */
  quoteItemRefund: verifiedEmailProcedure
    .meta({ description: "Quote per-item refund for selected tickets" })
    .input(quoteItemRefundInput)
    .output(quoteItemRefundOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        logger: ctx.logger,
        // Same clock as the display query and the refund mutations, so the
        // three surfaces judge the refund window on one instant.
        clock: ctx.clock,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof quoteItemRefund>[0];

      try {
        return await quoteItemRefund(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Refund specific order items (individual tickets) within an order.
   * Issues a partial Stripe refund and marks the selected items + tickets as refunded.
   */
  refundOrderItems: verifiedEmailProcedure
    .meta({ description: "Refund selected order items (per-ticket)" })
    .input(refundOrderItemsInput)
    .output(refundOrderItemsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        notify: ctx.notify,
        // See refundFullOrder above — same swallow-visibility requirement.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof refundOrderItems>[0];

      try {
        return await refundOrderItems(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Org-admin variant of quoteItemRefund. Authorizes ORG_FINANCE on the org
   * and verifies the order belongs to the org before quoting. Used by the
   * admin Orders page so org admins (not just the buyer) can quote refunds.
   */
  orgQuoteItemRefund: authedProcedure
    .meta({ description: "Quote per-item refund as an org admin" })
    .input(orgQuoteItemRefundInput)
    .output(orgQuoteItemRefundOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        authz: ctx.authz,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof orgQuoteItemRefund>[0];

      try {
        return await orgQuoteItemRefund(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Org-admin variant of refundOrderItems. Authorizes ORG_FINANCE on the org
   * and verifies the order belongs to the org, then issues the item refund via
   * the shared core. A note is required for the audit trail.
   */
  orgRefundOrderItems: authedProcedure
    .meta({ description: "Refund selected order items as an org admin" })
    .input(orgRefundOrderItemsInput)
    .output(orgRefundOrderItemsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        authz: ctx.authz,
        logger: ctx.logger,
        notify: ctx.notify,
        // Refund-debit swallows must reach Sentry (Step C review, BLOCKING).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof orgRefundOrderItems>[0];

      try {
        return await orgRefundOrderItems(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Org-admin variant of refundFullOrder. Authorizes ORG_FINANCE on the org
   * and verifies the order belongs to the org, then issues the whole-order
   * refund via the shared core. The org's only path to refund a RESALE order
   * (item refunds refuse RESALE; only the full refund performs the resale
   * unwind). A note is required for the audit trail.
   */
  orgRefundFullOrder: authedProcedure
    .meta({ description: "Refund a whole order as an org admin" })
    .input(orgRefundFullOrderInput)
    .output(orgRefundFullOrderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        authz: ctx.authz,
        logger: ctx.logger,
        notify: ctx.notify,
        publicAppUrl: ctx.publicAppUrl,
        // Refund-debit swallows must reach Sentry.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof orgRefundFullOrder>[0];

      try {
        return await orgRefundFullOrder(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Refund a door cash sale (or comp) as an Owner, Admin, Editor or Finance
   * member of the org (`ORG_CASH_REFUND_ROLES`), until 7 days after the
   * event ends (CASH_REFUND_WINDOW_CLOSED after;
   * platform admins are not bound) — the till's own refund stops after 15
   * minutes. No
   * platform money moves: the organiser hands the cash back, and the sale's
   * platform fee + tax stop being owed (its cash-sale ledger debit is
   * reversed). Card orders are refused (NOT_A_CASH_ORDER); they use
   * `orgRefundFullOrder`. Idempotent.
   */
  orgRefundCashSale: authedProcedure
    .meta({
      description:
        "Refund a door cash sale as an org owner, admin, editor or finance member",
    })
    .input(orgRefundCashSaleInput)
    .output(orgRefundCashSaleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        // Platform admins may refund past the org's 7-day window (audited).
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        metrics: ctx.metrics ?? undefined,
        // The per-item tax allocation's mismatch report must reach Sentry.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof orgRefundCashSale>[0];

      try {
        return await orgRefundCashSale(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Get a single order with items for an org admin.
   * Requires FINANCE role on the org.
   */
  getOrgOrder: authedProcedure
    .meta({ description: "Get order detail for org admin" })
    .input(getOrgOrderInput)
    .output(getOrgOrderOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
        reportError: ctx.reportError ?? null,
      } satisfies Parameters<typeof getOrgOrder>[0];

      try {
        return await getOrgOrder(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Pending-payout headline for an owner (org or human): what the LEDGER says
   * they are owed, matured or not. NOT gross ticket face value — see the use
   * case header for what that number used to be and why it overstated.
   *
   * `pendingPayoutCents` / `pendingItemCount` are NULLABLE: null means the
   * ledger read degraded, and the caller must render "could not check"
   * rather than zero.
   */
  getOwnerPayoutSummary: authedProcedure
    .meta({ description: "Get pending payout summary for owner" })
    .input(getOwnerPayoutSummaryInput)
    .output(getOwnerPayoutSummaryOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
        // The use case SWALLOWS a failed ledger read and degrades to
        // `resolved: false`, so the failure reaches Sentry only through here
        // (ReporterPort convention, CLAUDE.md).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getOwnerPayoutSummary>[0];

      try {
        return await getOwnerPayoutSummary(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Client-side payment confirmation.
   *
   * After `stripe.confirmCardPayment()` succeeds on the client, call this
   * mutation so the server can verify the PaymentIntent status with Stripe
   * and finalize the order immediately (instant UX). The Stripe webhook
   * remains active as a fallback.
   */
  confirmPayment: authedProcedure
    // Every call is a live Stripe retrieve, and the PaymentIntent id is
    // caller-chosen: bound it per buyer, the same 10/60s budget as
    // `createCheckout` (a real checkout confirms once). Runs before `.input()`;
    // the limiter does not read the payload.
    .use(
      rateLimit({
        key: (ctx) => `order:confirmPayment:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "confirming payments",
      }),
    )
    .input(confirmPaymentInput)
    .output(confirmPaymentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        notify: ctx.notify,
        reportError: ctx.reportError ?? undefined,
        // Dev/e2e credit maturity: without this, the client-confirm path
        // (the common local-dev path, no Stripe CLI) writes credits with
        // real payout dates and nothing pays in dev (Step B review NIT).
        devInstantPayouts: ctx.devInstantPayouts,
      } satisfies Parameters<typeof confirmPayment>[0];

      try {
        return await confirmPayment(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  requestExport: authedProcedure
    .input(requestAdminExportInput)
    .output(requestAdminExportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      if (!ctx.jobsServiceUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Background exports are not available (jobs service not configured)",
        });
      }

      const jobsBaseUrl = ctx.jobsServiceUrl;

      const enqueueJob = async (
        jobName: string,
        payload: unknown,
      ): Promise<void> => {
        // API key header + Google OIDC token: a bare `Bearer <api key>`
        // never gets past Cloud Run IAM (see jobs-service-request.ts).
        const res = await postJobToJobsService(jobsBaseUrl, jobName, payload);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to enqueue export job: ${res.status} ${body}`,
          });
        }
      };

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
        enqueueJob,
      } satisfies Parameters<typeof requestAdminExport>[0];

      try {
        return await requestAdminExport(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  migrateEventOrders: authedProcedure
    .input(migrateEventOrdersInput)
    .output(migrateEventOrdersOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof migrateEventOrders>[0];

      try {
        return await migrateEventOrders(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  sendMigrationNotification: authedProcedure
    .input(sendMigrationNotificationInput)
    .output(sendMigrationNotificationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      if (!ctx.mailer) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Mailer not configured",
        });
      }

      const publicAppUrl = ctx.publicAppUrl ?? "";

      const deps = {
        repos: ctx.repos,
        mailer: ctx.mailer,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof sendMigrationNotification>[0];

      try {
        return await sendMigrationNotification(deps, {
          ...input,
          actorHumanId,
          publicAppUrl,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type OrdersRouter = typeof ordersRouter;
