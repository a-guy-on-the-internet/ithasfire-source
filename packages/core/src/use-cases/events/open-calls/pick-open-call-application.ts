import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  OpenCallLineupAct,
  OpenCallSubmissionRecord,
} from "@th/ports/repos/events";

import { parseInput } from "../../../lib/io";
import { stampFirstOpen } from "./_shared/first-open";
import {
  anchorEnded,
  anchorOfForm,
  LIVE_OCCURRENCE_STATUSES,
  openCallEndedReason,
  type OpenCallAnchorContext,
} from "./_shared/open-call-anchor";
import { MAX_DATE_CHOICES, OPEN_CALL_GUEST_NAME_MAX } from "./_shared/open-call-application";
import {
  actOfSubmission,
  lineupRowIsAct,
  lockDecidableSubmission,
  openCallPickedNoticeSchema,
  resolveDecidableSubmission,
  runOpenCallNotice,
  type OpenCallPickedNotice,
} from "./_shared/open-call-decision";
import { anchorTitle } from "./get-open-call-application-status";

export const pickOpenCallApplicationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    submissionId: z.uuid(),
    /**
     * Series call only: which of the applicant's chosen nights to pick them
     * for (a non-empty subset of their date choices). Must be absent or
     * empty on an event call, where the act joins the event's one lineup.
     */
    occurrenceIds: z.array(z.uuid()).max(MAX_DATE_CHOICES).optional(),
  })
  .strict();

const pickedRowSchema = z
  .object({
    eventId: z.uuid(),
    /** The series night this row is for; null on an event call. */
    occurrenceId: z.uuid().nullable(),
    eventHumanId: z.uuid(),
    /** False when the act was already on that lineup: no row was added. */
    added: z.boolean(),
  })
  .strict();

export const pickOpenCallApplicationOutputSchema = z
  .object({
    submissionId: z.uuid(),
    status: z.literal("APPROVED"),
    /** True when it was already picked before this call (a retry). */
    alreadyPicked: z.boolean(),
    rows: z.array(pickedRowSchema),
    /** What step 7 sends; null when nothing changed (a pure retry). */
    notice: openCallPickedNoticeSchema.nullable(),
  })
  .strict();

export type PickOpenCallApplicationInput = z.input<typeof pickOpenCallApplicationInputSchema>;
export type PickOpenCallApplicationOutput = z.infer<typeof pickOpenCallApplicationOutputSchema>;

/** Same shape as `generateEventsFromSeries`' input, so it binds directly. */
export type MaterializeSeriesOccurrences = (input: {
  actorHumanId: string;
  seriesId: string;
  occurrenceIds: string[];
  clientKey: string;
}) => Promise<unknown>;

export type PickOpenCallApplicationDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * Tells the act (step 7: email + in-app, FR-017). Called after the commit;
   * a failure is logged and reported, and the pick stands.
   */
  notifyOpenCallPicked?: (notice: OpenCallPickedNotice) => Promise<unknown>;
  /**
   * THE series materialise path: `generateEventsFromSeries` bound to its own
   * deps (it runs its own transaction and idempotency). Used when a picked
   * night has no event yet. Absent while one is needed → refused
   * NOT_CONFIGURED before anything is written.
   */
  materializeSeriesOccurrences?: MaterializeSeriesOccurrences;
};

interface PickTarget {
  occurrenceId: string | null;
  eventId: string | null;
  /** The series night's end (null when the occurrence has none). */
  endsAt: Date | null;
}

type PickMode = "flip" | "retry";

