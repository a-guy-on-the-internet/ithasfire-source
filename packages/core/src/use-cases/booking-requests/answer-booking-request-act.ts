import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestActConfirmation,
  BookingRequestActOwnerKey,
  BookingRequestActRecord,
  BookingRequestRecord,
  BookingRequestStatus,
} from "@th/ports/repos/booking-requests";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import { fail } from "@th/errors";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

import { describeError, parseInput } from "../../lib/io";
import { plainTextOptional } from "../../lib/sanitize-plain-text";
import type { LineupNoticeHooks } from "../event-humans/notify-lineup-notices";
import { isUpcomingLiveBookingShow } from "../booking-agreements/_shared/booking-event-liveness";
import { actorEditsOrg } from "./_shared/act-answerers";
import { resolveBillActName } from "./_shared/bill-act-names";
import { isActOnBookingEventLineup } from "./_shared/bill-event";
import { bookingRequestActConfirmationSchema } from "./_shared/bill-items";
import {
  attachLateJoiner,
  findLateJoinTarget,
} from "./_shared/late-join";
import { resolveNoticeSenderName } from "./_shared/bill-notice-support";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import type {
  BookingLineupAnswer,
  NotifyBookingLineupAnsweredFn,
} from "./notify-booking-lineup-answered";

// ─────────────────────────────────────────────────────────────────────────────
// A tagged act answers its spot on a bill (lineup-booking-requests v2,
// FR-003; v3 FR-003): it JOINS or PASSES — `joinBookingRequestAct` /
// `passBookingRequestAct`. The v2 names `confirmBookingRequestAct` /
// `declineBookingRequestAct` are the same functions, kept for the one release
// the `confirmAct` / `declineAct` procedure aliases live. The stored values
// stay CONFIRMED / DECLINED (CONTEXT.md "Join / Pass").
//
// WHO: only the tagged act, and only for its OWN row — the act is read by
// its owner key, never by an act id, so there is nothing to point at
// someone else's spot:
//   · a tagged PERSON answers as themselves: (request, "human", the ACTOR);
//   · a tagged GROUP (v3 L17) is answered by any member with an org edit
//     role (ORG_EDIT_ROLES), who names it (`asOrgId`): (request,
//     "organization", that group) — read only AFTER the membership check.
// A request that does not exist, is not a TO_VENUE request, or on which the
// actor is not a TAGGED act (or does not edit the group they name) all
// answer the SAME `BOOKING_REQUEST_NOT_FOUND` with no meta: the endpoint
// must not tell a stranger which requests exist or who is on them.
//
// THE RULES (`judgeActAnswer`, also what the invite read exposes as
// canConfirm / canDecline):
//   · repeating the answer you already gave is a success no-op (no write, no
//     ledger entry) — idempotent on repeat;
//   · PENDING → CONFIRMED while the request is still live for the booking:
//     status PENDING | VIEWED (open) or ACCEPTED. DECLINED / WITHDRAWN /
//     EXPIRED refuse (`INVALID_STATUS`, reason `request_closed`). A MINTED
//     event does NOT refuse it (an act that answers a day after the night
//     was booked must still be able to say yes): while that event has not
//     started and is not cancelled the join puts the act on its lineup
//     (LATE JOIN, below); otherwise it attaches nothing and the editor sees
//     the act as a joined suggestion (`listBookingLineupSuggestions`);
//   · PENDING → DECLINED always. Saying no is never gated: a pending act was
//     never attached to anything, so declining after a mint only takes the
//     name out of the editor's suggestions (NFR-002: consent must always be
//     refusable);
//   · CONFIRMED → DECLINED (LEAVING the bill, v3 L14) unless the act is
//     ACTUALLY on the lineup of the event minted from the request
//     (`isActOnBookingEventLineup`: its humanId, or a group's orgId) — then
//     taking them off is the event editor's call (`INVALID_STATUS`,
//     `on_lineup`). That is "until the night is booked". Being minted is not
//     enough: an act that joined AFTER the mint was never attached, and one
//     the editor removed is no longer on it — both may still leave. Leaving
//     records a pass and is just as final;
//   · DECLINED → CONFIRMED never: DECLINED is terminal on that request
//     (`ACT_ALREADY_DECLINED`).
//
// RACE WITH THE MINT. The answer and `createEventFromAgreement` both take the
// bill's transaction advisory lock (`bookingRequests.lockBill`) before
// reading what they decide on, so a consent withdrawal and a mint serialize:
// whichever goes second sees the first one's commit (the withdrawal then
// reads the lineup the mint attached). Without it, a decline and a mint
// could each read the other's pre-commit state and a DECLINED act would flow
// onto the event. An editor's MANUAL attach is outside the bill and takes no
// lock (consent on direct EventHuman attach is out of scope in the spec).
//
// ONE transaction per answer: CAS on the act's confirmation, the ledger entry
// (`booking_request.act_confirmed` — visible to both sides —
// / `booking_request.act_declined` — SENDER-ONLY, the venue never learns an
// act passed, FR-004; it carries the pass / leave reason, v3 L19, so the
// sender reads it in the thread), and the audit row.
//
// LATE JOIN (v3 FR-010, `_shared/late-join.ts`). A join that lands after the
// bill flowed into an event that has not started and is not cancelled also
// puts the act on that event's lineup, in its bill slot, in the SAME
// transaction and under the same lock, with a `booking_request.act_joined_
// lineup` entry. A person is told through the lineup consent notice
// (`event.lineup-added`): OWED recorded before the transaction, dispatched
// after commit — the `attachEventHuman` discipline. (Both entries share the
// transaction's `createdAt`, so the thread's id tiebreak may show the lineup
// line above the join line; the copy reads either way.)
//
// AFTER COMMIT (v3 FR-012a): the SENDER hears the answer — in-app only,
// through `notifyBookingLineupAnswered`. Swallowed + reported. A server-side
// caller of the pass may leave named humans out of that note
// (`skipSenderNoticeFor` — a lineup leave tells the event's editors itself);
// by default nobody is left out.
//
// ONLY WHILE THE SHOW IS UPCOMING (`onlyWhileEventUpcoming`, owner ruling
// 2026-10-01). A lineup leave passes the act only for an upcoming, live show:
// a started, cancelled or archived show is history and the booking record is
// not touched. The leave checks that on its own snapshot, but the show can be
// cancelled (or reach its start) before the pass runs — so the caller names
// the event and the rule is re-judged HERE, in the pass's own transaction:
// `events.lockRows(share)` on that event (BEFORE the bill lock: event row →
// bill lock, the mint's order, so the two cannot deadlock), then the bill
// lock, then a re-read through `isUpcomingLiveBookingShow`. The share lock
// makes a cancel / archive / reschedule either commit before our read or wait
// for our commit. Not upcoming (or gone) → nothing is written and the pass
// throws `INVALID_STATUS` with reason `event_not_upcoming` — an expected lost
// race for the caller. Absent (every client path) → none of this runs.
// ─────────────────────────────────────────────────────────────────────────────

