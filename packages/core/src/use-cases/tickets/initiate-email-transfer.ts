import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { EventRecord } from "@th/ports/repos/events";
import { asKnownError } from "../../lib/errors";
import { eventEndedAt, isEventPast } from "../../lib/event-ended";
import { describeError, parseInput } from "../../lib/io";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { ensureTicketNotUnderClaim } from "../_helpers/ensure-ticket-not-under-claim";
import {
  ensureTicketRefundLockHeld,
  withTicketRefundLock,
} from "../_helpers/with-ticket-refund-lock";
import { fail } from "@th/errors";

const PENDING_TRANSFER_TTL_DAYS = 7;
const IDEMPOTENCY_TTL_SECONDS = 120;

// ── Schemas ────────────────────────────────────────────────────────────────

export const initiateEmailTransferInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ticketId: z.uuid(),
    recipientEmail: z.string().email().trim().toLowerCase(),
    reason: z.enum(["gift", "primary"]),
    clientKey: z.string().min(8).max(128),
  })
  .strict();

export const initiateEmailTransferOutputSchema = z
  .object({
    pendingTransferId: z.uuid(),
    ticketId: z.uuid(),
    recipientEmail: z.string(),
    token: z.string(),
    expiresAt: z.date(),
  })
  .strict();

export type InitiateEmailTransferInput = z.infer<
  typeof initiateEmailTransferInputSchema
>;
export type InitiateEmailTransferOutput = z.infer<
  typeof initiateEmailTransferOutputSchema
>;

