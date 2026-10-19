import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { OrgRole } from "@th/ports/repos/authz";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";
import { asKnownError } from "../../lib/errors";
import { isEventPast } from "../../lib/event-ended";
import { describeError, parseInput } from "../../lib/io";
import {
  requireOrgMembership,
  ORG_EDIT_OR_FINANCE_ROLES,
} from "../../lib/rbac";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import { ensureTicketNotUnderClaim } from "../_helpers/ensure-ticket-not-under-claim";
import {
  ensureTicketRefundLockHeld,
  withTicketRefundLock,
} from "../_helpers/with-ticket-refund-lock";
import { fail, isAppError } from "@th/errors";
import {
  actorHoldsEventEditRole,
  ensureDelegateNotSelfRecipient,
} from "../../lib/event-edit-rights";

const IDEMPOTENCY_TTL_SECONDS = 120;
const OWNER_ONLY_REASONS: ReadonlySet<TransferTicketInput["reason"]> = new Set([
  "primary",
  "resale",
  "gift",
]);

export const transferTicketInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ticketId: z.uuid(),
    targetHumanId: z.uuid(),
    reason: z.enum(["primary", "resale", "gift", "admin"]),
    orderId: z
      .string()
      .uuid()
      .nullish()
      .transform((value) => value ?? null),
    clientKey: z.string().min(8).max(128),
  })
  .strict();

export const transferTicketOutputSchema = z
  .object({
    ticketId: z.uuid(),
    eventId: z.uuid(),
    fromHumanId: z.uuid(),
    toHumanId: z.uuid(),
    reason: z.enum(["primary", "resale", "gift", "admin"]),
    orderId: z.string().uuid().nullable(),
    transferredAt: z.date(),
  })
  .strict();

export type TransferTicketInput = z.infer<typeof transferTicketInputSchema>;
export type TransferTicketOutput = z.infer<typeof transferTicketOutputSchema>;

export type TransferTicketDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /** Release-failure / lock-lost swallows of the ticket's refund lock. */
  reportError?: ReporterPort | null;
};

interface StoredTransferTicketRecord {
  payloadHash: string;
  response: TransferTicketOutput;
}

export async function transferTicket(
  deps: TransferTicketDeps,
  rawInput: unknown,
): Promise<TransferTicketOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "transferTicket" });

  const execute = async () => {
    const input = parseInput(transferTicketInputSchema, rawInput);
    if (input.reason === "resale" && input.orderId === null) {
      throw fail("ORDER_REQUIRED_FOR_RESALE");
    }

    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input.ticketId, input.clientKey);

    const cached =
      await deps.idempotency.get<StoredTransferTicketRecord>(idempotencyKey);
    if (cached) {
      if (cached.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return cached.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const replay =
        await deps.idempotency.get<StoredTransferTicketRecord>(idempotencyKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return replay.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      // Holds the ticket's order refund mutex across the tx (owner ruling
      // 2026-10-05): no move while a refund on that order is in flight.
      const result = await withTicketRefundLock(
        deps,
        input.ticketId,
        (lock) =>
          deps.repos.tx(async (tx) => {
            await ensureEmailVerified(tx, input.actorHumanId);

            const ticket = await ensureTicketExists(tx, input.ticketId);
            ensureTicketTransferable(ticket);
            if (ticket.ownerHumanId === input.targetHumanId) {
              throw fail("TICKET_ALREADY_OWNED_BY_TARGET");
            }

            const event = await ensureEventExists(tx, ticket.eventId);
            ensureResaleAllowed(event, input.reason);
            await ensureActorAuthorized(
              tx,
              event,
              ticket,
              input.actorHumanId,
              input.reason,
              input.targetHumanId,
            );

            const now = deps.clock.now();
            // A ticket for an event that is over has nothing left to hand on —
            // for every reason, organizer "admin" moves included. Checked after
            // authorization so a stranger learns nothing about the event.
            if (isEventPast(event, now)) {
              throw fail("TICKET_TRANSFER_EVENT_PAST");
            }

            // An unresolved resale claim on this ticket's order item freezes it,
            // for every reason — organizer `admin` moves included (owner ruling
            // 2026-10-04). Takes the claim lock before the first write below.
            // So does a refund in flight on the ticket's order (2026-10-05).
            ensureTicketRefundLockHeld(lock, ticket);
            await ensureTicketNotUnderClaim(tx, ticket);

            // `ensureTicketTransferable` above read the ticket; this writes it.
            // Nothing holds the row in between under READ COMMITTED, so both
            // writes are compare-and-swaps pinned to exactly what the read saw,
            // and a loser refuses with the SAME error the read would have thrown.
            // The refund side has already moved money by the time it races us —
            // it wins, and this transfer is the side that can safely fail late
            // (money audit 2026-09-08 #19).
            const transferred = await tx.tickets.transfer({
              ticketId: ticket.id,
              fromHumanId: ticket.ownerHumanId,
              toHumanId: input.targetHumanId,
              reason: input.reason,
              orderId: input.orderId,
              expectedStatus: "VALID",
            });
            if (!transferred) {
              throw fail("TICKET_NOT_TRANSFERABLE");
            }

            if (ticket.orderItemId) {
              // The item leaving "active" is what stops a later refund of the
              // sender's order from quoting it and burning the recipient's
              // ticket. If it is no longer active, something else already claimed
              // it; refusing rolls the ownership move above back with it.
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

            await tx.audit.log({
              entity: "ticket",
              entityId: ticket.id,
              action: `transfer.${input.reason}`,
              data: {
                eventId: ticket.eventId,
                fromHumanId: ticket.ownerHumanId,
                toHumanId: input.targetHumanId,
                orderId: input.orderId,
                actorHumanId: input.actorHumanId,
              },
              at: now,
            });

            return transferTicketOutputSchema.parse({
              ticketId: ticket.id,
              eventId: ticket.eventId,
              fromHumanId: ticket.ownerHumanId,
              toHumanId: input.targetHumanId,
              reason: input.reason,
              orderId: input.orderId,
              transferredAt: now,
            });
          }),
        { mayLock: (ticket) => mayLockForTransfer(deps.repos, ticket, input) },
      );

      await deps.idempotency.commit<StoredTransferTicketRecord>(
        idempotencyKey,
        {
          payloadHash,
          response: result,
        },
      );

      deps.metrics?.increment("ticket.transfer", {
        eventId: result.eventId,
        reason: result.reason,
        outcome: "success",
      });

      return result;
    } catch (error) {
      scopedLogger?.warn("transferTicket.failed", {
        error: describeError(error),
      });
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      deps.metrics?.increment("ticket.transfer", {
        reason: input.reason,
        outcome: "error",
      });
      throw asKnownError("transfer_ticket", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("transferTicket", execute);
  }

  return execute();
}

function buildIdempotencyKey(ticketId: string, clientKey: string): string {
  return `ticket:transfer:${ticketId}:${clientKey}`;
}

function buildPayloadHash(input: TransferTicketInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ticketId: input.ticketId,
        targetHumanId: input.targetHumanId,
        reason: input.reason,
        orderId: input.orderId,
      }),
    )
    .digest("hex");
}

