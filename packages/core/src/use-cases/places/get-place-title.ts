import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getPlaceTitleInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

export const getPlaceTitleOutputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /** Lifecycle status — same value `getPlaceForEdit` returns. */
    status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]),
    /**
     * Verification state — feeds the admin rail's place context header chip
     * (place-admin-rail-context D5/FR-202) without fetching the full
     * `getPlaceForEdit` payload.
     */
    verification: z.enum(["UNVERIFIED", "VERIFIED", "PENDING", "REJECTED"]),
    /**
     * The place's OWN IANA zone (`Place.timezone`), or null when none is
     * stored. Deliberately NOT resolved to a default: a caller that wants a
     * fallback chooses it. Coarse (a zone name, not a location), so it does
     * not reopen the address gate described on `getPlaceTitle`.
     */
    timezone: z.string().nullable(),
  })
  .strict();

export type GetPlaceTitleInput = z.infer<typeof getPlaceTitleInputSchema>;
export type GetPlaceTitleOutput = z.infer<typeof getPlaceTitleOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPlaceTitleDeps = {
  repos: Pick<Repos, "places" | "authz">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight single-place title fetch with ownership check — parallel to
 * `getEventTitle` (place-admin-rail-context D5). Use this when a shell/header
 * needs only the name + status/verification chips; `getPlaceForEdit` stays
 * the heavy edit payload and is NOT called by the shell (NFR-1).
 *
 * Access control is DELIBERATELY LOOSER than `getPlaceForEdit`, which it used
 * to mirror: a direct human owner, or a member of an owning org in ANY role.
 * It has to be — this read backs the admin rail's place context and the
 * `[placeId]` layout gate, so tightening it would break navigation for a
 * SCANNER who legitimately works this venue.
 *
 * What makes that safe is the PAYLOAD, not the caller: id, name, status,
 * verification and the place's IANA zone name, and nothing else.
 * `getPlaceForEdit` moved to `canManagePlace` (OWNER/ADMIN/EDITOR) because it
 * carries the venue's street address and exact coordinates. Do not add a
 * locational field to this projection without moving this gate with it.
 */
export async function getPlaceTitle(
  deps: GetPlaceTitleDeps,
  rawInput: unknown,
): Promise<GetPlaceTitleOutput> {
  const input = parseInput(getPlaceTitleInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership check: actor must be a direct human owner or a member of an
  // owning org, ANY role. Intentionally not `canManagePlace` — see the
  // docblock: this is the navigation bar, not the address bar.
  const isDirectHumanOwner = place.humanIdsWithAccess.includes(
    input.actorHumanId,
  );

  let isOrgOwner = false;
  if (!isDirectHumanOwner && place.orgIdsWithAccess.length > 0) {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: input.actorHumanId,
    });
    isOrgOwner = memberships.length > 0;
  }

  if (!isDirectHumanOwner && !isOrgOwner) {
    // Same error shape as getPlaceForEdit — a non-member learns nothing
    // beyond what the edit endpoint already reveals for the same probe.
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }

  deps.logger?.info("places.get_title", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
  });

  return getPlaceTitleOutputSchema.parse({
    id: place.id,
    name: place.name,
    status: place.status,
    verification: place.verificationStatus,
    timezone: place.timezone ?? null,
  });
}
