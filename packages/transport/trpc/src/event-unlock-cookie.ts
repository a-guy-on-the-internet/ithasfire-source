import { createHmac, timingSafeEqual } from "node:crypto";

import type { Ctx } from "./context";

const EVENT_UNLOCK_COOKIE_PREFIX = "th_eu_";
/**
 * APPLICATION grant (`th_ea_<eventId>`), set by the web claim route. A
 * SEPARATE name from the password cookie on purpose: every `th_eu_` reader
 * (sync-unlock → recordSignedPasswordUnlock, the orders-router persist, the
 * PASSWORD clause of event-read-access) treats it as "this viewer entered the
 * password", so a grant under that name would be one refactor away from
 * opening a password gate. Mirrors `apps/web/src/lib/event-unlock-cookie.ts`.
 */
const EVENT_APPLICATION_GRANT_COOKIE_PREFIX = "th_ea_";
/**
 * HMAC domain separator for the grant. The password cookie signs
 * `<eventId>|<exp>`; the grant signs
 * `th_ea|v2|<eventId>|<submissionId>|<approvedAtMs>|<exp>`, so neither
 * signature can ever verify as the other even under one secret.
 *
 * v2 added `approvedAtMs` (the submission's `reviewedAt` when the claim link
 * was redeemed) so a grant is bound to ONE approval: rescind → re-approve
 * does not revive it. v1 cookies (`<submissionId>.<exp>.<sig>`) have one
 * field fewer and fail the shape check — they fail closed, and the holder
 * re-clicks their claim link.
 */
const EVENT_APPLICATION_GRANT_HMAC_TAG = "th_ea|v2";
/**
 * INVITE grant (`th_ei_<eventId>`), set by the web invite redeem route
 * (gated-event invite links FR-004/FR-005, R10). Its own name for the same
 * reason `th_ea_` has one: it is neither "entered the password" nor "this
 * application was approved". It names an invite; core re-checks that invite
 * on every read (`invites/invite-grant.ts`: PERSONAL revoked → out, SHARED
 * reset/off → still in, event ended or cancelled → out).
 *
 * Format (mirrors `th_ea_`; the web signs, this file verifies):
 *   value = `<inviteId>.<expMs>.<base64url HMAC-SHA256(secret, msg)>`
 *   msg   = `th_ei|v1|<eventId>|<inviteId>|<expMs>`
 * with the same BETTER_AUTH_SECRET as the other gate cookies. `expMs` is the
 * event end the redeem returned (`expiresAtMs`). The `th_ei|v1` tag keeps a
 * grant from ever verifying as a `th_eu_` / `th_ea_` signature, or back.
 * Mirrors `apps/web/src/lib/event-unlock-cookie.ts`.
 */
const EVENT_INVITE_GRANT_COOKIE_PREFIX = "th_ei_";
const EVENT_INVITE_GRANT_HMAC_TAG = "th_ei|v1";
/**
 * Upper bound on `th_ei_*` cookies examined when looking for the grant a
 * redeem already holds; a browser has one per invited event, so this only
 * bounds the HMAC work a stuffed Cookie header can cause.
 */
const MAX_INVITE_GRANT_COOKIES_SCANNED = 20;
const EVENT_UNLOCK_SECRET_MIN_LENGTH = 32;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

/**
 * True when the request carries ANY gate cookie — a password unlock
 * (`th_eu_<eventId>`), an application grant (`th_ea_<eventId>`) or an invite
 * grant (`th_ei_<eventId>`), valid or not. Presence alone is enough to keep a request off shared caches: such a
 * caller may be entitled to see a gated event's details.
 */
export function hasEventUnlockCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const trimmed = part.trim();
    return (
      trimmed.startsWith(EVENT_UNLOCK_COOKIE_PREFIX) ||
      trimmed.startsWith(EVENT_APPLICATION_GRANT_COOKIE_PREFIX) ||
      trimmed.startsWith(EVENT_INVITE_GRANT_COOKIE_PREFIX)
    );
  });
}

function timingSafeStringEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

/** What a verified application grant names; core decides if it still holds. */
export type VerifiedApplicationGrant = {
  submissionId: string;
  /** The submission's `reviewedAt` (epoch ms) the grant was issued under. */
  approvedAtMs: number;
};

/**
 * The `{ submissionId, approvedAtMs }` carried by a VALID application grant
 * cookie for `eventId`, or `null`.
 *
 * Valid = well-formed `<submissionId>.<approvedAtMs>.<expMs>.<base64url hmac>`,
 * unexpired, and signed for THIS event with the shared secret. This proves
 * only that the web claim route issued it; whether it still opens anything is
 * decided in core by looking the submission up and requiring the same
 * approval (`_shared/application-gate-grant.ts`) — pass the result to the use
 * case, never treat it as an unlock on its own.
 */