/**
 * Pick an act (FR-016): the application becomes APPROVED and the act goes
 * on the lineup, role PERFORMER, at the END (after the highest sortOrder).
 * The row carries humanId for a person, orgId for an organisation, and
 * externalName + externalUrl for a guest (Q34). No agreement, no money
 * (Q23). Auth: edit rights on the call's event or series
 * (`resolveDecidableSubmission`); a submission of another call answers
 * OPEN_CALL_APPLICATION_NOT_FOUND.
 *
 * ── Dates ─────────────────────────────────────────────────────────────────
 *   - Event call (single date, or a multi-date event with EventDate rows):
 *     ONE row on the event's one lineup. `occurrenceIds` must be empty; the
 *     applicant's chosen EventDates stay on the submission, so the card
 *     keeps showing them.
 *   - Series call: `occurrenceIds` is required, non-empty, and every id must
 *     be one of the applicant's chosen occurrences (OPEN_CALL_DATES_REQUIRED
 *     / OPEN_CALL_DATE_INVALID). Each must still be a live, upcoming night
 *     (OPEN_CALL_DATE_UNAVAILABLE). Each gets its own row. A night with no
 *     event yet is materialised first (see "Two phases" below).
 *
 * ── When a pick is refused for time ───────────────────────────────────────
 *   - Event call: once the event has started, or (a multi-date event) once
 *     its LAST date has started, or the event is cancelled / archived /
 *     completed: OPEN_CALL_CLOSED (`openCallEndedReason`). The backstop
 *     (FR-021) is about to answer anyone still waiting, so a late pick
 *     would contradict it.
 *   - Series call: per night, OPEN_CALL_DATE_UNAVAILABLE (above); an
 *     archived series is OPEN_CALL_CLOSED.
 *   - NOT refused because the call is CLOSED (form.closedAt). Close stops
 *     new applications and sweeps PENDING ones (FR-020); an application
 *     the organizer side WAITLISTED survives the sweep and may still be
 *     picked after Close (FR-004: "keeps picking").
 *
 * ── Two phases (a deliberate deviation from "one transaction") ────────────
 * A series night with no event yet must be materialised through THE
 * existing path, `generateEventsFromSeries`, which runs its own transaction
 * and idempotency and so cannot nest in ours. So:
 *   1. a read-only transaction authorises, validates the input and finds
 *      the unmaterialised nights; the seam materialises them (committed);
 *   2. ONE decision transaction re-runs every check under the submission
 *      row lock and writes the decision and the lineup rows.
 * If phase 2 then fails (a concurrent decline, a night cancelled), the
 * night stays GENERATED as a draft event linked to its occurrence: the
 * same draft "generate" would make. A retry finds the event already linked
 * and does not materialise again; the `clientKey` is deterministic per
 * (application, nights), so even a replayed generation is the same one.
 *
 * ── Already on the lineup ─────────────────────────────────────────────────
 * When the act is already on that lineup (any role: the person, the org, or
 * a free-text row with the guest's name), the decision is recorded and no
 * row is added (`added: false`).
 *
 * ── Retry (idempotent) ────────────────────────────────────────────────────
 * Picking an APPROVED application again is success. Same nights → no new
 * rows, `notice: null`. Nights the act is not on yet (a retry naming more
 * of their chosen dates, or one the organizer removed them from) get rows,
 * and the notice lists them (`firstPick: false`). An application whose act
 * was removed from the lineup altogether (removedFromLineupAt set), dropped
 * out (WITHDRAWN) or was told "not this time" is NOT re-picked: the history
 * stays true, and putting someone back is a plain lineup add.
 *
 * ── Concurrency ───────────────────────────────────────────────────────────
 * One transaction. Locks, in order: the submission row FOR UPDATE
 * (`lockOpenCallSubmission`), then the lineup rows it writes. Never the form
 * row, no advisory lock. Two organizers picking at once serialise on the
 * submission row; the second reads APPROVED and runs as a retry, AFTER the
 * first committed, so it sees the first's rows and adds none for the same
 * nights (and the (event, human) / (event, org) unique keys back that up).
 * Pick vs applicant withdraw vs close sweep: all three are guarded writes
 * on the same row (PENDING → something); whichever takes the row lock first
 * wins, and the pick, reading under the lock, refuses a row already
 * WITHDRAWN or swept to REJECTED. The approve UPDATE is guarded anyway.
 * Two picks of DIFFERENT acts onto one event may both take the same
 * end-of-lineup sortOrder; ties are allowed and the editor can reorder.
 */
