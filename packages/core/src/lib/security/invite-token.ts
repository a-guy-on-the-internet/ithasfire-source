import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Gated-event invite link tokens
 * (docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml, NFR-001).
 *
 *   inv_<inviteId>_<base64url HMAC-SHA256(secret, "event-invite.v1:" + inviteId)>
 *
 * - The MAC is 256 bits, keyed by a server secret the caller passes in (core
 *   never reads env), so a token is infeasible to guess (NFR-003).
 * - It is RE-DERIVABLE from the invite id, so the organizer can Copy link
 *   again without the raw token ever being stored. The DB keeps only
 *   {@link hashInviteToken} (SHA-256 hex) for the lookup.
 * - Revocation is a row state (`revokedAt`), never a secret rotation.
 *   Rotating the secret would kill every link at once.
 * - The `event-invite.v1:` label keeps these MACs distinct from anything
 *   else that might ever be signed with the same secret.
 */

const PREFIX = "inv_";
const MAC_LABEL = "event-invite.v1:";
/** Lowercase canonical v1–v8 UUID text (what randomUUID / Postgres emit). */
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);
/** 32 MAC bytes → 43 unpadded base64url chars. */
const MAC_B64_LENGTH = 43;
const TOKEN_RE = new RegExp(
  `^${PREFIX}(${UUID_PATTERN})_([A-Za-z0-9_-]{${MAC_B64_LENGTH}})$`,
);

/** Exact length of every well-formed token: "inv_" + 36 + "_" + 43. */
export const INVITE_TOKEN_LENGTH = PREFIX.length + 36 + 1 + MAC_B64_LENGTH;

/** A shorter secret is a configuration bug, not a usable key. */
export const MIN_INVITE_TOKEN_SECRET_LENGTH = 32;

function assertSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    secret.length < MIN_INVITE_TOKEN_SECRET_LENGTH
  ) {
    throw new Error("invite_token_secret_too_short");
  }
}

/** HKDF `info` for the invite-token key. Bump the version to rotate. */
export const INVITE_TOKEN_KEY_LABEL = "th-event-invite-token.v1";

/**
 * The invite-token secret for a composition root: HKDF-SHA256 of the root
 * server secret (BETTER_AUTH_SECRET) under {@link INVITE_TOKEN_KEY_LABEL},
 * 32 bytes, base64url (43 chars). The same construction as
 * `network-identity.ts` / `delegate-invite-token.ts`, so the raw root secret
 * is never the MAC key and no new secret has to be provisioned.
 *
 * Returns null for a missing or short root secret; the use cases then fail
 * NOT_CONFIGURED instead of minting links under a weak key. Rotating the
 * root secret kills every invite link at once (see the header note).
 */
export function deriveInviteTokenSecret(
  rootSecret: string | null | undefined,
): string | null {
  if (
    typeof rootSecret !== "string" ||
    rootSecret.length < MIN_INVITE_TOKEN_SECRET_LENGTH
  ) {
    return null;
  }
  return Buffer.from(
    hkdfSync("sha256", rootSecret, Buffer.alloc(0), INVITE_TOKEN_KEY_LABEL, 32),
  ).toString("base64url");
}

function macFor(inviteId: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(MAC_LABEL + inviteId).digest();
}

/**
 * Mint (or re-derive) the raw token for an invite. Deterministic: the same
 * id and secret always give the same token. Throws on a malformed id or a
 * short secret; both are programming / configuration errors.
 */
export function mintInviteToken(inviteId: string, secret: string): string {
  assertSecret(secret);
  if (!UUID_RE.test(inviteId)) {
    throw new Error("invite_token_bad_invite_id");
  }
  return `${PREFIX}${inviteId}_${macFor(inviteId, secret).toString("base64url")}`;
}

/** SHA-256 hex of the raw token: the only form the DB stores. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Strict structural parse, no secret involved. Returns null for anything
 * that is not exactly `inv_<lowercase uuid>_<43 base64url chars>`.
 */
export function parseInviteToken(token: unknown): { inviteId: string } | null {
  if (typeof token !== "string" || token.length !== INVITE_TOKEN_LENGTH) {
    return null;
  }
  const match = TOKEN_RE.exec(token);
  if (!match?.[1]) return null;
  return { inviteId: match[1] };
}

/**
 * Parse, then recompute the MAC and compare it in constant time. Returns the
 * invite id only for a token this secret minted; the caller then looks the
 * row up by {@link hashInviteToken} and requires the ids to agree.
 */
export function verifyInviteToken(
  token: unknown,
  secret: string,
): { inviteId: string } | null {
  assertSecret(secret);
  const parsed = parseInviteToken(token);
  if (!parsed) return null;

  const presented = Buffer.from(
    (token as string).slice(PREFIX.length + 36 + 1),
    "base64url",
  );
  const expected = macFor(parsed.inviteId, secret);
  // Length check first: timingSafeEqual throws on unequal lengths. A
  // 43-char base64url string always decodes to 32 bytes, but non-canonical
  // trailing bits must not slip through either, hence the re-encode check.
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  if (
    presented.toString("base64url") !==
    (token as string).slice(PREFIX.length + 36 + 1)
  ) {
    return null;
  }
  return parsed;
}
