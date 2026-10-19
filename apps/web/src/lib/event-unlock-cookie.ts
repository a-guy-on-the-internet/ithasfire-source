import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { webEnv } from "@/config/env.server";

/**
 * Signed, per-event HTTP cookie that proves a viewer entered the correct
 * password for a gated event. Used so anonymous viewers' unlocks survive
 * the `router.refresh()` that follows a successful password submission.
 *
 * For signed-in viewers the unlock is persisted to the `event_unlocks`
 * table via `humanId`, so this cookie path is only relevant for guests.
 *
 * Cookie design
 *   - Name: `th_eu_<eventId>` — one cookie per event, scoped tight.
 *   - Value: `<expMs>.<base64url(hmac)>` where the HMAC covers
 *     `<eventId>|<expMs>` with the shared `BETTER_AUTH_SECRET`.
 *   - Flags: HttpOnly, Secure (in prod), SameSite=Lax, Path=/
 *   - TTL: 24 hours — long enough for "I'll check out tomorrow" but
 *     short enough that a stolen cookie doesn't live forever.
 *
 * Path is scoped to `/` so the checkout sync route can persist the
 * unlock after a guest signs in.
 *
 * PASSWORD gates only. The APPLICATION gate has its own grant below
 * (`th_ea_<eventId>`) — see {@link buildEventApplicationGrantSetCookie}.
 */

export const EVENT_UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_PREFIX = "th_eu_";
const COOKIE_PATH = "/";
const MIN_SECRET_LENGTH = 32;

