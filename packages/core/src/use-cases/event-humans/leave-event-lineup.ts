import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { EventRecord } from "@th/ports/repos/events";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import {
  ACT_EVENT_NOT_UPCOMING_REASON,
  type BookingRequestActAnswerOutput,
  type DeclineBookingRequestActOptions,
} from "../booking-requests/answer-booking-request-act";
import { findBillRequestForEvent } from "../booking-requests/_shared/bill-event";
import { LINEUP_LEFT_VARIANT } from "../comms/lineup-renderers";
import {
  isPubliclyListed,
  type LineupNoticeHooks,
} from "./notify-lineup-notices";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  displayNameForCopy,
  normalizeBaseUrl,
  reportSafely,
  resolveLineupEditorRecipients,
  type LineupEditorRecipient,
} from "./_shared/lineup-notice-support";
import {
  isPassableAct,
  isUpcomingLiveBookingShow,
} from "./_shared/lineup-leave-booking";
import { anchorOfForm } from "../events/open-calls/_shared/open-call-anchor";
import {
  lockPicksBehindLineupRow,
  reportDroppedOutSeamUnwired,
  runOpenCallNotice,
  settlePicksAfterLineupExit,
  type OpenCallDroppedOutNotice,
} from "../events/open-calls/_shared/open-call-decision";

// ─────────────────────────────────────────────────────────────────────────────
// Leave a lineup (owner ruling "option A", 2026-09-30).
//
// An editor may put a real person on a lineup without asking; the person can
// take THEMSELVES off. Only the person — never a delegate acting for them,
// never an editor (editors have `eventHumans.detach`). The input carries no
// row id: the use case looks up the actor's OWN row on the event, so there is
// nothing to aim at anyone else's row. `@@unique([eventId, humanId])` makes
// that at most one row.
//
// Any status and any role: it is the person's name. Editors are told
// (`event.lineup-left`) and may add the person again later — a normal attach,
// which is a new row (notified again, subject to the 7-day re-add cooldown).
//
// VOLUNTEER rows (owner ruling 2026-09-30): when the row is a VOLUNTEER row
// AND the person has a live (PENDING / APPROVED) volunteer signup for this
// event, leaving IS withdrawing — through `withdrawVolunteerSignup` itself,
// injected as `deps.withdrawVolunteerSignup`, never a copy of its logic. That
// flow detaches the row (APPROVED signups) and revokes rewards; this use case
// only detaches the row if the withdraw left it in place (a PENDING signup
// next to a hand-attached row). A VOLUNTEER row with no signup (an editor
// added the person by hand) is an ordinary lineup removal. The branch is
// decided in ONE place: `volunteerSignupToWithdraw`.
//
// Editors are ALWAYS told, exactly once: the withdraw sends its own
// `volunteer.spot-opened` to the org's editors only when an APPROVED seat
// opens with a waitlist behind it; in that case `event.lineup-left` is NOT
// added on top (see `withdrawToldEditors`). Every other volunteer leave (no
// waitlist, a PENDING signup, a personal event) sends `event.lineup-left`.
//
// BOOKING ACTS (owner rulings 2026-09-30 / 2026-10-01): when the event came
// out of a booking (`findBillRequestForEvent`), is still UPCOMING and alive
// (`isUpcomingLiveBookingShow` — a started, cancelled or archived show is
// lineup credit only: nothing is read or written on the booking), and the
// person is a TAGGED act on that bill that has not passed (PENDING or
// CONFIRMED — `isPassableAct`; `listMyLineups`' `passesBookingAct` shares
// both rules), leaving the lineup PASSES the act — through
// `passBookingRequestAct` itself, injected as `deps.passBookingRequestAct`,
// never a direct status write — so the editor is not re-suggested them
// (`listBookingLineupSuggestions` never shows DECLINED). Post-commit and in
// that order on purpose: the transition refuses to take a CONFIRMED act off
// the bill while it is ON the event's lineup (`on_lineup` — the editor's
// call), and after our commit it no longer is. Its own side effects stay
// whole: CAS under the bill lock, the sender-only `act_declined` ledger
// entry (`left: true` for a confirmed act), the audit row, and the SENDER's
// in-app "{act} left / passed on your bill". Swallowed + reported: the
// person is off the lineup whatever happens to the act; a lost race (an
// editor re-added them → `on_lineup`, the sender removed the act →
// not-found, or the show was cancelled / archived / reached its start
// before the pass → `event_not_upcoming`) is logged at info, not reported.
// The upcoming-and-live rule is checked twice: here on the leave's own
// snapshot (a history show costs no reads), and again by the pass itself
// under the bill lock (`onlyWhileEventUpcoming`), so a show that stops
// being upcoming in between never has its booking touched. Hand-attached people
// (no act), the sender's own SELF row and an already-passed or
// sender-removed act change nothing. A GROUP act is never touched: only the
// person's own `humanId` row is leavable (`orgId` rows are never `humanId`
// rows — the `EventHuman_identity_check` constraint).
//
// ONE notice per person (owner ruling 2026-10-01): whoever gets
// `event.lineup-left` (email + the lineup link) does NOT also get the
// booking's in-app "left your bill" — the pass is told to skip them
// (`skipSenderNoticeFor`), and the leaver. On a requester-owned show the
// sender's editors ARE the event's editors and hear once, via lineup-left;
// anyone ONLY on the sender side still gets the bill note. Trade-off,
// accepted: the skip list is fixed BEFORE lineup-left is sent, so a skipped
// person whose lineup-left send then fails hears nothing about the leave
// (that failure is reported, `recipient_failed`).
//
// OPEN CALLS (spec 2026-10-05 FR-017): leaving IS dropping out when the person
// was picked onto this lineup through an open call (their own APPROVED
// application, as themselves, on the call covering this event). In the SAME
// transaction the application becomes WITHDRAWN with droppedOutAt — but only
// once they have no row left on the call's nights they chose: leaving one
// night of a several-night series pick keeps the application APPROVED
// (they are still booked on the others). Lock order: the application row
// first, then the lineup row delete (`lockPicksBehindLineupRow`). The
// organizer side is told post-commit through `notifyOpenCallDroppedOut`
// (step 7) INSTEAD of the editors' `event.lineup-left` above (one notice per
// person); while that seam is unwired, lineup-left is sent as before and the
// gap is reported.
// ─────────────────────────────────────────────────────────────────────────────

