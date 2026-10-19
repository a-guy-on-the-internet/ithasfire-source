import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord, OrderSource } from "@th/ports/repos/orders";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { abandonClaim } from "../../lib/idempotency-claim";
// The AMOUNT_MISMATCH guard below MUST agree with what the refund quotes treat
// as "what the buyer paid" — this file used to carry a private copy of the same
// name, which shadowed the shared helper and had already drifted (it skipped the
// clamp, so a credit-heavy order could produce a negative expected amount here
// while every refund path clamped to 0).
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { computeOrderSplits } from "../../lib/pricing/compute-order-splits";
import { SALE_ORGANISER_CREDIT } from "../../lib/pricing/compute-ticket-price-for-agreement";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { createCreditsFromOrder } from "../settlements/create-credits-from-order";
import { mintTicketsForOrder } from "../tickets/mint-tickets";
import { finalizeResalePurchase } from "../resale/finalize-resale-purchase";
import {
  mergeSellerIntoSplits,
  reportResaleSellerPlaceholder,
  resolveResaleSellerSplit,
} from "../resale/resolve-resale-seller-split";
import { recordAttribution } from "./record-attribution";
import { notifyBuyer, type NotifyFn } from "./notify-buyer";
import { fail } from "@th/errors";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import {
  releaseRetiredCartHolds,
  settleCarriedOverCartPaymentIntent,
} from "./_shared/retire-carried-over-cart";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

// Stripe metadata values are always strings. Older payment intents may be
// missing newer keys entirely, and Stripe CLI replays can include empty
// strings ("") for any field. `.catch(undefined)` on optional fields lets
// the use case fall back to DB-derived values instead of hard-failing.
const stripeMetadataSchema = z
  .object({
    orderId: z.uuid(),
    eventId: z.uuid().optional().catch(undefined),
    source: z.enum(["primary", "resale"]).optional().catch(undefined),
    // POS Tap to Pay PIs (spec FR-013) carry the operator's humanId so
    // auto-admit TicketScan rows can be attributed to the actual seller.
    actorHumanId: z.uuid().optional().catch(undefined),
  })
  .passthrough();

const paymentIntentObjectSchema = z
  .object({
    id: z.string().min(8),
    status: z.literal("succeeded"),
    amount_received: z.number().int().nonnegative(),
    currency: z.string().min(3),
    metadata: stripeMetadataSchema,
  })
  .passthrough();

const stripeEventSchema = z.object({
  id: z.string().min(8),
  type: z.literal("payment_intent.succeeded"),
  data: z.object({ object: paymentIntentObjectSchema }),
});

export const finalizePaymentIntentInputSchema = z.object({
  stripeEvent: stripeEventSchema,
});

export const finalizePaymentIntentOutputSchema = z.object({
  ok: z.literal(true),
  orderId: z.uuid(),
});

export type FinalizePaymentIntentInput = z.infer<
  typeof finalizePaymentIntentInputSchema
>;
export type FinalizePaymentIntentOutput = z.infer<
  typeof finalizePaymentIntentOutputSchema
>;

export type FinalizePaymentIntentDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Multi-channel notification dispatcher. Optional — when present the buyer
   * receives a fire-and-forget in-app (+ push) confirmation after the order is
   * durably finalized. A notify outage never fails or rolls back the order.
   */
  notify?: NotifyFn;
  /** When true, ledger credits mature immediately (dev/test only). */
  devInstantPayouts?: boolean;
  /** Best-effort alert when ledger-credit creation fails. Swallow errors. */
  onSettlementFailure?: (ctx: { orderId: string; error: string }) => void;
  /**
   * Sentry reporter for the deliberate swallow below: a failed ledger-credit
   * write is logged-and-continued (recovery via `settlements.createFromOrder`),
   * and that swallow must be visible in Sentry, not just the logs. Accepts
   * `null` so the API composition root's `TrpcDeps` (whose `reportError` is
   * nullable) can be spread straight in.
   */
  reportError?: ReporterPort | null;
  /**
   * Needed ONLY to settle a stale sibling cart's PaymentIntent when this
   * order succeeds (see `cancelStalePendingCarts`). Without it, retirement
   * REFUSES and the sibling stays PENDING — the safe direction, because a
   * cancelled order under a still-confirmable PI is exactly the "buyer pays
   * and gets nothing" failure this exists to prevent.
   */
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  > | null;
};

interface StoredFinalizeRecord {
  response: FinalizePaymentIntentOutput;
  paymentIntentId: string;
}

