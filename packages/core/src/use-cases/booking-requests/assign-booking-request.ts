import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { requirePlaceOwnership } from "./_shared/place-access";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";

// ─────────────────────────────────────────────────────────────────────────────
// assignBookingRequest (booking-holds FR-015): set or clear the venue-internal
// assignee on a TO_VENUE request. ORG_EDIT_ROLES on the owning org; the
// assignee must hold an edit role in an org that owns the venue. Human-owned
// venues have no assignee (the owner IS the assignee; the field stays null)
// → BOOKING_ASSIGNMENT_NOT_APPLICABLE. Idempotent: same assignee = no write,
// no ledger entry.
// ─────────────────────────────────────────────────────────────────────────────

export const assignBookingRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    /** Null clears the assignment. */
    assigneeHumanId: z.uuid().nullable(),
  })
  .strict();

export const assignBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    assigneeHumanId: z.uuid().nullable(),
    previousAssigneeHumanId: z.uuid().nullable(),
  })
  .strict();

export type AssignBookingRequestInput = z.infer<typeof assignBookingRequestInputSchema>;
export type AssignBookingRequestOutput = z.infer<typeof assignBookingRequestOutputSchema>;

export type AssignBookingRequestDeps = {
  repos: Pick<
    Repos,
    "tx" | "bookingRequests" | "places" | "authz" | "audit" | "bookingRequestMessages"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Whether `humanId` holds an edit role in ANY of the venue's owning orgs —
 * the eligibility rule for an assignee (FR-015) and for the auto-assign on
 * the first staff message. Exported so post-message applies the same rule.
 */
export async function isEligibleAssignee(
  repos: Pick<Repos, "authz">,
  owningOrgIds: readonly string[],
  humanId: string,
): Promise<boolean> {
  if (owningOrgIds.length === 0) return false;
  const memberships = await repos.authz.getOrgMemberships({
    orgIds: [...owningOrgIds],
    humanId,
  });
  return memberships.some((m) => ORG_EDIT_ROLES.includes(m.role));
}

export async function assignBookingRequest(
  deps: AssignBookingRequestDeps,
  rawInput: unknown,
): Promise<AssignBookingRequestOutput> {
  const input = parseInput(assignBookingRequestInputSchema, rawInput);
  const now = deps.clock.now();

  const request = await deps.repos.bookingRequests.getById(input.bookingRequestId);
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  if (request.direction !== "TO_VENUE") {
    throw fail("BOOKING_HOLDS_VENUE_ONLY", {
      meta: { bookingRequestId: request.id, direction: request.direction },
    });
  }
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  await requirePlaceOwnership(deps.repos, place, input.actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });
  if (place.orgIdsWithAccess.length === 0) {
    throw fail("BOOKING_ASSIGNMENT_NOT_APPLICABLE", { meta: { placeId: place.id } });
  }
  if (
    input.assigneeHumanId &&
    !(await isEligibleAssignee(deps.repos, place.orgIdsWithAccess, input.assigneeHumanId))
  ) {
    throw fail("BOOKING_ASSIGNEE_NOT_ELIGIBLE", {
      meta: { assigneeHumanId: input.assigneeHumanId, placeId: place.id },
    });
  }

  if (request.assigneeHumanId === input.assigneeHumanId) {
    return assignBookingRequestOutputSchema.parse({
      bookingRequestId: request.id,
      assigneeHumanId: request.assigneeHumanId,
      previousAssigneeHumanId: request.assigneeHumanId,
    });
  }

  const outcome = await deps.repos.tx(async (tx) => {
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh) {
      throw fail("BOOKING_REQUEST_NOT_FOUND");
    }
    const previous = fresh.assigneeHumanId;
    if (previous === input.assigneeHumanId) {
      return { request: fresh, previous };
    }
    const updated = await tx.bookingRequests.setAssignee({
      id: fresh.id,
      assigneeHumanId: input.assigneeHumanId,
    });
    await appendBookingSystemEntry(tx, {
      bookingRequestId: updated.id,
      kind: "booking_request.assigned",
      data: { assigneeHumanId: input.assigneeHumanId, previousAssigneeHumanId: previous },
      actorHumanId: input.actorHumanId,
    });
    await tx.audit.log({
      entity: "booking_request",
      entityId: updated.id,
      action: "booking_request.assigned",
      data: {
        actorHumanId: input.actorHumanId,
        placeId: place.id,
        assigneeHumanId: input.assigneeHumanId,
        previousAssigneeHumanId: previous,
      },
      at: now,
    });
    return { request: updated, previous };
  });

  deps.logger?.info("booking_requests.assigned", {
    bookingRequestId: request.id,
    assigneeHumanId: input.assigneeHumanId,
    actorHumanId: input.actorHumanId,
  });

  return assignBookingRequestOutputSchema.parse({
    bookingRequestId: outcome.request.id,
    assigneeHumanId: outcome.request.assigneeHumanId,
    previousAssigneeHumanId: outcome.previous,
  });
}