/** Declined reason bound — the `BookingRequestAct.declineReason` column. */
export const BOOKING_ACT_DECLINE_REASON_MAX_LENGTH = 240;

/**
 * Request statuses on which a pending act may still CONFIRM: open
 * (PENDING | VIEWED — a parked request is PENDING) or ACCEPTED. The other
 * three are terminal for the booking.
 */
export const ACT_CONFIRMABLE_REQUEST_STATUSES = [
  "PENDING",
  "VIEWED",
  "ACCEPTED",
] as const satisfies readonly BookingRequestStatus[];

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answer AS this group (v3 L17): the tagged act is the group, and the actor
 * must hold an org edit role in it. Absent = the actor answers as themselves.
 */
const asOrgIdField = z.uuid().optional();

export const confirmBookingRequestActInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    asOrgId: asOrgIdField,
  })
  .strict();

export const declineBookingRequestActInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    asOrgId: asOrgIdField,
    /**
     * Optional pass / leave reason, sanitized BEFORE the length check; empty
     * → none. Stored on the act row and carried on the sender-only ledger
     * entry (v3 L19).
     */
    declineReason: plainTextOptional(
      BOOKING_ACT_DECLINE_REASON_MAX_LENGTH,
    ).optional(),
  })
  .strict();

/** v3 name (FR-003): "Count me in". Same contract as the v2 confirm. */
export const joinBookingRequestActInputSchema =
  confirmBookingRequestActInputSchema;