export type InitiateEmailTransferDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Optional mailer — when present the recipient gets a claim-link email. */
  mailer?: MailerPort;
  /** Base URL for building the claim link, e.g. "https://ithasfire.com/claim-transfer". */
  claimBaseUrl?: string;
  /**
   * Release-failure / lock-lost swallows of the ticket's refund lock, and a
   * claim email that failed to send (the transfer row stands).
   */
  reportError?: ReporterPort | null;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function initiateEmailTransfer(
  deps: InitiateEmailTransferDeps,
  rawInput: unknown,
): Promise<InitiateEmailTransferOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "initiateEmailTransfer" });

  const execute = async () => {
    const input = parseInput(initiateEmailTransferInputSchema, rawInput);

    const idempotencyKey = `pending-transfer:${input.ticketId}:${input.clientKey}`;

    const cached =
      await deps.idempotency.get<InitiateEmailTransferOutput>(idempotencyKey);
    if (cached) {
      return cached;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const replay =
        await deps.idempotency.get<InitiateEmailTransferOutput>(idempotencyKey);
      if (replay) return replay;
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      // The event's zone, read in the tx, so the email's expiry date is the
      // day the recipient's link lapses where the show is. The server's zone
      // (UTC on Cloud Run) put an evening end-of-event expiry on the next day.
      let eventTimeZone: string | null = null;
      // Holds the ticket's order refund mutex across the tx (owner ruling
      // 2026-10-05): no invite while a refund on that order is in flight.
      const result = await withTicketRefundLock(
        deps,
        input.ticketId,
        (lock) =>
          deps.repos.tx(async (tx) => {
            // Gate: sender must have verified email
            await ensureEmailVerified(tx, input.actorHumanId);

            // Verify ticket exists and is transferable
            const ticket = await ensureTicketExists(tx, input.ticketId);
            ensureTicketTransferable(ticket);

            // Only the ticket owner can initiate
            if (ticket.ownerHumanId !== input.actorHumanId) {
              throw fail("NOT_RESOURCE_OWNER");
            }

            // Don't allow transferring to yourself
            const senderIdentity = await tx.humans.getByIdWithIdentity(
              input.actorHumanId,
            );
            if (
              senderIdentity?.identity.email?.toLowerCase() ===
              input.recipientEmail
            ) {
              throw fail("CANNOT_TRANSFER_TO_SELF");
            }

            // A ticket under an unresolved resale claim is frozen (owner ruling
            // 2026-10-04). Before `expireLapsedForTicket`, this tx's first write,
            // so the claim lock is taken ahead of any row lock.
            // `claimPendingTransfer` checks again: a claim can open between this
            // invite and its acceptance. Same for a refund in flight on the
            // ticket's order (owner ruling 2026-10-05).
            ensureTicketRefundLockHeld(lock, ticket);
            await ensureTicketNotUnderClaim(tx, ticket);

            // A lapsed invite (expiresAt < now) is dead: nothing expires it in the
            // background, so retire it here, in this transaction, before looking
            // for a live one. Otherwise it blocks every new invite for the ticket
            // forever, and the end-of-event cap below makes that happen sooner.
            // Expire-then-check order means at most one PENDING row survives,
            // absent a concurrent initiate (no unique index guards that race).
            await tx.pendingTicketTransfers.expireLapsedForTicket(
              input.ticketId,
              deps.clock.now(),
            );

            // Check if there's already a live pending transfer for this ticket
            const existingPending =
              await tx.pendingTicketTransfers.findPendingByTicketId(
                input.ticketId,
              );
            if (existingPending) {
              throw fail("PENDING_TRANSFER_ALREADY_EXISTS");
            }

            // Check if the recipient already has an account — if so, tell the sender
            // to use the direct transfer flow instead
            const existingRecipient = await tx.humans.getByEmail(
              input.recipientEmail,
            );
            if (existingRecipient) {
              throw fail("RECIPIENT_ALREADY_HAS_ACCOUNT");
            }

            // Verify event exists (needed for audit and the past-event rule)
            const event = await ensureEventExists(tx, ticket.eventId);
            eventTimeZone = event.timezone;

            const now = deps.clock.now();
            if (isEventPast(event, now)) {
              throw fail("TICKET_TRANSFER_EVENT_PAST");
            }
            // The invite lapses at the event's end if that comes before the TTL:
            // a link sent the afternoon of the show must not read as good for a
            // week. `claimPendingTransfer` refuses a past event on its own too,
            // for invites created before this cap and for events moved earlier.
            // The expiry is fixed here: if the event later moves to a later date,
            // this invite still lapses at the old end and the sender must send a
            // new one, cancelling this one first (PENDING_TRANSFER_ALREADY_EXISTS).
            const expiresAt = new Date(
              Math.min(
                now.getTime() + PENDING_TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000,
                eventEndedAt(event).getTime(),
              ),
            );
            const token = generateToken();

            const pending = await tx.pendingTicketTransfers.create({
              ticketId: input.ticketId,
              fromHumanId: input.actorHumanId,
              recipientEmail: input.recipientEmail,
              reason: input.reason,
              token,
              expiresAt,
            });

            await tx.audit.log({
              entity: "ticket",
              entityId: input.ticketId,
              action: "transfer.email_initiated",
              data: {
                eventId: event.id,
                fromHumanId: input.actorHumanId,
                recipientEmail: input.recipientEmail,
                pendingTransferId: pending.id,
                reason: input.reason,
              },
              at: now,
            });

            return initiateEmailTransferOutputSchema.parse({
              pendingTransferId: pending.id,
              ticketId: pending.ticketId,
              recipientEmail: pending.recipientEmail,
              token: pending.token,
              expiresAt: pending.expiresAt,
            });
          }),
        // Only the holder may invite; anyone else is refused in the tx
        // (NOT_RESOURCE_OWNER) without ever holding the order's mutex.
        { mayLock: (ticket) => ticket.ownerHumanId === input.actorHumanId },
      );

      await deps.idempotency.commit(idempotencyKey, result);

      // Fire-and-forget: send claim email to the recipient
      if (deps.mailer && deps.claimBaseUrl) {
        const claimUrl = `${deps.claimBaseUrl}?token=${result.token}`;
        const expiresOn = result.expiresAt.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: resolveTimeZone(eventTimeZone),
        });
        deps.mailer
          .send({
            to: { to: result.recipientEmail },
            subject: "You've received a ticket on Ithas Fire",
            text: [
              "Someone has sent you a ticket on Ithas Fire!",
              "",
              "Click the link below to create an account (or sign in) and claim your ticket:",
              claimUrl,
              "",
              `This link expires on ${expiresOn}.`,
            ].join("\n"),
            html: [
              "<p>Someone has sent you a ticket on Ithas Fire!</p>",
              "<p>Click the link below to create an account (or sign in) and claim your ticket:</p>",
              `<p><a href="${claimUrl}">Claim Your Ticket</a></p>`,
              `<p>This link expires on ${expiresOn}.</p>`,
            ].join("\n"),
          })
          .catch((err) => {
            // ERROR (not warn): the transfer row IS persisted but the
            // recipient won't receive the claim link without manual
            // intervention. Surface to Cloud Logging error alerts so we
            // can resend or invalidate the transfer.
            scopedLogger?.error("initiateEmailTransfer.emailFailed", {
              recipientEmail: result.recipientEmail,
              pendingTransferId: result.pendingTransferId,
              ticketId: result.ticketId,
              error: describeError(err),
            });
            // Guarded: this runs detached from the request, so a throwing
            // reporter would surface as an unhandled rejection.
            try {
              deps.reportError?.(err, {
                tags: {
                  useCase: "initiateEmailTransfer",
                  branch: "claim_email_failed",
                },
                extra: {
                  pendingTransferId: result.pendingTransferId,
                  ticketId: result.ticketId,
                },
              });
            } catch {
              // Best-effort reporting; never changes behaviour.
            }
          });
      }

      return result;
    } catch (error) {
      scopedLogger?.warn("initiateEmailTransfer.failed", {
        error: describeError(error),
      });
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("initiate_email_transfer", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("initiateEmailTransfer", execute);
  }

  return execute();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

async function ensureTicketExists(
  tx: TxRepos,
  ticketId: string,
): Promise<TicketRecord> {
  const ticket = await tx.tickets.getById(ticketId);
  if (!ticket) {
    throw fail("TICKET_NOT_FOUND");
  }
  return ticket;
}

function ensureTicketTransferable(ticket: TicketRecord): void {
  if (ticket.status !== "VALID") {
    throw fail("TICKET_NOT_TRANSFERABLE");
  }
}

async function ensureEventExists(
  tx: TxRepos,
  eventId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  return event;
}
