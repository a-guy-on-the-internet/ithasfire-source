import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PlaceWaiverRecord } from "@th/ports/repos/place-waivers";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { fail } from "@th/errors";
import { ensurePlaceOwnerAccess } from "./_shared/ensure-place-owner-access";

// ── Shared deps ─────────────────────────────────────────────────────────────

export type PlaceWaiverDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// Owner gate: the shared `_shared/ensure-place-owner-access` helper (the
// verbatim extraction of the copy that used to live here — same lookups, same
// error codes; call sites pass `deps.repos`).

// ── Create ──────────────────────────────────────────────────────────────────

export const createPlaceWaiverInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  placeId: z.string().uuid(),
  title: plainTextRequired(200),
  content: z.string().trim().min(1).max(50_000),
});

export type CreatePlaceWaiverInput = z.infer<
  typeof createPlaceWaiverInputSchema
>;

export async function createPlaceWaiver(
  deps: PlaceWaiverDeps,
  rawInput: unknown,
): Promise<PlaceWaiverRecord> {
  const input = createPlaceWaiverInputSchema.parse(rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  // Deactivate any current active waiver for this place (only one active at a time).
  const currentActive = await deps.repos.placeWaivers.getActiveForPlace(
    input.placeId,
  );
  if (currentActive) {
    await deps.repos.placeWaivers.update({
      id: currentActive.id,
      isActive: false,
    });
    deps.logger?.info("Deactivated previous waiver", {
      previousId: currentActive.id,
      version: currentActive.version,
    });
  }

  const record = await deps.repos.placeWaivers.create({
    placeId: input.placeId,
    title: input.title,
    content: input.content,
  });

  deps.logger?.info("Created place waiver", {
    id: record.id,
    placeId: input.placeId,
    version: record.version,
  });
  return record;
}

// ── Update ──────────────────────────────────────────────────────────────────

export const updatePlaceWaiverInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
  title: plainTextRequired(200).optional(),
  content: z.string().trim().min(1).max(50_000).optional(),
  isActive: z.boolean().optional(),
});

export type UpdatePlaceWaiverInput = z.infer<
  typeof updatePlaceWaiverInputSchema
>;

export async function updatePlaceWaiver(
  deps: PlaceWaiverDeps,
  rawInput: unknown,
): Promise<PlaceWaiverRecord> {
  const input = updatePlaceWaiverInputSchema.parse(rawInput);

  const existing = await deps.repos.placeWaivers.getById(input.id);
  if (!existing) {
    throw fail("WAIVER_NOT_FOUND");
  }

  await ensurePlaceOwnerAccess(deps.repos, existing.placeId, input.actorHumanId);

  const record = await deps.repos.placeWaivers.update({
    id: input.id,
    title: input.title,
    content: input.content,
    isActive: input.isActive,
  });

  deps.logger?.info("Updated place waiver", { id: record.id });
  return record;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export const deletePlaceWaiverInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
});

export type DeletePlaceWaiverInput = z.infer<
  typeof deletePlaceWaiverInputSchema
>;

export async function deletePlaceWaiver(
  deps: PlaceWaiverDeps,
  rawInput: unknown,
): Promise<void> {
  const input = deletePlaceWaiverInputSchema.parse(rawInput);

  const existing = await deps.repos.placeWaivers.getById(input.id);
  if (!existing) {
    throw fail("WAIVER_NOT_FOUND");
  }

  await ensurePlaceOwnerAccess(deps.repos, existing.placeId, input.actorHumanId);

  await deps.repos.placeWaivers.delete(input.id);
  deps.logger?.info("Deleted place waiver", { id: input.id });
}

// ── List ────────────────────────────────────────────────────────────────────

export const listPlaceWaiversInputSchema = z.object({
  placeId: z.string().uuid(),
  activeOnly: z.boolean().optional().default(false),
});

export type ListPlaceWaiversInput = z.infer<typeof listPlaceWaiversInputSchema>;

export async function listPlaceWaivers(
  deps: PlaceWaiverDeps,
  rawInput: unknown,
): Promise<PlaceWaiverRecord[]> {
  const input = listPlaceWaiversInputSchema.parse(rawInput);

  // Public read for waiver text (users need to see what they're signing).
  return deps.repos.placeWaivers.listByPlace({
    placeId: input.placeId,
    activeOnly: input.activeOnly,
  });
}

// ── Get active (for checkout / agreement acceptance) ────────────────────────

export const getActivePlaceWaiverInputSchema = z.object({
  placeId: z.string().uuid(),
});

export type GetActivePlaceWaiverInput = z.infer<
  typeof getActivePlaceWaiverInputSchema
>;

export async function getActivePlaceWaiver(
  deps: PlaceWaiverDeps,
  rawInput: unknown,
): Promise<PlaceWaiverRecord | null> {
  const input = getActivePlaceWaiverInputSchema.parse(rawInput);
  return deps.repos.placeWaivers.getActiveForPlace(input.placeId);
}