/** v3 name (FR-003): "I'll pass" / "Leave the bill". Same contract as decline. */
export const passBookingRequestActInputSchema =
  declineBookingRequestActInputSchema;

export const bookingRequestActAnswerOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    actId: z.uuid(),
    confirmation: bookingRequestActConfirmationSchema,
    respondedAt: z.date().nullable(),
    /** False on an idempotent repeat — nothing was written. */
    changed: z.boolean(),
  })
  .strict();

export type ConfirmBookingRequestActInput = z.infer<
  typeof confirmBookingRequestActInputSchema
>;
export type DeclineBookingRequestActInput = z.infer<
  typeof declineBookingRequestActInputSchema
>;
export type BookingRequestActAnswerOutput = z.infer<
  typeof bookingRequestActAnswerOutputSchema
>;

/**
 * Caller-side options for a PASS — server-composed, never part of the
 * client input schema. Default (omitted / empty) = today's behaviour.
 */
export type DeclineBookingRequestActOptions = {
  /**
   * Humans the sender's "{act} left / passed on your bill" note must NOT go
   * to, because the caller tells them itself: a person leaving a booked
   * show's lineup (`leaveEventLineup`) sends `event.lineup-left` to the
   * event's editors, and owner ruling 2026-10-01 gives the overlap the
   * LINEUP notice. Everyone else on the sender side still hears.
   */
  skipSenderNoticeFor?: readonly string[];
  /**
   * Pass ONLY while this event is still upcoming and live
   * (`isUpcomingLiveBookingShow`), re-judged under the bill lock in the
   * pass's own transaction (module header). Otherwise nothing is written and
   * the call throws `INVALID_STATUS` with `meta.reason ===
   * "event_not_upcoming"` (see {@link ACT_EVENT_NOT_UPCOMING_REASON}). Set by
   * `leaveEventLineup`; absent = no event is read.
   */
  onlyWhileEventUpcoming?: { eventId: string };
};

/** `meta.reason` of the lost race {@link DeclineBookingRequestActOptions.onlyWhileEventUpcoming} guards. */
export const ACT_EVENT_NOT_UPCOMING_REASON = "event_not_upcoming";

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type AnswerBookingRequestActDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    // The ledger entry, appended in the answer's own tx.
    | "bookingRequestMessages"
    // "Is the artist on the minted event's lineup?"
    // (`isHumanOnBookingEventLineup`) — a withdrawal's only gate.
    | "agreements"
    | "events"
    | "eventHumans"
    // The artist's display-name snapshot for the ledger entry.
    | "humans"
    | "organizations"
    | "entityPages"
    | "audit"
    // Answering AS a group: the actor's org edit role in it (v3 L17).
    | "authz"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Late join (v3 FR-010): the lineup consent notice hooks
   * (`makeLineupNoticeHooks`) — `recordOwed` before the transaction,
   * `dispatch` after it. Absent = the act still lands on the lineup, and
   * nobody is told (seeds, scripts).
   */
  lineupNotices?: Pick<LineupNoticeHooks, "recordOwed" | "dispatch">;
  /** Post-commit: the sender hears the answer, in-app (v3 FR-012a). */
  notifyBookingLineupAnswered?: NotifyBookingLineupAnsweredFn;
  /** Web origin, for a late-joining group row's fallback page link. */
  publicAppUrl?: string | null;
  /** Swallow reporter for the post-commit notices (ReporterPort convention). */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// The rule
// ─────────────────────────────────────────────────────────────────────────────

type AnswerTarget = Extract<
  BookingRequestActConfirmation,
  "CONFIRMED" | "DECLINED"
>;

export type ActAnswerVerdict =
  | { kind: "noop" }
  | { kind: "write"; expectedFrom: "PENDING" | "CONFIRMED" }
  | {
      kind: "refuse";
      code: "ACT_ALREADY_DECLINED" | "INVALID_STATUS";
      reason: ActAnswerBlockedReason;
    };