export async function finalizePaymentIntent(
  deps: FinalizePaymentIntentDeps,
  rawInput: unknown,
): Promise<FinalizePaymentIntentOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "finalizePaymentIntent" });

  const execute = async () => {
    const input = parseInput(finalizePaymentIntentInputSchema, rawInput);
    const { stripeEvent } = input;
    const paymentIntent = stripeEvent.data.object;
    const metadata = paymentIntent.metadata;

    const idempotencyKey = buildIdempotencyKey(stripeEvent.id);

    const cached =
      await deps.idempotency.get<StoredFinalizeRecord>(idempotencyKey);
    if (cached) {
      if (cached.paymentIntentId !== paymentIntent.id) {
        throw fail("STRIPE_EVENT_CONFLICT");
      }
      scopedLogger?.info("finalizePaymentIntent.replay_cached", {
        orderId: cached.response.orderId,
        paymentIntentId: cached.paymentIntentId,
      });
      return cached.response;
    }

    // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
    const claimOwnerToken = randomUUID();
    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_KEY_TTL_SECONDS,
      claimOwnerToken,
    );
    if (!claimed) {
      const replay =
        await deps.idempotency.get<StoredFinalizeRecord>(idempotencyKey);
      if (replay) {
        if (replay.paymentIntentId !== paymentIntent.id) {
          throw fail("STRIPE_EVENT_CONFLICT");
        }
        return replay.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    scopedLogger?.info("finalizePaymentIntent.begin", {
      orderId: metadata.orderId,
      paymentIntentId: paymentIntent.id,
    });

    try {
      const result = await finalizePaymentIntentInternal(
        deps,
        scopedLogger,
        stripeEvent,
      );

      await deps.idempotency.commit<StoredFinalizeRecord>(
        idempotencyKey,
        {
          response: result,
          paymentIntentId: paymentIntent.id,
        },
        IDEMPOTENCY_KEEP_SECONDS,
      );

      return result;
    } catch (error) {
      await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
        useCase: "finalizePaymentIntent",
        logger: deps.logger ?? null,
        reportError: deps.reportError ?? null,
      });
      throw asKnownError("finalize_from_payment_intent", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("finalizePaymentIntent", execute);
  }

  return execute();
}