export function readEventApplicationGrantCookie(
  ctx: Pick<Ctx, "cookieHeader" | "eventUnlockSecret">,
  eventId: string,
): VerifiedApplicationGrant | null {
  const secret = ctx.eventUnlockSecret;
  if (!secret || secret.length < EVENT_UNLOCK_SECRET_MIN_LENGTH) return null;

  const value = getCookieValue(
    ctx.cookieHeader ?? null,
    `${EVENT_APPLICATION_GRANT_COOKIE_PREFIX}${eventId}`,
  );
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [submissionId, approvedAtRaw, expRaw, signature] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!UUID_RE.test(submissionId) || !signature) return null;
  if (!/^\d{1,16}$/.test(approvedAtRaw)) return null;
  if (!/^\d{1,16}$/.test(expRaw)) return null;
  const approvedAtMs = Number(approvedAtRaw);
  if (!Number.isSafeInteger(approvedAtMs)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  const expected = createHmac("sha256", secret)
    .update(
      `${EVENT_APPLICATION_GRANT_HMAC_TAG}|${eventId}|${submissionId}|${approvedAtRaw}|${expRaw}`,
    )
    .digest("base64url");
  if (!timingSafeStringEqual(expected, signature)) return null;
  return { submissionId, approvedAtMs };
}

/** What a verified invite grant names; core decides if it still holds. */
export type VerifiedInviteGrant = {
  inviteId: string;
  /** The cookie's own expiry (epoch ms): the event end at redeem time. */
  expMs: number;
};

function verifyInviteGrantValue(
  secret: string,
  eventId: string,
  value: string,
): VerifiedInviteGrant | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [inviteId, expRaw, signature] = parts as [string, string, string];
  if (!UUID_RE.test(inviteId) || !signature) return null;
  if (!/^\d{1,16}$/.test(expRaw)) return null;
  const expMs = Number(expRaw);
  if (!Number.isSafeInteger(expMs) || Date.now() > expMs) return null;

  const expected = createHmac("sha256", secret)
    .update(`${EVENT_INVITE_GRANT_HMAC_TAG}|${eventId}|${inviteId}|${expRaw}`)
    .digest("base64url");
  if (!timingSafeStringEqual(expected, signature)) return null;
  return { inviteId, expMs };
}

/**
 * The `{ inviteId, expMs }` carried by a VALID invite grant cookie for
 * `eventId`, or `null`.
 *
 * Valid = well-formed `<inviteId>.<expMs>.<base64url hmac>`, unexpired, and
 * signed for THIS event with the shared secret. Like the application grant,
 * this proves only that the web redeem route issued it: pass the result to
 * core as `inviteGrant` (`getEventGateState`), never treat it as an unlock on
 * its own.
 */
export function readEventInviteGrantCookie(
  ctx: Pick<Ctx, "cookieHeader" | "eventUnlockSecret">,
  eventId: string,
): VerifiedInviteGrant | null {
  const secret = ctx.eventUnlockSecret;
  if (!secret || secret.length < EVENT_UNLOCK_SECRET_MIN_LENGTH) return null;

  const value = getCookieValue(
    ctx.cookieHeader ?? null,
    `${EVENT_INVITE_GRANT_COOKIE_PREFIX}${eventId}`,
  );
  if (!value) return null;
  return verifyInviteGrantValue(secret, eventId, value);
}

/**
 * For the invite redeem: the id of `inviteId` when the request already holds
 * a VALID `th_ei_<eventId>` grant naming it, under any event's cookie name
 * (the redeem input carries only the token, so the event is not known up
 * front; each cookie is verified against the event in its own name, and the
 * web only ever signs an invite under its own event). Otherwise `null`.
 *
 * Server-derived only: this is what `redeemEventInvite` receives as
 * `currentInviteGrantId`, never client input.
 */
export function findHeldEventInviteGrantId(
  ctx: Pick<Ctx, "cookieHeader" | "eventUnlockSecret">,
  inviteId: string,
): string | null {
  const secret = ctx.eventUnlockSecret;
  if (!secret || secret.length < EVENT_UNLOCK_SECRET_MIN_LENGTH) return null;
  if (!ctx.cookieHeader || !UUID_RE.test(inviteId)) return null;

  let scanned = 0;
  for (const part of ctx.cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(EVENT_INVITE_GRANT_COOKIE_PREFIX)) continue;
    if (++scanned > MAX_INVITE_GRANT_COOKIES_SCANNED) break;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const eventId = trimmed.slice(EVENT_INVITE_GRANT_COOKIE_PREFIX.length, eq);
    if (!UUID_RE.test(eventId)) continue;
    const grant = verifyInviteGrantValue(secret, eventId, trimmed.slice(eq + 1));
    if (grant && grant.inviteId === inviteId) return grant.inviteId;
  }
  return null;
}

export function verifyEventUnlockCookie(ctx: Ctx, eventId: string): boolean {
  const secret = ctx.eventUnlockSecret;
  if (!secret || secret.length < EVENT_UNLOCK_SECRET_MIN_LENGTH) return false;

  const value = getCookieValue(
    ctx.cookieHeader,
    `${EVENT_UNLOCK_COOKIE_PREFIX}${eventId}`,
  );
  if (!value) return false;

  const [expRaw, signature] = value.split(".");
  if (!expRaw || !signature) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const expected = createHmac("sha256", secret)
    .update(`${eventId}|${expRaw}`)
    .digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}
