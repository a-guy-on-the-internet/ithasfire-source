import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const adminBulkDeletePlacesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();

export const adminBulkDeletePlacesOutputSchema = z
  .object({
    total: z.number().int(),
    deleted: z.number().int(),
    failed: z.number().int(),
    results: z.array(
      z.object({
        placeId: z.string().uuid(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    ),
  })
  .strict();

export type AdminBulkDeletePlacesInput = z.infer<
  typeof adminBulkDeletePlacesInputSchema
>;
export type AdminBulkDeletePlacesOutput = z.infer<
  typeof adminBulkDeletePlacesOutputSchema
>;

export type AdminBulkDeletePlacesDeps = {
  repos: Pick<Repos, "places" | "audit" | "tx">;
  authz: AuthZPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function adminBulkDeletePlaces(
  deps: AdminBulkDeletePlacesDeps,
  rawInput: unknown,
): Promise<AdminBulkDeletePlacesOutput> {
  const logger = deps.logger?.child({ useCase: "adminBulkDeletePlaces" });

  const execute = async () => {
    const input = parseInput(adminBulkDeletePlacesInputSchema, rawInput);

    // RBAC: ADMIN only
    const check = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    if (!check.allowed) {
      throw fail("STAFF_ONLY");
    }

    const results: AdminBulkDeletePlacesOutput["results"] = [];

    for (const placeId of input.placeIds) {
      try {
        // getById + audit + delete inside one tx to avoid TOCTOU
        await deps.repos.tx(async (tx) => {
          const place = await tx.places.getById(placeId);
          if (!place) {
            throw { code: "not_found" } as const;
          }

          // Audit BEFORE deletion (the record won't exist after)
          await tx.audit.log({
            entity: "Place",
            entityId: placeId,
            action: "admin.deletePlace",
            data: {
              actorHumanId: input.actorHumanId,
              deletedName: place.name,
            },
          });

          await tx.places.deletePlace(placeId);
        });

        results.push({ placeId, ok: true });
      } catch (err) {
        const error =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : "internal_error";
        results.push({ placeId, ok: false, error });
      }
    }

    const deleted = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return adminBulkDeletePlacesOutputSchema.parse({
      total: input.placeIds.length,
      deleted,
      failed,
      results,
    });
  };

  if (logger) {
    return logger.withTime("adminBulkDeletePlaces", execute);
  }

  return execute();
}
