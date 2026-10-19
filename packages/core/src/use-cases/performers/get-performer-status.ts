import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { isPerformerStatsEligible } from "../../lib/performer-stats";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getPerformerStatusInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

const ownerStatusSchema = z
  .object({
    ownerId: z.string(),
    enabled: z.boolean(),
    enabledAt: z.date().nullable(),
    /**
     * Raw stored organizer-booking-request acceptance GATE
     * (organizer-booking-requests FR-002). Drives the "Open to booking
     * requests" toggle; the EFFECTIVE receive gate is
     * `enabled && acceptsBookingRequests` (create checks both), so the value
     * survives a performer-mode off/on round-trip unchanged.
     */
    acceptsBookingRequests: z.boolean(),
  })
  .strict();

const humanStatusSchema = ownerStatusSchema
  .extend({
    /**
     * Whether the actor's verified platform stats meet the sharing threshold
     * (`MIN_SHOWS_FOR_STATS`). Drives the "include verified stats" opt-in on
     * booking surfaces — `false` (incl. no stats row) hides the checkbox, since
     * the server would only ever persist a null snapshot (FR-009).
     */
    statsEligible: z.boolean(),
  })
  .strict();

export const getPerformerStatusOutputSchema = z
  .object({
    /** The actor's own (human) performer-mode status. */
    human: humanStatusSchema,
    /** Statuses for orgs the actor administers (OWNER / ADMIN). */
    orgs: z.array(ownerStatusSchema),
  })
  .strict();

export type GetPerformerStatusInput = z.infer<
  typeof getPerformerStatusInputSchema
>;
export type GetPerformerStatusOutput = z.infer<
  typeof getPerformerStatusOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPerformerStatusDeps = {
  repos: Pick<Repos, "performerProfiles" | "authz" | "humanStats">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-side gate feeder for performer surfaces: the actor's own performer-mode
 * status plus the statuses of every org they can administer (the same roles
 * that may toggle org performer mode via `set-performer-mode`).
 */
export async function getPerformerStatus(
  deps: GetPerformerStatusDeps,
  rawInput: unknown,
): Promise<GetPerformerStatusOutput> {
  const input = parseInput(getPerformerStatusInputSchema, rawInput);

  const [humanProfile, humanStats] = await Promise.all([
    deps.repos.performerProfiles.getByOwner({
      ownerType: "human",
      ownerId: input.actorHumanId,
    }),
    // Missing aggregate row → not eligible (default-off, same as <3 shows).
    deps.repos.humanStats.findByHumanId(input.actorHumanId),
  ]);

  const adminMemberships = await deps.repos.authz.listOrgMembershipsByHumanId({
    humanId: input.actorHumanId,
    roles: [...ORG_ADMIN_ROLES],
  });

  const orgs = await Promise.all(
    adminMemberships.map(async (membership) => {
      const profile = await deps.repos.performerProfiles.getByOwner({
        ownerType: "organization",
        ownerId: membership.orgId,
      });
      return {
        ownerId: membership.orgId,
        enabled: isPerformerEnabled(profile),
        enabledAt: isPerformerEnabled(profile)
          ? (profile?.enabledAt ?? null)
          : null,
        acceptsBookingRequests: profile?.acceptsBookingRequests ?? false,
      };
    }),
  );

  return getPerformerStatusOutputSchema.parse({
    human: {
      ownerId: input.actorHumanId,
      enabled: isPerformerEnabled(humanProfile),
      enabledAt: isPerformerEnabled(humanProfile)
        ? (humanProfile?.enabledAt ?? null)
        : null,
      acceptsBookingRequests: humanProfile?.acceptsBookingRequests ?? false,
      statsEligible: isPerformerStatsEligible(humanStats),
    },
    orgs,
  });
}