async function finalizePaymentIntentInternal(
  deps: FinalizePaymentIntentDeps,
  logger: LoggerPort | undefined,
  stripeEvent: z.infer<typeof stripeEventSchema>,
): Promise<FinalizePaymentIntentOutput> {
  const paymentIntent = stripeEvent.data.object;
  const metadata = paymentIntent.metadata;
  const orderId = metadata.orderId;
  const paymentIntentId = paymentIntent.id;
  const amountReceived = paymentIntent.amount_received;
  const sourceHint = toOrderSource(metadata.source);

  const outcome = await deps.repos.tx(async (tx) => {
    const order = await tx.orders.getById(orderId);
    if (!order) {
      throw fail("ORDER_NOT_FOUND");
    }

    const event = await tx.events.getById(requireTicketingEventId(order));
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (metadata.eventId && metadata.eventId !== order.eventId) {
      throw fail("EVENT_MISMATCH");
    }

    const normalizedPaymentCurrency = (
      paymentIntent.currency ?? ""
    ).toLowerCase();
    const normalizedOrderCurrency = order.currency.toLowerCase();
    if (normalizedPaymentCurrency !== normalizedOrderCurrency) {
      throw {
        code: "invalid_input",
        message: "currency_mismatch",
        expectedCurrency: order.currency,
        paymentCurrency: paymentIntent.currency,
      } as const;
    }

    // Orders in a terminal state cannot be finalized.
    // PENDING and PROCESSING are both valid: PENDING is the normal card flow;
    // PROCESSING is the delayed-notification flow (ACH, bank transfer) where
    // the webhook already marked the order PROCESSING and now payment_intent.succeeded
    // has arrived confirming settlement.
    const statusLower = order.status;
    if (
      statusLower === "CANCELLED" ||
      statusLower === "REFUNDED" ||
      statusLower === "PART_REFUNDED" ||
      statusLower === "DISPUTED"
    ) {
      throw fail("ORDER_NOT_PROCESSABLE");
    }

    if (statusLower === "PROCESSING") {
      logger?.info("finalizePaymentIntent.processing_order_settled", {
        orderId: order.id,
        paymentIntentId,
      });
    }

    if (
      order.stripePaymentIntentId &&
      order.stripePaymentIntentId !== paymentIntentId
    ) {
      throw fail("PAYMENT_INTENT_MISMATCH");
    }

    const expectedAmount = computeExpectedPaymentAmount(order);
    if (amountReceived !== expectedAmount) {
      throw fail("AMOUNT_MISMATCH");
    }

    // ONE source of truth for "is this a resale order": the order row. Only a
    // RESALE row carries the pricing snapshot and listing the seller split
    // needs, and the mint/transfer branch below reads it too. The Stripe
    // metadata `source` is a hint written by the same checkout; a
    // disagreement is reported after commit, never acted on (it used to pick
    // the payout terms, so a mismatched hint could split a resale order over
    // PRIMARY terms or vice versa).
    const isResaleOrder = order.source === "RESALE";
    const sourceHintMismatch =
      sourceHint !== undefined && sourceHint !== order.source
        ? { sourceHint, orderSource: order.source }
        : null;

    // PRIMARY terms resolve here, as before. RESALE terms resolve below, off
    // the LISTING (the same terms checkout priced against), once the seller
    // split has loaded it.
    const primaryTerms = isResaleOrder
      ? null
      : await loadSettlementPrimaryPayoutTerms(
          tx,
          requireTicketingEventId(order),
        );

    // Replay of an order that is already SUCCEEDED (a re-delivered webhook,
    // or the client confirm racing the webhook). Checked BEFORE the link CAS:
    // that CAS only matches PENDING/PROCESSING, so a SUCCEEDED row with no PI
    // (legacy, or a swallowed P2002 from the old unconditional link) would
    // otherwise lose it and be refused although it is fully paid and minted.
    // Everything above (event, currency, PI mismatch, amount) still ran.
    if (order.status === "SUCCEEDED") {
      logger?.info("finalizePaymentIntent.replay_order", {
        orderId: order.id,
        paymentIntentId,
      });
      return replayedFinalize(order);
    }

    // Link the PI to this order if not already linked.
    // Skip if another order already owns this PI (e.g. from a previous
    // cancelled attempt) — the current order proceeds without a PI link
    // but won't be refundable via Stripe.
    //
    // The link is a CAS (still PENDING/PROCESSING, no other PI): `order` was
    // read without a lock, and a retire / release / reaper may have cancelled
    // it since — handing back its credit and seats. Belt-and-braces: for a
    // createCheckout order this is unreachable today, because its client
    // secret is only issued after createCheckout's own link CAS wins, so no
    // payment can exist for an order cancelled before that. The guard keeps
    // a stale read from ever resurrecting a CANCELLED order regardless.
    if (!order.stripePaymentIntentId) {
      const existingOwner =
        await tx.orders.findByPaymentIntent(paymentIntentId);
      if (!existingOwner) {
        // No one owns this PI yet — link it
        if (
          !(await tx.orders.linkPaymentIntentIfPending(
            order.id,
            paymentIntentId,
            { allowProcessing: true },
          ))
        ) {
          return replayedFinalize(
            await resolveLostOrderCas(
              tx,
              order.id,
              paymentIntentId,
              "link",
              logger,
            ),
          );
        }
      } else if (existingOwner.id !== order.id) {
        // A different (likely cancelled) order owns this PI — reassign it.
        // Clear the stale order's PI, then link to the current order.
        await tx.orders.clearPaymentIntent(existingOwner.id);
        if (
          !(await tx.orders.linkPaymentIntentIfPending(
            order.id,
            paymentIntentId,
            { allowProcessing: true },
          ))
        ) {
          return replayedFinalize(
            await resolveLostOrderCas(
              tx,
              order.id,
              paymentIntentId,
              "link",
              logger,
            ),
          );
        }
      }
      // else: this order already owns the PI (race with createCheckout)
      order.stripePaymentIntentId = paymentIntentId;
    }

    const basisCents = computeAgreementBasis(order);

    // RESALE: the seller is credited what they receive (basis − the event's
    // resale share) as their own split row, and the RESALE terms lines split
    // ONLY the organiser side (the share). The platform takes nothing: a
    // resale order's `feesPlatformCents` is 0, so the basis is the whole
    // ticket money. See resolve-resale-seller-split.ts. Throws (fail-closed)
    // when the order has no routable seller, has no share (priced under the
    // removed markup split), or its snapshot breaks seller + share = basis.
    const resaleSeller = isResaleOrder
      ? await resolveResaleSellerSplit(tx, { order, basisCents, logger })
      : null;

    const agreementContext =
      primaryTerms ??
      (await loadResalePayoutTermsForOrder(
        tx,
        {
          orderId: order.id,
          event,
          listingResalePayoutTermsId:
            resaleSeller?.listingResalePayoutTermsId ?? null,
        },
        { logger, reportError: deps.reportError },
      ));

    const splitsResult = computeOrderSplits({
      amountCents: resaleSeller
        ? resaleSeller.organiserShareCents
        : basisCents,
      lines: agreementContext.lines,
    });
    const splitRows = resaleSeller
      ? mergeSellerIntoSplits(splitsResult.splits, {
          payeeId: resaleSeller.sellerPayeeId,
          amountCents: resaleSeller.sellerCents,
        })
      : splitsResult.splits;
    const splitRowsTotalCents = splitRows.reduce(
      (sum, split) => sum + split.amountCents,
      0,
    );

    // The split rows about to be written do NOT add up to the basis. Only an
    // all-capped line set whose caps fall short of 100% can do this, and every
    // terms-writing use case now refuses that shape — so reaching here means
    // pre-gate terms are still in force on a live event.
    //
    // Deliberately NOT a throw: the buyer has already been charged, and
    // failing the webhook would strand a paid order. It is also deliberately
    // not a bare log line. The short rows flow into `tx.splits.upsertForOrder`
    // → `createCreditsFromOrder` → `verifyLedgerInvariants`, which checks
    // credits against those same short rows, so every downstream invariant
    // agrees with itself while the payees are quietly under-paid. This report
    // is the ONLY thing that fires. (`logger.warn` would not be captured —
    // CLAUDE.md error convention.) Reported AFTER the commit, like the
    // other in-transaction degrades below, so a rolled-back or retried
    // finalize never reports splits that were not written.
    //
    // On a RESALE order the lines split only the organiser share, so
    // `splitsTotalCents` is measured against `organiserShareCents`, not the
    // whole basis; the seller's exact share is reported alongside.
    const splitsShortOfBasis =
      splitsResult.unallocatedCents !== 0
        ? {
            payoutTermsId: agreementContext.agreement.id,
            basisCents,
            splitsTotalCents: splitsResult.totalCents,
            unallocatedCents: splitsResult.unallocatedCents,
            ...(resaleSeller
              ? {
                  organiserShareCents: resaleSeller.organiserShareCents,
                  sellerCents: resaleSeller.sellerCents,
                }
              : {}),
          }
        : null;

    const now = deps.clock.now();

    // CAS (PENDING/PROCESSING → SUCCEEDED), for the same reason as the link
    // above: a canceller that committed after `order` was read must win, and
    // nothing below (mint, splits, promo confirm) may run for that order.
    if (!(await tx.orders.markSucceededIfOpen(order.id))) {
      return replayedFinalize(
        await resolveLostOrderCas(
          tx,
          order.id,
          paymentIntentId,
          "succeed",
          logger,
        ),
      );
    }
    order.status = "SUCCEEDED";

    let ticketMintResult: {
      count: number;
      tickets: Array<{ id: string; code: string }>;
    };

    if (isResaleOrder) {
      // Resale orders already have existing tickets — transfer ownership
      // instead of minting new ones.
      await finalizeResalePurchase(tx, {
        order,
        clock: deps.clock,
        logger,
      });
      ticketMintResult = { count: 0, tickets: [] };
    } else {
      ticketMintResult = await mintTicketsForOrder(tx, {
        order,
        issuedAt: now,
        actor: { kind: "system", reason: "order_finalization" },
      });

      // ── Auto-admit on POS card sales (spec FR-013 / FR-011) ────────
      // POS Tap to Pay sales are admitted on payment success — the
      // sale IS the admission, so the operator doesn't need to scan
      // a ticket they just minted. CASH sales are auto-admitted
      // inline in `recordCashSale`, so they never hit this path.
      if (
        order.paymentChannel === "POS" &&
        ticketMintResult.tickets.length > 0
      ) {
        const operatorHumanId = metadata.actorHumanId ?? order.buyerHumanId;
        for (const ticket of ticketMintResult.tickets) {
          const mark = await tx.tickets.markScanned(ticket.code, now);
          if (!mark.ok) continue; // already-scanned races: skip silently
          await tx.tickets.recordScan({
            ticketId: ticket.id,
            eventId: requireTicketingEventId(order),
            actorHumanId: operatorHumanId,
            scannedAt: mark.scannedAt,
            locationLat: null,
            locationLng: null,
            outcome: "ACCEPTED",
            // FR-013 audit tag — distinguishes auto-admit from a
            // real operator scan in TicketScan reports.
            message: "POS_AUTO_ADMIT",
          });
        }
        logger?.info("finalizePaymentIntent.pos_auto_admitted", {
          orderId: order.id,
          eventId: order.eventId,
          ticketCount: ticketMintResult.tickets.length,
          operatorHumanId,
        });
      }
    }

    await tx.splits.upsertForOrder(order.id, splitRows);

    await tx.audit.log({
      entity: "order",
      entityId: order.id,
      action: "succeeded",
      data: {
        paymentIntentId,
        amountReceived,
        basisCents,
        splitsTotalCents: splitRowsTotalCents,
        ticketsIssued: ticketMintResult.count,
        ...(resaleSeller
          ? {
              resaleSeller: {
                listingId: resaleSeller.listingId,
                sellerHumanId: resaleSeller.sellerHumanId,
                sellerPayeeId: resaleSeller.sellerPayeeId,
                sellerCents: resaleSeller.sellerCents,
                organiserShareCents: resaleSeller.organiserShareCents,
                placeholderPayeeCreated: resaleSeller.placeholderPayeeCreated,
              },
            }
          : {}),
      },
      at: now,
    });

    if (ticketMintResult.count > 0) {
      await tx.audit.log({
        entity: "ticket",
        entityId: null,
        action: "issued",
        data: { orderId: order.id, count: ticketMintResult.count },
        at: now,
      });
    }

    await tx.audit.log({
      entity: "order_split",
      entityId: order.id,
      action: "created",
      data: {
        count: splitRows.length,
        totalCents: splitRowsTotalCents,
      },
      at: now,
    });

    // ── Confirm promo holds for this order ────────────────────────────
    // Promo holds were created during checkout as PENDING.
    // Now that payment has succeeded, promote them to CONFIRMED and
    // create PromoRedemption records so redemption stats are accurate.
    await tx.promos.confirmHoldsForOrder({
      orderId: order.id,
      confirmedAt: now,
    });

    // ── Settle fee-waiver reservations ────────────────────────────────
    // Payment succeeded, so the allowance this order reserved at checkout is
    // spent for good. Moves RESERVED -> SETTLED without touching any counter
    // (ticketsUsed already counts reservations) — it hardens the reservation so
    // a later expiry sweep can't hand the allowance back on a paid order.
    await tx.feeWaivers.settle(order.id);

    // ── Waiver acceptance ─────────────────────────────────────────────
    // If the event has a waiver template, record the buyer's acceptance
    // with a snapshot of the body hash and version at acceptance time.
    if (event.waiverTemplateId) {
      const template = await tx.waiverTemplates.getById(event.waiverTemplateId);
      if (template) {
        const bodyHash = createHash("sha256")
          .update(template.body)
          .digest("hex");
        await tx.waiverAcceptances.create({
          orderId: order.id,
          humanId: order.buyerHumanId,
          waiverTemplateId: template.id,
          waiverVersion: template.version,
          waiverBodyHash: bodyHash,
          ipAddress: null,
        });
      }
    }

    // ── Attribution ─────────────────────────────────────────────────
    await recordAttribution(
      tx,
      {
        eventId: event.id,
        orderId: order.id,
        buyerHumanId: order.buyerHumanId,
        ref: (metadata.ref as string) ?? null,
        utmSource: (metadata.utmSource as string) ?? null,
        utmMedium: (metadata.utmMedium as string) ?? null,
        utmCampaign: (metadata.utmCampaign as string) ?? null,
        checkoutArtistSelection:
          (metadata.checkoutArtistSelection as string) ?? null,
        billingCity: order.billingCity,
        billingState: order.billingState,
        billingCountry: order.billingCountry,
      },
      logger,
    );

    return {
      order,
      event,
      ticketsIssued: ticketMintResult.count,
      splitsApplied: true,
      alreadyFinalized: false,
      // Reported only AFTER the commit (below), so a rolled-back or retried
      // transaction never reports state that does not exist.
      resaleSeller,
      sourceHintMismatch,
      splitsShortOfBasis,
      organiserCreditUnknown: hasUnknownOrganiserCredit(
        order.feePolicySnapshot,
      ),
    } as const;
  });

  if (!outcome.alreadyFinalized) {
    if (outcome.ticketsIssued > 0) {
      logger?.info("finalizePaymentIntent.tickets_issued", {
        orderId,
        paymentIntentId,
        count: outcome.ticketsIssued,
      });
    }
    if (outcome.splitsApplied) {
      logger?.info("finalizePaymentIntent.splits_created", {
        orderId,
        paymentIntentId,
      });

      // Write SETTLEMENT_CREDIT ledger entries from the order splits (the
      // ledger-authoritative replacement for settlement rows)
      try {
        const creditResult = await createCreditsFromOrder(
          {
            repos: deps.repos,
            clock: deps.clock,
            instantPayouts: deps.devInstantPayouts,
          },
          { orderId },
        );
        logger?.info("finalizePaymentIntent.ledger_credits_created", {
          orderId,
          paymentIntentId,
          creditEntryIds: creditResult.credits.map((c) => c.entryId),
          skippedZeroAmount: creditResult.skippedZeroAmount,
        });
      } catch (err) {
        // Log but don't fail the finalization - credits can be re-driven later
        // via the settlements.createFromOrder tRPC mutation (idempotent keys).
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger?.error("finalizePaymentIntent.ledger_credits_failed", {
          orderId,
          paymentIntentId,
          error: errorMsg,
        });
        try {
          // Deliberate swallow → must reach Sentry (CLAUDE.md error-reporting
          // convention), guarded so a throwing reporter never changes behaviour.
          deps.reportError?.(err, {
            tags: {
              useCase: "finalizePaymentIntent",
              step: "createLedgerCredits",
            },
            extra: { orderId, paymentIntentId },
          });
        } catch {
          /* swallow */
        }
        try {
          deps.onSettlementFailure?.({ orderId, error: errorMsg });
        } catch {
          /* swallow */
        }
      }
    }
    // Post-commit reports of deliberate degrades inside the transaction.
    if (outcome.splitsShortOfBasis) {
      const err = new Error(
        `order splits do not sum to the basis: ${outcome.splitsShortOfBasis.unallocatedCents}c unallocated`,
      );
      const extra = {
        orderId,
        eventId: outcome.order.eventId,
        ...outcome.splitsShortOfBasis,
      };
      logger?.error("finalizePaymentIntent.splits_short_of_basis", {
        ...extra,
        err,
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          useCase: "finalizePaymentIntent",
          reason: "splits_short_of_basis",
        },
        extra,
      });
    }
    if (outcome.organiserCreditUnknown) {
      const err = new Error(
        "order carries an unknown organiserCredit marker; credited price minus fee",
      );
      const extra = {
        orderId,
        eventId: outcome.order.eventId,
        organiserCredit: (
          outcome.order.feePolicySnapshot as { organiserCredit?: unknown }
        ).organiserCredit,
      };
      logger?.error("finalizePaymentIntent.organiser_credit_unknown", {
        ...extra,
        err,
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          useCase: "finalizePaymentIntent",
          reason: "organiser_credit_unknown",
        },
        extra,
      });
    }
    if (outcome.resaleSeller) {
      reportResaleSellerPlaceholder(
        { logger, reportError: deps.reportError },
        {
          orderId,
          eventId: outcome.order.eventId ?? null,
          seller: outcome.resaleSeller,
        },
      );
    }
    if (outcome.sourceHintMismatch) {
      const err = new Error("finalize_source_hint_mismatch");
      logger?.error("finalizePaymentIntent.source_hint_mismatch", {
        orderId,
        paymentIntentId,
        ...outcome.sourceHintMismatch,
        err,
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          useCase: "finalizePaymentIntent",
          reason: "source_hint_mismatch",
        },
        extra: { orderId, paymentIntentId, ...outcome.sourceHintMismatch },
      });
    }

    logger?.info("finalizePaymentIntent.success", { orderId, paymentIntentId });

    // ── Cancel stale PENDING carts for same buyer + event ─────────────
    // When a buyer starts checkout multiple times, older PENDING orders
    // linger. Now that this order succeeded, cancel the others so they
    // don't appear as active carts and their seat holds are freed.
    await cancelStalePendingCarts(deps, logger, outcome.order);

    // ── Buyer in-app confirmation (fire-and-forget) ───────────────────
    // The durable guard against double-fire is the order's own SUCCEEDED
    // state: this runs only on the FIRST finalization (!alreadyFinalized),
    // before which any replay/webhook redelivery short-circuits. The notify
    // idempotency key (order-confirmed:${orderId}) is a best-effort backstop
    // only — its Redis TTL is short (60s), so don't rely on it for delivery
    // separated by more than that. Resale and primary are mutually exclusive:
    // a resale order mints 0 tickets and finalizes via finalizeResalePurchase.
    // The receipt email is sent separately by the webhook (sendTicketIssuedEmail
    // / sendResalePurchaseEmail), so these emit in-app (+ push) only.
    await notifyBuyerForFinalizedOrder(deps, {
      order: outcome.order,
      event: outcome.event,
      ticketsIssued: outcome.ticketsIssued,
      amountReceived,
    });
  } else {
    logger?.info("finalizePaymentIntent.replayed", {
      orderId,
      paymentIntentId,
    });
  }

  return finalizePaymentIntentOutputSchema.parse({ ok: true, orderId });
}

