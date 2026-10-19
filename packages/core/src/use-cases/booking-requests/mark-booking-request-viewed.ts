import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_ANY_ROLE, requireOwnerAccess } from "../../lib/rbac";
import { bookingRequestStatusSchema } from "./list-booking-requests";
import { requirePlaceOwnership } from "./_shared/place-access";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const markBookingRequestViewedInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
  })
  .strict();

export const markBookingRequestViewedOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    status: bookingRequestStatusSchema,
    viewedAt: z.date().nullable(),
  })
  .strict();

export type MarkBookingRequestViewedInput = z.infer<
  typeof markBookingRequestViewedInputSchema
>;
export type MarkBookingRequestViewedOutput = z.infer<
  typeof markBookingRequestViewedOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type MarkBookingRequestViewedDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "places"
    | "authz"
    | "audit"
    // Consumed inside the tx to append the booking-timeline entry.
    | "bookingRequestMessages"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Receiving-side PENDING → VIEWED stamp (spec FR-002 "opening one stamps
 * VIEWED"). Idempotent for already-VIEWED requests; terminal states throw
 * `invalid_status`.
 *
 * Authz follows the request's direction (organizer-booking-requests FR-004):
 * - TO_VENUE — venue owner (direct human or owning-org member, any role);
 * - TO_PERFORMER — the ACT (self for a human act; org-act membership ANY
 *   role, mirroring the venue inbox's membership-any viewing bar).
 */
export async function markBookingRequestViewed(
  deps: MarkBookingRequestViewedDeps,
  rawInput: unknown,
): Promise<MarkBookingRequestViewedOutput> {
  const input = parseInput(markBookingRequestViewedInputSchema, rawInput);

  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }

  if (request.direction === "TO_PERFORMER") {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType:
        request.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
      ownerId: request.performerOwnerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });
  } else {
    const place = await deps.repos.places.getById(request.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }
    await requirePlaceOwnership(deps.repos, place, input.actorHumanId);
  }

  // Idempotent no-op when already viewed.
  if (request.status === "VIEWED") {
    return markBookingRequestViewedOutputSchema.parse({
      bookingRequestId: request.id,
      status: request.status,
      viewedAt: request.viewedAt,
    });
  }

  if (request.status !== "PENDING") {
    throw fail("INVALID_STATUS");
  }

  const now = deps.clock.now();

  const updated = await deps.repos.tx(async (tx) => {
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh || fresh.status !== "PENDING") {
      // Lost a race — treat a concurrent VIEWED as success, anything else as
      // an invalid transition.
      if (fresh?.status === "VIEWED") return fresh;
      throw fail("BOOKING_REQUEST_NOT_PENDING");
    }

    // Write-time CAS: only PENDING may become VIEWED, so a concurrently
    // committed DECLINED/EXPIRED/WITHDRAWN can never be resurrected.
    const viewed = await tx.bookingRequests.markViewed({
      id: fresh.id,
      now,
      expectedFrom: ["PENDING"],
    });

    // Ledger entry, same tx as the CAS. Reached only on a real PENDING →
    // VIEWED flip: the already-VIEWED short-circuits above return before the
    // transaction opens, so re-opening the inbox never re-logs "viewed".
    await appendBookingSystemEntry(tx, {
      bookingRequestId: viewed.id,
      kind: "booking_request.viewed",
      data: {},
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: viewed.id,
      action: "booking_request.viewed",
      data: {
        actorHumanId: input.actorHumanId,
        direction: request.direction,
        placeId: request.placeId,
        organizerOrgId: request.organizerOrgId,
      },
      at: now,
    });

    return viewed;
  });

  deps.logger?.info("booking_requests.viewed", {
    bookingRequestId: updated.id,
    actorHumanId: input.actorHumanId,
  });

  return markBookingRequestViewedOutputSchema.parse({
    bookingRequestId: updated.id,
    status: updated.status,
    viewedAt: updated.viewedAt,
  });
}
