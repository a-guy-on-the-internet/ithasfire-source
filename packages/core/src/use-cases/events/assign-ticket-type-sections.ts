import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { ensureSeatSectionsBelongToEvent } from "./_shared/ensure-seat-sections-of-event";
import {
  ensureStoredOverridesGatedForTierWrites,
  type TierSectionWrite,
} from "./_shared/seat-price-override-rules";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each assignment maps a ticket type to a seat section (or `null` to unassign).
 */
const assignmentSchema = z
  .object({
    ticketTypeId: z.uuid(),
    seatSectionId: z.string().uuid().nullable(),
  })
  .strict();

export const assignTicketTypeSectionsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    assignments: z.array(assignmentSchema).min(1).max(100),
  })
  .strict();

export const assignTicketTypeSectionsOutputSchema = z
  .object({
    eventId: z.uuid(),
    updated: z.number().int(),
  })
  .strict();

export type AssignTicketTypeSectionsInput = z.infer<
  typeof assignTicketTypeSectionsInputSchema
>;
export type AssignTicketTypeSectionsOutput = z.infer<
  typeof assignTicketTypeSectionsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type AssignTicketTypeSectionsDeps = {
  repos: Repos;
  /** The instant the stored-override money gate's fee-policy walk reads at. */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports a corrupt stored seat price override the money gate counted as
   * paid (CLAUDE.md error convention). Wire it from `ctx.reportError`.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function assignTicketTypeSections(
  deps: AssignTicketTypeSectionsDeps,
  rawInput: unknown,
): Promise<AssignTicketTypeSectionsOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "assignTicketTypeSections",
  });

  const execute = async (): Promise<AssignTicketTypeSectionsOutput> => {
    const input = parseInput(assignTicketTypeSectionsInputSchema, rawInput);

    const result = await deps.repos.tx(async (tx) => {
      // 1. Validate event exists
      const event = await tx.events.getById(input.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }

      // 2. Authz
      await ensureActorCanEdit(tx, event, input.actorHumanId);

      // 3. Event must be editable (DRAFT or PUBLISHED with no tickets sold)
      ensureEventIsEditable(event);

      // 4. Read and validate every assignment before any write.
      const writes: TierSectionWrite[] = [];
      for (const assignment of input.assignments) {
        const ticketType = await tx.tickets.getTicketTypeById(
          assignment.ticketTypeId,
        );
        if (!ticketType) {
          throw fail("TICKET_TYPE_NOT_FOUND");
        }
        if (ticketType.eventId !== input.eventId) {
          throw fail("TICKET_TYPE_EVENT_MISMATCH");
        }
        writes.push({
          before: ticketType,
          after: { ...ticketType, seatSectionId: assignment.seatSectionId },
        });
      }

      //    Still validation: every section named must be one of THIS event's
      //    (the store only needs it to exist). One read for the whole call;
      //    a call of unassigns reads nothing. Refused before the gate and
      //    before any write, as not found whether the section is another
      //    event's or nobody's.
      await ensureSeatSectionsBelongToEvent(
        tx.seats,
        event.id,
        input.assignments.map((assignment) => assignment.seatSectionId),
      );

      // 5. Money gate: a free FIXED tier may not start selling a section
      //    that already stores a paid seat price override without the gates
      //    the override write runs. An unassign is never refused.
      await ensureStoredOverridesGatedForTierWrites(
        tx,
        event,
        writes,
        deps.clock.now(),
        {
          logger: scopedLogger,
          reportError: deps.reportError,
          source: "assignTicketTypeSections",
        },
      );

      // 6. Apply each assignment inside the same transaction
      let updated = 0;
      for (const assignment of input.assignments) {
        await tx.tickets.updateTicketType({
          id: assignment.ticketTypeId,
          seatSectionId: assignment.seatSectionId,
        });
        updated++;
      }

      // 7. Audit log
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "ticket_type_sections_assigned",
        data: {
          actorHumanId: input.actorHumanId,
          assignments: input.assignments,
        },
      });

      return { eventId: event.id, updated };
    });

    return assignTicketTypeSectionsOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("assignTicketTypeSections", execute);
  }

  return execute();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureEventIsEditable(event: EventRecord): void {
  if (
    event.status === "CANCELLED" ||
    event.status === "COMPLETED" ||
    event.status === "ARCHIVED"
  ) {
    throw fail("EVENT_NOT_EDITABLE");
  }
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
    return;
  }

  await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
}