function buildIdempotencyKey(stripeEventId: string): string {
  return `stripe_evt:${stripeEventId}`;
}

// ── Stale-cart cleanup ────────────────────────────────────────────────────

/**
 * After an order pays, retire the buyer's OTHER pending carts for the same
 * event so they stop holding inventory and allowances.
 *
 * Each sibling's PaymentIntent is cancelled and proven terminal FIRST
 * (`settleCarriedOverCartPaymentIntent`, no transaction open), and only then
 * is the order cancelled in one transaction with its promo, fee-waiver,
 * credit and resale listing holds released (`releaseRetiredCartHolds`). A
 * sibling whose PI already
 * succeeded or is processing is KEPT — its own webhook finalizes it. That
 * refusal is reported. Runs post-commit on the root repos; every failure is
 * swallowed (the paid order is durable) and reported.
 */
async function cancelStalePendingCarts(
  deps: FinalizePaymentIntentDeps,
  logger: LoggerPort | undefined,
  succeededOrder: OrderRecord,
): Promise<void> {
  try {
    const staleCarts = await deps.repos.orders.listOtherPending({
      buyerHumanId: succeededOrder.buyerHumanId,
      eventId: requireTicketingEventId(succeededOrder),
      excludeOrderId: succeededOrder.id,
    });

    if (staleCarts.length === 0) return;

    for (const stale of staleCarts) {
      try {
        // Same helper the checkout uses for a carried-over cart, for the same
        // reason: the sibling's PaymentIntent is NOT dead just because this
        // order paid. Stripe leaves a declined or untouched PI confirmable,
        // the buyer's other tab still holds its client secret, and a PI on a
        // CANCELLED order is one the reaper never visits (it reads PENDING
        // only). So the PI is cancelled and proven terminal FIRST; only then
        // is the order cancelled and its promo / fee-waiver holds released.
        // If the PI already succeeded or is processing, the cart is left
        // PENDING for its own webhook to finalize — never cancelled under a
        // charge.
        //
        // The cancel and the releases share ONE transaction (they used to run
        // as separate autocommits on the root repos): a resale sibling's
        // listing release must commit with its cancel, or a crash between
        // the two leaves a CANCELLED order holding a listing.
        const settle = await settleCarriedOverCartPaymentIntent(stale, {
          payments: deps.payments,
          logger,
          reportError: deps.reportError,
          caller: "finalizePaymentIntent",
        });
        const retired = settle.settled
          ? await deps.repos.tx((tx) =>
              releaseRetiredCartHolds(tx, stale.id, {
                expectedPaymentIntentId: stale.stripePaymentIntentId,
                caller: "finalizePaymentIntent",
                logger,
                reportError: deps.reportError,
              }),
            )
          : false;
        logger?.info(
          retired
            ? "finalizePaymentIntent.stale_cart_cancelled"
            : "finalizePaymentIntent.stale_cart_kept",
          { staleOrderId: stale.id, piId: stale.stripePaymentIntentId },
        );
      } catch (err) {
        logger?.warn("finalizePaymentIntent.stale_cart_cleanup_failed", {
          staleOrderId: stale.id,
          error: describeError(err),
        });
        // Deliberate swallow → must reach Sentry (CLAUDE.md error-reporting
        // convention). `warn` is not captured, and a stale cart whose promo
        // or fee-waiver holds were NOT released is a leak nobody would
        // otherwise see. Guarded so a throwing reporter never changes
        // behaviour — the paid order is already durable at this point.
        try {
          deps.reportError?.(err, {
            tags: {
              useCase: "finalizePaymentIntent",
              step: "cancelStalePendingCarts",
            },
            extra: { orderId: succeededOrder.id, staleOrderId: stale.id },
          });
        } catch {
          /* swallow */
        }
      }
    }

    logger?.info("finalizePaymentIntent.stale_carts_cleaned", {
      orderId: succeededOrder.id,
      staleCount: staleCarts.length,
    });
  } catch (err) {
    // Non-fatal: stale carts will be cleaned up by the cron
    logger?.warn("finalizePaymentIntent.stale_cart_query_failed", {
      orderId: succeededOrder.id,
      error: describeError(err),
    });
    // Deliberate swallow → must reach Sentry (CLAUDE.md error-reporting
    // convention); `warn` is not captured. Guarded so a throwing reporter
    // never changes behaviour.
    try {
      deps.reportError?.(err, {
        tags: {
          useCase: "finalizePaymentIntent",
          step: "cancelStalePendingCarts.query",
        },
        extra: { orderId: succeededOrder.id },
      });
    } catch {
      /* swallow */
    }
  }
}

