import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { parseInput } from "../../lib/io";
import { getMetaString } from "../../lib/orders/meta";
import { notifyClaimOpened } from "./notify-resale-events";
import { fail } from "@th/errors";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";
import { claimantHoldsTicket } from "../_helpers/claimant-holds-ticket";

// Claims can be filed for RESALE_CLAIM_WINDOW_DAYS after the event ends. The
// window lives in lib so the payout hold (pricing + credit maturity) reads the
// same number.
import { resaleClaimWindowClosesAt } from "../../lib/resale-claim-window";
import { claimEvidenceSchema } from "./claim-evidence";

// ── Schemas ────────────────────────────────────────────────────────────────

export const createClaimInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
  orderItemId: z.string().uuid(),
  kind: z.enum(["ticket_invalid", "entry_denied", "wrong_seat", "other"]),
  /** v1 evidence is the buyer's written description (see claim-evidence.ts). */
  evidence: claimEvidenceSchema,
});

export const createClaimOutputSchema = z.object({
  claimId: z.string().uuid(),
  status: z.string(),
  deadline: z.string().datetime(),
});

export type CreateClaimInput = z.infer<typeof createClaimInputSchema>;
export type CreateClaimOutput = z.infer<typeof createClaimOutputSchema>;

export type CreateClaimDeps = {
  repos: Repos;
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

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * File a buyer claim against a resale order item.
 *
 * Pre-conditions:
 *  - Order source must be RESALE
 *  - Current time must be >= event.startsAt (claim window open)
 *  - Current time must be <= event.endsAt + 3 days (claim window not expired)
 *  - No existing claim on this order item
 *  - The claimant still holds the ticket: the item is `active` and its ticket
 *    is owned by them and not LISTED (CLAIM_TICKET_NOT_HELD)
 */
export async function createClaim(
  deps: CreateClaimDeps,
  rawInput: unknown,
): Promise<CreateClaimOutput> {
  const input = parseInput(createClaimInputSchema, rawInput);
  const now = deps.clock.now();

  const result = await deps.repos.tx(async (tx) => {
    // ── Load order ───────────────────────────────────────────────────
    const order = await tx.orders.getById(input.orderId);
    if (!order) {
      throw fail("ORDER_NOT_FOUND");
    }

    if (order.buyerHumanId !== input.actorHumanId) {
      throw fail("FORBIDDEN");
    }

    if (order.source !== "RESALE") {
      throw fail("CLAIM_NOT_RESALE_ORDER");
    }

    // Verify the order item belongs to this order
    const orderItem = order.items.find((item) => item.id === input.orderItemId);
    if (!orderItem) {
      throw fail("ORDER_ITEM_NOT_FOUND");
    }

    // ── Load event ───────────────────────────────────────────────────
    const event = await tx.events.getById(requireTicketingEventId(order));
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    // ── Validate claim window ────────────────────────────────────────
    if (now < event.startsAt) {
      throw fail("CLAIM_WINDOW_NOT_OPEN");
    }

    const claimDeadline = resaleClaimWindowClosesAt(event);

    // Half-open window: AT the deadline instant the RESALE credits become
    // payable (the ledger's payable SQL and `createCreditsFromOrder` both
    // treat `>= close` as matured), so a claim filed then could not freeze
    // money that may already be leaving. Refuse it.
    if (now >= claimDeadline) {
      throw fail("CLAIM_WINDOW_EXPIRED");
    }

    // ── Check for existing claim ─────────────────────────────────────
    // Lock first: the same advisory lock every ticket move takes before its
    // "no unresolved claim" check (`ensureTicketNotUnderClaim`), so a move
    // never slips past a claim this transaction is about to commit. Nothing
    // above wrote a row, so the lock is still this tx's first.
    await tx.claims.lockOrderItem(input.orderItemId);
    const existingClaim = await tx.claims.getByOrderItemId(input.orderItemId);
    if (existingClaim) {
      throw fail("CLAIM_ALREADY_EXISTS");
    }

    // ── The claimant must still hold the ticket ──────────────────────
    // Approving a full_refund moves the ticket on this item back to the
    // seller, whoever holds it by then. So a buyer who gave it away,
    // transferred it, relisted it or resold it can't file one: the refund
    // would take the ticket from its new holder (owner ruling 2026-10-04).
    // Both reads happen under the lock above, which every ticket move takes
    // too; `order.items` was read before the lock and may be stale.
    if (
      !(await claimantHoldsTicket(tx, input.orderItemId, input.actorHumanId))
    ) {
      throw fail("CLAIM_TICKET_NOT_HELD");
    }

    // ── Find the seller (respondent) ─────────────────────────────────
    // During rollout, prefer the canonical relation field and fall back to legacy meta.
    const listingId =
      orderItem.resaleListingId ??
      getMetaString(orderItem.meta, "resaleListingId");
    let respondentId: string | null = null;

    if (listingId) {
      const listing = await tx.resaleListings.getById(listingId);
      if (listing) {
        respondentId = listing.sellerHumanId;
      }
    }

    if (!respondentId) {
      throw {
        code: "dependency_failed",
        message: "Could not identify the seller",
      } as const;
    }

    // ── Create claim ─────────────────────────────────────────────────
    const claim = await tx.claims.create({
      orderId: order.id,
      orderItemId: input.orderItemId,
      eventId: event.id,
      claimantId: input.actorHumanId,
      respondentId,
      kind: input.kind,
      evidence: input.evidence,
      deadline: claimDeadline,
    });

    // ── Audit ────────────────────────────────────────────────────────
    await tx.audit.log({
      entity: "claim",
      entityId: claim.id,
      action: "created",
      data: {
        orderId: order.id,
        orderItemId: input.orderItemId,
        eventId: event.id,
        claimantId: input.actorHumanId,
        respondentId,
        kind: input.kind,
        deadline: claimDeadline.toISOString(),
      },
      at: now,
    });

    return {
      claimId: claim.id,
      status: claim.status,
      deadline: claimDeadline.toISOString(),
      _respondentId: respondentId,
      _eventId: event.id,
    };
  });

  deps.logger?.info("createClaim.succeeded", { claimId: result.claimId });

  // Fire-and-forget: notify seller about the claim
  if (deps.mailer && deps.publicAppUrl) {
    notifyClaimOpened(
      {
        repos: deps.repos,
        mailer: deps.mailer,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        claimId: result.claimId,
        respondentId: result._respondentId,
        eventId: result._eventId,
        kind: input.kind,
        deadline: result.deadline,
        publicAppUrl: deps.publicAppUrl,
      },
    ).catch(() => {}); // swallow — already logged inside
  }

  return {
    claimId: result.claimId,
    status: result.status,
    deadline: result.deadline,
  };
}