/** Why an answer is refused — what a page shows instead of the button. */
export const actAnswerBlockedReasonSchema = z.enum([
  /** Confirm: DECLINED is terminal on the request. */
  "act_declined",
  /** Confirm: the request is DECLINED / WITHDRAWN / EXPIRED. */
  "request_closed",
  /** Decline: the artist is on the minted event's lineup — the editor's call. */
  "on_lineup",
]);
export type ActAnswerBlockedReason = z.infer<
  typeof actAnswerBlockedReasonSchema
>;

/**
 * The whole transition table in one pure function — see the module header.
 * Shared by the two mutations and the invite read, so the page can never
 * offer a button the server would refuse.
 */
export function judgeActAnswer(
  current: BookingRequestActConfirmation,
  to: AnswerTarget,
  context: {
    requestStatus: BookingRequestStatus;
    /**
     * The artist is ACTUALLY on the lineup of the event minted from the
     * request. Only a CONFIRMED → DECLINED withdrawal reads it.
     */
    actOnEventLineup: boolean;
  },
): ActAnswerVerdict {
  if (current === to) return { kind: "noop" };

  if (to === "CONFIRMED") {
    if (current === "DECLINED") {
      return {
        kind: "refuse",
        code: "ACT_ALREADY_DECLINED",
        reason: "act_declined",
      };
    }
    if (
      !(ACT_CONFIRMABLE_REQUEST_STATUSES as readonly string[]).includes(
        context.requestStatus,
      )
    ) {
      return {
        kind: "refuse",
        code: "INVALID_STATUS",
        reason: "request_closed",
      };
    }
    // The verdict doesn't depend on a mint; whether a late join attaches is decided in the tx (FR-010).
    return { kind: "write", expectedFrom: "PENDING" };
  }

  // to === "DECLINED"
  if (current === "PENDING") return { kind: "write", expectedFrom: "PENDING" };
  // current === "CONFIRMED": withdrawing consent.
  if (context.actOnEventLineup) {
    return { kind: "refuse", code: "INVALID_STATUS", reason: "on_lineup" };
  }
  return { kind: "write", expectedFrom: "CONFIRMED" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use cases
// ─────────────────────────────────────────────────────────────────────────────

/** The tagged act joins the bill (FR-003). Idempotent. */
export async function confirmBookingRequestAct(
  deps: AnswerBookingRequestActDeps,
  rawInput: unknown,
): Promise<BookingRequestActAnswerOutput> {
  const input = parseInput(confirmBookingRequestActInputSchema, rawInput);
  return answerBookingRequestAct(deps, {
    actorHumanId: input.actorHumanId,
    bookingRequestId: input.bookingRequestId,
    asOrgId: input.asOrgId ?? null,
    to: "CONFIRMED",
    declineReason: null,
    skipSenderNoticeFor: [],
    onlyWhileEventUpcoming: null,
  });
}

/**
 * The tagged act passes — or LEAVES the bill after joining, unless it is on
 * the minted event's lineup (FR-003, v3 L14). Either is final. Idempotent; a
 * repeat keeps the FIRST reason (nothing is rewritten).
 */
export async function declineBookingRequestAct(
  deps: AnswerBookingRequestActDeps,
  rawInput: unknown,
  options: DeclineBookingRequestActOptions = {},
): Promise<BookingRequestActAnswerOutput> {
  const input = parseInput(declineBookingRequestActInputSchema, rawInput);
  return answerBookingRequestAct(deps, {
    actorHumanId: input.actorHumanId,
    bookingRequestId: input.bookingRequestId,
    asOrgId: input.asOrgId ?? null,
    to: "DECLINED",
    declineReason: input.declineReason?.trim() || null,
    skipSenderNoticeFor: options.skipSenderNoticeFor ?? [],
    onlyWhileEventUpcoming: options.onlyWhileEventUpcoming ?? null,
  });
}

/** v3 name for {@link confirmBookingRequestAct} ("Count me in"). */
export const joinBookingRequestAct = confirmBookingRequestAct;
/** v3 name for {@link declineBookingRequestAct} ("I'll pass" / "Leave the bill"). */
export const passBookingRequestAct = declineBookingRequestAct;

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single not-found for "no such request", "not a TO_VENUE request" and
 * "you are not tagged on it" — deliberately without meta (no enumeration).
 */
function actNotFound(): never {
  throw fail("BOOKING_REQUEST_NOT_FOUND");
}

function refuse(
  verdict: Extract<ActAnswerVerdict, { kind: "refuse" }>,
  bookingRequestId: string,
): never {
  if (verdict.code === "ACT_ALREADY_DECLINED") {
    throw fail("ACT_ALREADY_DECLINED");
  }
  throw fail("INVALID_STATUS", {
    message: `booking_request_act_${verdict.reason}`,
    meta: { reason: verdict.reason, bookingRequestId },
  });
}

function toOutput(
  act: BookingRequestActRecord,
  changed: boolean,
): BookingRequestActAnswerOutput {
  return bookingRequestActAnswerOutputSchema.parse({
    bookingRequestId: act.bookingRequestId,
    actId: act.id,
    confirmation: act.confirmation,
    respondedAt: act.respondedAt,
    changed,
  });
}

function isActStateChanged(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { message?: unknown }).message ===
      "booking_request_act_state_changed"
  );
}

