import type { EventStatus } from "@th/types";

export type VolunteerSignupStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "CHECKED_IN";

export type ApplyResult = {
  key: string;
  label: string;
  ok: boolean;
  /** Server status of the created signup. Present when `ok`. */
  status?: VolunteerSignupStatus;
  /**
   * True when the signup landed PENDING because the target shift/role was
   * full at submit time — the pending pool is the waitlist (Gap 1,
   * 2026-06-10). Present when `ok`.
   */
  waitlisted?: boolean;
  /** Mapped, human-readable failure reason. Present when `!ok`. */
  error?: string;
};

/**
 * Capacity check mirroring the pre-submit checkbox label: a target
 * (shift, or the role itself when shiftless) is full when it has a
 * capacity and accepted signups have reached it.
 */
export function isCapacityFull(
  target: { capacity: number | null; acceptedCount: number } | null | undefined,
): boolean {
  return (
    target != null &&
    target.capacity != null &&
    target.acceptedCount >= target.capacity
  );
}

/**
 * Map one settled submit mutation into a status-aware row for the
 * success summary. Pure so the waitlist/approved classification is
 * unit-testable; error copy stays with the caller via `mapError`.
 */
export function buildApplyResult(args: {
  key: string;
  label: string;
  settled: PromiseSettledResult<{ status: string }> | undefined;
  targetWasFull: boolean;
  mapError: (reason: unknown) => string;
}): ApplyResult {
  const { key, label, settled, targetWasFull, mapError } = args;

  if (settled?.status === "fulfilled") {
    const status = settled.value.status as VolunteerSignupStatus;
    return {
      key,
      label,
      ok: true,
      status,
      waitlisted: status === "PENDING" && targetWasFull,
    };
  }

  return {
    key,
    label,
    ok: false,
    error: mapError(settled?.status === "rejected" ? settled.reason : null),
  };
}

export function shouldHideVolunteerSection(
  eventStatus?: EventStatus,
  eventEndsAt?: Date | string | null,
  nowMs = Date.now(),
) {
  if (eventStatus && eventStatus !== "PUBLISHED") {
    return true;
  }

  if (!eventEndsAt) {
    return false;
  }

  const endsAt =
    eventEndsAt instanceof Date ? eventEndsAt : new Date(eventEndsAt);
  return !Number.isNaN(endsAt.getTime()) && endsAt.getTime() < nowMs;
}

/**
 * Retry policy for the public volunteer-roles query.
 *
 * The Volunteer CTA in the contextual action bar is gated on this query
 * succeeding with at least one role. A single transient failure (network
 * blip, API restart) with `retry: false` used to hide the CTA for the rest
 * of the page session — fatal for day-of recruiting where the page may be
 * loaded mid-event on a flaky venue connection (Gap 8, 2026-06-11).
 *
 * - `NOT_FOUND` is the server's intentional "volunteering is off / event
 *   not visible" signal — never retry it; the section should settle to
 *   hidden immediately.
 * - Anything else (network errors, 5xx, timeouts) retries up to
 *   {@link VOLUNTEER_ROLES_MAX_RETRIES} times with React Query's default
 *   exponential backoff, which is enough to ride out a dev-server or
 *   deploy restart.
 */
export const VOLUNTEER_ROLES_MAX_RETRIES = 3;

export function shouldRetryVolunteerRolesQuery(
  failureCount: number,
  error: { data?: { code?: string } | null } | null | undefined,
): boolean {
  if (error?.data?.code === "NOT_FOUND") {
    return false;
  }
  return failureCount < VOLUNTEER_ROLES_MAX_RETRIES;
}

/**
 * What reminds a signup made from one pick in the event box
 * (volunteer-ask-reminders FR-001, R7): a shift pick is reminded before its
 * shift; a role pick only when the role has NO shifts, before the event
 * starts. A role-level pick on a role that has shifts gets no reminder, and
 * an unknown role gets none (fail-closed). Mirrors core's
 * `signupReminderAnchor` for event signups; the server enforces it.
 */
export type EventPickReminderAnchor = "SHIFT" | "EVENT_START";

export function eventPickReminderAnchor(
  pick: { roleId: string; shiftId: string | null },
  roles: ReadonlyArray<{ id: string; shifts: ReadonlyArray<unknown> }>,
): EventPickReminderAnchor | null {
  if (pick.shiftId) return "SHIFT";
  const role = roles.find((r) => r.id === pick.roleId);
  return role?.shifts.length === 0 ? "EVENT_START" : null;
}
