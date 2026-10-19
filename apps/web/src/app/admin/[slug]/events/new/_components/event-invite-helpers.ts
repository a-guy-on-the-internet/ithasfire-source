import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";

/**
 * Pure helpers for the Access Gate invite panel (gated-event invite links,
 * docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml, FR-001/002/003).
 * Kept out of the components so the copy rules are unit-testable without the
 * styling layer.
 */

export type InviteGateType = "PASSWORD" | "APPLICATION";

/** Translator narrowed to strings (the app's `t` returns `string`). */
export type InviteTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** The counts `events.createGuestInvites` returns. */
export type GuestInviteSendResult = {
  created: number;
  reused: number;
  sent: number;
  skippedUnsubscribed: number;
  /**
   * Opted out of this organiser's invites (or on the org's suppression
   * list). A count only: which addresses is never sent back.
   */
  skippedOptedOut: number;
  skippedNoEmail: number;
  failed: number;
};

/**
 * A send's one-line result. `info` = nothing went wrong but nothing was sent
 * either (the person opted out): muted like success, but the form keeps what
 * was typed.
 */
export type InviteFeedbackTone = "success" | "error" | "info";

/**
 * The transport's rate limiter throws a bare `TOO_MANY_REQUESTS` TRPCError
 * whose message is an English sentence ("Rate limit exceeded for …"). That
 * sentence would pass `formatErrorMessage` untranslated, so it is caught here
 * by its tRPC code instead.
 */
export function isRateLimitedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: { code?: unknown; httpStatus?: unknown } })
    .data;
  return data?.code === "TOO_MANY_REQUESTS" || data?.httpStatus === 429;
}

/**
 * A send (create / resend) refused because the sender's account email isn't
 * verified (`EMAIL_NOT_VERIFIED`, create-event-guest-invites.ts).
 */
export function isEmailNotVerifiedError(error: unknown): boolean {
  return getAppErrorCode(error) === "EMAIL_NOT_VERIFIED";
}

/** A send (create / resend) refused because the event is a draft or archived. */
export function isNotPublishedError(error: unknown): boolean {
  return getAppErrorCode(error) === "EVENT_NOT_PUBLISHED";
}

/**
 * Refusals the invite use cases raise with a specific MESSAGE under a generic
 * code (`INVALID_INPUT` / `INVALID_STATUS`). The transport forwards the
 * message as the client error's `message`, so it is matched exactly here
 * (create-event-guest-invites.ts, _shared.ts). An unverified sender is an
 * app CODE, not a message: `EMAIL_NOT_VERIFIED`, see
 * {@link isEmailNotVerifiedError}.
 */
const MESSAGE_COPY: Record<string, string> = {
  guest_invite_list_too_large: "admin.ginListTooLarge",
  invite_revoked: "admin.ginInviteWasRevoked",
  event_not_gated: "admin.ginEventNotGated",
};

/**
 * Refusals that mean the panel's data is stale (the invite was revoked
 * elsewhere, the gate was removed): callers refetch the list after showing
 * the message.
 */
export function isStaleInviteError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  // INVITES_PAUSED: the organiser was paused since the status was read (W4).
  if (getAppErrorCode(error) === "INVITES_PAUSED") return true;
  return message === "invite_revoked" || message === "event_not_gated";
}

/**
 * The daily allowance's numbers, as the copy states them. Mirrors
 * `NEW_SENDER_DAILY_RECIPIENTS`, `TRACK_RECORD_DAILY_RECIPIENTS`,
 * `MIN_DISTINCT_SCANNED_HOLDERS` and `NEW_ACCOUNT_DAILY_RECIPIENTS` in core's
 * invite-allowance.ts (pinned by a test, so the two cannot drift apart
 * silently).
 */
export const INVITE_ALLOWANCE_NUMBERS = {
  newDaily: 50,
  scanned: 10,
  trustedDaily: 1000,
  newAccountDaily: 10,
} as const;

/** `meta.tier` on INVITE_ALLOWANCE_EXCEEDED: which rule set the limit. */
type AllowanceTier = "NEW_ACCOUNT" | "NEW_SENDER" | "TRACK_RECORD";

function readTier(meta: Record<string, unknown>): AllowanceTier | null {
  const value = meta.tier;
  return value === "NEW_ACCOUNT" ||
    value === "NEW_SENDER" ||
    value === "TRACK_RECORD"
    ? value
    : null;
}

function readNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * INVITE_ALLOWANCE_EXCEEDED (board option A, "state the rule"): how many
 * fit, then why the number is what it is. `meta` = `{ requested, remaining,
 * limit, tier, … }` (invite-allowance.ts). `tier` names the rule that bound
 * the send: a sender's account under a week old gets its own lines; without
 * a `tier` (an older server) the limit alone picks new vs track record. Null when the meta is missing, so the
 * caller falls back to the generic `errors.*` line.
 */
