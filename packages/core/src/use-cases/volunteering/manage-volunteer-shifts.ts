import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { VolunteerShiftRecord } from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  createVolunteerShiftInputSchema,
  createVolunteerShiftBatchInputSchema,
  updateVolunteerShiftInputSchema,
  deleteVolunteerShiftInputSchema,
  listVolunteerShiftsInputSchema,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ManageVolunteerShiftsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveRoleEvent(
  tx: Parameters<Parameters<Repos["tx"]>[0]>[0],
  roleId: string,
  actorHumanId: string,
) {
  const role = await tx.volunteering.getEventRole(roleId);
  // Ask-owned roles (nullable eventId since generic asks) never carry
  // shifts — v1 ask scheduling is the ask's window only (A4 manages them).
  if (!role || !role.eventId) {
    throw fail("ROLE_NOT_FOUND");
  }

  const event = await tx.events.getById(role.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  await requireOrgMembership({
    repos: tx,
    orgId: event.orgId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  return { role, event };
}

async function resolveShiftRoleEvent(
  tx: Parameters<Parameters<Repos["tx"]>[0]>[0],
  shiftId: string,
  actorHumanId: string,
) {
  const shift = await tx.volunteering.getShift(shiftId);
  if (!shift) {
    throw fail("SHIFT_NOT_FOUND");
  }
  const { role, event } = await resolveRoleEvent(
    tx,
    shift.roleId,
    actorHumanId,
  );
  return { shift, role, event };
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a shift within a volunteer role.
 *
 * Validates `endsAt > startsAt` at the schema level.
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function createVolunteerShift(
  deps: ManageVolunteerShiftsDeps,
  rawInput: unknown,
): Promise<VolunteerShiftRecord> {
  const input = parseInput(createVolunteerShiftInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await resolveRoleEvent(tx, input.roleId, input.actorHumanId);

    const created = await tx.volunteering.createShift({
      roleId: input.roleId,
      label: input.label ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      capacity: input.capacity ?? null,
      notes: input.notes ?? null,
    });

    await tx.audit.log({
      entity: "volunteer_shift",
      entityId: created.id,
      action: "created",
      data: { roleId: input.roleId, label: input.label ?? null },
      at: deps.clock.now(),
    });

    return created;
  });
}

/**
 * Create multiple shifts for a volunteer role in one request.
 *
 * Validates at least one shift draft and `endsAt > startsAt` for each row.
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function createVolunteerShiftBatch(
  deps: ManageVolunteerShiftsDeps,
  rawInput: unknown,
): Promise<VolunteerShiftRecord[]> {
  const input = parseInput(createVolunteerShiftBatchInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await resolveRoleEvent(tx, input.roleId, input.actorHumanId);
    const existingShifts = await tx.volunteering.listShifts(input.roleId);
    let nextSortOrder =
      existingShifts.reduce(
        (maxSortOrder, shift) => Math.max(maxSortOrder, shift.sortOrder),
        -1,
      ) + 1;

    const createdShifts: VolunteerShiftRecord[] = [];

    for (const shift of input.shifts) {
      const created = await tx.volunteering.createShift({
        roleId: input.roleId,
        label: shift.label ?? null,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        capacity: shift.capacity ?? null,
        notes: shift.notes ?? null,
        sortOrder: nextSortOrder++,
      });

      await tx.audit.log({
        entity: "volunteer_shift",
        entityId: created.id,
        action: "created",
        data: { roleId: input.roleId, label: shift.label ?? null },
        at: deps.clock.now(),
      });

      createdShifts.push(created);
    }

    return createdShifts;
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Update an existing volunteer shift.
 *
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function updateVolunteerShift(
  deps: ManageVolunteerShiftsDeps,
  rawInput: unknown,
): Promise<VolunteerShiftRecord> {
  const input = parseInput(updateVolunteerShiftInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await resolveShiftRoleEvent(tx, input.id, input.actorHumanId);

    const updated = await tx.volunteering.updateShift(input.id, {
      label: input.label,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      capacity: input.capacity,
      notes: input.notes,
      sortOrder: input.sortOrder,
    });

    await tx.audit.log({
      entity: "volunteer_shift",
      entityId: input.id,
      action: "updated",
      data: { roleId: updated.roleId },
      at: deps.clock.now(),
    });

    return updated;
  });
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a volunteer shift.
 *
 * Nulls out `shiftId` on existing signups (handled by Prisma onDelete: SetNull).
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function deleteVolunteerShift(
  deps: ManageVolunteerShiftsDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(deleteVolunteerShiftInputSchema, rawInput);

  await deps.repos.tx(async (tx) => {
    const { shift } = await resolveShiftRoleEvent(
      tx,
      input.id,
      input.actorHumanId,
    );

    await tx.volunteering.deleteShift(input.id);

    await tx.audit.log({
      entity: "volunteer_shift",
      entityId: input.id,
      action: "deleted",
      data: { roleId: shift.roleId },
      at: deps.clock.now(),
    });
  });
}

// ── List ────────────────────────────────────────────────────────────────────

/**
 * List shifts for a volunteer role.
 *
 * Auth: OWNER | ADMIN | EDITOR on the event's org.
 */
export async function listVolunteerShifts(
  deps: ManageVolunteerShiftsDeps,
  rawInput: unknown,
): Promise<VolunteerShiftRecord[]> {
  const input = parseInput(listVolunteerShiftsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await resolveRoleEvent(tx, input.roleId, input.actorHumanId);

    return tx.volunteering.listShifts(input.roleId);
  });
}