export const leaveEventLineupInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const leaveEventLineupOutputSchema = z
  .object({
    eventId: z.uuid(),
    eventHumanId: z.uuid(),
    /** Set when leaving also withdrew the person's volunteer signup. */
    withdrawnVolunteerSignupId: z.uuid().nullable(),
  })
  .strict();

export type LeaveEventLineupInput = z.infer<typeof leaveEventLineupInputSchema>;
export type LeaveEventLineupOutput = z.infer<
  typeof leaveEventLineupOutputSchema
>;

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type LeaveEventLineupDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "eventHumans"
    | "volunteering"
    | "humans"
    | "organizations"
    | "entityPages"
    // The event → booking link (`findBillRequestForEvent`) and the person's
    // own act on that bill.
    | "agreements"
    | "bookingRequests"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Tells the event's editors. Optional: without it the person still leaves,
   * nobody is told, and that is reported (it is a wiring bug).
   */
  notify?: NotifyFn;
  /** Web origin for the editors' lineup link. */
  publicAppUrl?: string | null;
  /** Reports a swallowed editor-notice failure; the leave still succeeds. */
  reportError?: ReporterPort;
  /**
   * `withdrawVolunteerSignup` bound to the volunteer flow's own deps (the
   * transport passes the same deps as `volunteer.signups.withdraw`). Absent →
   * a VOLUNTEER row with a signup cannot be left here: refused rather than
   * leaving an APPROVED signup behind a removed row.
   */
  withdrawVolunteerSignup?: (input: {
    actorHumanId: string;
    signupId: string;
  }) => Promise<unknown>;
  /**
   * Owner ruling: a self-leave clears the 7-day re-add cooldown, so a re-add
   * after the person removed themselves is always told. Post-commit; never
   * throws (the hook reports).
   */
  lineupNotices?: Pick<LineupNoticeHooks, "clearCooldown">;
  /**
   * `passBookingRequestAct` (= `declineBookingRequestAct`) bound to the
   * booking flow's own deps, sender notice included (the transport passes
   * the same deps as `bookingRequests.passAct`). Post-commit. Absent while
   * the person has a live act → the act is not passed, and that is reported
   * (a wiring bug); the leave still succeeds.
   */
  passBookingRequestAct?: (
    input: { actorHumanId: string; bookingRequestId: string },
    options: DeclineBookingRequestActOptions,
  ) => Promise<Pick<BookingRequestActAnswerOutput, "changed" | "confirmation">>;
  /**
   * Open calls (FR-017): tells the organizer side that a picked act dropped
   * out by leaving. Post-commit, once per application this leave withdrew,
   * INSTEAD of the editors' `event.lineup-left`; a failure is logged and
   * reported (not retried), and the leave stands. Unwired = the application
   * is still marked, the editors get lineup-left as before, and the gap is
   * reported (`dropped_out_seam_unwired`).
   */
  notifyOpenCallDroppedOut?: (notice: OpenCallDroppedOutNotice) => Promise<unknown>;
};

