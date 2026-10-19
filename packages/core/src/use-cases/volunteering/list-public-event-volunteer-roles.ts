import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { ensureEventOpenToPublic } from "../events/_shared/event-open-to-public";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listPublicEventVolunteerRolesInputSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

export type ListPublicEventVolunteerRolesInput = z.infer<
  typeof listPublicEventVolunteerRolesInputSchema
>;

// Public DTO — intentionally narrower than the admin `EventVolunteerRole*Record`
// shape. We strip `templateId`, `autoApprove`, `notes`, and `createdAt` /
// `updatedAt` timestamps to avoid leaking admin-only details to
// unauthenticated viewers of the signup page.
export type PublicVolunteerShift = {
  id: string;
  label: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number | null;
  sortOrder: number;
  signupCount: number;
  /**
   * Accepted signups only (APPROVED | CHECKED_IN) — the number that counts
   * against `capacity`. `signupCount` stays pending-inclusive for
   * compatibility; the public form compares `acceptedCount` to `capacity`
   * to render "Full — you'll be waitlisted" without blocking applications.
   */
  acceptedCount: number;
};

export type PublicVolunteerRole = {
  id: string;
  name: string;
  description: string | null;
  capacity: number | null;
  sortOrder: number;
  signupCount: number;
  /** See `PublicVolunteerShift.acceptedCount`. */
  acceptedCount: number;
  shifts: PublicVolunteerShift[];
};

export type ListPublicEventVolunteerRolesOutput = {
  introText: string | null;
  roles: PublicVolunteerRole[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListPublicEventVolunteerRolesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public, unauthenticated use case powering the event volunteer signup page.
 *
 * Visibility gate mirrors `getPublicEventBody`:
 *   - event must exist
 *   - event must be PUBLISHED
 *   - event must have volunteering enabled
 *
 * Any gate failure throws `not_found` so the endpoint never leaks which of
 * those conditions failed (or that the event exists at all).
 *
 * All reads run inside a single `repos.tx()` for consistency and to avoid
 * an N+1 transaction pattern across roles/shifts.
 */
export async function listPublicEventVolunteerRoles(
  deps: ListPublicEventVolunteerRolesDeps,
  rawInput: unknown,
): Promise<ListPublicEventVolunteerRolesOutput> {
  const input = parseInput(listPublicEventVolunteerRolesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    // Conservative gate: collapse every "not visible" branch into the same
    // `not_found` shape — including a banned owner's event (ban-that-sticks),
    // the same gate as the signup it feeds.
    const event = await ensureEventOpenToPublic(tx, input.eventId);
    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_FOUND");
    }
    if (!event.volunteeringEnabled) {
      throw fail("EVENT_NOT_FOUND");
    }

    const roles = await tx.volunteering.listEventRoles(input.eventId);
    const [
      signupCountByRole,
      signupCountByShift,
      acceptedCountByRole,
      acceptedCountByShift,
    ] = await Promise.all([
      tx.volunteering.countByRole(input.eventId),
      tx.volunteering.countByShiftForEvent(input.eventId),
      tx.volunteering.countAcceptedByRole(input.eventId),
      tx.volunteering.countAcceptedByShiftForEvent(input.eventId),
    ]);

    const publicRoles: PublicVolunteerRole[] = roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      capacity: role.capacity,
      sortOrder: role.sortOrder,
      signupCount: signupCountByRole[role.id] ?? 0,
      acceptedCount: acceptedCountByRole[role.id] ?? 0,
      shifts: role.shifts.map((shift) => ({
        id: shift.id,
        label: shift.label,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        capacity: shift.capacity,
        sortOrder: shift.sortOrder,
        signupCount: signupCountByShift[shift.id] ?? 0,
        acceptedCount: acceptedCountByShift[shift.id] ?? 0,
      })),
    }));

    deps.logger?.info("volunteering.list_public_roles", {
      eventId: event.id,
      roleCount: publicRoles.length,
    });

    return {
      introText: event.volunteerIntroText ?? null,
      roles: publicRoles,
    };
  });
}
