import { createHash, randomBytes } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Invite-to-claim token crypto (booking-request-embed-button FR-007, NFR-003)
//
// The RAW token appears exactly once: in the claim link of the invite email.
// At rest we store only its sha256 hex — same posture as the codebase's other
// bearer secrets (email-transfer claim links use `randomBytes(32).base64url`,
// ICS/volunteer tokens store sha256 digests). Claim-time lookup is an exact
// equality match on the hash: with 256 bits of `randomBytes` entropy behind
// it, a timing oracle on the hash/index comparison reveals nothing an
// attacker could enumerate, so no constant-time compare is needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw-token shape: 32 random bytes, url-safe base64 → exactly 43 chars (no
 * padding). Pinned to {43}: every token this module generates is 43 chars, so
 * anything else is malformed by construction — reject it at the boundary
 * instead of hashing garbage. Widen deliberately (alongside
 * `generateClaimToken`) if the token size ever changes.
 */
export const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type GeneratedClaimToken = {
  /** URL-safe raw token — email link only. NEVER persist or log this. */
  rawToken: string;
  /** sha256 hex of `rawToken` — the only form that touches the DB/audit. */
  tokenHash: string;
};

export function generateClaimToken(): GeneratedClaimToken {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashClaimToken(rawToken) };
}

/** sha256 hex of a raw claim token (the at-rest / lookup form). */
export function hashClaimToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * The adapter maps a P2002 on the unique `claimTokenHash` column to this
 * conflict message. With a 256-bit random token a collision is astronomically
 * unlikely — callers retry ONCE with a fresh token and let a second failure
 * propagate as the dependency error it would genuinely be.
 */
export function isClaimTokenHashCollision(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { message?: unknown }).message === "claim_token_hash_collision"
  );
}