export async function leaveEventLineup(
  deps: LeaveEventLineupDeps,
  rawInput: unknown,
): Promise<LeaveEventLineupOutput> {
  const input = parseInput(leaveEventLineupInputSchema, rawInput);

  // Read outside the tx to pick the branch: the volunteer withdraw runs its
  // own transaction, so it cannot be nested inside ours.
  const ownRow = await deps.repos.eventHumans.getByEventAndHuman({
    eventId: input.eventId,
    humanId: input.actorHumanId,
  });
  // Not on this lineup (or no such event): the same answer either way, so
  // the call cannot probe which events exist.
  if (!ownRow) {
    throw fail("EVENT_HUMAN_NOT_FOUND");
  }

  const signup = await volunteerSignupToWithdraw(deps, ownRow, input);
  const signupId = signup?.id ?? null;
  if (signupId) {
    if (!deps.withdrawVolunteerSignup) {
      throw fail("NOT_CONFIGURED", {
        message: "volunteer_withdraw_unwired",
      });
    }
    await deps.withdrawVolunteerSignup({
      actorHumanId: input.actorHumanId,
      signupId,
    });
  }

  const { row, event, droppedOut } = await deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_HUMAN_NOT_FOUND");
    }
    // Open calls: lock the person's picks on this event BEFORE reading and
    // deleting the row (lock order: application, then lineup row). The row
    // is read AFTER the lock, so a concurrent leave or detach that won while
    // we waited is seen here, not as a raw P2025 from the delete.
    const leaverAct = { kind: "human", humanId: input.actorHumanId } as const;
    const picks = await lockPicksBehindLineupRow(tx, {
      eventId: input.eventId,
      act: leaverAct,
    });
    const row = await tx.eventHumans.getByEventAndHuman({
      eventId: input.eventId,
      humanId: input.actorHumanId,
    });
    if (!row && !signupId) {
      // Gone between the read and the tx (a concurrent leave or detach).
      throw fail("EVENT_HUMAN_NOT_FOUND");
    }
    await removeOwnLineupRowInTx(tx, {
      row,
      ownRow,
      actorHumanId: input.actorHumanId,
      now: deps.clock.now(),
      auditExtra: signupId ? { withdrawnVolunteerSignupId: signupId } : {},
    });
    const droppedOut = await settlePicksAfterLineupExit(tx, {
      picks,
      act: leaverAct,
      kind: "dropped_out",
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      now: deps.clock.now(),
    });

    return { row: row ?? ownRow, event, droppedOut };
  });

  // ONE notice per editor (owner ruling 2026-10-01): when this leave
  // dropped the person out of an open-call pick (their last PERFORMER night
  // on the call), the dropped-out notice below is the editors' notice, so
  // lineup-left is skipped. A partial series leave, and every ordinary
  // leave, sends lineup-left exactly as before. Editors are ALWAYS told:
  // with the dropped-out seam unwired, lineup-left is sent and the gap is
  // reported. If the wired seam then throws, the failure is reported but
  // not retried and lineup-left is not sent either: the same trade-off as
  // `recipient_failed`, since step 7's seam is the only path.
  const droppedOutSeamWired = deps.notifyOpenCallDroppedOut !== undefined;
  if (droppedOut.length > 0 && !droppedOutSeamWired) {
    reportDroppedOutSeamUnwired(deps, "leaveEventLineup", {
      eventId: event.id,
      submissionIds: droppedOut.map((pick) => pick.submissionId),
    });
  }
  await runLineupLeaveAftermath(deps, {
    event,
    row,
    actorHumanId: input.actorHumanId,
    signup,
    ...(droppedOut.length > 0 && droppedOutSeamWired ? { skipEditorNotice: true } : {}),
  });

  for (const pick of droppedOut) {
    await runOpenCallNotice(deps, "leaveEventLineup", deps.notifyOpenCallDroppedOut, {
      kind: "open_call_dropped_out",
      submissionId: pick.submissionId,
      formId: pick.formId,
      anchor: anchorOfForm(pick.form),
      via: "lineup_leave",
      removedEventIds: [event.id],
    });
  }

  return leaveEventLineupOutputSchema.parse({
    eventId: row.eventId,
    eventHumanId: row.id,
    withdrawnVolunteerSignupId: signupId,
  });
}

