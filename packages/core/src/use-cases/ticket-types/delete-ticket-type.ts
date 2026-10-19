import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { markForSearchReindex } from "../search/search-reindex-marks";

export const deleteTicketTypeInputSchema = z.object({
  actorHumanId: z.uuid(),
  ticketTypeId: z.uuid(),
});

export const deleteTicketTypeOutputSchema = z.object({
  ticketTypeId: z.uuid(),
  deleted: z.literal(true),
});

export type DeleteTicketTypeInput = z.infer<typeof deleteTicketTypeInputSchema>;
export type DeleteTicketTypeOutput = z.infer<
  typeof deleteTicketTypeOutputSchema
>;

export type DeleteTicketTypeDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /** Stamps the search reindex mark (`search/search-reindex-marks.ts`). */
  clock: ClockPort;
};

export async function deleteTicketType(
  deps: DeleteTicketTypeDeps,
  rawInput: unknown,
): Promise<DeleteTicketTypeOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "deleteTicketType" });

  const execute = async (): Promise<DeleteTicketTypeOutput> => {
    const input = parseInput(deleteTicketTypeInputSchema, rawInput);

    return deps.repos.tx(async (tx) => {
      const ticketType = await tx.tickets.getTicketTypeById(input.ticketTypeId);
      if (!ticketType) {
        throw fail("TICKET_TYPE_NOT_FOUND");
      }

      const event = await tx.events.getById(ticketType.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }

      await ensureActorCanEdit(tx, event, input.actorHumanId);
      ensureEventIsEditable(event);

      // Refuse to delete a ticket type that has already issued tickets —
      // orders/finance reference it, and OrderItem.ticketTypeId is SET NULL on
      // delete, which would orphan sold-ticket reporting. Sold types must be
      // archived via the normal flow, not removed.
      const issued = await tx.tickets.countIssuedForTicketType(ticketType.id);
      if (issued > 0) {
        throw fail("TICKET_TYPE_HAS_SALES");
      }

      await tx.tickets.deleteTicketType(ticketType.id);

      await tx.audit.log({
        entity: "ticket_type",
        entityId: ticketType.id,
        action: "deleted",
        data: {
          eventId: event.id,
          name: ticketType.name,
          actorHumanId: input.actorHumanId,
        },
        at: new Date(),
      });

      // The event document stamps its tiers' pricing.
      if (event.status === "PUBLISHED") {
        await markForSearchReindex(
          tx,
          [{ kind: "event", id: event.id }],
          deps.clock.now(),
        );
      }

      return deleteTicketTypeOutputSchema.parse({
        ticketTypeId: ticketType.id,
        deleted: true,
      });
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("deleteTicketType", execute);
  }

  return execute();
}

async function ensureActorCanEdit(
  tx: TxRepos,
  event: EventRecord,
  actorHumanId: string,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
  }
}

function ensureEventIsEditable(event: EventRecord): void {
  if (event.status === "ARCHIVED" || event.status === "CANCELLED") {
    throw fail("EVENT_NOT_EDITABLE");
  }
}