function toOrderSource(source: string | undefined): OrderSource | undefined {
  if (!source) return undefined;
  if (source.toLowerCase() === "primary") return "PRIMARY";
  if (source.toLowerCase() === "resale") return "RESALE";
  return undefined;
}

/**
 * Loads the event's ACTIVE PRIMARY payout terms + lines at settlement time.
 * PRIMARY orders only: a RESALE order splits over the terms its LISTING was
 * priced against (`loadResalePayoutTermsForOrder`), never "the first ACTIVE
 * RESALE terms on the event", so the RESALE arms this used to carry are gone.
 *
 * Renamed off `loadAgreementContext` because that name also belongs to the
 * exported (deprecated) alias of `loadPayoutTermsContext` in checkout-helpers,
 * which has a DIFFERENT arity — it now takes a required `now` — and returns a
 * `feePolicy` this one does not. Two same-named functions with divergent
 * signatures on the settlement path is a trap for whoever next threads a clock
 * through here, so the private one carries a name that says what it actually
 * does: pick the PRIMARY settlement terms, no fee policy.
 */
async function loadSettlementPrimaryPayoutTerms(
  tx: TxRepos,
  eventId: string,
): Promise<{ agreement: PayoutTermsRecord; lines: PayoutTermsLineRecord[] }> {
  const agreements = await tx.payoutTerms.listByEvent(eventId);
  const agreement = agreements.find(
    (item) =>
      // "PRIMARY_SPLIT" is the legacy spelling of the same kind.
      (item.kind === "PRIMARY" || (item.kind as string) === "PRIMARY_SPLIT") &&
      item.status === "ACTIVE",
  );
  if (!agreement) {
    throw fail("AGREEMENT_MISSING");
  }

  const lines = await tx.payoutTerms.listLines(agreement.id);
  if (!lines.length) {
    throw fail("AGREEMENT_MISSING_LINES");
  }

  return { agreement, lines };
}