/**
 * What a self-leave needs besides the volunteer withdraw: the deps of its
 * post-commit aftermath. `dropOutOfOpenCall` runs a signed-in person's
 * drop out through these (spec 2026-10-05 FR-017: person acts drop out
 * through the leaveEventLineup path).
 */
export type LineupLeaveEffectsDeps = Pick<
  LeaveEventLineupDeps,
  | "repos"
  | "clock"
  | "logger"
  | "notify"
  | "publicAppUrl"
  | "reportError"
  | "lineupNotices"
  | "passBookingRequestAct"
>;

/**
 * THE in-transaction core of a self-leave: delete the person's own row (if
 * still there; the volunteer withdraw may have detached it already, never
 * twice) and audit `left_lineup`. Lock order is the caller's: any open-call
 * application rows are locked BEFORE this delete.
 */
export async function removeOwnLineupRowInTx(
  tx: TxRepos,
  args: {
    row: EventHumanRecord | null;
    ownRow: EventHumanRecord;
    actorHumanId: string;
    now: Date;
    auditExtra?: Record<string, unknown>;
  },
): Promise<void> {
  if (args.row) {
    await tx.eventHumans.detach(args.row.id);
  }
  await tx.audit.log({
    entity: "event_human",
    entityId: args.ownRow.id,
    action: "left_lineup",
    data: {
      eventId: args.ownRow.eventId,
      humanId: args.actorHumanId,
      externalName: args.ownRow.externalName,
      role: args.ownRow.role,
      actorHumanId: args.actorHumanId,
      self: true,
      ...(args.auditExtra ?? {}),
    },
    at: args.now,
  });
}

/** The aftermath's deps plus the use case its reports are tagged with. */
type AftermathCtx = LineupLeaveEffectsDeps & { reportUseCase?: string };

const reportUseCase = (deps: AftermathCtx) => deps.reportUseCase ?? "leaveEventLineup";

