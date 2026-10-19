import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { canonicalEmail } from "../event-edit-rights";

/**
 * "Stop invites from this organiser" tokens (gated-event invite links,
 * owner ruling 2026-10-05; fix round 1 2026-10-06 hashes the address).
 *
 *   iso_<base64url(payload)>_<base64url HMAC-SHA256(secret, LABEL + payload)>
 *   payload = "<o|h>:<ownerId>:<emailHash>"
 *   emailHash = base64url HMAC-SHA256(k_email, EMAIL_LABEL + canonical email)
 *   k_email = HKDF-SHA256(secret, info {@link INVITE_OPT_OUT_EMAIL_KEY_LABEL})
 *
 * - Stateless: minting needs no DB row, so every invite email can carry one.
 *   The organiser kind + id and the address's keyed hash are all inside the
 *   signed payload; nothing else is trusted.
 * - The address itself never appears: not in the token (which lands in
 *   request logs at Cloud Run and Cloudflare) and not in the opt-out table,
 *   which stores the same hash. The hash is keyed, so a leaked table or log
 *   can't be reversed with a dictionary of addresses without the key.
 * - The hash is of the CANONICAL address ({@link canonicalInviteEmail}):
 *   `ana+x@gmail.com` and `a.na@googlemail.com` opt out the same person,
 *   and an organiser can't dodge an opt-out by re-typing an alias.
 * - Keyed by its OWN HKDF-derived secret (info {@link INVITE_OPT_OUT_KEY_LABEL}),
 *   never the invite-token key: a leaked opt-out link can only ever opt that
 *   one address out of invites, from that organiser or, from the stop page,
 *   from every organiser ("Stop all event invites"). It cannot unlock,
 *   read or send anything.
 * - No expiry: an old email's link must keep working (CAN-SPAM wants an
 *   opt-out to work for at least 30 days; we keep it forever). Rotating the
 *   root secret invalidates every outstanding link AND orphans the stored
 *   hashes (they no longer match any new hash): a rotation must re-key or
 *   accept losing opt-outs.
 * - Verify is constant-time and re-encodes both halves, so a token has
 *   exactly one valid spelling.
 */

const PREFIX = "iso_";
const MAC_LABEL = "event-invite-optout.v1:";
const EMAIL_LABEL = "event-invite-optout-email.v1:";
/** 32 MAC bytes → 43 unpadded base64url chars. */
const MAC_B64_LENGTH = 43;
/** An email hash is a 32-byte HMAC, so also 43 base64url chars. */
export const INVITE_OPT_OUT_EMAIL_HASH_LENGTH = MAC_B64_LENGTH;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const EMAIL_HASH_RE = /^[A-Za-z0-9_-]{43}$/;
/** "o:" + uuid + ":" + hash. */
const PAYLOAD_LENGTH = 2 + 36 + 1 + INVITE_OPT_OUT_EMAIL_HASH_LENGTH;

/**
 * Length of every well-formed token (the payload is fixed-size): prefix +
 * base64url of the payload + "_" + MAC. Transport input bounds use it.
 */
export const INVITE_OPT_OUT_TOKEN_MAX_LENGTH =
  PREFIX.length + Math.ceil((PAYLOAD_LENGTH * 4) / 3) + 1 + MAC_B64_LENGTH;

/** A shorter secret is a configuration bug, not a usable key. */
export const MIN_INVITE_OPT_OUT_SECRET_LENGTH = 32;

/** HKDF `info` for the opt-out key. Bump the version to rotate. */
export const INVITE_OPT_OUT_KEY_LABEL = "th-invite-optout.v1";
/** HKDF `info` for the email-hash key, derived from the opt-out secret. */
export const INVITE_OPT_OUT_EMAIL_KEY_LABEL = "th-invite-optout-email.v1";

export type InviteOptOutOwner =
  | { kind: "ORG"; orgId: string }
  | { kind: "HUMAN"; humanId: string };

export type InviteOptOutClaims = {
  owner: InviteOptOutOwner;
  /** {@link hashInviteOptOutEmail} of the address. */
  emailHash: string;
};

/**
 * One spelling per mailbox, for opt-out matching (security review N6: an
 * organiser must not get past an opt-out by adding "+tag" or dots). Reuses
 * the platform's {@link canonicalEmail} (lowercase + trim, "+tag" dropped
 * for every domain, Gmail dots dropped and googlemail.com folded into
 * gmail.com), so an opt-out and a ban agree on what "the same mailbox" is.
 * Over-merging (a domain where "+" or dots ARE distinct mailboxes) can only
 * suppress MORE mail, the safe side for an opt-out.
 */
export function canonicalInviteEmail(email: string): string {
  return canonicalEmail(email) ?? "";
}

const emailKeyCache = new Map<string, Buffer>();
function emailKeyFor(secret: string): Buffer {
  let key = emailKeyCache.get(secret);
  if (!key) {
    key = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), INVITE_OPT_OUT_EMAIL_KEY_LABEL, 32),
    );
    // One or two secrets per process in practice; bounded anyway.
    if (emailKeyCache.size > 8) emailKeyCache.clear();
    emailKeyCache.set(secret, key);
  }
  return key;
}