/**
 * The RESALE payout terms for a resale order: the SAME resolution
 * `createResaleCheckout` priced against — `listing.resalePayoutTermsId ??
 * event.resalePayoutTermsId` — never "the first ACTIVE RESALE terms on the
 * event". Those can differ (the event's resale terms replaced after the
 * listing was snapshotted), and finalize must split the organiser share over
 * the lines the buyer's price was computed for.
 *
 * Status is deliberately not checked, matching checkout: the listing pinned
 * these terms when it was priced.
 *
 * A missing row still throws AGREEMENT_MISSING / AGREEMENT_MISSING_LINES (the
 * paid order goes to manual review, as before). It is ALSO logged and
 * reported here: the throw rides the webhook's backstop, but a paid resale
 * order stranded by vanished terms needs its own named signal.
 */
async function loadResalePayoutTermsForOrder(
  tx: TxRepos,
  params: {
    orderId: string;
    event: Pick<EventRecord, "id" | "resalePayoutTermsId">;
    listingResalePayoutTermsId: string | null;
  },
  deps: { logger?: LoggerPort; reportError?: ReporterPort | null },
): Promise<{ agreement: PayoutTermsRecord; lines: PayoutTermsLineRecord[] }> {
  const payoutTermsId =
    params.listingResalePayoutTermsId ?? params.event.resalePayoutTermsId ?? null;

  const refuse = (
    code: "AGREEMENT_MISSING" | "AGREEMENT_MISSING_LINES",
    reason: string,
  ): never => {
    const extra = {
      orderId: params.orderId,
      eventId: params.event.id,
      payoutTermsId,
      listingResalePayoutTermsId: params.listingResalePayoutTermsId,
      eventResalePayoutTermsId: params.event.resalePayoutTermsId ?? null,
      reason,
    };
    const err = new Error(`finalize_resale_terms_unresolvable:${reason}`);
    deps.logger?.error("finalizePaymentIntent.resale_terms_unresolvable", {
      ...extra,
      err,
    });
    reportBestEffort(deps.reportError, err, {
      tags: { useCase: "finalizePaymentIntent", reason },
      extra,
    });
    return fail(code, { meta: { scope: "resale", ...extra } });
  };

  if (!payoutTermsId) {
    return refuse("AGREEMENT_MISSING", "resale_terms_id_missing");
  }
  const agreement = await tx.payoutTerms.getById(payoutTermsId);
  if (!agreement) {
    return refuse("AGREEMENT_MISSING", "resale_terms_row_missing");
  }
  const lines = await tx.payoutTerms.listLines(agreement.id);
  if (!lines.length) {
    return refuse("AGREEMENT_MISSING_LINES", "resale_terms_lines_missing");
  }
  return { agreement, lines };
}