/**
 * `mayLock` pre-filter for the ticket's refund lock: the same authorization
 * the tx runs (`ensureActorAuthorized`), read before it, so a caller the tx
 * would refuse never holds the order's refund mutex. Owners pass without a
 * read; only an organizer `admin` move costs the event + membership reads.
 * Coded refusals mean "no lock"; anything else (a DB error) still throws.
 */
async function mayLockForTransfer(
  repos: Repos,
  ticket: TicketRecord,
  input: TransferTicketInput,
): Promise<boolean> {
  if (ticket.ownerHumanId === input.actorHumanId) {
    return true;
  }
  if (input.reason !== "admin") {
    return false;
  }
  const event = await repos.events.getById(ticket.eventId);
  if (!event) {
    return false;
  }
  try {
    await ensureActorAuthorized(
      repos,
      event,
      ticket,
      input.actorHumanId,
      input.reason,
      input.targetHumanId,
    );
    return true;
  } catch (error) {
    if (isAppError(error)) {
      return false;
    }
    throw error;
  }
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

/**
 * Same rule as `initiateEmailTransfer`: only a VALID ticket moves. A LISTED
 * ticket belongs to its resale listing, a SCANNED one has been used, a
 * REFUNDED one no longer exists, and an INVALID one was voided — gifting any
 * of them would hand a second person a ticket the first path still owns.
 */
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

function ensureResaleAllowed(
  event: EventRecord,
  reason: TransferTicketInput["reason"],
): void {
  if (reason !== "resale") {
    return;
  }

  if (!event.agreementResaleId) {
    throw fail("RESALE_DISABLED_FOR_EVENT");
  }
}

async function ensureActorAuthorized(
  tx: TxRepos,
  event: EventRecord,
  ticket: TicketRecord,
  actorHumanId: string,
  reason: TransferTicketInput["reason"],
  targetHumanId: string,
): Promise<void> {
  if (ticket.ownerHumanId === actorHumanId) {
    return;
  }

  if (OWNER_ONLY_REASONS.has(reason)) {
    throw fail("NOT_RESOURCE_OWNER");
  }

  if (reason !== "admin") {
    throw fail("INSUFFICIENT_ROLE");
  }

  if (event.orgId) {
    const membership = await tx.authz.getOrgMembership({
      orgId: event.orgId,
      humanId: actorHumanId,
    });
    if (
      !membership ||
      !(ORG_EDIT_OR_FINANCE_ROLES as readonly string[]).includes(
        membership.role,
      )
    ) {
      throw fail("INSUFFICIENT_ROLE");
    }
    return;
  }

  // The owner, or an edit-role delegate (owner ruling 2026-09-28; the org
  // arm's FINANCE does not carry over — FINANCE delegates are not editors).
  if (
    await actorHoldsEventEditRole(
      tx.authz,
      { orgId: null, humanId: event.humanId },
      actorHumanId,
    )
  ) {
    // …but a DELEGATE may not transfer the principal's tickets to themselves
    // (owner ruling 2026-09-28). The owner passes this untouched.
    await ensureDelegateNotSelfRecipient(tx.humans, {
      eventOwner: { orgId: null, humanId: event.humanId },
      actorHumanId,
      recipientHumanId: targetHumanId,
    });
    return;
  }

  throw fail("INSUFFICIENT_ROLE");
}
