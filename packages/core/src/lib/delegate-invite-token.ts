import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless, signed delegate-invitation tokens.
 *
 * WHY STATELESS: `HumanDelegate` has no pending state, and adding one needs a
 * migration that also changes every delegation read (authz, event edit
 * rights). Instead the principal mints a signed invitation and hands the link
 * to the person they want as a delegate; the grant row is only created when
 * THAT person accepts while signed in with the invited email. Consent without
 * a schema change (security review F3, 2026-09-29).
 *
 * The token binds principal, invited email, role and expiry, and carries a
 * random nonce. `acceptDelegateInvite` makes each nonce single-use through the
 * idempotency store, so a link can't be replayed after the principal removes
 * the delegate.
 *
 * NOT ENCRYPTED: the payload is base64url JSON. It holds the principal's id,
 * the invited email (which the holder already knows — it was sent to them) and
 * the role. Anyone who can read the link can read those; nothing else.
 *
 * Key: HMAC-SHA256 under a key DERIVED from the shared server secret with
 * HKDF-SHA256 (`info` = a fixed label, same construction as
 * `lib/location/obfuscation-key.ts`), so the root secret used elsewhere can't
 * be confused with a delegate-invite signature (domain separation).
 */

const VERSION = "v1";
/** HKDF `info` — bump the version to invalidate every outstanding link. */
const KEY_LABEL = "ithasfire.delegate-invite.v1";
export const DELEGATE_INVITE_SECRET_MIN_LENGTH = 32;

export type DelegateInvitePayload = {
  /** Principal (account owner) granting the delegation. */
  principalId: string;
  /** Lower-cased email the invitation is bound to. */
  email: string;
  /** Delegate role (never OWNER — enforced by the use case schemas). */
  role: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /** Random single-use id. */
  nonce: string;
};

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_LABEL, 32));
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", deriveKey(secret))
    .update(`${VERSION}.${body}`)
    .digest("base64url");
}

export function isUsableDelegateInviteSecret(
  secret: string | null | undefined,
): secret is string {
  return (
    typeof secret === "string" &&
    secret.length >= DELEGATE_INVITE_SECRET_MIN_LENGTH
  );
}

export function newDelegateInviteNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function signDelegateInviteToken(
  secret: string,
  payload: DelegateInvitePayload,
): string {
  const body = Buffer.from(
    JSON.stringify({
      p: payload.principalId,
      e: payload.email,
      r: payload.role,
      x: payload.exp,
      n: payload.nonce,
    }),
  ).toString("base64url");
  return `${VERSION}.${body}.${sign(secret, body)}`;
}

/**
 * Returns the payload when the signature is valid, else null. Does NOT check
 * expiry — the caller does, so it can report "expired" distinctly from
 * "invalid".
 */
export function verifyDelegateInviteToken(
  secret: string,
  token: string,
): DelegateInvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, body, signature] = parts as [string, string, string];
  if (version !== VERSION || !body || !signature) return null;

  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const d = decoded as Record<string, unknown>;
  if (
    typeof d.p !== "string" ||
    typeof d.e !== "string" ||
    typeof d.r !== "string" ||
    typeof d.x !== "number" ||
    !Number.isFinite(d.x) ||
    typeof d.n !== "string"
  ) {
    return null;
  }
  return { principalId: d.p, email: d.e, role: d.r, exp: d.x, nonce: d.n };
}
