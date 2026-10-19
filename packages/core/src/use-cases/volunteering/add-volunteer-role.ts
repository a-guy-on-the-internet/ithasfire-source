import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventVolunteerRoleRecord } from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import {
  addVolunteerAskRoleInputSchema,
  updateVolunteerAskRoleInputSchema,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ManageVolunteerAskRolesDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Add ─────────────────────────────────────────────────────────────────────

/**
 * Add a volunteer role owned by a generic ask (FR-002). The role row lives
 * in `EventVolunteerRole` with `askId` set and NO `eventId` — event-owned
 * roles keep flowing through `createEventVolunteerRole`.
 *
 * - Authz: `resolveAskOwnership` inside the same tx as the write.
 * - Template seeding mirrors `createEventVolunteerRole`: the template fills
 *   description/capacity only when the input didn't provide them. A
 *   template is usable here when it is EITHER this ask's org's own row OR a
 *   LIVE platform catalogue row (FR-010) — and nothing wider. A template
 *   owned by a DIFFERENT org, and a platform role whose pack is still
 *   DRAFT, both yield TEMPLATE_NOT_FOUND without confirming the row exists.
 *   An ask with no denormalized orgId can still seed from the LIVE
 *   catalogue, but never from any org's private templates.
 * - Role names are unique per ask; the adapter's
 *   `{ code: "duplicate_role_name" }` conflict propagates untouched.
 */
export async function addVolunteerAskRole(
  deps: ManageVolunteerAskRolesDeps,
  rawInput: unknown,
): Promise<EventVolunteerRoleRecord> {
  const input = parseInput(addVolunteerAskRoleInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    await resolveAskOwnership(tx, ask, input.actorHumanId);

    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    // Template seeding — mirrors createEventVolunteerRole's field copying.
    let description = input.description ?? null;
    let capacity = input.capacity ?? null;

    if (input.templateId) {
      // Tenancy is resolved in the query, not after it: "this ask's org's
      // row, or a LIVE platform row". `ask.orgId` null narrows to the
      // catalogue only — it must never mean "any row".
      const template = await tx.volunteering.getRoleTemplateUsableBy(
        input.templateId,
        ask.orgId,
      );
      if (!template) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      if (input.description === undefined) description = template.description;
      if (input.capacity === undefined) capacity = template.defaultCapacity;
    }

    const created = await tx.volunteering.createEventRole({
      askId: input.askId,
      templateId: input.templateId ?? null,
      name: input.name,
      description,
      capacity,
      defaultHours: input.defaultHours ?? null,
    });

    await tx.audit.log({
      entity: "event_volunteer_role",
      entityId: created.id,
      action: "created",
      data: {
        askId: input.askId,
        name: input.name,
        templateId: input.templateId ?? null,
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return created;
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Update an ask-owned volunteer role (name/description/capacity/
 * defaultHours).
 *
 * Deliberately a TWIN of `updateEventVolunteerRole` rather than a widened
 * guard on it: the event path authorizes via the event's org and must keep
 * rejecting ask-only roles (`!role.eventId` → ROLE_NOT_FOUND), while this
 * path authorizes via the ask subject. One trust gate per owner keeps both
 * legible. Roles that carry an eventId (event-owned, including backfilled
 * EVENT-ask roles) uniformly 404 here and stay managed by the event flow.
 */
export async function updateVolunteerAskRole(
  deps: ManageVolunteerAskRolesDeps,
  rawInput: unknown,
): Promise<EventVolunteerRoleRecord> {
  const input = parseInput(updateVolunteerAskRoleInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const role = await tx.volunteering.getEventRole(input.id);
    if (!role || !role.askId || role.eventId) {
      throw fail("ROLE_NOT_FOUND");
    }

    const ask = await tx.volunteering.getAsk(role.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    await resolveAskOwnership(tx, ask, input.actorHumanId);

    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    // Rename races the per-ask unique the same way create does; the
    // adapter's duplicate_role_name conflict propagates untouched.
    const updated = await tx.volunteering.updateEventRole(input.id, {
      name: input.name,
      description: input.description,
      capacity: input.capacity,
      defaultHours: input.defaultHours,
    });

    await tx.audit.log({
      entity: "event_volunteer_role",
      entityId: input.id,
      action: "updated",
      data: {
        askId: role.askId,
        name: input.name,
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return updated;
  });
}
