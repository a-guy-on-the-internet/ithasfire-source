import { lookupOwn } from "@/lib/lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// Volunteering (generic asks) — shared UI helpers
//
// Pure helpers shared by the org/place/human ask dashboards, the ask manage
// page, the public signup page (/v/[askId]), and the coordinator console.
// Kept free of React so they can be unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────

export type AskStatus = "DRAFT" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED";
export type AskCadence = "ONE_TIME" | "ONGOING" | "RECURRING";

export type BadgeToneName =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export const ASK_STATUS_LABEL_KEY: Record<AskStatus, string> = {
  DRAFT: "volunteering.askStatusDraft",
  OPEN: "volunteering.askStatusOpen",
  PAUSED: "volunteering.askStatusPaused",
  CLOSED: "volunteering.askStatusClosed",
  ARCHIVED: "volunteering.askStatusArchived",
};

export const ASK_STATUS_TONE: Record<AskStatus, BadgeToneName> = {
  DRAFT: "neutral",
  OPEN: "success",
  PAUSED: "warning",
  CLOSED: "danger",
  ARCHIVED: "neutral",
};

export const ASK_CADENCE_LABEL_KEY: Record<AskCadence, string> = {
  ONE_TIME: "volunteering.cadenceOneTime",
  ONGOING: "volunteering.cadenceOngoing",
  RECURRING: "volunteering.cadenceRecurring",
};

// Signup status maps mirror the admin SignupsTab treatment so the two
// review surfaces (event tab / ask surfaces) read identically.
export type SignupStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "CHECKED_IN"
  | "NO_SHOW";

export const SIGNUP_STATUS_LABEL_KEY: Record<SignupStatus, string> = {
  PENDING: "volunteering.signupStatusPending",
  APPROVED: "volunteering.signupStatusApproved",
  REJECTED: "volunteering.signupStatusRejected",
  WITHDRAWN: "volunteering.signupStatusWithdrawn",
  CHECKED_IN: "volunteering.signupStatusCheckedIn",
  NO_SHOW: "volunteering.signupStatusNoShow",
};

export const SIGNUP_STATUS_TONE: Record<SignupStatus, BadgeToneName> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  WITHDRAWN: "neutral",
  CHECKED_IN: "info",
  NO_SHOW: "neutral",
};

/**
 * ATTENDEE-facing wording for the same statuses, used by `/my-volunteering`.
 *
 * The map above is the ORGANIZER's vocabulary — a reviewer reads a queue of
 * applications, so "Pending" / "Approved" / "Rejected" are correct there. A
 * volunteer is asking one question ("am I on the schedule?"), so the same
 * enum needs an answer, not a record status. Two label tables, ONE tone
 * table: tone is a visual property of the status and must not fork.
 *
 * `NO_SHOW` is deliberately absent. Nothing in the system writes it (no use
 * case sets that status), so there is no attendee-facing promise to make
 * around it; {@link attendeeSignupStatusLabelKey} falls back to the
 * organizer label so an unexpected row still renders instead of crashing.
 */
export const SIGNUP_STATUS_ATTENDEE_LABEL_KEY: Record<
  Exclude<SignupStatus, "NO_SHOW">,
  string
> = {
  PENDING: "volunteering.myStatusPending",
  APPROVED: "volunteering.myStatusApproved",
  REJECTED: "volunteering.myStatusRejected",
  WITHDRAWN: "volunteering.myStatusWithdrawn",
  CHECKED_IN: "volunteering.myStatusCheckedIn",
};

/**
 * i18n key for the attendee-facing label of a signup status. Falls back to
 * the organizer label (and finally to the pending label) so an unmapped or
 * unexpected wire value can never render `undefined` or throw.
 */
export function attendeeSignupStatusLabelKey(status: SignupStatus): string {
  return (
    (SIGNUP_STATUS_ATTENDEE_LABEL_KEY as Partial<Record<SignupStatus, string>>)[
      status
    ] ??
    SIGNUP_STATUS_LABEL_KEY[status] ??
    SIGNUP_STATUS_LABEL_KEY.PENDING
  );
}

// ── Comp-ticket rewards (volunteer-comp-tickets spec) ───────────────────────
//
// A reward grant is one of three live states. `NONE` is the absence of any
// grant on a signup (no badge rendered). Redemption is derived server-side
// from the live comp-ticket scan; the ledger exposes it as a `redeemed` flag,
// so the UI collapses (status, redeemed) into a single effective status here.

export type RewardGrantStatus = "GRANTED" | "REDEEMED" | "REVOKED";
export type RewardBadgeStatus = RewardGrantStatus | "NONE";

export const REWARD_STATUS_LABEL_KEY: Record<RewardGrantStatus, string> = {
  GRANTED: "volunteering.rewardStatusGranted",
  REDEEMED: "volunteering.rewardStatusRedeemed",
  REVOKED: "volunteering.rewardStatusRevoked",
};

export const REWARD_STATUS_TONE: Record<RewardGrantStatus, BadgeToneName> = {
  GRANTED: "info",
  REDEEMED: "success",
  REVOKED: "neutral",
};

export type RewardTrigger = "ON_APPROVAL" | "ON_CHECK_IN";

export const REWARD_TRIGGER_LABEL_KEY: Record<RewardTrigger, string> = {
  ON_APPROVAL: "volunteering.rewardTriggerOnApproval",
  ON_CHECK_IN: "volunteering.rewardTriggerOnCheckIn",
};