function getSecret(): string | null {
  const secret = webEnv.betterAuth.secret;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const eventUnlockCookieName = (eventId: string): string =>
  `${COOKIE_PREFIX}${eventId}`;

/** Returns the full Set-Cookie value, or null if the server lacks a secret. */
export function buildEventUnlockSetCookie(eventId: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const exp = Date.now() + EVENT_UNLOCK_TTL_MS;
  const payload = `${eventId}|${exp}`;
  const value = `${exp}.${base64UrlEncode(sign(payload, secret))}`;
  const name = eventUnlockCookieName(eventId);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAgeSec = Math.floor(EVENT_UNLOCK_TTL_MS / 1000);
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`;
}

/** Verify a cookie value (already extracted from the request). */
export function verifyEventUnlockCookie(
  eventId: string,
  cookieValue: string | undefined | null,
): boolean {
  if (!cookieValue) return false;
  const secret = getSecret();
  if (!secret) return false;
  const idx = cookieValue.indexOf(".");
  if (idx < 1 || idx === cookieValue.length - 1) return false;
  const exp = Number(cookieValue.slice(0, idx));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const sigB64 = cookieValue.slice(idx + 1);
  const expected = sign(`${eventId}|${exp}`, secret);
  let provided: Buffer;
  try {
    provided = base64UrlDecode(sigB64);
  } catch {
    return false;
  }
  return safeEqual(expected, provided);
}

// ─────────────────────────────────────────────────────────────────────────────
// Application grant (`th_ea_<eventId>`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signed, per-event cookie the approval-claim route sets for an applicant
 * whose approval token it just redeemed. It carries the approved
 * `submissionId` plus `approvedAtMs` (the submission's `reviewedAt` for that
 * approval) and is honoured ONLY for APPLICATION gates, and only while that
 * submission is still APPROVED for this event under that same approval — the
 * API re-reads it on every check
 * (`packages/core/src/use-cases/events/_shared/application-gate-grant.ts`),
 * so rescind / withdraw / reject revoke it on the next request, and a later
 * re-approval does not bring it back.
 *
 * Why not reuse `th_eu_`: that cookie means "entered the password" to every
 * reader (sync-unlock, the orders-router persist, the PASSWORD read clause),
 * and it is a pure bearer pass with nothing server-side to revoke.
 *
 * Cookie design
 *   - Name: `th_ea_<eventId>`.
 *   - Value: `<submissionId>.<approvedAtMs>.<expMs>.<base64url(hmac)>`, HMAC
 *     over `th_ea|v2|<eventId>|<submissionId>|<approvedAtMs>|<expMs>` with
 *     the same `BETTER_AUTH_SECRET`. The `th_ea|v2` tag domain-separates it
 *     from the password cookie's `<eventId>|<expMs>` so neither verifies as
 *     the other. (v1 lacked `approvedAtMs`; the API rejects v1 values.)
 *   - Flags and TTL: identical to the password cookie (HttpOnly, Secure in
 *     prod, SameSite=Lax, Path=/, 24h).
 *
 * Verified by the API (`packages/transport/trpc/src/event-unlock-cookie.ts`,
 * `readEventApplicationGrantCookie`) — the web never decides on it locally; the
 * SSR tRPC client forwards it on the uncacheable routes.
 */
export const EVENT_APPLICATION_GRANT_COOKIE_PREFIX = "th_ea_";
const APPLICATION_GRANT_HMAC_TAG = "th_ea|v2";

export const eventApplicationGrantCookieName = (eventId: string): string =>
  `${EVENT_APPLICATION_GRANT_COOKIE_PREFIX}${eventId}`;

/** Returns the full Set-Cookie value, or null if the server lacks a secret. */
export function buildEventApplicationGrantSetCookie(
  eventId: string,
  submissionId: string,
  /** The submission's `reviewedAt` (epoch ms) for the approval redeemed. */
  approvedAtMs: number,
): string | null {
  const secret = getSecret();
  if (!secret) return null;
  if (!Number.isSafeInteger(approvedAtMs) || approvedAtMs < 0) return null;
  const exp = Date.now() + EVENT_UNLOCK_TTL_MS;
  const payload = `${APPLICATION_GRANT_HMAC_TAG}|${eventId}|${submissionId}|${approvedAtMs}|${exp}`;
  const value = `${submissionId}.${approvedAtMs}.${exp}.${base64UrlEncode(sign(payload, secret))}`;
  const name = eventApplicationGrantCookieName(eventId);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAgeSec = Math.floor(EVENT_UNLOCK_TTL_MS / 1000);
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invite grant (`th_ei_<eventId>`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signed, per-event cookie the invite redeem route
 * (`app/api/events/[eventId]/invite/route.ts`) sets for a signed-out visitor
 * who opened a live invite link (gated-event invite links FR-004 / FR-005
 * SHARED). It names the INVITE, not a person: the API re-checks that invite on
 * every read (`packages/core/src/use-cases/events/invites/invite-grant.ts`):
 * a revoked PERSONAL invite, an ended or cancelled event, or an ungated event
 * all end it on the next request. It opens EITHER gate type.
 *
 * Cookie design
 *   - Name: `th_ei_<eventId>`.
 *   - Value: `<inviteId>.<expMs>.<base64url(hmac)>`, HMAC-SHA256 over
 *     `th_ei|v1|<eventId>|<inviteId>|<expMs>` with the same
 *     `BETTER_AUTH_SECRET`. The `th_ei|v1` tag domain-separates it from the
 *     password and application cookies.
 *   - Flags: identical to the other two (HttpOnly, Secure in prod,
 *     SameSite=Lax, Path=/).
 *   - TTL: until `expMs`, the event end the redeem returned (FR-008). Max-Age
 *     never runs past it.
 *
 * Verified by the API (`packages/transport/trpc/src/event-unlock-cookie.ts`,
 * `readEventInviteGrantCookie`); the golden vector in
 * `__tests__/event-unlock-cookie.test.ts` pins the bytes both sides agree on.
 */
export const EVENT_INVITE_GRANT_COOKIE_PREFIX = "th_ei_";
const INVITE_GRANT_HMAC_TAG = "th_ei|v1";

export const eventInviteGrantCookieName = (eventId: string): string =>
  `${EVENT_INVITE_GRANT_COOKIE_PREFIX}${eventId}`;

/**
 * Returns the full Set-Cookie value, or null when the server lacks a secret,
 * `expMs` is unusable, or the grant has already expired (nothing to set).
 */
export function buildEventInviteGrantSetCookie(
  eventId: string,
  inviteId: string,
  /** The event end (epoch ms) the redeem returned as `expiresAtMs`. */
  expMs: number,
): string | null {
  const secret = getSecret();
  if (!secret) return null;
  if (!Number.isSafeInteger(expMs) || expMs < 0) return null;
  const maxAgeSec = Math.floor((expMs - Date.now()) / 1000);
  if (maxAgeSec <= 0) return null;
  const payload = `${INVITE_GRANT_HMAC_TAG}|${eventId}|${inviteId}|${expMs}`;
  const value = `${inviteId}.${expMs}.${base64UrlEncode(sign(payload, secret))}`;
  const name = eventInviteGrantCookieName(eventId);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`;
}
