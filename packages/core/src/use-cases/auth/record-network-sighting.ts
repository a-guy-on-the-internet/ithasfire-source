import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  createNetworkIdentityHasher,
  isUsableNetworkIdentitySecret,
  type NetworkIdentityHasher,
  normalizeCountryCode,
  userAgentFamily,
} from "../../lib/security/network-identity";

/**
 * Record where a sign-up / sign-in came from, as keyed hashes only
 * (ban-that-sticks, 2026-09-29).
 *
 * The raw client IP is hashed HERE and dropped: the repo call receives
 * `ipHash` / `networkHash` and nothing that could be turned back into the
 * address. The user agent is reduced to a coarse family and the country is
 * Cloudflare's two-letter code.
 *
 * BEST-EFFORT BY CONTRACT. This runs inside Better Auth's hooks, so a throw
 * here would fail a sign-in. Every failure is swallowed, logged at ERROR and
 * reported through `reportError` (CLAUDE.md error-reporting convention), and
 * the caller gets an outcome instead. A missing IP is not a failure (local
 * dev, a header-less caller) — it is skipped quietly.
 */

export const recordNetworkSightingInputSchema = z
  .object({
    authUserId: z.string().min(1).max(128),
    humanId: z.string().uuid().nullable(),
    kind: z.enum(["SIGN_UP", "SIGN_IN"]),
    /** Raw client IP from the resolver. Hashed, never stored. */
    clientIp: z.string().max(256).nullable(),
    /** Raw `cf-ipcountry` header value. */
    countryHeader: z.string().max(16).nullable(),
    /** Raw `user-agent` header value. Reduced to a family, never stored. */
    userAgent: z.string().max(4096).nullable(),
  })
  .strict();

export type RecordNetworkSightingInput = z.input<
  typeof recordNetworkSightingInputSchema
>;

export type RecordNetworkSightingDeps = {
  repos: Pick<Repos, "networkSightings">;
  /** Root secret (BETTER_AUTH_SECRET); a purpose-bound key is derived. */
  identitySecret: string | null | undefined;
  /** Prebuilt hasher for `identitySecret`; built from the secret if absent. */
  hasher?: NetworkIdentityHasher | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type RecordNetworkSightingOutcome =
  | "recorded"
  | "skipped_no_ip"
  | "skipped_no_secret"
  | "failed";

function reportSafely(
  reportError: ReporterPort | undefined,
  err: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    reportError?.(err, context);
  } catch {
    // Best-effort by contract (see @th/ports/reporter).
  }
}

export async function recordNetworkSighting(
  deps: RecordNetworkSightingDeps,
  rawInput: unknown,
): Promise<RecordNetworkSightingOutcome> {
  let kind: string | undefined;
  let authUserId: string | undefined;
  try {
    const input = parseInput(recordNetworkSightingInputSchema, rawInput);
    kind = input.kind;
    authUserId = input.authUserId;

    if (!isUsableNetworkIdentitySecret(deps.identitySecret)) {
      // Misconfiguration, not a per-request condition: say so loudly.
      const err = new Error("network_sighting_secret_missing");
      deps.logger?.error("auth.network_sighting.secret_missing", {
        kind,
        err,
      });
      reportSafely(deps.reportError, err, {
        tags: { area: "auth", op: "network_sighting", kind },
      });
      return "skipped_no_secret";
    }

    const hasher =
      deps.hasher ?? createNetworkIdentityHasher(deps.identitySecret);
    const hashes = hasher.hashIp(input.clientIp);
    if (!hashes) {
      deps.logger?.info("auth.network_sighting.skipped_no_ip", { kind });
      return "skipped_no_ip";
    }

    await deps.repos.networkSightings.record({
      authUserId: input.authUserId,
      humanId: input.humanId,
      kind: input.kind,
      ipHash: hashes.ipHash,
      networkHash: hashes.networkHash,
      country: normalizeCountryCode(input.countryHeader),
      userAgentFamily: userAgentFamily(input.userAgent),
    });
    return "recorded";
  } catch (err) {
    // Deliberate swallow: a sighting must never block auth.
    deps.logger?.error("auth.network_sighting.record_failed", {
      kind,
      authUserId,
      err,
    });
    reportSafely(deps.reportError, err, {
      tags: { area: "auth", op: "network_sighting", kind },
      extra: { authUserId },
    });
    return "failed";
  }
}