/**
 * Collapse a ledger grant's raw status + derived redemption into the single
 * effective status the badge renders. A REVOKED grant wins (it's void); an
 * un-revoked but scanned/redeemed grant reads REDEEMED; otherwise GRANTED.
 */
export function effectiveRewardStatus(grant: {
  status: RewardGrantStatus;
  redeemed: boolean;
}): RewardGrantStatus {
  if (grant.status === "REVOKED") return "REVOKED";
  if (grant.redeemed) return "REDEEMED";
  return "GRANTED";
}

/**
 * Build a `signupId → effective reward status` lookup from a ledger's grants.
 * Multiple grants per signup are collapsed with a REDEEMED > GRANTED > REVOKED
 * precedence so a live comp never hides behind an older revoked slot.
 */
export function rewardStatusBySignup(
  grants: ReadonlyArray<{
    signupId: string;
    status: RewardGrantStatus;
    redeemed: boolean;
  }>,
): Map<string, RewardGrantStatus> {
  const rank: Record<RewardGrantStatus, number> = {
    REVOKED: 0,
    GRANTED: 1,
    REDEEMED: 2,
  };
  const map = new Map<string, RewardGrantStatus>();
  for (const grant of grants) {
    const next = effectiveRewardStatus(grant);
    const current = map.get(grant.signupId);
    if (!current || rank[next] > rank[current]) {
      map.set(grant.signupId, next);
    }
  }
  return map;
}

// ── Conflict-reason mapping ─────────────────────────────────────────────────
//
// Use cases throw CONFLICT with `meta.reason`; the API errorFormatter
// surfaces it as `error.data.meta.reason` (and the canonical code as
// `error.data.appCode`). Map the known volunteering reasons to friendly
// i18n keys; anything unknown falls back to the caller's generic message.

export const CONFLICT_REASON_KEY: Record<string, string> = {
  ask_archived: "volunteering.errAskArchived",
  ask_not_open: "volunteering.errAskNotOpen",
  duplicate_group_name: "volunteering.errDuplicateGroupName",
  duplicate_role_name: "volunteering.errDuplicateRoleName",
  group_full: "volunteering.errGroupFull",
  ask_full: "volunteering.errAskFull",
  // Comp-ticket rewards (volunteer-comp-tickets spec)
  reward_requires_event_ask: "volunteering.errRewardRequiresEventAsk",
  duplicate_reward: "volunteering.errDuplicateReward",
  reward_already_redeemed: "volunteering.errRewardAlreadyRedeemed",
};

/** Extract the domain conflict reason from a tRPC client error, if any. */
export function getVolunteerConflictReason(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const meta = (data as { meta?: unknown }).meta;
  if (meta && typeof meta === "object") {
    const reason = (meta as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  const appCode = (data as { appCode?: unknown }).appCode;
  if (typeof appCode === "string" && appCode.length > 0) {
    return appCode.toLowerCase();
  }
  return null;
}

/**
 * i18n key for a known volunteering conflict, or null when the error isn't
 * one of the mapped domain conflicts (caller shows its generic failure).
 */
export function volunteerConflictMessageKey(error: unknown): string | null {
  const reason = getVolunteerConflictReason(error);
  if (!reason) return null;
  return lookupOwn(CONFLICT_REASON_KEY, reason) ?? null;
}

// ── "My volunteering" .ics feed URL ─────────────────────────────────────────
//
// The transport returns the token ONLY; the client composes the public feed
// URL exactly like `src/lib/calendar/calendar-actions.ts` composes the venue feed URL:
//   {apiBaseUrl}/api/volunteering/{token}/calendar.ics

export function composeVolunteerFeedUrls(
  apiBaseUrl: string | null,
  feedToken: string,
): { httpUrl: string; webcalUrl: string } {
  const base =
    apiBaseUrl ??
    (typeof window !== "undefined" ? window.location.origin : "");
  const httpUrl = `${base}/api/volunteering/${feedToken}/calendar.ics`;
  return { httpUrl, webcalUrl: httpUrl.replace(/^https?:/, "webcal:") };
}

/** Blob-download an .ics body (same delivery as `src/lib/calendar/calendar-actions.ts`). */
export function downloadIcsFile(filename: string, icsBody: string): void {
  const blob = new Blob([icsBody], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Ask application-form schema (public signup questions) ───────────────────
//
// `formSchema` is stored as opaque JSON. The public page recognizes the
// minimal `{ questions: [{ id, label, required?, multiline? }] }` shape and
// renders a text input per question; anything else is ignored (the form
// simply shows no extra questions). Answers submit as `{ [id]: value }`.

export type AskFormQuestion = {
  id: string;
  label: string;
  required: boolean;
  multiline: boolean;
};

export function parseAskFormQuestions(formSchema: unknown): AskFormQuestion[] {
  if (!formSchema || typeof formSchema !== "object") return [];
  const questions = (formSchema as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const out: AskFormQuestion[] = [];
  for (const raw of questions) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { id?: unknown }).id;
    const label = (raw as { label?: unknown }).label;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof label !== "string" || label.length === 0) continue;
    out.push({
      id,
      label,
      required: (raw as { required?: unknown }).required === true,
      multiline: (raw as { multiline?: unknown }).multiline === true,
    });
  }
  return out;
}
