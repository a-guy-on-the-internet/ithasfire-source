import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { fail } from "@th/errors";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const togglePlaceDirectoryListingInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    listedInDirectory: z.boolean(),
  })
  .strict();

export const togglePlaceDirectoryListingOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    listedInDirectory: z.boolean(),
  })
  .strict();

export type TogglePlaceDirectoryListingInput = z.infer<
  typeof togglePlaceDirectoryListingInputSchema
>;
export type TogglePlaceDirectoryListingOutput = z.infer<
  typeof togglePlaceDirectoryListingOutputSchema
>;

export type TogglePlaceDirectoryListingDeps = {
  // Widened from Pick — reindexAfterMutation reads `places` and `entityPages`.
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort: when provided, reindexes the place to reflect the toggle. */
  search?: MultiSearchPort;
  /**
   * Best-effort reporter, forwarded to that reindex. This is a `kind: "place"`
   * reindex, so `buildSearchIndex`'s swallowed EntityPage read costs the venue
   * its `pageSlug` — silently dropping it to the `/places/id/{uuid}` fallback
   * in search until the nightly job. Unlike an org/human reindex (where the
   * same swallow only loses a bio) that is a user-visible degradation, so it
   * has to be reportable.
   */
  reportError?: ReporterPort;
};

export async function togglePlaceDirectoryListing(
  deps: TogglePlaceDirectoryListingDeps,
  rawInput: unknown,
): Promise<TogglePlaceDirectoryListingOutput> {
  const input = parseInput(togglePlaceDirectoryListingInputSchema, rawInput);
  const now = deps.clock.now();

  // Platform admin only
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN"],
    errorCode: "STAFF_ONLY",
  });

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Update the place with toggled directory listing. One transaction with
  // its audit row and the search mark (`listedInDirectory` is indexed).
  await deps.repos.tx(async (tx) => {
    // Compare-and-set of the flag alone, so a concurrent moderator edit of
    // the name/address/pin is never overwritten from the read above, and
    // whether the flag moved comes from the write, not from that read.
    const { changed } = await tx.places.setDirectoryListing({
      placeId: input.placeId,
      listedInDirectory: input.listedInDirectory,
    });

    await tx.audit.log({
      entity: "place",
      entityId: input.placeId,
      action: input.listedInDirectory
        ? "place.listed_in_directory"
        : "place.unlisted_from_directory",
      data: {
        actorHumanId: input.actorHumanId,
        listedInDirectory: input.listedInDirectory,
      },
      at: now,
    });

    if (changed) {
      await markForSearchReindex(tx, [{ kind: "place", id: input.placeId }], now);
    }
  });

  reindexAfterMutation(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    "togglePlaceDirectoryListing",
    { kind: "place", id: input.placeId },
  );

  return {
    placeId: input.placeId,
    listedInDirectory: input.listedInDirectory,
  };
}
