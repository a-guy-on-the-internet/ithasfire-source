import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const listEventTicketTypesForEditInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const listEventTicketTypesForEditOutputSchema = z
  .object({
    eventId: z.uuid(),
    /** Place layout ID assigned to this event. Null when GA (no assigned layout). */
    placeLayoutId: z.string().uuid().nullable(),
    ticketTypes: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          /**
           * The STORED list price, deliberately NOT resolved through
           * `resolveUnitPriceCents`. See the note on the use case below: this
           * is the value bound to the admin editor's Price field, and resolving
           * it would make the form round-trip the post-flip price back into
           * `priceCents` on the next save, destroying the schedule.
           */
          priceCents: z.number().int(),
          pricingMode: z.enum(["FIXED", "ADJUSTABLE"]),
          minimumCents: z.number().int().nullable(),
          suggestedCents: z.number().int().nullable(),
          capacity: z.number().int(),
          status: z.enum(["DRAFT", "ACTIVE"]),
          seatSectionId: z.string().uuid().nullable(),
          /** Layout-internal section key (e.g. "ga-floor") for matching with PlaceLayout sections. */
          layoutSectionId: z.string().nullable(),
          resaleAllowed: z.boolean(),
          resaleCapCents: z.number().int().nullable(),
          transferAllowed: z.boolean(),
          /**
           * Scheduled price change (FR-005), both null or both set. Surfaced so
           * the editor can READ BACK what the organizer set — Q-002's resolved
           * decision makes this mandatory in Phase 1c, because FR-007's
           * timezone correctness is unverifiable by the only person who can
           * catch a mistake unless the resolved instant is shown back.
           */
          scheduledPriceCents: z.number().int().nullable(),
          scheduledPriceAt: z.date().nullable(),
          /**
           * Per-type sales window (FR-009 / packs FR-014), each bound
           * INDEPENDENTLY nullable — unlike the schedule pair above there is no
           * both-or-neither rule, because "opens Friday, never closes" is a
           * complete configuration.
           *
           * Surfaced for the same reason the schedule pair is: FR-013's admin
           * control cannot seed its edit form, and the ticket list cannot show
           * a saved window, from a projection that does not carry it. Until
           * this was added the organizer had no way to see or change a window
           * they had already set.
           */
          salesOpenAt: z.date().nullable(),
          salesCloseAt: z.date().nullable(),
          /**
           * What this tier costs an online buyer RIGHT NOW, resolved through
           * `resolveUnitPriceCents` (FR-004). Present so any admin surface that
           * wants "what is it selling for" reads a resolved number instead of
           * reaching for `priceCents`. Display-only — never write it back.
           */
          effectivePriceCents: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListEventTicketTypesForEditInput = z.infer<
  typeof listEventTicketTypesForEditInputSchema
>;
export type ListEventTicketTypesForEditOutput = z.infer<
  typeof listEventTicketTypesForEditOutputSchema
>;

export type ListEventTicketTypesForEditDeps = {
  repos: Repos;
  /** Required (FR-003) — feeds `effectivePriceCents`. */
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * ADMIN EDIT projection of an event's ticket types.
 *
 * DELIBERATE FR-004 EXEMPTION, and the one place in this migration where
 * resolving would be a bug rather than a fix. FR-004's site inventory lists
 * this file, but it is an EDIT FORM projection, not a price display: its
 * `priceCents` is the value bound to the organizer's Price input, and
 * `updateTicketType` writes that same field straight back. If this returned the
 * resolved price, then after a flip the form would render $20 in the Price box
 * and the organizer's next save — of any unrelated field — would persist
 * priceCents=2000 alongside scheduledPriceCents=2000, silently collapsing the
 * schedule and destroying the pre-flip price with no history (which
 * `out_of_scope` explicitly declines to keep).
 *
 * Instead the raw price stays raw and the resolved view is ADDITIVE:
 * `effectivePriceCents` for "what it costs now", plus the schedule pair for the
 * Q-002 read-back. Nothing here can be mistaken for a money-authoritative read.
 */
export async function listEventTicketTypesForEdit(
  deps: ListEventTicketTypesForEditDeps,
  rawInput: unknown,
): Promise<ListEventTicketTypesForEditOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "listEventTicketTypesForEdit",
  });

  const execute = async (): Promise<ListEventTicketTypesForEditOutput> => {
    const input = parseInput(listEventTicketTypesForEditInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    await ensureActorCanEdit(deps, event, input.actorHumanId);

    const ticketTypes = await deps.repos.events.listTicketTypes(event.id);

    // Single query for all sections — avoids N+1 per ticket type.
    const allSections = await deps.repos.seats.listSectionsByEvent(event.id);
    const sectionLookup = new Map<string, string | null>();
    for (const sec of allSections) {
      sectionLookup.set(sec.id, sec.layoutSectionId ?? null);
    }

    const now = deps.clock.now();

    return listEventTicketTypesForEditOutputSchema.parse({
      eventId: event.id,
      placeLayoutId: event.placeLayoutId ?? null,
      ticketTypes: ticketTypes.map((tt) => ({
        id: tt.id,
        name: tt.name,
        priceCents: tt.priceCents,
        pricingMode: tt.pricingMode ?? "FIXED",
        minimumCents: tt.minimumCents ?? null,
        suggestedCents: tt.suggestedCents ?? null,
        capacity: tt.capacity,
        status: tt.status,
        seatSectionId: tt.seatSectionId ?? null,
        layoutSectionId: tt.seatSectionId
          ? (sectionLookup.get(tt.seatSectionId) ?? null)
          : null,
        resaleAllowed: tt.resaleAllowed,
        resaleCapCents: tt.resaleCapCents,
        transferAllowed: tt.transferAllowed,
        scheduledPriceCents: tt.scheduledPriceCents ?? null,
        scheduledPriceAt: tt.scheduledPriceAt ?? null,
        salesOpenAt: tt.salesOpenAt ?? null,
        salesCloseAt: tt.salesCloseAt ?? null,
        effectivePriceCents: resolveUnitPriceCents(tt, { now }),
      })),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listEventTicketTypesForEdit", execute);
  }

  return execute();
}

async function ensureActorCanEdit(
  deps: ListEventTicketTypesForEditDeps,
  event: EventRecord,
  actorHumanId: string,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }

  await ensureActorHoldsHumanEventRole(
    deps.repos.authz,
    event.humanId,
    actorHumanId,
  );
}
