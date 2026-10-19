import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { effectiveResaleCapCents } from "../../lib/pricing/effective-resale-cap";
import { solveResaleCharge } from "../../lib/pricing/resale-charge";
import {
  computeResaleSchedule,
  RESALE_LISTING_MAX_ASK_CENTS,
} from "../../lib/pricing/resale-pricing";
import { resolvePurchasedUnitPriceCents } from "../orders/_shared/resolve-purchased-unit-price";
import { payeePayoutBlocker } from "../settlements/payee-payout-readiness";
import { notifyListingCreated } from "./notify-resale-events";
import { ensureTicketNotUnderClaim } from "../_helpers/ensure-ticket-not-under-claim";
import { setListedNowPointer } from "../_helpers/order-item-listing-pointer";
import {
  ensureTicketRefundLockHeld,
  withTicketRefundLock,
} from "../_helpers/with-ticket-refund-lock";
import { fail } from "@th/errors";
import {
  fillResaleTermsOnce,
  priceResaleAsk,
  resolveResaleFeePolicy,
  resolveResaleTicketTerms,
} from "./_shared/resale-ticket-terms";

// ── Schemas ────────────────────────────────────────────────────────────────

export const createResaleListingInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  ticketId: z.string().uuid(),
  /**
   * Bounded so the buyer's whole charge (the ask, a buyer-paid share,
   * processing and tax) fits one Stripe charge: see
   * RESALE_LISTING_MAX_ASK_CENTS.
   */
  askPriceCents: z.number().int().positive().max(RESALE_LISTING_MAX_ASK_CENTS),
  /** ISO currency code. Defaults to event currency when omitted. */
  currency: z.string().min(3).max(3).optional(),
  /** Custom expiry. Must not exceed event start. Defaults to event.startsAt. */
  expiresAt: z.coerce.date().optional(),
  clientKey: z.string().min(8),
});

export const createResaleListingOutputSchema = z.object({
  listingId: z.string().uuid(),
  ticketId: z.string().uuid(),
  askPriceCents: z.number().int().positive(),
  currency: z.string(),
  expiresAt: z.string().datetime(),
});

export type CreateResaleListingInput = z.infer<
  typeof createResaleListingInputSchema
>;
export type CreateResaleListingOutput = z.infer<
  typeof createResaleListingOutputSchema
>;

export type CreateResaleListingDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  mailer?: MailerPort;
  publicAppUrl?: string;
  logger?: LoggerPort;
  /**
   * Passed to the seller notice: reports an in-app row whose render payload
   * could not be stored (see comms/direct-in-app.ts).
   */
  reportError?: ReporterPort | null;
};

const IDEMPOTENCY_TTL_SECONDS = 120;

interface StoredListingRecord {
  payloadHash: string;
  response: CreateResaleListingOutput;
}

// ── Use case ───────────────────────────────────────────────────────────────