/**
 * THE post-commit aftermath of a self-leave, in order: clear the re-add
 * cooldown, plan the editors' `event.lineup-left` (skipped when the
 * volunteer withdraw already told them), pass the person's booking act,
 * then send lineup-left. Never throws: every failure is reported.
 *
 * Options (open calls, owner ruling 2026-10-01 "ONE notice per person"):
 *   - `skipEditorNotice`: the editors are told by ONE other notice (the
 *     open-call dropped-out notice), so lineup-left is neither planned nor
 *     sent. The cooldown clear and the booking-act pass still run; the
 *     pass then skips only the leaver.
 *   - `skipBookingActPass`: leave the booking act alone (a drop out by
 *     status-link TOKEN must not reach a booking; see dropOutOfOpenCall).
 *   - `useCase`: the tag its failure reports carry (default
 *     "leaveEventLineup").
 * With no options this is exactly the leave's own aftermath.
 */
export async function runLineupLeaveAftermath(
  deps: LineupLeaveEffectsDeps,
  args: {
    event: EventRecord;
    row: EventHumanRecord;
    actorHumanId: string;
    signup: VolunteerSignupRecord | null;
    skipEditorNotice?: boolean;
    skipBookingActPass?: boolean;
    useCase?: string;
  },
): Promise<void> {
  const ctx: AftermathCtx = args.useCase ? { ...deps, reportUseCase: args.useCase } : deps;
  // Post-commit: a throwing hook must never turn a committed leave into an
  // error (the real hook already swallows; this guards any other binding).
  try {
    await ctx.lineupNotices?.clearCooldown({
      eventId: args.row.eventId,
      humanId: args.actorHumanId,
    });
  } catch (error) {
    reportSafely(ctx.reportError, error, {
      tags: { useCase: reportUseCase(ctx), reason: "cooldown_clear_failed" },
      extra: { eventId: args.row.eventId },
    });
  }

  // Editors told exactly once: skip `event.lineup-left` only when the
  // withdraw's own spot-opened notice already went to them. Resolved BEFORE
  // the act is passed, because the booking's "left your bill" note skips
  // whoever gets lineup-left (owner ruling 2026-10-01).
  const editorsToldByWithdraw = Boolean(
    !args.skipEditorNotice &&
      args.signup &&
      (await withdrawToldEditors(ctx, args.signup, args.event)),
  );
  const leaveNotice =
    editorsToldByWithdraw || args.skipEditorNotice
      ? null
      : await planLeaveNotice(ctx, args.event, args.row, args.actorHumanId);

  // The person's act on the booking this upcoming show came from, if any,
  // passes — AFTER the commit, so the transition no longer sees them on the
  // lineup. Never the leaver, never a lineup-left recipient. When the
  // volunteer withdraw already told the editors (spot-opened, so no
  // lineup-left), the skip list holds ONLY the leaver: an editor who is also
  // on the sender side then gets spot-opened AND the bill note — different
  // notices about different things, accepted.
  if (!args.skipBookingActPass) {
    await passOwnBookingAct(ctx, args.event, args.actorHumanId, [
      args.actorHumanId,
      ...(leaveNotice?.recipients.map((r) => r.humanId) ?? []),
    ]);
  }

  if (leaveNotice) {
    await sendLeaveNotice(ctx, args.event, args.row, leaveNotice);
  }
}

/**
 * THE volunteer branch (owner ruling 2026-09-30): the live signup to
 * withdraw when a VOLUNTEER row leaves, else null (every other role, and a
 * hand-attached VOLUNTEER row with no signup, is an ordinary removal).
 */
async function volunteerSignupToWithdraw(
  deps: LeaveEventLineupDeps,
  row: EventHumanRecord,
  input: LeaveEventLineupInput,
): Promise<VolunteerSignupRecord | null> {
  if (row.role !== "VOLUNTEER") return null;
  const signups = await deps.repos.volunteering.listSignupsByHuman(
    input.actorHumanId,
  );
  return (
    signups.find(
      (s) => s.eventId === input.eventId && isWithdrawableSignupStatus(s.status),
    ) ?? null
  );
}

/** The statuses `withdrawVolunteerSignup` accepts. */
export function isWithdrawableSignupStatus(status: string): boolean {
  return status === "APPROVED" || status === "PENDING";
}

