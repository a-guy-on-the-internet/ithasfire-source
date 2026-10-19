import { z } from "zod";
import { toSafeExternalUrl } from "@th/types";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type {
  OpenCallFormRecord,
  OpenCallLineupAct,
  OpenCallSubmissionRecord,
} from "@th/ports/repos/events";

import { describeError } from "../../../../lib/io";
import {
  anchorOfForm,
  ensureActorCanEditOpenCallAnchor,
  resolveOpenCallForEvent,
  type OpenCallAnchorContext,
} from "./open-call-anchor";
import { resolveOrganizerSubmission } from "./organizer-side";

/**
 * Shared pieces of the open-call DECISION use cases (open calls v1 step 6):
 * pick (FR-016), "not this time" (FR-018), drop out (FR-017) and the lineup
 * removal stamp (FR-019).
 *
 * ── The link between a lineup row and a submission ────────────────────────
 * There is NO column linking an EventHuman row to the submission whose pick
 * created it (and step 6 adds no migration). The link is the act's IDENTITY
 * on the submission's PICK EVENTS:
 *   - identity ({@link OpenCallLineupAct}): a person applying as themselves
 *     = EventHuman.humanId; an organisation = EventHuman.orgId; a guest = a
 *     free-text row (no humanId, no orgId) whose externalName equals the
 *     guest name (trimmed, case-insensitive) AND whose externalUrl equals
 *     the guest url (trimmed; null = null).
 *   - pick events ({@link pickEventIdsOf}): the call's event for an event
 *     call; for a series call, the materialised events of the occurrences
 *     the applicant CHOSE (pick rows only ever land on a subset of those).
 *
 * Two matchers, on purpose:
 *   - {@link lineupRowIsAct} (placement only, FR-016 "already on the
 *     lineup"): a person or an org in ANY role; a guest only as a PERFORMER
 *     free-text row with the same name and url (a stranger's "Sam" row with
 *     another url, or none, is not them, so the pick inserts a new row).
 *   - {@link lineupRowIsPickedAct} (drop-out removal, and the "anything
 *     left?" check after a leave or a removal): the same identity, role
 *     PERFORMER only. A person's VOLUNTEER / HOST / other row is never
 *     removed by a drop out (a VOLUNTEER row belongs to its signup, which
 *     only `withdrawVolunteerSignup` may end) and never counts as "still
 *     booked".
 *
 * Remaining limits, accepted:
 *   - On a series, drop out removes the act's PERFORMER rows on every night
 *     they CHOSE, so an organizer-added PERFORMER row for the same act on a
 *     chosen-but-not-picked night goes too (it is the same act, same call).
 *   - A guest row later linked to an account (`inviteLineupHumanToRegister`
 *     stamps humanId on it) no longer matches the guest identity, so leaving
 *     or removing that row does not reach the submission. Likewise a guest
 *     row whose name or url an editor changed. And two different guests
 *     with the same name AND url are one act to this rule.
 *   - Picking someone ALREADY on a night in a non-PERFORMER role (HOST,
 *     VOLUNTEER, ...) adds no row there (FR-016). That role row never counts
 *     as "still booked", so a later leave or removal of their OTHER picked
 *     night settles the application (WITHDRAWN / removedFromLineupAt) while
 *     they remain on the first night in that role.
 *   - A person picked while already a VOLUNTEER on that event (so the pick
 *     added no row) who then leaves with an APPROVED volunteer signup and a
 *     waitlist behind it can trigger BOTH the volunteer flow's
 *     `volunteer.spot-opened` and the open-call dropped-out notice: two
 *     notices about two different things.
 *
 * ── Lock order ────────────────────────────────────────────────────────────
 * Every decision path takes SUBMISSION row locks first and only then
 * writes lineup rows. A path holding ONE submission (pick, decline, drop
 * out) locks it with `lockOpenCallSubmission`; a lineup-exit path (leave,
 * removal) locks EVERY submission of the act on the call with
 * `lockOpenCallSubmissionsByAct`, in ascending id order, so two such paths
 * never invert. Never the form row. Close holds the form FOR UPDATE
 * and then updates PENDING submissions; submit holds FOR KEY SHARE / FOR NO
 * KEY UPDATE on the form and inserts a NEW submission row. Neither ever
 * waits on a lineup row, and none of ours ever waits on the form, so no
 * cycle exists. No advisory lock is taken anywhere on these paths.
 */

