import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "../events/_shared/ensure-actor-can-edit-event";
import { ARRIVAL_AREA_AUDIT_ACTIONS } from "./_shared/arrival-area-audit";
import {
  kindAllowedBy,
  probeEventAreaStaff,
  resolveEventAreaAccess,
} from "./_shared/event-area-access";
import {
  buildEventEditorList,
  listArrivalAreasForEditorOutputSchema,
  type ListArrivalAreasForEditorOutput,
} from "./list-arrival-areas-for-editor";

// ─────────────────────────────────────────────────────────────────────────────
// Hide or show one PLACE area on one event (arrival-areas FR-004, FR-013).
//
// Who: whoever may edit the event (`ensureActorCanEditEvent`).
// Which area: a place area of the event's CURRENT place that this editor
// may see in the editor (`resolveEventAreaAccess`, the projection's rule:
// the place's exact address must be visible to them, and the place's LOAD_IN
// only to its managers). Anything else (an event-only area, another place's
// area, an area this editor cannot see, a missing id) is
// ARRIVAL_AREA_NOT_FOUND, so a hide can neither reveal nor probe another
// place's areas.
//
// Idempotent: hiding a hidden area (or showing a shown one) writes nothing
// and audits nothing. Runs under `arrivalAreas.lockParent` on the event, so
// it serialises with an event save that changes the place (FR-014 deletes
// the hides that stop applying in that save's transaction).
// ─────────────────────────────────────────────────────────────────────────────

export const setEventArrivalAreaHiddenInputSchema = z
  .object({
    /** Server-injected (ctx); the transport must `.omit()` it from client input. */
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    arrivalAreaId: z.string().uuid(),
    hidden: z.boolean(),
  })
  .strict();

export type SetEventArrivalAreaHiddenInput = z.infer<
  typeof setEventArrivalAreaHiddenInputSchema
>;

export type SetEventArrivalAreaHiddenDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "canManagePlace" | "canEditEvent">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/** Answers with the event's editor list (see list-arrival-areas-for-editor). */
export async function setEventArrivalAreaHidden(
  deps: SetEventArrivalAreaHiddenDeps,
  rawInput: unknown,
): Promise<Extract<ListArrivalAreasForEditorOutput, { parent: "event" }>> {
  const input = parseInput(setEventArrivalAreaHiddenInputSchema, rawInput);
  // Advisory: fail fast without taking a lock.
  const preEvent = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  // Root-pool authz probes BEFORE the transaction (never under the lock).
  const staff = await probeEventAreaStaff(deps.authz, {
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
    placeId: preEvent.placeId ?? null,
  });
  const now = deps.clock.now();

  const changed = await deps.repos.tx(async (tx) => {
    if (!(await tx.arrivalAreas.lockParent({ eventId: input.eventId }))) {
      throw fail("EVENT_NOT_FOUND");
    }
    const event = await ensureActorCanEditEvent(
      tx,
      input.eventId,
      input.actorHumanId,
    );
    const area = await tx.arrivalAreas.getById(input.arrivalAreaId);
    if (!area || area.placeId === null || area.placeId !== event.placeId) {
      throw fail("ARRIVAL_AREA_NOT_FOUND", {
        meta: { arrivalAreaId: input.arrivalAreaId },
      });
    }
    const place = await tx.places.getById(area.placeId);
    const access = await resolveEventAreaAccess(
      { repos: tx },
      {
        event,
        place,
        viewerHumanId: input.actorHumanId,
        gateAccessGranted: true,
        now,
        // `placeStaff` only if the locked row still names the probed place.
        precomputedStaff: { ...staff, eventStaff: true },
      },
    );
    if (
      !place ||
      !access.addressVisible ||
      !kindAllowedBy({ ...area, source: "PLACE" }, access.grants)
    ) {
      throw fail("ARRIVAL_AREA_NOT_FOUND", {
        meta: { arrivalAreaId: input.arrivalAreaId },
      });
    }

    const wrote = input.hidden
      ? await tx.arrivalAreas.hide(input.eventId, input.arrivalAreaId)
      : await tx.arrivalAreas.unhide(input.eventId, input.arrivalAreaId);
    if (wrote) {
      await tx.audit.log({
        entity: "event",
        entityId: input.eventId,
        action: input.hidden
          ? ARRIVAL_AREA_AUDIT_ACTIONS.hidden
          : ARRIVAL_AREA_AUDIT_ACTIONS.unhidden,
        data: {
          actorHumanId: input.actorHumanId,
          eventId: input.eventId,
          arrivalAreaId: input.arrivalAreaId,
          placeId: area.placeId,
          before: { hidden: !input.hidden },
          after: { hidden: input.hidden },
        },
        at: now,
      });
    }
    return wrote;
  });

  if (changed) {
    deps.logger?.info(
      input.hidden ? "arrival_area_hidden" : "arrival_area_unhidden",
      { eventId: input.eventId, arrivalAreaId: input.arrivalAreaId },
    );
  }
  const list = listArrivalAreasForEditorOutputSchema.parse(
    await buildEventEditorList(deps, input.eventId, input.actorHumanId),
  );
  if (list.parent !== "event") throw new Error("unreachable: event editor list");
  return list;
}