/**
 * Did `withdrawVolunteerSignup` already tell the editors? It sends
 * `volunteer.spot-opened` exactly when the signup WAS APPROVED, the event is
 * org-owned, and signups are pending behind the freed seat (shift-scoped, else
 * role-scoped) — the same three conditions, read here after it ran. A read
 * failure answers "no": a possible duplicate beats a silent leave.
 */
async function withdrawToldEditors(
  deps: AftermathCtx,
  signupBeforeWithdraw: VolunteerSignupRecord,
  event: EventRecord,
): Promise<boolean> {
  if (signupBeforeWithdraw.status !== "APPROVED" || !event.orgId) return false;
  try {
    const pending = await deps.repos.volunteering.countPendingSignups(
      signupBeforeWithdraw.shiftId
        ? { shiftId: signupBeforeWithdraw.shiftId }
        : { roleId: signupBeforeWithdraw.roleId },
    );
    return pending > 0;
  } catch (error) {
    reportSafely(deps.reportError, error, {
      tags: { useCase: reportUseCase(deps), reason: "spot_opened_probe_failed" },
      extra: { eventId: event.id, signupId: signupBeforeWithdraw.id },
    });
    return false;
  }
}

/**
 * Post-commit: pass the person's own TAGGED act on the bill this event came
 * from — only while the show is upcoming and alive (module header). The
 * sender's "left your bill" note skips `skipSenderNoticeFor`. Never throws.
 */
async function passOwnBookingAct(
  deps: AftermathCtx,
  event: EventRecord,
  humanId: string,
  skipSenderNoticeFor: readonly string[],
): Promise<void> {
  // Started, cancelled or archived: lineup credit only — the booking record
  // is history and is not touched (owner ruling 2026-10-01). No reads.
  if (!isUpcomingLiveBookingShow(event, deps.clock.now())) return;

  const extra = { eventId: event.id };
  const report = (error: unknown, reason: string) => {
    deps.logger?.error("event_humans.lineup_leave_aftermath.booking_act_pass_failed", {
      reason,
      ...extra,
      err: error,
      error: describeError(error),
    });
    reportSafely(deps.reportError, error, {
      tags: { useCase: reportUseCase(deps), reason },
      extra,
    });
  };
  try {
    const request = await findBillRequestForEvent(deps.repos, event.id);
    if (!request) return;
    const act = await deps.repos.bookingRequests.getActForOwner({
      bookingRequestId: request.id,
      actOwnerType: "human",
      actOwnerId: humanId,
    });
    // Hand-attached (no act), the sender's own SELF row, already passed:
    // nothing to end. (A sender-removed act reads as null.)
    if (!isPassableAct(act)) return;
    if (!deps.passBookingRequestAct) {
      report(
        new Error(
          "lineup leave aftermath: passBookingRequestAct unwired — booking act not passed",
        ),
        "booking_act_pass_unwired",
      );
      return;
    }
    await deps.passBookingRequestAct(
      { actorHumanId: humanId, bookingRequestId: request.id },
      // Re-judged under the bill lock, in the pass's own transaction: the
      // show may have been cancelled or started since the check above.
      { skipSenderNoticeFor, onlyWhileEventUpcoming: { eventId: event.id } },
    );
  } catch (error) {
    // Lost races, not failures: an editor put the person back on the lineup
    // between our commit and the pass (the transition rightly keeps the act
    // — it is the editor's call now), or the sender removed the act from the
    // bill meanwhile (the transition answers not-found), or the show was
    // cancelled / archived / started before the pass took the bill lock
    // (the guarded pass writes nothing). Nothing to fix.
    const race = expectedPassRace(error);
    if (race) {
      deps.logger?.info("event_humans.lineup_leave_aftermath.booking_act_not_passed", {
        ...extra,
        useCase: reportUseCase(deps),
        race,
      });
      return;
    }
    report(error, "booking_act_pass_failed");
  }
}

