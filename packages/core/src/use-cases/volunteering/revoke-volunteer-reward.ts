import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { TicketRecord } from "@th/ports/repos/tickets";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES, requireOrgMembership } from "../../lib/rbac";
import { setListedNowPointer } from "../_helpers/order-item-listing-pointer";
import { releaseSeatsForVoidedTickets } from "../orders/_shared/release-seats-for-voided-tickets";
import { revokeVolunteerRewardInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type RevokeVolunteerRewardDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports a revoke that left the ticket alone because the comp had passed
   * on (resold, gifted, or mid-sale). The grant is still revoked; this is
   * the deliberate degraded branch (CLAUDE.md, error reporting).
   */
  reportError?: ReporterPort;
};

export type RevokeVolunteerRewardOutput = {
  ok: true;
  skipped?: "ALREADY_REVOKED";
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Void an unused comp grant and return its budget slot. Fired on signup
 * WITHDRAWN (system, no actor) or a manual admin revoke (2026-07-01
 * resolutions: nothing else auto-revokes — no no-show path).
 *
 * - Only a GRANTED, UN-redeemed grant can be revoked. A redeemed reward (grant
 *   REDEEMED or its comp Ticket already SCANNED) is left intact — clawing it
 *   back is a manual refund decision, surfaced here as a
 *   `reward_already_redeemed` conflict.
 * - Revoke = set the comp `Ticket.status = INVALID` (unless already SCANNED)
 *   and void the $0 comp `Order` (SUCCEEDED COMP → CANCELLED). There is
 *   nothing to refund on a comp.
 * - The ticket is voided ONLY while the comp is still the volunteer's: on
 *   the comp order, owned by that order's buyer, and not mid-sale. A comp
 *   that was resold or gifted, or whose resale listing is HELD by a buyer's
 *   checkout, has PASSED ON: the grant is still REVOKED, but the ticket, the
 *   comp order and the budget slot are left alone (the place is still
 *   taken) and it is reported. The person now holding it did nothing wrong,
 *   and voiding it would strand their money (a charged resale buyer with no
 *   ticket, or a refund that cannot unwind).
 * - A LISTED comp's ACTIVE resale listing is cancelled in the same
 *   transaction, before the void, so nothing can later move the INVALID
 *   ticket back to a place-holding status (refunds-restock spec 2026-10-09).
 * - The ticket row is locked first (`getByIdForUpdate`), so the status and
 *   owner the decision reads cannot change under it.
 * - Idempotent: an already-REVOKED grant is a no-op (never double-decrements
 *   the budget). `decrementGrantsUsed` is floored at 0 in the adapter as a
 *   second belt.
 * - When `actorHumanId` is present (manual revoke) the actor must hold
 *   `ORG_FINANCE_ROLES` on the reward's owning org — the same finance gate as
 *   configuring the reward. System-fired revokes (withdraw) carry no actor.
 */
export async function revokeVolunteerReward(
  deps: RevokeVolunteerRewardDeps,
  rawInput: unknown,
): Promise<RevokeVolunteerRewardOutput> {
  const input = parseInput(revokeVolunteerRewardInputSchema, rawInput);

  // The tx hands back a comp it left alone, so the report fires only for a
  // revoke that committed.
  const { output, passedOn } = await deps.repos.tx(async (tx): Promise<{
    output: RevokeVolunteerRewardOutput;
    passedOn: TicketPassedOn | null;
  }> => {
    const grant = await tx.volunteering.getGrant(input.grantId);
    if (!grant) {
      throw fail("NOT_FOUND", {
        message: "grant_not_found",
        meta: { entity: "volunteer_reward_grant" },
      });
    }

    // Manual-revoke RBAC BEFORE any status inspection (anti-oracle + money
    // gate). Resolve the owning org via the grant's reward → ask.
    if (input.actorHumanId) {
      const reward = await tx.volunteering.getReward(grant.rewardId);
      const ask = reward
        ? await tx.volunteering.getAsk(reward.askId)
        : null;
      if (!ask || !ask.orgId) {
        // EVENT-subject reward asks always carry an orgId; its absence is a
        // data problem — fail closed rather than grant access.
        throw fail("EVENT_NOT_ORG_OWNED");
      }
      await requireOrgMembership({
        repos: tx,
        orgId: ask.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_FINANCE_ROLES,
      });
    }

    // Idempotent no-op — never re-return the budget slot.
    if (grant.status === "REVOKED") {
      return {
        output: { ok: true, skipped: "ALREADY_REVOKED" },
        passedOn: null,
      };
    }

    // LOCK the ticket row, then read it. Everything below decides from its
    // status and owner and then writes it or its listing; an unlocked read
    // let `createResaleListing` commit VALID → LISTED in between and leave an
    // ACTIVE listing over a voided ticket. Ticket before listing: the order
    // `commit`, `lockHold` and `releaseHold` take.
    const ticket = grant.ticketId
      ? await tx.tickets.getByIdForUpdate(grant.ticketId)
      : null;

    // Redeemed guard: an already-scanned comp (or an explicitly REDEEMED
    // grant) is a manual refund decision, not an auto-clawback.
    const ticketScanned = ticket?.status === "SCANNED";
    if (grant.status === "REDEEMED" || ticketScanned) {
      throw fail("CONFLICT", {
        message: "reward_already_redeemed",
        meta: { reason: "reward_already_redeemed", grantId: grant.id },
      });
    }

    const now = deps.clock.now();

    /** Reserved seat handed back by this revoke (audit trail). */
    let releasedSeatIds: string[] = [];
    /** Set when the comp has passed on and the ticket was left alone. */
    let passed: TicketPassedOn | null = null;

    if (ticket) {
      // Is the comp still the volunteer's? The comp ORDER's buyer is the
      // test, not `grant.humanId` (null for a shadow profile): a resale
      // repoints `orderId` at the buyer's order, a gift moves
      // `ownerHumanId`.
      const compOrder = grant.compOrderId
        ? await tx.orders.getById(grant.compOrderId)
        : null;
      if (!compOrder) {
        passed = describePassedOn(ticket, "comp_order_missing");
      } else if (
        ticket.orderId !== compOrder.id ||
        ticket.ownerHumanId !== compOrder.buyerHumanId
      ) {
        passed = describePassedOn(ticket, "resold_or_transferred");
      } else if (ticket.status === "VALID" || ticket.status === "LISTED") {
        // Only VALID / LISTED comps reach the void: SCANNED was refused
        // above, and REFUNDED / INVALID are already dead.
        if (ticket.status === "LISTED") {
          // Up for resale. Close the listing FIRST, as a compare-and-swap,
          // and decide from the result. A buyer's `hold` takes only the
          // listing row, so whichever of us flips it first wins: if the
          // listing is HELD (or the CAS lost to a hold), a buyer's checkout
          // is in flight and may already be paid, so the comp is passing on.
          const listing = await tx.resaleListings.getByTicketId(ticket.id);
          const open =
            listing != null &&
            listing.status !== "CANCELLED" &&
            listing.status !== "EXPIRED";
          if (open) {
            const cancelled =
              listing.status === "ACTIVE" &&
              (await tx.resaleListings.cancel(
                listing.id,
                // `cancel` is seller-scoped and there is no seller actor
                // here: pass the listing's own seller, as the refund heal does.
                listing.sellerHumanId,
              ));
            if (!cancelled) {
              const after = await tx.resaleListings.getById(listing.id);
              passed = describePassedOn(ticket, "resale_in_flight", {
                listingId: listing.id,
                listingStatus: after?.status ?? listing.status,
              });
            } else if (ticket.orderItemId) {
              // The ticket is still on the comp order (checked above), so
              // this is that order's item and the pointer is its "listed
              // now" one. Routed through the one rule all the same: an item
              // of a RESALE order is never written.
              await setListedNowPointer(tx, {
                orderItemId: ticket.orderItemId,
                listingId: null,
                orderSource: compOrder.source,
              });
            }
          }
        }

        if (!passed) {
          // Compare-and-swap from the status read under the lock. `false`
          // cannot happen while the lock holds; if it ever does, refuse
          // rather than void a ticket in a state nobody examined.
          const voided = await tx.tickets.setStatus(ticket.id, "INVALID", {
            expectedStatus: ticket.status,
          });
          if (!voided) {
            throw fail("CONFLICT", {
              message: "ticket_status_changed",
              meta: { reason: "ticket_status_changed", grantId: grant.id },
            });
          }

          // A comp can be SEATED, and INVALID does not own a seat
          // (`SEAT_OWNING_TICKET_STATUSES`). Without this the `Seat` stays
          // SOLD with nobody in it — permanently unsellable inventory, the
          // same dead seat every refund path now avoids. Safe by the helper's
          // contract: this ticket was voided one line up, in this transaction.
          releasedSeatIds = await releaseSeatsForVoidedTickets(
            tx,
            [ticket],
            now,
          );
        }
      }
    }

    // Void the $0 comp order (guarded to SUCCEEDED COMP in the adapter),
    // unless the comp passed on: then the order still backs a live ticket
    // (or a sale in flight) and is left as it is.
    if (grant.compOrderId && !passed) {
      await tx.orders.cancelCompOrder(grant.compOrderId);
    }

    await tx.volunteering.updateGrantStatus(grant.id, {
      status: "REVOKED",
      revokedAt: now,
      revokeReason: input.reason,
    });

    // Return the budget slot, unless the comp passed on: its place is still
    // taken, so the slot stays counted as used.
    if (!passed) {
      await tx.volunteering.decrementGrantsUsed(grant.rewardId);
    }

    await tx.audit.log({
      entity: "volunteer_reward_grant",
      entityId: grant.id,
      action: "volunteer_reward_revoked",
      data: {
        actorHumanId: input.actorHumanId ?? null,
        rewardId: grant.rewardId,
        signupId: grant.signupId,
        compOrderId: grant.compOrderId,
        ticketId: grant.ticketId,
        reason: input.reason,
        system: input.actorHumanId == null,
        releasedSeatIds:
          releasedSeatIds.length > 0 ? releasedSeatIds : undefined,
        // The comp had passed on: ticket, comp order and budget slot untouched.
        ticketPassedOn: passed ?? undefined,
      },
      at: now,
    });

    return { output: { ok: true }, passedOn: passed };
  });

  if (passedOn) {
    reportTicketPassedOn(deps, input.grantId, passedOn);
  }

  return output;
}

/** Why a revoke left the ticket alone, and who holds it. */
type TicketPassedOn = {
  ticketId: string;
  ownerHumanId: string;
  reason: "resold_or_transferred" | "resale_in_flight" | "comp_order_missing";
  listingId?: string;
  listingStatus?: string;
};

function describePassedOn(
  ticket: TicketRecord,
  reason: TicketPassedOn["reason"],
  listing?: { listingId: string; listingStatus: string },
): TicketPassedOn {
  return {
    ticketId: ticket.id,
    ownerHumanId: ticket.ownerHumanId,
    reason,
    ...listing,
  };
}

function reportTicketPassedOn(
  deps: RevokeVolunteerRewardDeps,
  grantId: string,
  passed: TicketPassedOn,
): void {
  deps.logger?.error("revokeVolunteerReward.ticket_passed_on", {
    grantId,
    ...passed,
  });
  try {
    deps.reportError?.(new Error("revoke_volunteer_reward_ticket_passed_on"), {
      tags: { useCase: "revokeVolunteerReward", reason: passed.reason },
      extra: { grantId, ...passed },
    });
  } catch {
    // A throwing reporter must never change behaviour.
  }
}