// ── Who may decide ──────────────────────────────────────────────────────────

export interface DecidableSubmission {
  form: OpenCallFormRecord;
  anchor: OpenCallAnchorContext;
  submission: OpenCallSubmissionRecord;
}

/**
 * The application, for someone with EDIT RIGHTS on its call's anchor (Q28:
 * pick and "not this time" need event edit rights; for a series call,
 * series edit rights). Two steps, in this order:
 *   1. organizer-SIDE membership (`resolveOrganizerSubmission`): a stranger,
 *      an unknown call, and a submission of ANOTHER call all answer
 *      OPEN_CALL_APPLICATION_NOT_FOUND, before the submission is read;
 *   2. edit rights (`ensureActorCanEditOpenCallAnchor`, the same bar as
 *      posting and closing). Since the 2026-10-06 ruling (FR-014 as
 *      amended, Q43) step 1 already demands the same edit role set, so this
 *      is defence in depth (step 1 already refuses a COMMUNITY-stewardship
 *      event and a missing owner row); its own codes, unreachable today, are
 *      INSUFFICIENT_ROLE for an event or an org series and NOT_RESOURCE_OWNER
 *      for a person's series. See `isOnOrganizerSide` for why the two
 *      checks stay separate.
 */
export async function resolveDecidableSubmission(
  tx: TxRepos,
  input: { formId: string; submissionId: string; actorHumanId: string },
  logger?: LoggerPort,
): Promise<DecidableSubmission> {
  const { form, submission } = await resolveOrganizerSubmission(tx, input);
  const anchor = await ensureActorCanEditOpenCallAnchor(
    tx,
    form,
    input.actorHumanId,
    logger,
  );
  return { form, anchor, submission };
}

/**
 * Re-read the submission under its row lock. A row gone between the auth
 * read and the lock answers like any missing application.
 */
export async function lockDecidableSubmission(
  tx: TxRepos,
  form: Pick<OpenCallFormRecord, "id">,
  submissionId: string,
): Promise<OpenCallSubmissionRecord> {
  const locked = await tx.eventApplications.lockOpenCallSubmission({
    submissionId,
    formId: form.id,
  });
  if (!locked) throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
  return locked;
}

// ── Act identity ────────────────────────────────────────────────────────────

/** The act an application is for (Q33): the org, the person, or the guest. */
export function actOfSubmission(
  submission: Pick<
    OpenCallSubmissionRecord,
    "applyingAsOrgId" | "humanId" | "guestName" | "guestUrl"
  >,
): OpenCallLineupAct {
  if (submission.applyingAsOrgId) return { kind: "org", orgId: submission.applyingAsOrgId };
  if (submission.humanId) return { kind: "human", humanId: submission.humanId };
  const name = submission.guestName?.trim() ?? "";
  // Submit requires a guest name (FR-006); a guest row without one is a
  // broken invariant, not a user error.
  if (name.length === 0) throw new Error("open-call guest submission has no name");
  // The url a pick writes onto the row: only a safe http(s) one (submit
  // already validates; this keeps an unsafe stored value off the lineup).
  const url = submission.guestUrl?.trim() ?? "";
  return { kind: "guest", name, url: url && toSafeExternalUrl(url) ? url : null };
}

/** The act a lineup row is, or null for a row with no identity at all. */
export function actOfLineupRow(
  row: Pick<EventHumanRecord, "humanId" | "orgId" | "externalName" | "externalUrl">,
): OpenCallLineupAct | null {
  if (row.humanId) return { kind: "human", humanId: row.humanId };
  if (row.orgId) return { kind: "org", orgId: row.orgId };
  const name = row.externalName?.trim() ?? "";
  if (name.length === 0) return null;
  const url = row.externalUrl?.trim() ?? "";
  return { kind: "guest", name, url: url.length > 0 ? url : null };
}

