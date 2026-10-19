import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Status-link tokens for open-call applications (NFR-001, FR-009).
 *
 * DERIVED, not random (owner ruling 2026-10-07): the token is
 *
 *   base64url(HMAC-SHA256(secret, "open-call-status.v1:" + submissionId))
 *
 * without padding (43 characters, 256 bits), keyed by a server secret the
 * composition root passes in (HKDF of UNSUBSCRIBE_SECRET,
 * `lib/security/open-call-status-token-key.ts`; core never reads env). Same shape as the earlier random token, so the boundary schema
 * and the page URL did not change. Because it is re-derivable from the
 * submission id, every later email (picked, not this time, messages...) can
 * carry the guest's real status link and a one-tap Drop out, while the DB
 * still keeps ONLY the SHA-256 (hex) in
 * `EventApplicationSubmission.statusTokenHash` (unique index, lookup
 * unchanged). The raw token is never persisted, logged or put in a stored
 * notification: it is built at send time and goes straight to the mailer.
 *
 * Rotating the secret kills every outstanding link (accepted by the owner).
 * Rows created before this change (2026-10-07) hold the hash of a RANDOM
 * token, so their links never resolve again: dev data only, the feature is
 * unreleased.
 * The `open-call-status.v1:` label keeps these MACs apart from anything else
 * ever signed with the same secret.
 *
 * Why no salt / slow hash on the stored hash: the token is a 256-bit MAC,
 * not a password. A fast hash of a high-entropy secret is not
 * brute-forceable, and an unsalted hash is what lets the lookup go through
 * the unique index.
 */

/** base64url of a 32-byte MAC, no padding. */
export const STATUS_TOKEN_LENGTH = 43;
/** A shorter secret is a configuration bug, not a usable key. */
export const MIN_STATUS_TOKEN_SECRET_LENGTH = 32;
const MAC_LABEL = "open-call-status.v1:";
/** A token stops working this long after the last date the application chose (NFR-001). */
export const STATUS_TOKEN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Boundary schema for a raw token: exact length, base64url alphabet. */
export const statusTokenSchema = z
  .string()
  .length(STATUS_TOKEN_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

/** True when `secret` is usable as the status-token key. */
export function isUsableStatusTokenSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_STATUS_TOKEN_SECRET_LENGTH;
}

/**
 * The raw status token for a submission, and its stored hash. Deterministic:
 * the same (secret, submissionId) always gives the same token. Throws on a
 * missing or short secret (a configuration bug; never sign under a weak key).
 */
export function deriveStatusToken(
  secret: string,
  submissionId: string,
): { token: string; hash: string } {
  if (!isUsableStatusTokenSecret(secret)) throw new Error("open_call_status_token_secret_too_short");
  const token = createHmac("sha256", secret)
    .update(MAC_LABEL + submissionId, "utf8")
    .digest("base64url");
  return { token, hash: hashStatusToken(token) };
}

export function hashStatusToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time equality of two hex SHA-256 digests. The lookup itself goes
 * through the unique index on the hash (a B-tree compare of the attacker's
 * HASH, not their token): timing there can at most reveal how many leading
 * hash characters of a guess match some stored hash, which gives no help
 * finding a preimage. This re-check of the row it returned is defense in
 * depth, so the token is also "compared in constant time" literally.
 */
export function statusTokenHashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The applicant's status page (FR-009). */
export function openCallStatusPath(publicId: string, token: string): string {
  return `/call/${publicId}/application/${token}`;
}
