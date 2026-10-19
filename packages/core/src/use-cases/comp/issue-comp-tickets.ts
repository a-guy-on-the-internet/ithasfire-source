import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ADMIN_ROLES } from "../../lib/rbac";
import { mintTicketsForOrder } from "../tickets/mint-tickets";
import {
  resolveTicketResaleClause,
  stampTicketResaleClause,
} from "../orders/_shared/resolve-ticket-resale-clause";
import { fail } from "@th/errors";
import { ensureGuestHumanKeepingName } from "../../lib/ensure-guest-human";
import {
  plainTextMultilineOptional,
  plainTextOptional,
} from "../../lib/sanitize-plain-text";
import {
  ensureActorHoldsHumanEventRole,
  ensureDelegateNotSelfRecipient,
} from "../../lib/event-edit-rights";

// ── Schemas ────────────────────────────────────────────────────────────────

export const issueCompTicketsInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  ticketTypeId: z.uuid(),
  quantity: z.number().int().min(1).max(100),
  recipientEmail: z.string().email().max(320),
  recipientName: plainTextOptional(200).optional(),
  reason: plainTextMultilineOptional(500).optional(),
});

export const issueCompTicketsOutputSchema = z.object({
  orderId: z.string().uuid(),
  recipientHumanId: z.string().uuid(),
});

export type IssueCompTicketsInput = z.infer<typeof issueCompTicketsInputSchema>;
export type IssueCompTicketsOutput = z.infer<
  typeof issueCompTicketsOutputSchema
>;

export type IssueCompTicketsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Issue complimentary (free) tickets to a recipient by email.
 *
 * Creates a $0 COMP order + mints tickets immediately. The recipient
 * gets an email with QR codes; no account required.
 */
export async function issueCompTickets(
  deps: IssueCompTicketsDeps,
  rawInput: unknown,
): Promise<IssueCompTicketsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "issueCompTickets" });

  const execute = async () => {
    const input = parseInput(issueCompTicketsInputSchema, rawInput);
    return executeIssueCompTickets(deps, scopedLogger, input);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("issueCompTickets", execute);
  }
  return execute();
}