export function inviteAllowanceMessage(
  error: unknown,
  t: InviteTranslate,
  scope: "list" | "single",
): string | null {
  if (getAppErrorCode(error) !== "INVITE_ALLOWANCE_EXCEEDED") return null;
  const meta = (error as { data?: { meta?: unknown } } | null)?.data?.meta;
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;
  const limit = readNumber(record, "limit");
  const remaining = readNumber(record, "remaining");
  const requested = readNumber(record, "requested");
  if (limit === null || remaining === null) return null;
  const tier = readTier(record);
  const newAccount = tier === "NEW_ACCOUNT";
  const count =
    scope === "list" && remaining > 0 && requested !== null
      ? t("admin.ginAllowanceList", { listCount: requested, remaining })
      : newAccount
        ? t("admin.ginAllowanceSpentNewAccount", { limit })
        : t("admin.ginAllowanceSpent", { limit });
  const trusted =
    tier === "TRACK_RECORD" ||
    (tier === null && limit >= INVITE_ALLOWANCE_NUMBERS.trustedDaily);
  const { newDaily, scanned, trustedDaily, newAccountDaily } =
    INVITE_ALLOWANCE_NUMBERS;
  const rule = newAccount
    ? t("admin.ginAllowanceRuleNewAccount", { newAccountDaily })
    : trusted
      ? t("admin.ginAllowanceRuleTrusted", { trustedDaily })
      : t("admin.ginAllowanceRuleNew", { newDaily, scanned, trustedDaily });
  return `${count} ${rule}`;
}

/**
 * One line for any invite mutation failure. The refusals an organizer can act
 * on get their own copy; everything else goes through the app's formatter
 * WITH the translator (without it, every code reads "Something went wrong").
 * `scope`: a contact-list send states the list's size when over the daily
 * allowance; everything else (one guest, a resend) states the allowance.
 */
export function inviteErrorMessage(
  error: unknown,
  t: InviteTranslate,
  scope: "list" | "single" = "single",
): string {
  // Before the generic 429 check: both of these arrive as TOO_MANY_REQUESTS.
  const appCode = getAppErrorCode(error);
  if (appCode === "INVITE_ALLOWANCE_EXCEEDED") {
    return (
      inviteAllowanceMessage(error, t, scope) ??
      formatErrorMessage(error, (key) => t(key))
    );
  }
  if (appCode === "INVITE_RESEND_TOO_SOON") {
    // errors.inviteResendTooSoon
    return formatErrorMessage(error, (key) => t(key));
  }
  // Paused since the panel last read its status (W4): the notice explains.
  if (appCode === "INVITES_PAUSED") return t("admin.ginPauseRaced");
  // The allowance limiter is down (it fails closed); internal-tier code.
  if (appCode === "SERVICE_UNAVAILABLE") return t("admin.ginSendUnavailable");
  if (isRateLimitedError(error)) return t("admin.ginRateLimited");
  if (isEmailNotVerifiedError(error)) return t("admin.ginVerifyEmailToSend");
  if (isNotPublishedError(error)) return t("admin.ginNotPublished");
  const message = (error as { message?: unknown } | null)?.message;
  // Own-property check: a server message like "constructor" must not match
  // an inherited Object.prototype member.
  if (typeof message === "string" && Object.hasOwn(MESSAGE_COPY, message)) {
    return t(MESSAGE_COPY[message]);
  }
  if (getAppErrorCode(error) === "EVENT_ALREADY_ENDED") {
    return t("admin.ginEventEnded");
  }
  return formatErrorMessage(error, (key) => t(key));
}

/** A guest's name for labels; the email stands in when no name was given. */
export function guestDisplayName(guest: {
  name: string | null;
  email: string;
}): string {
  const name = guest.name?.trim();
  return name ? name : guest.email;
}

/**
 * The one-line result of a contact-list send, e.g.
 * "Sent to 41. 3 skipped (unsubscribed). 1 failed." Zero counts are left
 * out except "Sent to", which always leads so a list that sent nothing says
 * so plainly.
 */
export function summarizeListSend(
  result: GuestInviteSendResult,
  t: InviteTranslate,
): string {
  const parts = [t("admin.ginListSentTo", { count: result.sent })];
  if (result.reused > 0) {
    parts.push(t("admin.ginListAlreadyInvited", { count: result.reused }));
  }
  if (result.skippedUnsubscribed > 0) {
    parts.push(
      t("admin.ginListSkippedUnsubscribed", {
        count: result.skippedUnsubscribed,
      }),
    );
  }
  // A count, never names: a person's "no" stays theirs.
  if (result.skippedOptedOut > 0) {
    parts.push(
      t("admin.ginListSkippedOptedOut", { count: result.skippedOptedOut }),
    );
  }
  if (result.skippedNoEmail > 0) {
    parts.push(
      t("admin.ginListSkippedNoEmail", { count: result.skippedNoEmail }),
    );
  }
  if (result.failed > 0) {
    parts.push(t("admin.ginListFailed", { count: result.failed }));
  }
  return parts.join(" ");
}

/**
 * The result of adding ONE guest by hand. A hand-added guest is emailed
 * unless they already hold a live invite (reused without re-sending) or have
 * asked this organiser to stop (owner ruling 2026-10-05: no row, no email).
 */
export function summarizeSingleSend(
  result: GuestInviteSendResult,
  email: string,
  t: InviteTranslate,
): { message: string; tone: InviteFeedbackTone } {
  if (result.skippedOptedOut > 0) {
    return { message: t("admin.ginOptedOut"), tone: "info" };
  }
  if (result.failed > 0) {
    return { message: t("admin.ginSendFailedEmail"), tone: "error" };
  }
  if (result.sent > 0) {
    return { message: t("admin.ginSentTo", { email }), tone: "success" };
  }
  if (result.reused > 0) {
    return { message: t("admin.ginAlreadyInvited", { email }), tone: "success" };
  }
  return { message: t("admin.ginSendFailedEmail"), tone: "error" };
}

/** Loose client check before the server's own email validation. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
