import { getAppErrorCode } from "@/lib/app-error";

/**
 * Invite complaint auto-pause (W4, board option A): which notice the
 * "Invited guests" panel shows, derived from `invitePauses.status`. Pure, so
 * the state machine is unit-testable without the styling layer.
 */

/** How long after a staff LIFT the panel still says "Invites are back on". */
export const INVITE_PAUSE_LIFTED_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

/** Server/browser clock skew tolerated on a just-made lift. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** `invitePauses.status` as the client sees it (dates may arrive serialized). */
export type InvitePauseStatusData = {
  paused: boolean;
  pause: {
    reason: "COMPLAINT_COUNT" | "COMPLAINT_RATE";
    pausedAt: Date | string;
    complaintCount: number;
    recipientCount: number;
    windowDays: number;
    reviewRequestedAt: Date | string | null;
    reviewRequestNote: string | null;
    canRequestReview: boolean;
  } | null;
  lastDecision: {
    decision: "LIFTED" | "KEPT";
    decidedAt: Date | string;
    note: string | null;
  } | null;
};

export type InvitePauseView =
  /** Status not known yet: the panel renders without its send controls. */
  | { kind: "loading" }
  /** Not paused (or the status read failed: the server still refuses). */
  | { kind: "open" }
  /** Not paused; staff lifted a pause in the last 7 days. */
  | { kind: "lifted"; liftedAt: Date }
  /** Paused, nobody has asked for a review yet. */
  | {
      kind: "paused";
      reason: "COMPLAINT_COUNT" | "COMPLAINT_RATE";
      complaintCount: number;
      recipientCount: number;
      windowDays: number;
    }
  /** Paused, a review request is waiting. */
  | { kind: "requested"; requestedAt: Date }
  /** Paused, staff looked and kept it (with a note); they may ask again. */
  | { kind: "kept"; decidedAt: Date; note: string | null };

export function deriveInvitePauseView(
  query: {
    /** React Query `isPending`: no data yet (incl. a disabled query). */
    isPending: boolean;
    isError: boolean;
    data: InvitePauseStatusData | undefined;
  },
  now: Date,
): InvitePauseView {
  const { data } = query;
  if (!data) {
    // Error → today's behaviour (form shown); the server refuses a paused send.
    return query.isPending && !query.isError ? { kind: "loading" } : { kind: "open" };
  }
  const { pause, lastDecision } = data;
  if (data.paused && pause) {
    if (pause.reviewRequestedAt) {
      return { kind: "requested", requestedAt: new Date(pause.reviewRequestedAt) };
    }
    if (lastDecision?.decision === "KEPT") {
      return {
        kind: "kept",
        decidedAt: new Date(lastDecision.decidedAt),
        note: lastDecision.note,
      };
    }
    return {
      kind: "paused",
      reason: pause.reason,
      complaintCount: pause.complaintCount,
      recipientCount: pause.recipientCount,
      windowDays: pause.windowDays,
    };
  }
  if (!data.paused && lastDecision?.decision === "LIFTED") {
    const liftedAt = new Date(lastDecision.decidedAt);
    const age = now.getTime() - liftedAt.getTime();
    if (age >= -CLOCK_SKEW_MS && age < INVITE_PAUSE_LIFTED_NOTICE_MS) {
      return { kind: "lifted", liftedAt };
    }
  }
  return { kind: "open" };
}

/** True while the panel may offer anything that sends an invite email. */
export function canSendInvites(view: InvitePauseView): boolean {
  return view.kind === "open" || view.kind === "lifted";
}

/** A send / resend refused because the organiser is paused (a race). */
export function isInvitesPausedError(error: unknown): boolean {
  return getAppErrorCode(error) === "INVITES_PAUSED";
}

/**
 * "Ask for a review" refused because the panel is stale: a request is
 * already waiting (another editor asked) or the pause is gone. Nothing to
 * show; the refetched status says it.
 */
export function isStaleReviewRequestError(error: unknown): boolean {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  const appCode = getAppErrorCode(error);
  return (
    data?.code === "CONFLICT" ||
    appCode === "CONFLICT" ||
    appCode === "INVALID_STATUS"
  );
}