/**
 * The cents an order credits the organiser side: the number its splits sum to.
 *
 * The rule is read from the order's own `feePolicySnapshot.organiserCredit`,
 * stamped at checkout by `buildFeePolicySnapshot`:
 *
 *   - `"FULL_PRICE"` (every sale since the 2026-10-11 ruling): the full ticket
 *     money the buyer paid, `amountGrossCents`. The platform fee is taken
 *     once, from the buyer on top.
 *   - anything else (no snapshot, no key, a malformed snapshot, an unknown
 *     value): the order was sold before the ruling and was credited
 *     `amountGrossCents − feesPlatformCents`. It keeps that amount.
 *
 * `amountGrossCents` is post-discount and carries no tax and no buyer fees.
 * Floored at 0. This is the only place the rule is decided; every reader that
 * re-derives a basis (finalize, the zero-charge checkout path, the deal
 * settlement sheet) calls it with the order's snapshot. Never throws.
 *
 * Spec: docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml (FR-002).
 */
export function computeAgreementBasis(
  order: Pick<
    OrderRecord,
    "amountGrossCents" | "feesPlatformCents" | "feePolicySnapshot"
  >,
): number {
  if (creditsFullPrice(order.feePolicySnapshot)) {
    return Math.max(order.amountGrossCents, 0);
  }
  return Math.max(order.amountGrossCents - order.feesPlatformCents, 0);
}