export async function pickOpenCallApplication(
  deps: PickOpenCallApplicationDeps,
  rawInput: unknown,
): Promise<PickOpenCallApplicationOutput> {
  const input = parseInput(pickOpenCallApplicationInputSchema, rawInput);
  const occurrenceIds = [...new Set(input.occurrenceIds ?? [])];

  // Phase 1 (read-only): authorise, validate, and find nights that need an
  // event. Materialising runs its own transaction, so it cannot nest in ours.
  const plan = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { form, anchor, submission } = await resolveDecidableSubmission(
      tx,
      input,
      deps.logger,
    );
    judgePickable(submission);
    await ensurePickableInTime(tx, anchor, now);
    const targets = await resolvePickTargets(tx, anchor, submission, occurrenceIds, now);
    // A night with no end time cannot be materialised today:
    // `generateEventsFromSeries` copies `occurrence.endsAt ?? null` into the
    // required Event.endsAt (generate-events-from-series.ts:361) and Prisma
    // rejects the insert. Refuse it here, cleanly, before calling the seam.
    // Fixing generation is a separate change.
    if (targets.some((t) => t.eventId === null && t.endsAt === null)) {
      throw fail("OPEN_CALL_DATE_UNAVAILABLE");
    }
    return {
      seriesId: form.seriesId,
      toMaterialise: targets
        .filter((t) => t.eventId === null && t.occurrenceId !== null)
        .map((t) => t.occurrenceId!),
    };
  });

  if (plan.toMaterialise.length > 0 && plan.seriesId) {
    if (!deps.materializeSeriesOccurrences) {
      throw fail("NOT_CONFIGURED", { message: "open_call_materialize_unwired" });
    }
    const ids = [...plan.toMaterialise].sort();
    await deps.materializeSeriesOccurrences({
      actorHumanId: input.actorHumanId,
      seriesId: plan.seriesId,
      occurrenceIds: ids,
      // Deterministic per (application, nights): a retry replays the same
      // generation instead of conflicting with it.
      clientKey: `open-call-pick:${input.submissionId}:${createHash("sha256")
        .update(ids.join(","))
        .digest("hex")
        .slice(0, 16)}`,
    });
  }

  // Phase 2: the pick itself, one transaction, re-judged under the lock.
  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { form, anchor } = await resolveDecidableSubmission(tx, input, deps.logger);
    const submission = await lockDecidableSubmission(tx, form, input.submissionId);
    const mode = judgePickable(submission);
    await ensurePickableInTime(tx, anchor, now);
    const targets = await resolvePickTargets(tx, anchor, submission, occurrenceIds, now);
    // Materialisation skipped it (started, cancelled meanwhile) or failed to
    // link it: not bookable.
    if (targets.some((t) => t.eventId === null)) throw fail("OPEN_CALL_DATE_UNAVAILABLE");

    if (mode === "flip") {
      const flipped = await tx.eventApplications.approveOpenCallSubmission({
        submissionId: submission.id,
        formId: form.id,
        reviewerHumanId: input.actorHumanId,
        reviewedAt: now,
      });
      // Unreachable while we hold the row lock; fail closed if it ever isn't.
      if (!flipped) throw fail("OPEN_CALL_APPLICATION_DECIDED");
    }
    await stampFirstOpen(tx, {
      form,
      submission,
      actorHumanId: input.actorHumanId,
      now,
      via: "pick",
    });

    const act = actOfSubmission(submission);
    const rows: z.infer<typeof pickedRowSchema>[] = [];
    for (const target of targets) {
      const placed = await placeOnLineup(tx, target.eventId!, act);
      rows.push({ ...placed, occurrenceId: target.occurrenceId });
    }
    const added = rows.filter((r) => r.added);

    const ref = anchorOfForm(form);
    if (mode === "flip" || added.length > 0) {
      await tx.audit.log({
        entity: ref.kind === "event" ? "event" : "event_series",
        entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
        action:
          mode === "flip" ? "open_call_application_picked" : "open_call_application_pick_extended",
        data: {
          actorHumanId: input.actorHumanId,
          formId: form.id,
          submissionId: submission.id,
          rows: rows.map((r) => ({
            eventId: r.eventId,
            occurrenceId: r.occurrenceId,
            eventHumanId: r.eventHumanId,
            added: r.added,
          })),
        },
        at: now,
      });
    }

    const notice: OpenCallPickedNotice | null =
      mode === "flip" || added.length > 0
        ? {
            kind: "open_call_picked",
            submissionId: submission.id,
            formId: form.id,
            anchor: ref,
            title: anchorTitle(anchor),
            firstPick: mode === "flip",
            eventIds: rows.map((r) => r.eventId),
            addedEventIds: added.map((r) => r.eventId),
          }
        : null;
    return { submissionId: submission.id, alreadyPicked: mode === "retry", rows, notice };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "application_picked",
    formId: input.formId,
    submissionId: result.submissionId,
    alreadyPicked: result.alreadyPicked,
    rowsAdded: result.rows.filter((r) => r.added).length,
    actorHumanId: input.actorHumanId,
  });

  if (result.notice) {
    await runOpenCallNotice(deps, "pickOpenCallApplication", deps.notifyOpenCallPicked, result.notice);
  }

  return pickOpenCallApplicationOutputSchema.parse({ ...result, status: "APPROVED" });
}

/**
 * Which pick this is, or the refusal. PENDING (and WAITLISTED, which the
 * open-call indexes treat as open) flips; APPROVED with the act still
 * booked is a retry; everything else is decided.
 */
function judgePickable(submission: OpenCallSubmissionRecord): PickMode {
  switch (submission.status) {
    case "PENDING":
    case "WAITLISTED":
      return "flip";
    case "APPROVED":
      if (submission.removedFromLineupAt !== null) throw fail("OPEN_CALL_APPLICATION_DECIDED");
      return "retry";
    case "WITHDRAWN":
      throw fail("OPEN_CALL_APPLICATION_WITHDRAWN");
    default:
      throw fail("OPEN_CALL_APPLICATION_DECIDED");
  }
}