/**
 * `actOnEventLineup` for {@link judgeActAnswer}: read ONLY for a withdrawal
 * (CONFIRMED → DECLINED) — no other transition consults it. A group is on
 * the lineup by its `orgId` (v3 L18).
 */
async function withdrawalHitsLineup(
  repos: Parameters<typeof isActOnBookingEventLineup>[0],
  act: BookingRequestActRecord,
  to: AnswerTarget,
  request: Parameters<typeof isActOnBookingEventLineup>[1],
): Promise<boolean> {
  if (act.confirmation !== "CONFIRMED" || to !== "DECLINED") return false;
  if (!act.actOwnerId || !act.actOwnerType) return false;
  return isActOnBookingEventLineup(repos, request, {
    ownerType: act.actOwnerType,
    ownerId: act.actOwnerId,
  });
}

/**
 * A late join the transaction MAY attach (v3 FR-010), prepared BEFORE it for
 * EVERY join: a lineup row id is pre-generated and — for a person — its
 * lineup notice recorded OWED under that id (no non-tx I/O inside the
 * interactive tx). Whether anything attaches is decided ONLY in the
 * transaction, under the bill lock (`findLateJoinTarget` on the tx bag): a
 * night booked between this read and the lock must still put the joiner on
 * the lineup, so nothing here may gate on an event existing. An unused id
 * leaves an inert OWED record (the notice ledger's documented posture for a
 * rolled-back attach: the sweep only visits rows that exist).
 */
type LateJoinPrep = {
  rowId: string;
  /** Set when a lineup notice was recorded OWED (a person, hooks wired). */
  notice: {
    addedByHumanId: string | null;
    addedByOrgId: string | null;
    addedByName: string;
  } | null;
};

async function prepareLateJoin(
  deps: AnswerBookingRequestActDeps,
  request: BookingRequestRecord,
  act: BookingRequestActRecord,
  to: AnswerTarget,
): Promise<LateJoinPrep | null> {
  if (to !== "CONFIRMED") return null;
  const rowId = randomUUID();
  const sender = getBookingRequestSender(request);
  if (
    act.actOwnerType !== "human" ||
    !deps.lineupNotices ||
    sender.kind !== "owned" ||
    isUnclaimedBookingInquiry(request)
  ) {
    return { rowId, notice: null };
  }
  // "Who added you": the sender — a person (`addedByHumanId`), or a group
  // (`addedByOrgId`, no person); the name carries the copy either way.
  const notice = {
    addedByHumanId:
      sender.performerOwnerType === "human" ? sender.performerOwnerId : null,
    addedByOrgId:
      sender.performerOwnerType === "organization"
        ? sender.performerOwnerId
        : null,
    addedByName: await resolveNoticeSenderName(deps.repos, request),
  };
  await deps.lineupNotices.recordOwed({
    eventHumanId: rowId,
    ...notice,
    via: "attach",
  });
  return { rowId, notice };
}