const normName = (value: string) => value.trim().toLowerCase();
const normUrl = (value: string | null | undefined) => {
  const v = value?.trim() ?? "";
  return v.length > 0 ? v : null;
};

/** Same act (module header: the identity rule). */
export function sameAct(a: OpenCallLineupAct, b: OpenCallLineupAct): boolean {
  if (a.kind === "human" && b.kind === "human") return a.humanId === b.humanId;
  if (a.kind === "org" && b.kind === "org") return a.orgId === b.orgId;
  if (a.kind === "guest" && b.kind === "guest") {
    return normName(a.name) === normName(b.name) && normUrl(a.url) === normUrl(b.url);
  }
  return false;
}

type RowIdentity = Pick<EventHumanRecord, "humanId" | "orgId" | "externalName" | "externalUrl" | "role">;

/**
 * PLACEMENT ONLY (FR-016 "already on the lineup"): a person or an org in any
 * role; a guest only as a PERFORMER free-text row with the same name + url.
 */
export function lineupRowIsAct(row: RowIdentity, act: OpenCallLineupAct): boolean {
  if (act.kind === "human") return row.humanId === act.humanId;
  if (act.kind === "org") return row.orgId === act.orgId;
  return (
    row.role === "PERFORMER" &&
    row.humanId === null &&
    row.orgId === null &&
    row.externalName !== null &&
    normName(row.externalName) === normName(act.name) &&
    normUrl(row.externalUrl) === normUrl(act.url)
  );
}

/** Drop-out removal and the "anything left?" check: PERFORMER rows only. */
export function lineupRowIsPickedAct(row: RowIdentity, act: OpenCallLineupAct): boolean {
  return row.role === "PERFORMER" && lineupRowIsAct(row, act);
}

// ── Pick events ─────────────────────────────────────────────────────────────

/**
 * The events a pick of this submission can have put the act on (module
 * header). Event call: the call's event (a multi-date event has ONE shared
 * lineup, FR-016). Series call: the materialised event of each CHOSEN
 * occurrence that has one and is still the series' night (not DETACHED).
 */
export async function pickEventIdsOf(
  tx: Pick<TxRepos, "seriesOccurrences">,
  form: Pick<OpenCallFormRecord, "eventId" | "seriesId">,
  submission: Pick<OpenCallSubmissionRecord, "dateChoices">,
): Promise<string[]> {
  const ref = anchorOfForm(form);
  if (ref.kind === "event") return [ref.eventId];
  const out: string[] = [];
  for (const choice of submission.dateChoices) {
    if (!choice.occurrenceId) continue;
    const occurrence = await tx.seriesOccurrences.getById(choice.occurrenceId);
    if (
      occurrence &&
      occurrence.seriesId === ref.seriesId &&
      occurrence.eventId &&
      occurrence.status !== "DETACHED" &&
      !out.includes(occurrence.eventId)
    ) {
      out.push(occurrence.eventId);
    }
  }
  return out;
}

/** The act's PERFORMER rows on the given events (removal / "anything left?"). */
export async function pickedActLineupRows(
  tx: Pick<TxRepos, "eventHumans">,
  eventIds: readonly string[],
  act: OpenCallLineupAct,
): Promise<EventHumanRecord[]> {
  const rows: EventHumanRecord[] = [];
  for (const eventId of eventIds) {
    const lineup = await tx.eventHumans.listByEvent(eventId);
    rows.push(...lineup.filter((row) => lineupRowIsPickedAct(row, act)));
  }
  return rows;
}

// ── Lineup leave / removal → the submission (FR-017, FR-019) ────────────────

export interface LockedPick {
  form: OpenCallFormRecord;
  submission: OpenCallSubmissionRecord;
  pickEventIds: string[];
}

/**
 * The PICKED (APPROVED) open-call applications behind an act's row on one
 * event, LOCKED. Call inside the lineup transaction BEFORE deleting the row.
 *
 * Every submission of the act on the covering call is locked FOR UPDATE,
 * whatever its status, in id order (`lockOpenCallSubmissionsByAct`), and
 * only THEN filtered to APPROVED. Reading first and locking only the
 * APPROVED ones would race a pick in flight: a pick holding the row lock
 * that will commit APPROVED (adding no row, the act already being on the
 * lineup) would be read as PENDING and skipped, and its application would
 * stay APPROVED with the act gone. Locking every row waits for that pick
 * and sees its result.
 *
 * The call is the one covering the event (`resolveOpenCallForEvent`: its
 * own call, else its series' call; drafts included, since a draft has no
 * picks anyway). Only applications whose pick events include this event
 * count.
 */
