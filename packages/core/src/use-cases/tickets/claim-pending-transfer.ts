import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PendingTicketTransferRecord } from "@th/ports/repos/pending-ticket-transfers";
import { asKnownError } from "../../lib/errors";
import { isEventPast } from "../../lib/event-ended";
import { describeError, parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { ensureTicketNotUnderClaim } from "../_helpers/ensure-ticket-not-under-claim";
import {
  ensureTicketRefundLockHeld,
  withTicketRefundLock,
} from "../_helpers/with-ticket-refund-lock";

const IDEMPOTENCY_TTL_SECONDS = 120;

// ── Schemas ────────────────────────────────────────────────────────────────

export const claimPendingTransferInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    token: z.string().min(1),
    clientKey: z.string().min(8).max(128),
  })
  .strict();

export const claimPendingTransferOutputSchema = z
  .object({
    ticketId: z.uuid(),
    eventId: z.uuid(),
    fromHumanId: z.uuid(),
    toHumanId: z.uuid(),
    reason: z.string(),
    transferredAt: z.date(),
  })
  .strict();

export type ClaimPendingTransferInput = z.infer<
  typeof claimPendingTransferInputSchema
>;
export type ClaimPendingTransferOutput = z.infer<
  typeof claimPendingTransferOutputSchema
>;