/**
 * Module header, "When a pick is refused for time". Deliberately ignores
 * form.closedAt: a WAITLISTED application may be picked after Close.
 */
async function ensurePickableInTime(
  tx: Pick<TxRepos, "eventDates" | "seriesOccurrences" | "events">,
  anchor: OpenCallAnchorContext,
  now: Date,
): Promise<void> {
  if (anchor.kind === "event") {
    const { reason } = await openCallEndedReason(tx, anchor, now);
    if (reason !== null) throw fail("OPEN_CALL_CLOSED");
    return;
  }
  if (anchorEnded(anchor)) throw fail("OPEN_CALL_CLOSED");
}

/** The nights to put the act on (module header, "Dates"). */
async function resolvePickTargets(
  tx: Pick<TxRepos, "seriesOccurrences" | "events">,
  anchor: OpenCallAnchorContext,
  submission: OpenCallSubmissionRecord,
  occurrenceIds: readonly string[],
  now: Date,
): Promise<PickTarget[]> {
  if (anchor.kind === "event") {
    if (occurrenceIds.length > 0) throw fail("OPEN_CALL_DATE_INVALID");
    return [{ occurrenceId: null, eventId: anchor.event.id, endsAt: anchor.event.endsAt }];
  }
  if (occurrenceIds.length === 0) throw fail("OPEN_CALL_DATES_REQUIRED");
  const chosen = new Set(
    submission.dateChoices.map((c) => c.occurrenceId).filter((id): id is string => id !== null),
  );
  for (const id of occurrenceIds) {
    if (!chosen.has(id)) throw fail("OPEN_CALL_DATE_INVALID");
  }
  const live: ReadonlySet<string> = new Set(LIVE_OCCURRENCE_STATUSES);
  const targets: PickTarget[] = [];
  for (const id of occurrenceIds) {
    const occurrence = await tx.seriesOccurrences.getById(id);
    if (
      !occurrence ||
      occurrence.seriesId !== anchor.series.id ||
      !live.has(occurrence.status) ||
      occurrence.startsAt.getTime() <= now.getTime()
    ) {
      throw fail("OPEN_CALL_DATE_UNAVAILABLE");
    }
    // A night whose materialised event was cancelled is off even while the
    // occurrence row still reads live (listOpenCallDates, same rule).
    if (occurrence.eventId) {
      const event = await tx.events.getById(occurrence.eventId);
      if (event?.status === "CANCELLED") throw fail("OPEN_CALL_DATE_UNAVAILABLE");
    }
    targets.push({
      occurrenceId: occurrence.id,
      eventId: occurrence.eventId,
      endsAt: occurrence.endsAt,
    });
  }
  return targets;
}

/**
 * Put the act on one event's lineup, at the end, unless it is already there.
 * Person and org rows go through the adapter's idempotent (event, human) /
 * (event, org) upsert: a returned id that is not ours means a row already
 * existed; a person or org counts as "already on the lineup" in ANY role
 * (FR-016). A guest counts only as a PERFORMER free-text row with the same
 * name AND url (`lineupRowIsAct`); anything else gets a new row, so an
 * unrelated "Sam" is never taken over. Free-text rows have no unique key;
 * the submission row lock serialises concurrent picks of the same guest, so
 * the second sees the first's row.
 */
async function placeOnLineup(
  tx: Pick<TxRepos, "eventHumans">,
  eventId: string,
  act: OpenCallLineupAct,
): Promise<{ eventId: string; eventHumanId: string; added: boolean }> {
  const lineup = await tx.eventHumans.listByEvent(eventId);
  const existing = lineup.find((row) => lineupRowIsAct(row, act));
  if (existing) return { eventId, eventHumanId: existing.id, added: false };

  const sortOrder = lineup.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
  const id = randomUUID();
  const identity =
    act.kind === "human"
      ? { humanId: act.humanId, orgId: null }
      : act.kind === "org"
        ? { humanId: null, orgId: act.orgId }
        : {
            humanId: null,
            orgId: null,
            externalName: act.name.slice(0, OPEN_CALL_GUEST_NAME_MAX).trim(),
            externalUrl: act.url,
          };
  const row = await tx.eventHumans.attach({
    id,
    eventId,
    ...identity,
    role: "PERFORMER",
    sortOrder,
  });
  return { eventId, eventHumanId: row.id, added: row.id === id };
}