/**
 * True when a snapshot carries an `organiserCredit` key whose value is not the
 * known marker: a new sale mis-stamped, which `computeAgreementBasis` credits
 * at price minus fee. An absent key (sold before the ruling) is NOT unknown.
 * Callers report it after the commit.
 */
export function hasUnknownOrganiserCredit(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const value = (snapshot as { organiserCredit?: unknown }).organiserCredit;
  return value !== undefined && value !== SALE_ORGANISER_CREDIT;
}

/** True only for a snapshot object stamped `organiserCredit: "FULL_PRICE"`. */
function creditsFullPrice(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  return (
    (snapshot as { organiserCredit?: unknown }).organiserCredit ===
    SALE_ORGANISER_CREDIT
  );
}

type NotifyBuyerForFinalizedOrderParams = {
  order: OrderRecord;
  event: EventRecord | undefined;
  ticketsIssued: number;
  /** Amount the buyer actually paid (Stripe amount_received), in cents. */
  amountReceived: number;
};

/**
 * Fire-and-forget buyer in-app confirmation after an order is finalized.
 *
 * - Resale orders → `resale.purchase-confirmed` (ticket transferred, fresh QR).
 * - Primary orders with issued tickets → `order.confirmed`.
 *
 * The two are mutually exclusive for a given order: resale orders mint 0
 * tickets, primary orders mint > 0. Guest / POS_WALKUP buyers are skipped by
 * `notifyBuyer`; failures never propagate.
 */
async function notifyBuyerForFinalizedOrder(
  deps: FinalizePaymentIntentDeps,
  params: NotifyBuyerForFinalizedOrderParams,
): Promise<void> {
  if (!deps.notify) return;

  const { order, event, amountReceived, ticketsIssued } = params;
  const eventTitle = event?.title ?? "your event";

  if (order.source === "RESALE") {
    await notifyBuyer(
      {
        repos: deps.repos,
        notify: deps.notify,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        buyerHumanId: order.buyerHumanId,
        variant: "resale.purchase-confirmed",
        payload: {
          orderId: order.id,
          eventId: order.eventId,
          eventTitle,
          amountCents: amountReceived,
          currency: order.currency,
        },
        idempotencyKey: `resale-purchase:${order.id}`,
      },
    );
    return;
  }

  // Primary checkout — only notify when tickets were actually issued.
  if (ticketsIssued <= 0) return;

  await notifyBuyer(
    {
      repos: deps.repos,
      notify: deps.notify,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      buyerHumanId: order.buyerHumanId,
      variant: "order.confirmed",
      payload: {
        orderId: order.id,
        eventId: order.eventId,
        eventTitle,
        ticketCount: ticketsIssued,
        amountCents: amountReceived,
        currency: order.currency,
      },
      idempotencyKey: `order-confirmed:${order.id}`,
    },
  );
}

/** The result of a finalize that found the order already finalized. */
function replayedFinalize<O>(order: O) {
  return {
    order,
    ticketsIssued: 0,
    splitsApplied: false,
    alreadyFinalized: true,
  } as const;
}

/**
 * A conditional write in finalize lost to a concurrent status change. Re-read
 * and decide which change won:
 *
 * - The order is SUCCEEDED and linked to THIS PaymentIntent: another
 *   finalizer for the same payment won (the client confirm and the
 *   `payment_intent.succeeded` webhook use different idempotency keys, so
 *   both can be inside finalize at once). Payment and tickets are in place;
 *   return the order as an idempotent replay, which mints nothing.
 * - Anything else (CANCELLED, refunded, another PI): refuse through the SAME
 *   paths the up-front guards use, so the payment lands where every "paid
 *   but not processable" one already does (thrown → webhook DLQ + Sentry;
 *   the client-confirm path surfaces the error), and the transaction rolls
 *   back before anything is minted or split.
 */
async function resolveLostOrderCas(
  tx: TxRepos,
  orderId: string,
  paymentIntentId: string,
  step: "link" | "succeed",
  logger: LoggerPort | undefined,
) {
  const fresh = await tx.orders.getById(orderId);
  if (
    fresh?.status === "SUCCEEDED" &&
    fresh.stripePaymentIntentId === paymentIntentId
  ) {
    logger?.info("finalizePaymentIntent.concurrent_finalize_replay", {
      orderId,
      paymentIntentId,
      step,
    });
    return fresh;
  }
  logger?.error("finalizePaymentIntent.order_cas_lost", {
    orderId,
    paymentIntentId,
    step,
    status: fresh?.status ?? null,
    linkedPaymentIntentId: fresh?.stripePaymentIntentId ?? null,
  });
  if (
    fresh?.stripePaymentIntentId &&
    fresh.stripePaymentIntentId !== paymentIntentId
  ) {
    throw fail("PAYMENT_INTENT_MISMATCH");
  }
  throw fail("ORDER_NOT_PROCESSABLE");
}