export type ClaimPendingTransferDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /** Release-failure / lock-lost swallows of the ticket's refund lock. */
  reportError?: ReporterPort | null;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function claimPendingTransfer(
  deps: ClaimPendingTransferDeps,
  rawInput: unknown,
): Promise<ClaimPendingTransferOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "claimPendingTransfer" });

  const execute = async () => {
    const input = parseInput(claimPendingTransferInputSchema, rawInput);

    const idempotencyKey = `claim-transfer:${input.token}:${input.clientKey}`;

    const cached =
      await deps.idempotency.get<ClaimPendingTransferOutput>(idempotencyKey);
    if (cached) return cached;

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const replay =
        await deps.idempotency.get<ClaimPendingTransferOutput>(idempotencyKey);
      if (replay) return replay;
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      // Holds the ticket's order refund mutex across the tx (owner ruling
      // 2026-10-05): no claim while a refund on that order is in flight. The
      // invite is read once here only to pick the lock; the tx reads it again.
      const lockTarget = await deps.repos.pendingTicketTransfers.getByToken(
        input.token,
      );
      const result = await withTicketRefundLock(
        deps,
        lockTarget?.ticketId ?? null,
        (lock) =>
          deps.repos.tx(async (tx) => {
            const pending = await tx.pendingTicketTransfers.getByToken(
              input.token,
            );
            if (!pending) {
              throw fail("PENDING_TRANSFER_NOT_FOUND");
            }

            // Verify the claimant's email matches the intended recipient. This
            // runs BEFORE the invite's state is judged: a caller holding the
            // token under the wrong account learns only EMAIL_MISMATCH, never
            // whether the invite lapsed, was claimed, or its event is over.
            const claimantIdentity = await tx.humans.getByIdWithIdentity(
              input.actorHumanId,
            );
            if (!claimantIdentity) {
              throw fail("ACTOR_NOT_FOUND");
            }
            if (
              claimantIdentity.identity.email?.toLowerCase() !==
              pending.recipientEmail.toLowerCase()
            ) {
              throw fail("EMAIL_MISMATCH");
            }

            await ensurePendingTransferClaimable(tx, pending, deps.clock.now());

            // A matching address is not proof of controlling it: an account can
            // be created with the recipient's email and never verified. This is
            // the other door to the same ownership change `transferTicket`
            // guards with `ensureEmailVerified`, so it refuses with the same
            // error — after the match check, before any write (money audit
            // 2026-09-08 #17).
            await ensureEmailVerified(tx, input.actorHumanId);

            // Verify the ticket still exists and is still owned by the sender
            const ticket = await tx.tickets.getById(pending.ticketId);
            if (!ticket) {
              throw fail("TICKET_NOT_FOUND");
            }
            if (ticket.ownerHumanId !== pending.fromHumanId) {
              throw fail("TICKET_NO_LONGER_OWNED_BY_SENDER");
            }
            if (ticket.status !== "VALID") {
              throw fail("TICKET_NOT_TRANSFERABLE");
            }

            const now = deps.clock.now();

            // An invite sent before the show is not claimable after it. No job
            // expires the row; it stays PENDING until the sender's next invite
            // for this ticket retires it (initiateEmailTransfer expires lapsed
            // rows) or `cancelPendingTransfer` is called (no web action today).
            const event = await tx.events.getById(ticket.eventId);
            if (!event) {
              throw fail("EVENT_NOT_FOUND");
            }
            if (isEventPast(event, now)) {
              throw fail("TICKET_TRANSFER_EVENT_PAST");
            }

            // Re-checked at acceptance: the sender may have opened a resale claim
            // on this ticket after sending the invite (owner ruling 2026-10-04).
            // Takes the claim lock before the first write below. Same for a
            // refund in flight on the ticket's order (owner ruling 2026-10-05).
            ensureTicketRefundLockHeld(lock, ticket);
            await ensureTicketNotUnderClaim(tx, ticket);

            // Execute the actual transfer. The owner/status checks above were a
            // READ; this is the WRITE, and nothing holds the row in between under
            // READ COMMITTED. Both writes are therefore compare-and-swaps pinned
            // to what the read saw, and a loser refuses with the same errors the
            // read would have thrown — a refund that raced us has already moved
            // money and wins (money audit 2026-09-08 #19).
            const transferred = await tx.tickets.transfer({
              ticketId: pending.ticketId,
              fromHumanId: pending.fromHumanId,
              toHumanId: input.actorHumanId,
              reason: pending.reason as "primary" | "resale" | "gift" | "admin",
              expectedStatus: "VALID",
            });
            if (!transferred) {
              throw fail("TICKET_NOT_TRANSFERABLE");
            }

            // Mirror transferTicket: the sender's order item leaves "active" so a
            // later refund of the sender's order cannot quote it and burn the
            // recipient's ticket.
            if (ticket.orderItemId) {
              const itemFlipped = await tx.orderItems.updateStatus(
                ticket.orderItemId,
                "transferred",
                now,
                undefined,
                undefined,
                { expectedStatus: "active" },
              );
              if (!itemFlipped) {
                throw fail("TICKET_NOT_TRANSFERABLE");
              }
            }

            // Mark the pending transfer as claimed
            await tx.pendingTicketTransfers.markClaimed(
              pending.id,
              input.actorHumanId,
              now,
            );

            await tx.audit.log({
              entity: "ticket",
              entityId: pending.ticketId,
              action: "transfer.email_claimed",
              data: {
                eventId: ticket.eventId,
                fromHumanId: pending.fromHumanId,
                toHumanId: input.actorHumanId,
                pendingTransferId: pending.id,
                recipientEmail: pending.recipientEmail,
                reason: pending.reason,
              },
              at: now,
            });

            return claimPendingTransferOutputSchema.parse({
              ticketId: pending.ticketId,
              eventId: ticket.eventId,
              fromHumanId: pending.fromHumanId,
              toHumanId: input.actorHumanId,
              reason: pending.reason,
              transferredAt: now,
            });
          }),
        {
          // Only the invite's recipient may take the lock: the same address
          // comparison the tx makes (EMAIL_MISMATCH), read before it. A
          // wrong account takes no lock and still learns only EMAIL_MISMATCH.
          mayLock: async () => {
            if (!lockTarget) return false;
            const claimant = await deps.repos.humans.getByIdWithIdentity(
              input.actorHumanId,
            );
            return (
              claimant?.identity.email?.toLowerCase() ===
              lockTarget.recipientEmail.toLowerCase()
            );
          },
        },
      );

      await deps.idempotency.commit(idempotencyKey, result);

      deps.metrics?.increment("ticket.transfer", {
        eventId: result.eventId,
        reason: result.reason,
        outcome: "success",
        source: "email_claim",
      });

      return result;
    } catch (error) {
      scopedLogger?.warn("claimPendingTransfer.failed", {
        error: describeError(error),
      });
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      deps.metrics?.increment("ticket.transfer", {
        reason: "unknown",
        outcome: "error",
        source: "email_claim",
      });
      throw asKnownError("claim_pending_transfer", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("claimPendingTransfer", execute);
  }

  return execute();
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * A row marked EXPIRED (retired when the sender sent a newer invite) and a
 * PENDING row past its expiresAt are the same thing to the recipient: expired,
 * or, once the show is over, "event over". CLAIMED / CANCELLED keep the
 * legacy conflict. Runs after the email match, so only the recipient sees it.
 */
async function ensurePendingTransferClaimable(
  tx: TxRepos,
  pending: PendingTicketTransferRecord,
  now: Date,
): Promise<void> {
  // A row marked EXPIRED (retired when the sender sent a newer invite) and
  // a PENDING row past its expiresAt are the same thing to the recipient.
  if (
    pending.status === "EXPIRED" ||
    (pending.status === "PENDING" && pending.expiresAt < now)
  ) {
    // Invites are capped at the event's end, so after the show an invite is
    // usually BOTH expired and for a past event. "Expired" tells the
    // recipient to ask for a new one, which can no longer work; say the
    // event is over instead.
    const ticket = await tx.tickets.getById(pending.ticketId);
    const event = ticket ? await tx.events.getById(ticket.eventId) : null;
    if (event && isEventPast(event, now)) {
      throw fail("TICKET_TRANSFER_EVENT_PAST");
    }
    throw fail("PENDING_TRANSFER_EXPIRED");
  }
  if (pending.status !== "PENDING") {
    throw {
      code: "conflict",
      message: `pending_transfer_${pending.status.toLowerCase()}`,
    } as const;
  }
}
