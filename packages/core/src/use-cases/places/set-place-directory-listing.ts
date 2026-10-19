import { z } from "zod";

import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { markForSearchReindex } from "../search/search-reindex-marks";

const STAFF_ROLES: HumanRole[] = ["ADMIN", "REVIEWER"];

export const setPlaceDirectoryListingInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    listedInDirectory: z.boolean(),
    /**
     * Free-form audit reason. Required when toggling OFF (so the trail
     * captures why a venue was de-listed); optional when re-listing.
     */
    reason: plainTextMultilineOptional(500).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.listedInDirectory === true ||
      (typeof v.reason === "string" && v.reason.length > 0),
    { message: "reason_required_to_unlist", path: ["reason"] },
  );

export const setPlaceDirectoryListingOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    listedInDirectory: z.boolean(),
  })
  .strict();

export type SetPlaceDirectoryListingInput = z.infer<
  typeof setPlaceDirectoryListingInputSchema
>;
export type SetPlaceDirectoryListingOutput = z.infer<
  typeof setPlaceDirectoryListingOutputSchema
>;

export type SetPlaceDirectoryListingDeps = {
  repos: Pick<Repos, "places" | "audit" | "tx">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Platform-admin-only flip of `Place.listedInDirectory`. The flag is the
 * single source of truth for whether a venue appears in public directory
 * surfaces (autocomplete, /venues, etc.). Approving a verification request
 * already auto-lists; this use case exists for after-the-fact curation
 * (de-listing spammy or duplicate venues, re-listing after dispute).
 */
export async function setPlaceDirectoryListing(
  deps: SetPlaceDirectoryListingDeps,
  rawInput: unknown,
): Promise<SetPlaceDirectoryListingOutput> {
  const input = parseInput(setPlaceDirectoryListingInputSchema, rawInput);

  const staff = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: [...STAFF_ROLES],
  });
  if (!staff.allowed) {
    throw fail("STAFF_ONLY");
  }

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // No-op when the flag is already in the desired state. We still log so
  // the audit trail captures the (idempotent) staff intent.
  const now = deps.clock.now();
  // One transaction: the flip, its audit row and the search mark
  // (`listedInDirectory` is on the place's search document).
  await deps.repos.tx(async (tx) => {
    // Compare-and-set of the flag alone. Rebuilding the row from `place`
    // (read before this transaction) would overwrite a moderator's
    // concurrent name/address/pin edit. Whether the flag moved, the audit's
    // `previous` and the search mark all come from the CAS, never from that
    // read: a concurrent toggle between the read and here must not leave an
    // audit row that disagrees with the row.
    const { changed } = await tx.places.setDirectoryListing({
      placeId: place.id,
      listedInDirectory: input.listedInDirectory,
    });

    await tx.audit.log({
      entity: "place",
      entityId: place.id,
      action: input.listedInDirectory
        ? "place.directory_listed"
        : "place.directory_unlisted",
      data: {
        previous: changed ? !input.listedInDirectory : input.listedInDirectory,
        next: input.listedInDirectory,
        reason: input.reason ?? null,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    if (changed) {
      await markForSearchReindex(tx, [{ kind: "place", id: place.id }], now);
    }
  });

  deps.logger?.info("places.set_directory_listing", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    listedInDirectory: input.listedInDirectory,
  });

  return setPlaceDirectoryListingOutputSchema.parse({
    placeId: place.id,
    listedInDirectory: input.listedInDirectory,
  });
}