async function answerBookingRequestAct(
  deps: AnswerBookingRequestActDeps,
  args: {
    actorHumanId: string;
    bookingRequestId: string;
    /** Answering AS this group (v3 L17); null = as the actor themselves. */
    asOrgId: string | null;
    to: AnswerTarget;
    declineReason: string | null;
    /** {@link DeclineBookingRequestActOptions.skipSenderNoticeFor}. */
    skipSenderNoticeFor: readonly string[];
    /** {@link DeclineBookingRequestActOptions.onlyWhileEventUpcoming}. */
    onlyWhileEventUpcoming: { eventId: string } | null;
  },
): Promise<BookingRequestActAnswerOutput> {
  const { to } = args;
  // A group is answered only by its editors — checked BEFORE the row is
  // read, and refused with the same not-found as everything else (a
  // non-editor must not learn whether that group is on that request).
  if (
    args.asOrgId !== null &&
    !(await actorEditsOrg(deps.repos, args.actorHumanId, args.asOrgId))
  ) {
    actNotFound();
  }
  // The act's own row, by owner key — nothing else is addressable: the
  // ACTOR as a person, or the group the actor was just proven to edit.
  const key: BookingRequestActOwnerKey = {
    bookingRequestId: args.bookingRequestId,
    ...(args.asOrgId !== null
      ? { actOwnerType: "organization" as const, actOwnerId: args.asOrgId }
      : { actOwnerType: "human" as const, actOwnerId: args.actorHumanId }),
  };

  const act = await deps.repos.bookingRequests.getActForOwner(key);
  // A SELF row owned by a human sender is not an invitation to answer.
  if (!act || act.source !== "TAGGED") actNotFound();
  const request = await deps.repos.bookingRequests.getById(
    args.bookingRequestId,
  );
  if (!request || request.direction !== "TO_VENUE") actNotFound();

  // Idempotent repeat — before any further read or the transaction.
  if (act.confirmation === to) return toOutput(act, false);

  // Pre-flight on committed state (read-only): refuse the deterministic
  // cases without opening a transaction. Re-judged under the lock below.
  const preflight = judgeActAnswer(act.confirmation, to, {
    requestStatus: request.status,
    actOnEventLineup: await withdrawalHitsLineup(deps.repos, act, to, request),
  });
  if (preflight.kind === "refuse") refuse(preflight, request.id);

  const actName = await resolveBillActName(deps.repos, act);
  // Late join (FR-010): prepared outside the tx (row id + OWED notice).
  const lateJoin = await prepareLateJoin(deps, request, act, to);
  const now = deps.clock.now();

  let outcome: {
    act: BookingRequestActRecord;
    changed: boolean;
    request: BookingRequestRecord;
    from: BookingRequestActConfirmation;
    attached: { row: EventHumanRecord; eventId: string } | null;
  };
  try {
    outcome = await deps.repos.tx(async (tx) => {
      // Serializes against the event mint and the bill edit (module
      // header) — BEFORE the reads the decision rests on. The guarded
      // pass locks its event row first (event row → bill lock).
      const guardEventId = args.onlyWhileEventUpcoming?.eventId ?? null;
      if (guardEventId !== null) {
        await tx.events.lockRows({ ids: [guardEventId], mode: "share" });
      }
      await tx.bookingRequests.lockBill(request.id);

      // A group's editor is re-checked on the locked snapshot: a role
      // revoked since the pre-read must not still answer for the group.
      if (
        args.asOrgId !== null &&
        !(await actorEditsOrg(tx, args.actorHumanId, args.asOrgId))
      ) {
        actNotFound();
      }

      const fresh = await tx.bookingRequests.getActForOwner(key);
      if (!fresh || fresh.source !== "TAGGED") actNotFound();

      const freshRequest = await tx.bookingRequests.getById(request.id);
      if (!freshRequest || freshRequest.direction !== "TO_VENUE") {
        actNotFound();
      }
      const unchanged = {
        act: fresh,
        changed: false,
        request: freshRequest,
        from: fresh.confirmation,
        attached: null,
      };
      if (fresh.confirmation === to) return unchanged;

      // Started, cancelled, archived or gone since the caller looked: the
      // booking record is history — write nothing (owner ruling 2026-10-01).
      if (guardEventId !== null) {
        const guardEvent = await tx.events.getById(guardEventId);
        if (
          !guardEvent ||
          !isUpcomingLiveBookingShow(guardEvent, deps.clock.now())
        ) {
          throw fail("INVALID_STATUS", {
            message: `booking_request_act_${ACT_EVENT_NOT_UPCOMING_REASON}`,
            meta: {
              reason: ACT_EVENT_NOT_UPCOMING_REASON,
              bookingRequestId: request.id,
              eventId: guardEventId,
            },
          });
        }
      }

      const verdict = judgeActAnswer(fresh.confirmation, to, {
        requestStatus: freshRequest.status,
        actOnEventLineup: await withdrawalHitsLineup(tx, fresh, to, freshRequest),
      });
      if (verdict.kind === "refuse") refuse(verdict, request.id);
      if (verdict.kind === "noop") return unchanged;

      const updated = await tx.bookingRequests.setActConfirmation({
        ...key,
        expectedFrom: verdict.expectedFrom,
        to,
        respondedAt: now,
        declineReason: to === "DECLINED" ? args.declineReason : null,
      });

      // Ledger, same tx as the CAS. `act_declined` is sender-only: hidden
      // from the venue side and it does not bump `lastMessageAt`
      // (`appendBookingSystemEntry` handles both) — so its pass / leave
      // reason (v3 L19) and whether it was a LEAVE reach the sender only.
      if (to === "CONFIRMED") {
        await appendBookingSystemEntry(tx, {
          bookingRequestId: request.id,
          kind: "booking_request.act_confirmed",
          data: { actId: updated.id, actName },
          actorHumanId: args.actorHumanId,
        });
      } else {
        await appendBookingSystemEntry(tx, {
          bookingRequestId: request.id,
          kind: "booking_request.act_declined",
          data: {
            actId: updated.id,
            actName,
            ...(args.declineReason ? { reason: args.declineReason } : {}),
            ...(verdict.expectedFrom === "CONFIRMED" ? { left: true } : {}),
          },
          actorHumanId: args.actorHumanId,
        });
      }

      // Late join (FR-010): decided HERE, on the locked snapshot, and only
      // here — the night may have been booked, cancelled or started, or the
      // act put on by hand, since the pre-read. With no live upcoming event
      // a join attaches nothing (the editor sees a joined suggestion).
      let attached: { row: EventHumanRecord; eventId: string } | null = null;
      if (to === "CONFIRMED" && lateJoin) {
        const target = await findLateJoinTarget(tx, freshRequest, updated, now);
        if (target) {
          const row = await attachLateJoiner(tx, {
            request: freshRequest,
            act: updated,
            target,
            rowId: lateJoin.rowId,
            publicAppUrl: deps.publicAppUrl ?? null,
          });
          await appendBookingSystemEntry(tx, {
            bookingRequestId: request.id,
            kind: "booking_request.act_joined_lineup",
            data: { actId: updated.id, eventId: target.event.id, actName },
            actorHumanId: args.actorHumanId,
          });
          attached = { row, eventId: target.event.id };
        }
      }

      await tx.audit.log({
        entity: "booking_request_act",
        entityId: updated.id,
        action:
          to === "CONFIRMED"
            ? "booking_request.act_confirmed"
            : "booking_request.act_declined",
        data: {
          actorHumanId: args.actorHumanId,
          bookingRequestId: request.id,
          ...(args.asOrgId !== null ? { asOrgId: args.asOrgId } : {}),
          from: fresh.confirmation,
          to,
          ...(to === "DECLINED" ? { declineReason: args.declineReason } : {}),
          ...(attached
            ? { joinedLineup: { eventId: attached.eventId, eventHumanId: attached.row.id } }
            : {}),
        },
        at: now,
      });

      return {
        act: updated,
        changed: true,
        request: freshRequest,
        from: fresh.confirmation,
        attached,
      };
    });
  } catch (error) {
    // Lost CAS: the row left the state we read. Every answer path takes the
    // bill lock first, so this needs a writer that did not — answer from
    // what actually won rather than surfacing a raw conflict.
    if (isActStateChanged(error)) {
      const current = await deps.repos.bookingRequests.getActForOwner(key);
      if (current?.confirmation === to) return toOutput(current, false);
      if (to === "CONFIRMED" && current?.confirmation === "DECLINED") {
        throw fail("ACT_ALREADY_DECLINED");
      }
    }
    throw error;
  }

  if (outcome.changed) {
    await tellLateJoiner(deps, outcome.attached, lateJoin);
    await tellSender(deps, {
      request: outcome.request,
      act: outcome.act,
      actName,
      answer:
        to === "CONFIRMED"
          ? "joined"
          : outcome.from === "CONFIRMED"
            ? "left"
            : "passed",
      actorHumanId: args.actorHumanId,
      skipSenderNoticeFor: args.skipSenderNoticeFor,
    });
  }

  deps.logger?.info(
    to === "CONFIRMED"
      ? "booking_requests.act_confirmed"
      : "booking_requests.act_declined",
    {
      bookingRequestId: request.id,
      actId: outcome.act.id,
      actorHumanId: args.actorHumanId,
      asOrgId: args.asOrgId,
      changed: outcome.changed,
      joinedLineupEventId: outcome.attached?.eventId ?? null,
    },
  );

  return toOutput(outcome.act, outcome.changed);
}

