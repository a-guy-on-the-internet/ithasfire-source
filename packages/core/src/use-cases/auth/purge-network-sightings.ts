import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { NETWORK_SIGHTING_RETENTION_DAYS } from "../../lib/security/network-identity";

/**
 * Retention purge for "a ban that sticks" (2026-09-29): delete network
 * sightings older than the retention window (default 30 days) and NETWORK
 * ban rows whose expiry has passed, and clear the keyed IP hash stored with
 * community edit suggestions older than the same window. EMAIL ban rows never
 * expire and are not touched; they are removed only when their human is
 * reactivated.
 *
 * Runs from the `security.purge-network-sightings` scheduled job. Idempotent.
 */
export const purgeNetworkSightingsInputSchema = z
  .object({
    retentionDays: z
      .number()
      .int()
      .min(1)
      .max(NETWORK_SIGHTING_RETENTION_DAYS)
      .default(NETWORK_SIGHTING_RETENTION_DAYS),
  })
  .strict();

export type PurgeNetworkSightingsDeps = {
  repos: Pick<Repos, "networkSightings" | "bans" | "eventEditSuggestions">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type PurgeNetworkSightingsOutput = {
  sightingsDeleted: number;
  expiredBansDeleted: number;
  suggestionIpHashesCleared: number;
  cutoff: string;
};

export async function purgeNetworkSightings(
  deps: PurgeNetworkSightingsDeps,
  rawInput: unknown,
): Promise<PurgeNetworkSightingsOutput> {
  const input = parseInput(purgeNetworkSightingsInputSchema, rawInput ?? {});
  const now = deps.clock.now();
  const cutoff = new Date(
    now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000,
  );
  const sightings = await deps.repos.networkSightings.purgeOlderThan({
    before: cutoff,
  });
  const bans = await deps.repos.bans.purgeExpired({ before: now });
  const suggestions =
    await deps.repos.eventEditSuggestions.clearSubmitterIpHashesBefore({
      before: cutoff,
    });
  const output = {
    sightingsDeleted: sightings.count,
    expiredBansDeleted: bans.count,
    suggestionIpHashesCleared: suggestions.count,
    cutoff: cutoff.toISOString(),
  };
  deps.logger?.info("auth.network_sightings_purged", output);
  return output;
}
