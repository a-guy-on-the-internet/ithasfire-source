import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  EventVolunteerRoleRecord,
  EventVolunteerRoleWithShiftsRecord,
  RoleTemplateShiftRecord,
} from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { resolveOrCreateEventAsk } from "./_shared/resolve-event-ask";
import {
  createEventVolunteerRoleInputSchema,
  createFromTemplatesInputSchema,
  updateEventVolunteerRoleInputSchema,
  deleteEventVolunteerRoleInputSchema,
  listEventVolunteerRolesInputSchema,
  type CreateEventVolunteerRoleUseCaseInput,
  type CreateFromTemplatesUseCaseInput,
  type UpdateEventVolunteerRoleUseCaseInput,
  type DeleteEventVolunteerRoleUseCaseInput,
  type ListEventVolunteerRolesUseCaseInput,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ManageEventVolunteerRolesDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Authorize the actor on the event's org and hand back BOTH the event and
 * its (now proven non-null) `orgId`. Callers need the id as a `string` to
 * scope template lookups by tenant — returning it separately keeps that
 * narrowing in one place instead of re-asserting it per call site.
 */
async function resolveEventOrg(
  tx: Parameters<Parameters<Repos["tx"]>[0]>[0],
  eventId: string,
  actorHumanId: string,
) {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  const orgId = event.orgId;
  if (!orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }
  await requireOrgMembership({
    repos: tx,
    orgId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
  return { event, orgId };
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a volunteer role for a specific event.
 *
 * If `templateId` is provided, copies name/description/capacity from the
 * template as defaults. A template is usable here when it is EITHER this
 * event's org's own row OR a LIVE platform catalogue row (FR-010) — and
 * nothing wider. This used to be an unscoped `getRoleTemplate(id)`, which
 * let any org seed a role from another org's private template by id;
 * anything not usable now uniformly yields TEMPLATE_NOT_FOUND without
 * confirming the row exists.
 *
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function createEventVolunteerRole(
  deps: ManageEventVolunteerRolesDeps,
  rawInput: unknown,
): Promise<EventVolunteerRoleRecord> {
  const input = parseInput(createEventVolunteerRoleInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { event, orgId } = await resolveEventOrg(
      tx,
      input.eventId,
      input.actorHumanId,
    );

    // If template is provided, resolve it for defaults
    let name = input.name;
    let description = input.description ?? null;
    let capacity = input.capacity ?? null;

    if (input.templateId) {
      const template = await tx.volunteering.getRoleTemplateUsableBy(
        input.templateId,
        orgId,
      );
      if (!template) {
        throw fail("TEMPLATE_NOT_FOUND");
      }
      // Use template values as defaults only if input didn't provide them
      if (!input.name) name = template.name;
      if (input.description === undefined) description = template.description;
      if (input.capacity === undefined) capacity = template.defaultCapacity;
    }

    // Stamp the event's EVENT-subject ask (lazily created for events that
    // enabled volunteering after the A1 backfill) so new event roles match
    // the backfilled rows' eventId+askId shape.
    const eventAsk = await resolveOrCreateEventAsk(tx, event);

    const created = await tx.volunteering.createEventRole({
      eventId: input.eventId,
      askId: eventAsk.id,
      templateId: input.templateId ?? null,
      name,
      description,
      capacity,
      autoApprove: input.autoApprove ?? null,
    });

    await tx.audit.log({
      entity: "event_volunteer_role",
      entityId: created.id,
      action: "created",
      data: {
        eventId: input.eventId,
        name,
        templateId: input.templateId ?? null,
      },
      at: deps.clock.now(),
    });

    return created;
  });
}

// ── Create from templates (bulk) ────────────────────────────────────────────

export interface CreateFromTemplatesOutput {
  roles: EventVolunteerRoleRecord[];
  /**
   * Per-role shift presets carried over from the template (offset form).
   * The UI materializes these against the event's `startsAt` (or "today"
   * when the event has none) and seeds them into the shift composer for
   * the organizer to confirm. We deliberately don't auto-persist them as
   * `EventVolunteerShift` rows — letting the user review prevents
   * surprises when the template was authored for a different time of day.
   */
  templateShiftsByRoleId: Record<string, RoleTemplateShiftRecord[]>;
  /** Echoed back so the UI can decide whether to fall back to "today". */
  eventStartsAt: Date | null;
}

/**
 * Bulk-create event volunteer roles from role templates — the event's own
 * org's templates and LIVE platform catalogue rows alike (FR-010). A
 * template owned by another org, or one belonging to a DRAFT pack, yields
 * TEMPLATE_NOT_FOUND and rolls the whole batch back.
 *
 * Returns the materialized shift drafts alongside each role so the apply
 * flow can seed `InlineShiftComposer` without an extra round trip.
 * Shifts are NOT auto-persisted — the organizer confirms via the
 * composer.
 *
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function createFromTemplates(
  deps: ManageEventVolunteerRolesDeps,
  rawInput: unknown,
): Promise<CreateFromTemplatesOutput> {
  const input = parseInput(createFromTemplatesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { event, orgId } = await resolveEventOrg(
      tx,
      input.eventId,
      input.actorHumanId,
    );

    // One EVENT-ask resolution for the whole batch (see
    // createEventVolunteerRole).
    const eventAsk = await resolveOrCreateEventAsk(tx, event);

    const roles: EventVolunteerRoleRecord[] = [];
    const createdFrom: Array<{ roleId: string; templateId: string }> = [];

    for (const templateId of input.templateIds) {
      const template = await tx.volunteering.getRoleTemplateUsableBy(
        templateId,
        orgId,
      );
      if (!template) {
        throw fail("TEMPLATE_NOT_FOUND", { meta: { templateId } });
      }

      const created = await tx.volunteering.createEventRole({
        eventId: input.eventId,
        askId: eventAsk.id,
        templateId,
        name: template.name,
        description: template.description,
        capacity: template.defaultCapacity,
      });

      roles.push(created);
      createdFrom.push({ roleId: created.id, templateId });
    }

    // Template shifts in ONE query to avoid N+1, and deliberately AFTER the
    // tenancy loop: only ids this org was cleared to use are ever passed in,
    // so a foreign template's shifts are not merely filtered out of the
    // response — they are never read.
    const shiftsByTemplateId =
      await tx.volunteering.listRoleTemplateShiftsByTemplateIds(
        createdFrom.map((c) => c.templateId),
      );

    const templateShiftsByRoleId: Record<string, RoleTemplateShiftRecord[]> =
      {};
    for (const { roleId, templateId } of createdFrom) {
      templateShiftsByRoleId[roleId] = shiftsByTemplateId[templateId] ?? [];
    }

    await tx.audit.log({
      entity: "event_volunteer_role",
      entityId: input.eventId,
      action: "bulk_created_from_templates",
      data: {
        eventId: input.eventId,
        templateIds: input.templateIds,
        count: roles.length,
      },
      at: deps.clock.now(),
    });

    return {
      roles,
      templateShiftsByRoleId,
      eventStartsAt: event.startsAt ?? null,
    };
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Update an event volunteer role.
 *
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function updateEventVolunteerRole(
  deps: ManageEventVolunteerRolesDeps,
  rawInput: unknown,
): Promise<EventVolunteerRoleRecord> {
  const input = parseInput(updateEventVolunteerRoleInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const role = await tx.volunteering.getEventRole(input.id);
    // Ask-owned roles (nullable eventId since generic asks) are managed by
    // the ask role flow (A4), not this event-scoped use case.
    if (!role || !role.eventId) {
      throw fail("ROLE_NOT_FOUND");
    }

    await resolveEventOrg(tx, role.eventId, input.actorHumanId);

    const updated = await tx.volunteering.updateEventRole(input.id, {
      name: input.name,
      description: input.description,
      capacity: input.capacity,
      autoApprove: input.autoApprove,
      sortOrder: input.sortOrder,
    });

    await tx.audit.log({
      entity: "event_volunteer_role",
      entityId: input.id,
      action: "updated",
      data: { name: input.name },
      at: deps.clock.now(),
    });

    return updated;
  });
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete an event volunteer role.
 *
 * Cascade-deletes shifts. Signups are deleted via Prisma cascade.
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function deleteEventVolunteerRole(
  deps: ManageEventVolunteerRolesDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(deleteEventVolunteerRoleInputSchema, rawInput);

  await deps.repos.tx(async (tx) => {
    const role = await tx.volunteering.getEventRole(input.id);
    // Ask-owned roles (nullable eventId since generic asks) are managed by
    // the ask role flow (A4), not this event-scoped use case.
    if (!role || !role.eventId) {
      throw fail("ROLE_NOT_FOUND");
    }

    await resolveEventOrg(tx, role.eventId, input.actorHumanId);

    await tx.volunteering.deleteEventRole(input.id);

    await tx.audit.log({
      entity: "event_volunteer_role",
      entityId: input.id,
      action: "deleted",
      data: { eventId: role.eventId, name: role.name },
      at: deps.clock.now(),
    });
  });
}

// ── List ────────────────────────────────────────────────────────────────────

/**
 * List volunteer roles (with shifts) for an event.
 *
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function listEventVolunteerRoles(
  deps: ManageEventVolunteerRolesDeps,
  rawInput: unknown,
): Promise<EventVolunteerRoleWithShiftsRecord[]> {
  const input = parseInput(listEventVolunteerRolesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await resolveEventOrg(tx, input.eventId, input.actorHumanId);

    return tx.volunteering.listEventRoles(input.eventId);
  });
}
