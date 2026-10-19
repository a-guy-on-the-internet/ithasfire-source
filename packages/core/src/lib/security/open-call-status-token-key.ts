import { hkdfSync } from "node:crypto";

/**
 * The open-call status-link token key (core
 * `use-cases/events/open-calls/_shared/status-token.ts`), for a composition
 * root: HKDF-SHA256 of the root secret UNSUBSCRIBE_SECRET under
 * {@link OPEN_CALL_STATUS_TOKEN_KEY_LABEL}, 32 bytes, base64url (43 chars).
 *
 * Why UNSUBSCRIBE_SECRET (orchestrator decision 2026-10-07): it is REQUIRED
 * in production for BOTH the API and the jobs service (jobs sends guest
 * notices in step 8), and both already HKDF it for the location obfuscation
 * key, so the two derive the same status key with nothing new provisioned.
 * The label keeps this key apart from the unsubscribe HMAC and the
 * obfuscation key: knowing one never yields another. Same construction as
 * `deriveInviteTokenSecret` (./invite-token.ts).
 *
 * Returns null for a missing or short root; open-call submit then answers
 * NOT_CONFIGURED and guest emails fail (reported). Rotating the root voids
 * every outstanding open-call status link (docs/runbooks/rotate-unsubscribe-secret.md).
 */

/** HKDF `info` for the status-token key. Bump the version to rotate. */
export const OPEN_CALL_STATUS_TOKEN_KEY_LABEL = "th-open-call-status-token.v1";

/** A shorter root is a configuration bug, not a usable key (API prod floor). */
export const MIN_OPEN_CALL_STATUS_ROOT_SECRET_LENGTH = 32;

export function deriveOpenCallStatusTokenSecret(
  rootSecret: string | null | undefined,
): string | null {
  if (
    typeof rootSecret !== "string" ||
    rootSecret.length < MIN_OPEN_CALL_STATUS_ROOT_SECRET_LENGTH
  ) {
    return null;
  }
  return Buffer.from(
    hkdfSync("sha256", rootSecret, Buffer.alloc(0), OPEN_CALL_STATUS_TOKEN_KEY_LABEL, 32),
  ).toString("base64url");
}