/**
 * Post-commit: the person who just landed on the lineup is told through the
 * lineup consent notice (`event.lineup-added`) — only when its OWED record
 * was written for exactly this row. Swallowed + reported.
 */
async function tellLateJoiner(
  deps: AnswerBookingRequestActDeps,
  attached: { row: EventHumanRecord; eventId: string } | null,
  lateJoin: LateJoinPrep | null,
): Promise<void> {
  if (!attached || !lateJoin?.notice || !deps.lineupNotices) return;
  if (attached.row.id !== lateJoin.rowId) return;
  try {
    await deps.lineupNotices.dispatch({
      kind: "attached",
      eventId: attached.eventId,
      eventHumanId: attached.row.id,
      addedByHumanId: lateJoin.notice.addedByHumanId,
      addedByOrgId: lateJoin.notice.addedByOrgId,
      addedByName: lateJoin.notice.addedByName,
    });
  } catch (error) {
    reportAnswerSwallow(deps, error, "booking_requests.act_late_join_notice_failed", {
      step: "lineup_notice",
      extra: { eventId: attached.eventId, eventHumanId: attached.row.id },
    });
  }
}

/** Post-commit: the sender hears the answer, in-app (FR-012a). Swallowed. */
async function tellSender(
  deps: AnswerBookingRequestActDeps,
  args: {
    request: BookingRequestRecord;
    act: BookingRequestActRecord;
    actName: string;
    answer: BookingLineupAnswer;
    actorHumanId: string;
    skipSenderNoticeFor: readonly string[];
  },
): Promise<void> {
  if (!deps.notifyBookingLineupAnswered) return;
  try {
    await deps.notifyBookingLineupAnswered({
      bookingRequest: args.request,
      act: args.act,
      actName: args.actName,
      answer: args.answer,
      actorHumanId: args.actorHumanId,
      // Only when a caller asked: the default call is unchanged.
      ...(args.skipSenderNoticeFor.length > 0
        ? { skipRecipientHumanIds: args.skipSenderNoticeFor }
        : {}),
    });
  } catch (error) {
    reportAnswerSwallow(deps, error, "booking_requests.act_answer_notice_failed", {
      step: "lineup_answered",
      extra: {
        bookingRequestId: args.request.id,
        actId: args.act.id,
        answer: args.answer,
      },
    });
  }
}

function reportAnswerSwallow(
  deps: Pick<AnswerBookingRequestActDeps, "logger" | "reportError">,
  error: unknown,
  event: string,
  context: { step: string; extra: Record<string, unknown> },
): void {
  deps.logger?.error(event, {
    ...context.extra,
    err: error,
    error: describeError(error),
  });
  try {
    deps.reportError?.(error, {
      tags: { useCase: "answerBookingRequestAct", step: context.step },
      extra: context.extra,
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never fail the
    // committed answer.
  }
}