export async function lockPicksBehindLineupRow(
  tx: TxRepos,
  input: { eventId: string; act: OpenCallLineupAct },
): Promise<LockedPick[]> {
  const covering = await resolveOpenCallForEvent(tx, input.eventId, { postedOnly: false });
  if (!covering) return [];
  const form = covering.form;
  const locked = await tx.eventApplications.lockOpenCallSubmissionsByAct({
    formId: form.id,
    act: input.act,
  });
  const out: LockedPick[] = [];
  for (const submission of locked) {
    if (submission.status !== "APPROVED") continue;
    if (!sameAct(actOfSubmission(submission), input.act)) continue;
    const pickEventIds = await pickEventIdsOf(tx, form, submission);
    if (!pickEventIds.includes(input.eventId)) continue;
    out.push({ form, submission, pickEventIds });
  }
  return out;
}

export type LineupExitKind = "dropped_out" | "removed_from_lineup";

export interface SettledPick {
  submissionId: string;
  formId: string;
  form: OpenCallFormRecord;
}

/**
 * After the row is deleted: for each locked pick whose act has NO PERFORMER
 * row left on its pick events, record the exit (a VOLUNTEER or HOST row on
 * another night is not "still booked"). A self-leave (`dropped_out`) marks
 * the application WITHDRAWN with droppedOutAt (FR-017); an organizer's
 * removal (`removed_from_lineup`) stamps removedFromLineupAt and keeps
 * APPROVED (FR-019). While the act is still on another of the call's
 * nights (a series pick for several dates), nothing is recorded: they are
 * still booked, and the lineup itself shows which night they left.
 * Audited per settled application, inside the caller's transaction.
 */
export async function settlePicksAfterLineupExit(
  tx: TxRepos,
  input: {
    picks: readonly LockedPick[];
    act: OpenCallLineupAct;
    kind: LineupExitKind;
    actorHumanId: string;
    eventId: string;
    now: Date;
  },
): Promise<SettledPick[]> {
  const settled: SettledPick[] = [];
  for (const pick of input.picks) {
    const remaining = await pickedActLineupRows(tx, pick.pickEventIds, input.act);
    if (remaining.length > 0) continue;
    const changed =
      input.kind === "dropped_out"
        ? await tx.eventApplications.markOpenCallSubmissionDroppedOut({
            submissionId: pick.submission.id,
            formId: pick.form.id,
            droppedOutAt: input.now,
          })
        : await tx.eventApplications.markOpenCallSubmissionRemovedFromLineup({
            submissionId: pick.submission.id,
            formId: pick.form.id,
            removedAt: input.now,
          });
    if (!changed) continue;
    const ref = anchorOfForm(pick.form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action:
        input.kind === "dropped_out"
          ? "open_call_application_dropped_out"
          : "open_call_application_removed_from_lineup",
      data: {
        actorHumanId: input.actorHumanId,
        formId: pick.form.id,
        submissionId: pick.submission.id,
        eventId: input.eventId,
        via: input.kind === "dropped_out" ? "lineup_leave" : "lineup_removal",
      },
      at: input.now,
    });
    settled.push({ submissionId: pick.submission.id, formId: pick.form.id, form: pick.form });
  }
  return settled;
}

// ── Notices (seams for step 7) ──────────────────────────────────────────────

const anchorRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: z.uuid() }).strict(),
  z.object({ kind: z.literal("series"), seriesId: z.uuid() }).strict(),
]);