function expectedPassRace(
  error: unknown,
): "on_lineup" | "act_gone" | "event_not_upcoming" | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, meta } = error as {
    code?: unknown;
    meta?: { reason?: unknown };
  };
  if (meta?.reason === "on_lineup") return "on_lineup";
  if (meta?.reason === ACT_EVENT_NOT_UPCOMING_REASON) return "event_not_upcoming";
  if (code === "BOOKING_REQUEST_NOT_FOUND") return "act_gone";
  return null;
}

type LeaveNoticePlan = {
  notify: NotifyFn;
  recipients: LineupEditorRecipient[];
  personName: string;
};

function leaveNoticeReporter(
  deps: AftermathCtx,
  event: EventRecord,
  row: EventHumanRecord,
) {
  const logger = deps.logger?.child({ useCase: reportUseCase(deps) });
  const extra = { eventId: event.id, eventHumanId: row.id };
  return (error: unknown, reason: string, more = {}) => {
    logger?.error("event_humans.leave.editor_notice_failed", {
      reason,
      ...extra,
      ...more,
      error: describeError(error),
    });
    reportSafely(deps.reportError, error, {
      tags: { useCase: reportUseCase(deps), reason },
      extra: { ...extra, ...more },
    });
  };
}

/**
 * Who gets `event.lineup-left`: the event's editors minus the leaver. Null
 * when nobody will be sent it — unwired (reported), resolution failed
 * (reported), or nobody to tell (an ownerless community listing, or the
 * leaver is the only editor; expected, not a failure).
 */
async function planLeaveNotice(
  deps: AftermathCtx,
  event: EventRecord,
  row: EventHumanRecord,
  leaverHumanId: string,
): Promise<LeaveNoticePlan | null> {
  const report = leaveNoticeReporter(deps, event, row);
  try {
    const notify = deps.notify;
    const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
    if (!notify || !baseUrl) {
      report(
        new Error(
          "leaveEventLineup: notify/publicAppUrl unwired — editors not told",
        ),
        "not_configured",
      );
      return null;
    }
    const recipients = (
      await resolveLineupEditorRecipients(deps.repos, event, baseUrl)
    ).filter((r) => r.humanId !== leaverHumanId);
    if (recipients.length === 0) return null;

    const leaver = await deps.repos.humans.getById(leaverHumanId);
    const personName =
      displayNameForCopy(leaver?.name ?? null) ??
      displayNameForCopy(row.externalName) ??
      "Someone";
    return { notify, recipients, personName };
  } catch (error) {
    report(error, "fanout_failed");
    return null;
  }
}

/**
 * Post-commit fan-out of `event.lineup-left`. Swallowed per recipient (one
 * failed send never blocks the next); every swallow is logged at error and
 * reported.
 */
async function sendLeaveNotice(
  deps: AftermathCtx,
  event: EventRecord,
  row: EventHumanRecord,
  plan: LeaveNoticePlan,
): Promise<void> {
  const report = leaveNoticeReporter(deps, event, row);
  for (const recipient of plan.recipients) {
    try {
      const result = await plan.notify({
        humanId: recipient.humanId,
        variant: LINEUP_LEFT_VARIANT,
        // Per (row, recipient): the row id is unique for good (a re-add is
        // a new row), so a later leave of a re-added row is a new notice.
        idempotencyKey: `lineup-left:${row.id}:${recipient.humanId}`,
        scope: { kind: "EVENT", eventId: event.id },
        payload: {
          eventId: event.id,
          eventHumanId: row.id,
          eventTitle: event.title,
          startsAtIso: event.startsAt.toISOString(),
          timezone: event.timezone || null,
          personName: plan.personName,
          lineupUrl: recipient.lineupUrl,
          wasPubliclyListed: isPubliclyListed(event, row),
        },
        channels: { sms: { enabled: false } },
      });
      if (result.email?.status === "failed") {
        report(
          new Error(`lineup_left_email_failed:${result.email.reason}`),
          "email_failed",
          { recipientHumanId: recipient.humanId },
        );
      }
    } catch (error) {
      report(error, "recipient_failed", {
        recipientHumanId: recipient.humanId,
      });
    }
  }
}