export async function createResaleListing(
  deps: CreateResaleListingDeps,
  rawInput: unknown,
): Promise<CreateResaleListingOutput> {
  const input = parseInput(createResaleListingInputSchema, rawInput);
  const now = deps.clock.now();

  const idempotencyKey = `resale-listing:${input.actorHumanId}:${input.clientKey}`;
  const payloadHash = JSON.stringify({
    ticketId: input.ticketId,
    askPriceCents: input.askPriceCents,
  });

  // ── Idempotency check ────────────────────────────────────────────────
  const replay =
    await deps.idempotency.get<StoredListingRecord>(idempotencyKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS,
  );
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredListingRecord>(idempotencyKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    // Holds the ticket's order refund mutex across the tx (owner ruling
    // 2026-10-05): no listing while a refund on that order is in flight.
    const result = await withTicketRefundLock(
      deps,
      input.ticketId,
      (lock) =>
        deps.repos.tx(async (tx) => {
          // ── Load ticket ────────────────────────────────────────────────
          const ticket = await tx.tickets.getById(input.ticketId);
          if (!ticket) {
            throw fail("TICKET_NOT_FOUND");
          }

          if (ticket.ownerHumanId !== input.actorHumanId) {
            throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "ticket" } });
          }

          if (ticket.status !== "VALID") {
            throw fail("TICKET_NOT_ELIGIBLE_FOR_RESALE");
          }

          // No relisting a ticket the seller has an unresolved resale claim on
          // (owner ruling 2026-10-04). Takes the claim lock before this tx's
          // first write (`resaleListings.create`). Mostly defensive today —
          // claims open at event start and the listing cutoff defaults to start —
          // but it bites once the cutoff is overridden or the event moves, so it
          // is not dead code. Same for a refund in flight on the ticket's order
          // (owner ruling 2026-10-05).
          ensureTicketRefundLockHeld(lock, ticket);
          await ensureTicketNotUnderClaim(tx, ticket);

          // ── Load event ─────────────────────────────────────────────────
          const event = await tx.events.getById(ticket.eventId);
          if (!event) {
            throw fail("EVENT_NOT_FOUND");
          }

          if (!event.resalePayoutTermsId) {
            throw fail("RESALE_NOT_ENABLED");
          }

          // The RESALE terms: whose payout lines the share runs over at
          // finalize (snapshotted onto the listing below), and the seller's
          // payout release days. Not the fee policy: processing is priced
          // from the policy a primary sale uses (FR-013), below.
          const resaleTerms = await tx.payoutTerms.getById(
            event.resalePayoutTermsId,
          );
          if (!resaleTerms) {
            throw fail("AGREEMENT_MISSING", { meta: { scope: "resale" } });
          }

          // ── Ticket type POLICY (live row) ──────────────────────────────
          // The live TicketType is read for POLICY only — whether resale is
          // permitted at all and the type's current resale cap (lifted per
          // ticket below, never used bare). These are forward-looking rules
          // the organizer owns and may change; a listing created today
          // should honour today's rules.
          //
          // It is deliberately NOT read for historical VALUE. See FR-001.
          let resaleCapCents: number | null = null;
          if (ticket.ticketTypeId) {
            const ticketType = await tx.tickets.getTicketTypeById(
              ticket.ticketTypeId,
            );
            if (ticketType) {
              if (!ticketType.resaleAllowed) {
                throw fail("RESALE_NOT_ALLOWED_FOR_TYPE");
              }
              resaleCapCents = ticketType.resaleCapCents;
            }
          }

          // ── Face VALUE = the ticket's list price at purchase (FR-001) ──
          // Snapshotted on the OrderItem at purchase and never recomputed:
          // what the seller paid, kept on the listing for display. It no
          // longer prices anything; the share and the cap read the ticket's
          // resale record below (organiser-resale-share FR-005, FR-007).
          const purchaseOrderItemId = ticket.orderItemId;
          const faceValueCents = await resolvePurchasedUnitPriceCents(
            tx,
            ticket,
          );
          if (purchaseOrderItemId == null || faceValueCents == null) {
            // Loud, never a silent fall back to the live price. Every ticket
            // minted through `mintTicketsForOrder` (checkout, POS, comp, resale)
            // has an OrderItem; reaching here means fixture/legacy data.
            throw fail("RESALE_PURCHASE_PRICE_UNKNOWN", {
              meta: { ticketId: ticket.id },
            });
          }

          // ── How the ticket was bought: PRIMARY, COMP, ... or RESALE ────
          // A ticket bought on resale can be listed again, any number of
          // times (owner ruling 2026-10-11). What differs is the purchase
          // item's `resaleListingId`, keyed on the ORDER behind that item and
          // not on the actor: whoever holds the ticket now (the resale buyer,
          // or someone they gave it to), the item it points at is the resale
          // buyer's.
          //
          // On a RESALE order's item that column is the SOLD listing the
          // ticket was BOUGHT THROUGH, and the refund unwind
          // (`unwindResaleOrderAfterRefund`) reads it to find the sale to
          // undo. So this listing must not be written onto it (see
          // `setListedNowPointer` below, and `_helpers/
          // order-item-listing-pointer.ts` for the rule). A refund of that
          // resale order closes this new listing first (a held one too),
          // and leaves the ticket where it is only once it has sold.
          const purchaseOrderItem =
            await tx.orderItems.getById(purchaseOrderItemId);
          const purchaseOrder = purchaseOrderItem
            ? await tx.orders.getById(purchaseOrderItem.orderId)
            : null;
          if (!purchaseOrderItem || !purchaseOrder) {
            // Cannot tell how the ticket was bought: refuse, never guess.
            // (An order item always has its order; this is corrupt data.)
            throw fail("ORDER_NOT_FOUND", {
              meta: { ticketId: ticket.id, via: "resale_listing" },
            });
          }

          // ── The purchase behind THIS ticket has been refunded ───────────
          // Whoever holds a ticket whose own purchase was refunded has their
          // money back and must not be paid for it again. Two signs of it:
          //
          //  - the purchase ITEM is refunded (any order source);
          //  - the purchase order is a REFUNDED **RESALE** order. A resale
          //    order has one ticket item, so its status speaks for the item.
          //    This is the ticket handed BACK to an already refunded resale
          //    buyer when a later sale down the chain was refunded after
          //    theirs (`unwindResaleOrderAfterRefund`,
          //    "sellerPurchaseAlreadyRefunded"): VALID, on an item set back
          //    to `active`, so only the order still says they were refunded.
          //
          // A REFUNDED order of any other source says nothing about one of
          // its tickets: `refundFullOrder` marks the order REFUNDED when
          // every ticket item is refunded OR transferred, and a transferred
          // item is not paid back. So these are NOT refused:
          //  - a gifted ticket (item `transferred`) on an order whose other
          //    tickets were refunded;
          //  - a ticket that came back to its seller from a refund of their
          //    buyer (item set back to `active`) under such an order.
          const purchaseItemRefunded =
            purchaseOrderItem.status === "refunded" ||
            Boolean(purchaseOrderItem.refundedAt);
          const resalePurchaseRefunded =
            purchaseOrder.source === "RESALE" &&
            purchaseOrder.status === "REFUNDED";
          if (purchaseItemRefunded || resalePurchaseRefunded) {
            throw fail("TICKET_NOT_ELIGIBLE_FOR_RESALE", {
              meta: { reason: "purchase_refunded", ticketId: ticket.id },
            });
          }

          const schedule = computeResaleSchedule({
            event,
            payoutTerms: resaleTerms,
          });
          if (now >= schedule.saleCutoffAt) {
            throw fail("SALE_CUTOFF_PASSED");
          }

          // ── The ticket's resale clause and original price ──────────────
          // From the record on the purchase item (FR-003), never the event's
          // live clause: a ticket keeps the clause of its first sale (R10).
          // A ticket sold before the record existed gets the event's clause
          // at this moment written onto its purchase item, ONCE (FR-004): a
          // conditional write in this transaction, so a refused listing
          // rolls it back and two racing listings price under one clause.
          const ticketTerms = await fillResaleTermsOnce(
            tx,
            purchaseOrderItemId,
            await resolveResaleTicketTerms(tx, {
              event,
              purchaseItem: purchaseOrderItem,
              purchaseOrder,
            }),
          );

          // ── The share and the cap (FR-002, FR-005, FR-007) ─────────────
          // The type's cap stays POLICY, read from the live TicketType. The
          // ceiling for THIS ticket never falls below its ORIGINAL price
          // (owner rulings 2026-10-10 Q-001 and R15): a seat with a $50 seat
          // price override on a $30 type capped at $35 lists for up to $50,
          // and a ticket bought on resale is floored at its first sale's
          // price, never the previous resale ask. With a BUYER clause the
          // ask plus the share must fit; the refusal names the highest ask
          // that does.
          const priced = priceResaleAsk({
            askCents: input.askPriceCents,
            clause: ticketTerms.clause,
            capCents: effectiveResaleCapCents({
              ticketTypeResaleCapCents: resaleCapCents,
              ticketUnitPriceCents: faceValueCents,
              originalUnitPriceCents: ticketTerms.originalUnitPriceCents,
            }),
          });
          if (!priced.withinCap) {
            throw fail("RESALE_PRICE_EXCEEDS_CAP", {
              meta: {
                askPriceCents: input.askPriceCents,
                basisCents: priced.share.basisCents,
                capCents: priced.capCents,
                sharePayer: priced.share.payer,
                highestFittingAskCents: priced.highestFittingAskCents,
              },
            });
          }
          const share = priced.share;

          // ── The RESALE terms must carry payout lines ───────────────────
          // Finalize splits the share over them, so checkout refuses every
          // buyer (AGREEMENT_MISSING_LINES) when there are none. Refusing
          // here keeps a listing nobody can buy from going live. Inside the
          // tx: the FR-004 clause fill above rolls back with the refusal.
          const resaleLines = await tx.payoutTerms.listLines(
            event.resalePayoutTermsId,
          );
          if (resaleLines.length === 0) {
            throw fail("AGREEMENT_MISSING_LINES", {
              meta: { scope: "resale" },
            });
          }

          // ── Processing (FR-013) ────────────────────────────────────────
          // From the fee policy a primary sale of this event uses, on what
          // the buyer pays before processing (the basis: the ask, plus the
          // share when the buyer pays it). The buyer pays it on top.
          //
          // The PRE-TAX figure: the listing cannot know the buyer's tax, so
          // it stores the processing on a charge with no tax, the amount
          // pages show as "includes processing, plus tax". Checkout re-solves
          // processing over the full charge, tax included (owner 2026-10-14,
          // `solveResaleCharge`), from the fee policy frozen here
          // (`processingFeeConfigRef`); the order records that figure.
          const feePolicy = await resolveResaleFeePolicy(tx, event, now, {
            logger: deps.logger,
            reportError: deps.reportError,
          });
          const processingPassThroughCents = solveResaleCharge({
            basisCents: share.basisCents,
            taxLines: [],
            processorPct: feePolicy.processsorFeePct,
            processorFixedCents: feePolicy.processorFixedCents,
          }).processingPassThroughCents;

          // ── Check for existing active listing ──────────────────────────
          // `getByTicketId` returns the ticket's live listing when it has
          // one, else its latest past one. A past (CANCELLED / EXPIRED)
          // listing does not block a new one: it stays as its own row and
          // the ticket is listed again beside it. So does a SOLD one: that
          // is the sale this holder (or whoever gave them the ticket) bought
          // it through.
          const existingListing = await tx.resaleListings.getByTicketId(
            input.ticketId,
          );
          if (
            existingListing &&
            (existingListing.status === "ACTIVE" ||
              existingListing.status === "HELD")
          ) {
            throw fail("TICKET_NOT_ELIGIBLE_FOR_RESALE");
          }

          // ── Seller payout eligibility ──────────────────────────────────
          // A listing promises the seller money, so the seller must be
          // payable by the batch that will pay them: a Stripe account AND
          // payouts enabled. A bare payee row is not enough — the PENDING
          // placeholder (`resolve-resale-seller-split`) has neither.
          const sellerPayeeRef = await tx.payees.getBySubject({
            type: "HUMAN",
            id: input.actorHumanId,
          });
          const sellerPayee = sellerPayeeRef
            ? await tx.payees.getById(sellerPayeeRef.id)
            : null;
          if (payeePayoutBlocker(sellerPayee) !== null) {
            throw fail("SELLER_PAYOUT_NOT_SETUP");
          }

          // ── Determine currency & expiry ────────────────────────────────
          const currency = input.currency ?? event.currency ?? "usd";
          const expiresAt = input.expiresAt ?? schedule.saleCutoffAt;

          if (expiresAt > schedule.saleCutoffAt) {
            throw {
              code: "invalid_input",
              message: "Expiry cannot exceed sale cutoff time",
            } as const;
          }

          // ── Create listing ─────────────────────────────────────────────
          // A racing create for the same ticket that committed after the
          // read above loses on the DB's one-live-listing-per-ticket index.
          // Same refusal as the pre-check; the throw rolls this tx back.
          const listing = await tx.resaleListings
            .create({
              ticketId: input.ticketId,
              eventId: event.id,
              sellerHumanId: input.actorHumanId,
              askPriceCents: input.askPriceCents,
              faceValueCents,
              eventShareCents: share.shareCents,
              sharePayer: share.payer,
              processingPassThroughCents,
              processingFeeConfigRef: feePolicy.id,
              saleCutoffAt: schedule.saleCutoffAt,
              payoutReleaseAt: schedule.payoutReleaseAt,
              currency,
              expiresAt,
              resalePayoutTermsId: event.resalePayoutTermsId,
            })
            .catch((error: unknown) => {
              if (isLiveListingConflict(error)) {
                throw fail("TICKET_NOT_ELIGIBLE_FOR_RESALE");
              }
              throw error;
            });

          // The purchase item's "listed now" pointer. Written for every
          // ticket (the face-value gate above rejects one with no OrderItem,
          // so this link is never silently skipped) EXCEPT one bought on
          // resale: that item's column stays the listing it was bought
          // through, and "listed now" is read from the ticket instead.
          await setListedNowPointer(tx, {
            orderItemId: purchaseOrderItemId,
            listingId: listing.id,
            orderSource: purchaseOrder.source,
          });

          // ── Set ticket status to LISTED ────────────────────────────────
          // From VALID only, the status read above. The refund mutex keeps
          // refunds out, but a comp revoke takes no such lock: a ticket
          // voided since the read is terminal and must not be listed back
          // into a place-holding status (refunds-restock spec 2026-10-09).
          // Throwing rolls the listing create back with it.
          const listed = await tx.tickets.setStatus(input.ticketId, "LISTED", {
            expectedStatus: "VALID",
          });
          if (!listed) {
            throw fail("TICKET_NOT_ELIGIBLE_FOR_RESALE");
          }

          // ── Audit ──────────────────────────────────────────────────────
          await tx.audit.log({
            entity: "resale_listing",
            entityId: listing.id,
            action: "created",
            data: {
              ticketId: input.ticketId,
              eventId: event.id,
              sellerHumanId: input.actorHumanId,
              askPriceCents: input.askPriceCents,
              faceValueCents,
              originalUnitPriceCents: ticketTerms.originalUnitPriceCents,
              resaleClause: ticketTerms.clause,
              // FR-004: this listing wrote the ticket's first record.
              resaleClauseFilled: ticketTerms.fill !== null,
              eventShareCents: share.shareCents,
              sharePayer: share.payer,
              shareHeld: share.shareHeld,
              heldFromCents: share.heldFromCents,
              sellerReceivesCents: share.sellerReceivesCents,
              basisCents: share.basisCents,
              processingPassThroughCents,
              processingFeeConfigRef: feePolicy.id,
              saleCutoffAt: schedule.saleCutoffAt.toISOString(),
              payoutReleaseAt: schedule.payoutReleaseAt.toISOString(),
              currency,
              expiresAt: expiresAt.toISOString(),
              resalePayoutTermsId: event.resalePayoutTermsId,
            },
            at: now,
          });

          return {
            listingId: listing.id,
            ticketId: listing.ticketId,
            askPriceCents: listing.askPriceCents,
            currency: listing.currency,
            expiresAt: (listing.expiresAt ?? expiresAt).toISOString(),
            _eventId: event.id,
          };
        }),
      // Only the holder may list; anyone else is refused in the tx
      // (NOT_RESOURCE_OWNER) without ever holding the order's mutex.
      { mayLock: (ticket) => ticket.ownerHumanId === input.actorHumanId },
    );

    await deps.idempotency.commit<StoredListingRecord>(idempotencyKey, {
      payloadHash,
      response: result,
    });

    deps.logger?.info("createResaleListing.succeeded", {
      listingId: result.listingId,
      ticketId: result.ticketId,
    });

    // Fire-and-forget seller confirmation notification
    if (deps.mailer && deps.publicAppUrl) {
      notifyListingCreated(
        {
          repos: deps.repos,
          mailer: deps.mailer,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        {
          listingId: result.listingId,
          sellerHumanId: input.actorHumanId,
          eventId: result._eventId,
          askPriceCents: result.askPriceCents,
          currency: result.currency,
          publicAppUrl: deps.publicAppUrl,
        },
      ).catch(() => {}); // swallow — already logged inside
    }

    // Strip internal field before returning
    const { _eventId: _, ...output } = result;
    return output;
  } catch (error) {
    await deps.idempotency.fail(idempotencyKey, describeError(error));
    throw asKnownError("create_resale_listing", error);
  }
}

/**
 * What `resaleListings.create` throws when the ticket already has a live
 * (ACTIVE / HELD) listing: the loser of two racing creates.
 */
function isLiveListingConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "conflict" && message === "resale_listing_live_exists";
}