export const openCallPickedNoticeSchema = z
  .object({
    kind: z.literal("open_call_picked"),
    submissionId: z.uuid(),
    formId: z.uuid(),
    anchor: anchorRefSchema,
    title: z.string(),
    /** True on the first pick; false when a retry added more dates. */
    firstPick: z.boolean(),
    /** Every event the act is now booked on through this pick. */
    eventIds: z.array(z.uuid()),
    /** The events a row was added to by THIS call (others: already there). */
    addedEventIds: z.array(z.uuid()),
  })
  .strict();
export type OpenCallPickedNotice = z.infer<typeof openCallPickedNoticeSchema>;

export const openCallNotThisTimeNoticeSchema = z
  .object({
    kind: z.literal("open_call_not_this_time"),
    submissionId: z.uuid(),
    formId: z.uuid(),
    anchor: anchorRefSchema,
    title: z.string(),
    /** The optional personal note (FR-018), sanitised. */
    decisionReason: z.string().nullable(),
  })
  .strict();
export type OpenCallNotThisTimeNotice = z.infer<typeof openCallNotThisTimeNoticeSchema>;

export const openCallDroppedOutNoticeSchema = z
  .object({
    kind: z.literal("open_call_dropped_out"),
    submissionId: z.uuid(),
    formId: z.uuid(),
    anchor: anchorRefSchema,
    /** How the act left: their status link / session, or a lineup self-leave. */
    via: z.enum(["status_link", "session", "lineup_leave"]),
    /** The events whose lineup rows this drop out removed. */
    removedEventIds: z.array(z.uuid()),
  })
  .strict();
export type OpenCallDroppedOutNotice = z.infer<typeof openCallDroppedOutNoticeSchema>;

/**
 * FR-022: the event or series was cancelled or deleted, or the call was
 * deleted, and this PENDING application went to EXPIRED. Step 8's
 * sweep-open-calls job sends it per expired application (the notifier is
 * idempotent per submission, so a re-run sends nothing twice). `title` is
 * carried because a deleted anchor can no longer be read.
 */
export const openCallPulledNoticeSchema = z
  .object({
    kind: z.literal("open_call_pulled"),
    submissionId: z.uuid(),
    formId: z.uuid(),
    anchor: anchorRefSchema,
    title: z.string(),
  })
  .strict();
export type OpenCallPulledNotice = z.infer<typeof openCallPulledNoticeSchema>;

/**
 * Run a notifier seam AFTER the commit. The decision stands whatever
 * happens: a failure is logged at error and reported (CLAUDE.md
 * ReporterPort convention), guarded so a throwing reporter changes nothing.
 * An unwired seam is silent here; the composition root (step 7) wires it.
 */
export async function runOpenCallNotice<N extends { kind: string; submissionId: string }>(
  deps: { logger?: LoggerPort; reportError?: ReporterPort },
  useCase: string,
  notify: ((notice: N) => Promise<unknown>) | undefined,
  notice: N,
): Promise<void> {
  if (!notify) return;
  try {
    await notify(notice);
  } catch (error) {
    deps.logger?.error("open_call.notice_failed", {
      useCase,
      kind: notice.kind,
      submissionId: notice.submissionId,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase, reason: "notice_failed", kind: notice.kind },
        extra: { submissionId: notice.submissionId },
      });
    } catch {
      // Best-effort: a throwing reporter must never change the outcome.
    }
  }
}

/**
 * A dropped-out notice was due but `notifyOpenCallDroppedOut` is not wired
 * (step 7 wires it). The caller falls back to the editors' lineup-left
 * where it can (a person's leave or drop out), so the editors are never
 * left with nothing; this makes the wiring gap visible. Logged at error and
 * reported, guarded (a throwing reporter changes nothing). Never throws.
 */
export function reportDroppedOutSeamUnwired(
  deps: { logger?: LoggerPort; reportError?: ReporterPort },
  useCase: string,
  extra: Record<string, unknown>,
): void {
  const error = new Error(
    `${useCase}: notifyOpenCallDroppedOut unwired — dropped-out notice not sent`,
  );
  deps.logger?.error("open_call.dropped_out_seam_unwired", { useCase, ...extra });
  try {
    deps.reportError?.(error, {
      tags: { useCase, reason: "dropped_out_seam_unwired" },
      extra,
    });
  } catch {
    // Best-effort: a throwing reporter must never change the outcome.
  }
}