async function executeIssueCompTickets(
  deps: IssueCompTicketsDeps,
  logger: LoggerPort | undefined,
  input: IssueCompTicketsInput,
): Promise<IssueCompTicketsOutput> {
  const { repos, clock } = deps;
  const now = clock.now();

  return repos.tx(async (tx) => {
    // 1. Load event and validate
    const event = await tx.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    // A COMMUNITY listing is ownerless and RSVP-only: no ticket types, no
    // orders, no one to issue on its behalf (owner ruling 2026-10-07: no comp
    // tickets on COMMUNITY events). Refused by stewardship, explicitly, BEFORE
    // the role check: the owner arms below would refuse an ownerless row too,
    // but only by accident of `humanId` being null, and a future widening of
    // them (e.g. a community-moderator arm) must not open comps here. Same
    // code checkout uses for an RSVP event.
    if (event.stewardship === "COMMUNITY") {
      throw fail("EVENT_NOT_TICKETED");
    }
    if (event.status === "CANCELLED") {
      throw fail("EVENT_CANCELLED");
    }
    if (event.status === "ARCHIVED") {
      throw fail("EVENT_ARCHIVED");
    }

    // 2. RBAC: require ADMIN or OWNER on the event's org
    if (event.orgId) {
      await requireOrgMembership({
        repos: tx,
        orgId: event.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_ADMIN_ROLES,
      });
    } else {
      // The owner, or an OWNER/ADMIN delegate (owner ruling 2026-09-28).
      await ensureActorHoldsHumanEventRole(
        tx.authz,
        event.humanId,
        input.actorHumanId,
        ORG_ADMIN_ROLES,
      );
    }

    // 2b. A DELEGATE may not comp themselves (owner ruling 2026-09-28) —
    // checked before the recipient is resolved, so a refusal creates no
    // shadow Human. Owners and org members pass untouched.
    await ensureDelegateNotSelfRecipient(tx.humans, {
      eventOwner: { orgId: event.orgId, humanId: event.humanId },
      actorHumanId: input.actorHumanId,
      recipientEmail: input.recipientEmail,
    });

    // 3. Validate ticket type
    const ticketTypes = await tx.events.listTicketTypes(input.eventId);
    const ticketType = ticketTypes.find((tt) => tt.id === input.ticketTypeId);
    if (!ticketType) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }

    // DELIBERATELY NOT GATED ON THE SALES WINDOW (packs FR-014). A comp is an
    // ORGANIZER action, not a purchase: comping a tier before it goes on sale —
    // guest list, press, artist holds — is routine, and comping one after it
    // closes is how a door problem gets fixed. `assertTicketTypeOnSale`
    // (lib/orders/door-pricing.ts) guards the five sites that TAKE MONEY;
    // this is not one of them, and the exemption is intentional rather than an
    // oversight. Note the capacity check immediately below is advisory here for
    // the same reason — an admin override already outranks the tier's own
    // limits on this path.
    //
    // 4. Check capacity (warn but don't block — admin override). Same
    // definition of a taken place as the pre-charge gate and the mint
    // backstop: refunded and revoked tickets do not count.
    const issuedCount = await tx.tickets.countCapacityConsumingForTicketType(
      input.ticketTypeId,
    );
    const remaining = ticketType.capacity - issuedCount;
    if (remaining < input.quantity) {
      logger?.warn("issueCompTickets.capacity_warning", {
        ticketTypeId: input.ticketTypeId,
        remaining,
        requested: input.quantity,
      });
    }

    // 5. Resolve recipient (creates shadow Human if needed)
    // Never renames an existing account (the organizer types the name).
    const guestResult = await ensureGuestHumanKeepingName(tx.humans, {
      email: input.recipientEmail,
      name: input.recipientName ?? null,
    });

    // 6. Create $0 COMP order + mint tickets
    const orderId = await createCompOrder(tx, {
      eventId: input.eventId,
      ticketTypeId: input.ticketTypeId,
      quantity: input.quantity,
      buyerHumanId: guestResult.humanId,
      now,
      // Stamped on the order so the comps ledger is a plain Order read. The
      // audit-log entry below is retained deliberately — it stays the
      // tamper-evident record; these columns are the queryable projection.
      compReason: input.reason ?? null,
      compIssuedByHumanId: input.actorHumanId,
    });

    // 7. Audit log
    await tx.audit.log({
      entity: "order",
      entityId: orderId,
      action: "comp_issued",
      data: {
        eventId: input.eventId,
        ticketTypeId: input.ticketTypeId,
        quantity: input.quantity,
        recipientEmail: input.recipientEmail,
        recipientHumanId: guestResult.humanId,
        issuedByHumanId: input.actorHumanId,
        reason: input.reason ?? null,
      },
      at: now,
    });

    logger?.info("issueCompTickets.succeeded", { orderId });

    return issueCompTicketsOutputSchema.parse({
      orderId,
      recipientHumanId: guestResult.humanId,
    });
  });
}

// ── Helper: create $0 comp order + mint tickets ────────────────────────────

export async function createCompOrder(
  tx: TxRepos,
  params: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    buyerHumanId: string;
    now: Date;
    /**
     * Hand-issue provenance. Omitted by `grantVolunteerReward` — a
     * trigger-issued comp has no typed reason and no human issuer, and is
     * identified by its VolunteerRewardGrant row instead. Null here therefore
     * means "not hand-issued", never "unknown".
     */
    compReason?: string | null;
    compIssuedByHumanId?: string | null;
  },
): Promise<string> {
  const orderId = randomUUID();

  // FR-003 (organiser-resale-share): a comp is a first sale at $0, so each
  // ticket records the event's resale clause in force now and an original
  // price of 0. Read here, in the caller's transaction, so both callers
  // (`issueCompTickets`, `grantVolunteerReward`) stamp it.
  const event = await tx.events.getById(params.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  const resaleClause = await resolveTicketResaleClause(tx, event);

  const items = stampTicketResaleClause(
    Array.from({ length: params.quantity }, () => ({
      kind: "ticket" as const,
      ticketTypeId: params.ticketTypeId,
      qty: 1,
      unitPriceCents: 0,
      amountCents: 0,
    })),
    resaleClause,
  );

  await tx.orders.createPending({
    id: orderId,
    eventId: params.eventId,
    buyerHumanId: params.buyerHumanId,
    amountGrossCents: 0,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    source: "COMP",
    compReason: params.compReason ?? null,
    compIssuedByHumanId: params.compIssuedByHumanId ?? null,
    items,
  });

  await tx.orders.markSucceeded(orderId);

  const fullOrder = await tx.orders.getById(orderId);
  if (!fullOrder) {
    throw fail("ORDER_NOT_FOUND", { meta: { kind: "comp" } });
  }
  fullOrder.status = "SUCCEEDED";

  await mintTicketsForOrder(tx, {
    order: fullOrder,
    issuedAt: params.now,
    actor: { kind: "system", reason: "comp_ticket_issuance" },
  });

  return orderId;
}
