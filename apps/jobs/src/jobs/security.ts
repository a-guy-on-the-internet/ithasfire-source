/**
 * Security retention jobs.
 *
 * security.purge-network-sightings — daily retention purge for "a ban that
 * sticks" (2026-09-29). Deletes NetworkSighting rows (keyed hashes of the
 * network a sign-up / sign-in came from) older than 30 days, and NETWORK
 * BannedIdentity rows whose 30-day expiry has passed, and clears the keyed IP
 * hash on community edit suggestions older than 30 days. EMAIL ban rows never
 * expire here; they go when their human is reactivated.
 *
 * The 30-day window is the promise the privacy policy makes, so this job is
 * the enforcement of that promise, not housekeeping.
 */
import { z } from "zod";

import { purgeNetworkSightings } from "@th/core/use-cases/auth/purge-network-sightings";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

export const purgeNetworkSightingsJob = defineScheduledTask({
  name: "security.purge-network-sightings",
  description:
    "Delete hashed sign-up/sign-in network sightings older than 30 days, expired network ban rows, and edit-suggestion IP hashes older than 30 days (privacy-policy retention).",
  input: z.object({
    /** Shorten the window for a one-off run; never longer than 30 days. */
    retentionDays: z.coerce.number().int().min(1).max(30).optional(),
  }),
  schedule: getSchedule("security.purge-network-sightings"),
  handler: async ({ input, ctx }) => {
    // Forward retentionDays only when provided so the use case's own default
    // (the 30-day constant) applies — no duplicated default to drift.
    const result = await purgeNetworkSightings(
      {
        repos: {
          networkSightings: ctx.repos.networkSightings,
          bans: ctx.repos.bans,
          eventEditSuggestions: ctx.repos.eventEditSuggestions,
        },
        clock: ctx.clock,
        logger: ctx.logger,
      },
      {
        ...(input.retentionDays !== undefined
          ? { retentionDays: input.retentionDays }
          : {}),
      },
    );
    ctx.logger.info("security.purge-network-sightings.completed", result);
    return result;
  },
});

export const securityJobs = [purgeNetworkSightingsJob];
