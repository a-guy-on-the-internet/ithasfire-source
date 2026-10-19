import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { ORG_ADMIN_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { toPerformerOwnerType } from "./set-performer-mode";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setPerformerBookingAcceptanceInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    ownerType: z.enum(["human", "org"]),
    ownerId: z.uuid(),
    accepts: z.boolean(),
  })
  .strict();

export const setPerformerBookingAcceptanceOutputSchema = z
  .object({
    accepts: z.boolean(),
  })
  .strict();

export type SetPerformerBookingAcceptanceInput = z.infer<
  typeof setPerformerBookingAcceptanceInputSchema
>;
export type SetPerformerBookingAcceptanceOutput = z.infer<
  typeof setPerformerBookingAcceptanceOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetPerformerBookingAcceptanceDeps = {
  repos: Pick<Repos, "tx" | "performerProfiles" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performer opt-in to RECEIVING organizer booking requests
 * (organizer-booking-requests FR-002) — mirrors `set-place-booking-acceptance`
 * (idempotent, audited) with the performer twist: the flag is a sub-gate of
 * performer mode, so ENABLING requires an enabled PerformerProfile
 * (`PERFORMER_MODE_REQUIRED` otherwise), while DISABLING is always allowed on
 * an existing profile (an act that turned performer mode off can still flip
 * the stale acceptance off). The create gate checks BOTH flags, so disabling
 * performer mode alone already stops new requests.
 *
 * Authorization matches `setPerformerMode` (the sibling toggle on the same
 * settings surface): self for a human act, ORG_ADMIN_ROLES for an org act.
 */
export async function setPerformerBookingAcceptance(
  deps: SetPerformerBookingAcceptanceDeps,
  rawInput: unknown,
): Promise<SetPerformerBookingAcceptanceOutput> {
  const input = parseInput(setPerformerBookingAcceptanceInputSchema, rawInput);

  const ownerType = toPerformerOwnerType(input.ownerType);

  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
  });

  const profile = await deps.repos.performerProfiles.getByOwner({
    ownerType,
    ownerId: input.ownerId,
  });

  // Disabling with no profile at all is a pure no-op (nothing to flip, the
  // create gate already rejects); enabling requires performer mode.
  if (!profile) {
    if (!input.accepts) {
      return setPerformerBookingAcceptanceOutputSchema.parse({
        accepts: false,
      });
    }
    throw fail("PERFORMER_MODE_REQUIRED");
  }
  if (input.accepts && !isPerformerEnabled(profile)) {
    throw fail("PERFORMER_MODE_REQUIRED");
  }

  const now = deps.clock.now();

  // Idempotent: flipping to the current state skips the write but still
  // audits the (idempotent) intent, mirroring set-place-booking-acceptance.
  await deps.repos.tx(async (tx) => {
    if (profile.acceptsBookingRequests !== input.accepts) {
      await tx.performerProfiles.setAcceptsBookingRequests({
        ownerType,
        ownerId: input.ownerId,
        accepts: input.accepts,
      });
    }

    await tx.audit.log({
      entity: "performer_profile",
      entityId: profile.id,
      action: input.accepts
        ? "performer_profile.booking_acceptance_enabled"
        : "performer_profile.booking_acceptance_disabled",
      data: {
        ownerType,
        ownerId: input.ownerId,
        previous: profile.acceptsBookingRequests,
        next: input.accepts,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });
  });

  deps.logger?.info("performers.set_booking_acceptance", {
    performerProfileId: profile.id,
    ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    acceptsBookingRequests: input.accepts,
  });

  return setPerformerBookingAcceptanceOutputSchema.parse({
    accepts: input.accepts,
  });
}