/**
 * The keyed hash an opt-out is stored and matched under: HMAC-SHA256 of the
 * {@link canonicalInviteEmail} under a key HKDF-derived from the opt-out
 * secret, 43 base64url chars. Deterministic, so send-time matching hashes
 * each candidate the same way.
 */
export function hashInviteOptOutEmail(email: string, secret: string): string {
  assertSecret(secret);
  return createHmac("sha256", emailKeyFor(secret))
    .update(EMAIL_LABEL + canonicalInviteEmail(email))
    .digest("base64url");
}

function assertSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    secret.length < MIN_INVITE_OPT_OUT_SECRET_LENGTH
  ) {
    throw new Error("invite_optout_secret_too_short");
  }
}

/**
 * The opt-out secret for a composition root: HKDF-SHA256 of the root server
 * secret (BETTER_AUTH_SECRET) under {@link INVITE_OPT_OUT_KEY_LABEL}, 32
 * bytes, base64url. Same construction as `deriveInviteTokenSecret`. Null for
 * a missing or short root; the send then fails NOT_CONFIGURED rather than
 * mailing an invite without a working opt-out.
 */
export function deriveInviteOptOutSecret(
  rootSecret: string | null | undefined,
): string | null {
  if (
    typeof rootSecret !== "string" ||
    rootSecret.length < MIN_INVITE_OPT_OUT_SECRET_LENGTH
  ) {
    return null;
  }
  return Buffer.from(
    hkdfSync("sha256", rootSecret, Buffer.alloc(0), INVITE_OPT_OUT_KEY_LABEL, 32),
  ).toString("base64url");
}

function payloadFor(claims: InviteOptOutClaims): string {
  const ownerPart =
    claims.owner.kind === "ORG"
      ? `o:${claims.owner.orgId}`
      : `h:${claims.owner.humanId}`;
  return `${ownerPart}:${claims.emailHash}`;
}

function macFor(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(MAC_LABEL + payload).digest();
}

function parsePayload(payload: string): InviteOptOutClaims | null {
  // "<o|h>:<uuid>:<43-char hash>": fixed size.
  if (payload.length !== PAYLOAD_LENGTH) return null;
  const kind = payload.slice(0, 2);
  const id = payload.slice(2, 38);
  if (payload[38] !== ":") return null;
  const emailHash = payload.slice(39);
  if (!UUID_RE.test(id) || !EMAIL_HASH_RE.test(emailHash)) return null;
  if (kind === "o:") return { owner: { kind: "ORG", orgId: id }, emailHash };
  if (kind === "h:") return { owner: { kind: "HUMAN", humanId: id }, emailHash };
  return null;
}

/**
 * Mint the opt-out token for (organiser, address). Deterministic. Throws on
 * a short secret, a malformed owner id or an unusable address: all three are
 * programming or configuration errors at the call site.
 */
export function mintInviteOptOutToken(
  input: { owner: InviteOptOutOwner; email: string },
  secret: string,
): string {
  assertSecret(secret);
  if (!input.email.includes("@")) throw new Error("invite_optout_bad_claims");
  const claims: InviteOptOutClaims = {
    owner: input.owner,
    emailHash: hashInviteOptOutEmail(input.email, secret),
  };
  const payload = payloadFor(claims);
  if (!parsePayload(payload)) {
    throw new Error("invite_optout_bad_claims");
  }
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${PREFIX}${encoded}_${macFor(payload, secret).toString("base64url")}`;
}

/**
 * Verify a presented token: structure, MAC (constant time), canonical
 * encoding, then the payload's shape. Returns the claims only for a token
 * this secret minted; null for anything else (never throws on input).
 */
export function verifyInviteOptOutToken(
  token: unknown,
  secret: string,
): InviteOptOutClaims | null {
  assertSecret(secret);
  if (
    typeof token !== "string" ||
    token.length > INVITE_OPT_OUT_TOKEN_MAX_LENGTH ||
    !token.startsWith(PREFIX)
  ) {
    return null;
  }
  const body = token.slice(PREFIX.length);
  // base64url has "_" in its alphabet, so the payload/MAC split is by
  // position: the MAC is always the last 43 chars, after one "_".
  const macPart = body.slice(body.length - MAC_B64_LENGTH);
  const encodedPayload = body.slice(0, body.length - MAC_B64_LENGTH - 1);
  if (
    body.length <= MAC_B64_LENGTH + 1 ||
    body[body.length - MAC_B64_LENGTH - 1] !== "_" ||
    !B64URL_RE.test(encodedPayload) ||
    !B64URL_RE.test(macPart)
  ) {
    return null;
  }

  const payloadBuf = Buffer.from(encodedPayload, "base64url");
  if (payloadBuf.toString("base64url") !== encodedPayload) return null;
  const payload = payloadBuf.toString("utf8");

  const presented = Buffer.from(macPart, "base64url");
  const expected = macFor(payload, secret);
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  if (presented.toString("base64url") !== macPart) return null;

  return parsePayload(payload);
}
