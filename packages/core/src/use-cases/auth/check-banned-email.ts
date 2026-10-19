import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import {
  createNetworkIdentityHasher,
  isUsableNetworkIdentitySecret,
  type NetworkIdentityHasher,
} from "../../lib/security/network-identity";

/**
 * Is this address the mailbox of a BANNED human? (ban-that-sticks, 2026-09-29)
 *
 * The address is canonicalised as mail is delivered (case, `+tag`, Gmail dots,
 * googlemail.com — `canonicalEmail`) and HMAC'd; only the hash is looked up,
 * so `Banned.Person+x@googlemail.com` matches a ban recorded for
 * `bannedperson@gmail.com`.
 *
 * FAILURE POLICY:
 *  - lookup error → reported and RETHROWN (fail closed: a sign-up that cannot
 *    confirm the address is not banned does not go through), mirroring the
 *    session gate in `apps/api/src/auth/account-security.ts`. With
 *    `callerReportsLookupFailure` it is rethrown UNREPORTED (logged at warn):
 *    the session gate reports it once itself, with the authUserId;
 *  - no usable secret → reported and answers `false` (fail open): nothing
 *    could have been recorded without the secret either, so there is nothing
 *    to match, and blocking every sign-up on a config error is an outage.
 */
export type CheckBannedEmailDeps = {
  repos: Pick<Repos, "bans">;
  clock: ClockPort;
  identitySecret: string | null | undefined;
  /**
   * Prebuilt hasher for `identitySecret` (HKDF runs once per process, not per
   * call). Optional; built from the secret when absent.
   */
  hasher?: NetworkIdentityHasher | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * The caller reports a lookup failure itself (with richer context), so this
   * use case must not: set by the session gate, which reports every failure
   * of its mailbox check under `session_gate_mailbox_lookup` with the
   * authUserId. The error is still rethrown (fail closed). Does not affect
   * the missing-secret report.
   */
  callerReportsLookupFailure?: boolean;
};

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

export async function isEmailBanned(
  deps: CheckBannedEmailDeps,
  email: string | null | undefined,
): Promise<boolean> {
  if (!isUsableNetworkIdentitySecret(deps.identitySecret)) {
    const err = new Error("banned_email_check_secret_missing");
    deps.logger?.error("auth.banned_email_check.secret_missing", { err });
    reportSafely(deps.reportError, err, {
      tags: { area: "auth", op: "banned_email_check" },
    });
    return false;
  }
  const hasher =
    deps.hasher ?? createNetworkIdentityHasher(deps.identitySecret);
  const valueHash = hasher.hashEmail(email);
  if (!valueHash) return false;
  try {
    return await deps.repos.bans.isActive({
      kind: "EMAIL",
      valueHash,
      now: deps.clock.now(),
    });
  } catch (err) {
    if (deps.callerReportsLookupFailure) {
      // warn, not error: pinoIntegration captures `logger.error`, and the
      // caller already reports this failure once.
      deps.logger?.warn("auth.banned_email_check.lookup_failed", { err });
    } else {
      deps.logger?.error("auth.banned_email_check.lookup_failed", { err });
      reportSafely(deps.reportError, err, {
        tags: { area: "auth", op: "banned_email_check" },
      });
    }
    throw err;
  }
}
