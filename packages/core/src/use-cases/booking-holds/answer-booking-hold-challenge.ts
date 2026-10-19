import { z } from "zod";

import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookerBookingHoldRecord,
  BookingHoldRecord,
  PlaceBookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import {
  respondToBookingAgreement,
  type RespondToBookingAgreementDeps,
} from "../booking-agreements/respond-to-booking-agreement";
import { actorActsForParty } from "../booking-requests/_shared/place-access";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  withCommittedHoldIntents,
  type BookingHoldNotificationIntent,
} from "./_shared/booking-hold-intents";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { sameGrantee } from "../place-booking-grants/_shared/grant-context";
import {
  actBookingHoldOutputSchema,
  bookingHoldOutputSchema,
  findRequestlessHoldOwnerAuthority,
  loadActHoldContext,
  requireRequestHold,
  requireRequestlessHoldPlace,
  staffRecipientHintFor,
  toActBookingHoldOutput,
  toBookingHoldOutput,
  type ActHoldContext,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import {
  requestlessHoldNotificationIntentSchema,
  type RequestlessHoldNotificationIntent,
} from "./_shared/requestless-hold-intents";
import {
  casHoldRespondBy,
  lineKeyOf,
  recordMovers,
  releaseHoldCas,
  renumberLine,
  type HoldLineKey,
} from "./_shared/hold-line";
import {
  KEEP_AWAITING_TERMS_WINDOW_MS,
  isKeptAwaitingTerms,
  keptEntryMatch,
  resolveActChallengeView,
  resolveKeepPlan,
  type KeepPlan,
} from "./_shared/keep-will";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// answerBookingHoldChallenge (FR-006) — ACT side only (the hold's owner side,
// the sender pair: `loadActHoldContext`).
//
//   keep    → KEEP = COMMIT (booking-the-night N19 / FR-014). What Keep does
//             is `resolveKeepPlan` — the same answer the act's panel and the
//             challenge notice showed (`keepWill`):
//               book_now      this request's terms are PROPOSED for the
//                             hold's night (on its line): Keep IS "Agree &
//                             book" — `respondToBookingAgreement` (FR-001),
//                             reused, never re-implemented — and books the
//                             night in the same call. A refusal from the
//                             agree (the night went elsewhere, the booking's
//                             event is gone or on another day, the terms
//                             moved …) is the KEEP's refusal: nothing is
//                             recorded as kept, the hold stays CHALLENGED on
//                             its original clock, and the act can still
//                             release or let it lapse. The one exception: a
//                             concurrent agree of the same terms (the card's
//                             "Agree & book", a double tap) booked the night
//                             first — Keep's goal is met, so it succeeds.
//               ask_for_terms no terms for that night are with the act: the
//                             keep is RECORDED (`booking_hold.kept` with the
//                             challenge it answers), the venue is told "send
//                             terms to keep this night", and the hold stays
//                             CHALLENGED with a new deadline —
//                             max(current, now + 48h). The existing lapse
//                             (CHALLENGED past `respondBy` → EXPIRED) is the
//                             timer: no parallel one. The act keeps the night
//                             by agreeing the terms when they arrive (the
//                             agree confirms its own CHALLENGED hold). A
//                             second keep of the same challenge is a no-op —
//                             it never pushes the deadline again.
//             `expectedKeepWill` (what the act's panel said) guards consent:
//             when it no longer holds — terms arrived, or were pulled back —
//             the keep is refused TERMS_CHANGED_SINCE_VIEWED (no meta), so a
//             tap meant as "ask for terms" can never book a night. On the
//             book_now branch it is REQUIRED (review W1, fail closed): a keep
//             that would book with no `expectedKeepWill` is refused the same
//             way and records nothing — booking a night is only ever the act
//             agreeing terms it was shown. ask_for_terms may proceed without.
//             Terms already AGREED for the night (review W3): nothing to keep
//             — refused TERMS_AGREED_FOR_THIS_NIGHT (no meta), never asked
//             for again.
//   release → CHALLENGED → RELEASED (MANUAL); the line moves up, every mover
//             is notified, staff (email) hear the act stepped aside.
// Idempotent: keep on an ACTIVE or already-booked hold, and release on a
// RELEASED hold, are no-ops. A deadline that already passed is settled first
// and answered with BOOKING_HOLD_CHALLENGE_LAPSED.
//
// REQUEST-LESS HOLDS (holds-without-a-request H5 / H13 / FR-006): the hold's
// OWNER answers — a BOOKER hold its booker (the booker gate with `as` = the
// holder), a PLACE hold the place's staff
// (`findRequestlessHoldOwnerAuthority`, the rule plan step 7's book reads
// too). Anyone else reads BOOKING_HOLD_NOT_FOUND, exactly like a missing id
// or a stranger on the act path (no kind or existence oracle). There is no
// bare keep: `keep` is refused CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE (after
// the owner gate). `release` releases it as above (MANUAL, the line moves
// up, staff told: `requestless_hold.answered`). Booking it is the other
// answer, and that is `bookRequestlessHold` (step 7), not this use case: it
// takes the line in the same step (H8), which needs the event mint. The
// booker's "own" is re-read on the hold row under the line lock (a revoke
// may have kept the hold as the place's since the gate): not own any more
// reads BOOKING_HOLD_NOT_FOUND, and nothing is released.
// ─────────────────────────────────────────────────────────────────────────────

export const answerBookingHoldChallengeInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    holdId: z.uuid(),
    answer: z.enum(["keep", "release"]),
    /**
     * What the act's panel said Keep would do (`keepWill`). When given and
     * the server's answer differs, the keep is refused
     * TERMS_CHANGED_SINCE_VIEWED. REQUIRED for a keep that books (the
     * book_now branch refuses without it — review W1); optional for a keep
     * that asks for terms, and ignored by a release.
     */
    expectedKeepWill: z.enum(["book_now", "ask_for_terms"]).optional(),
  })
  .strict();

/**
 * How a keep landed: `booked` (Keep agreed the terms and booked the night),
 * `awaiting_terms` (recorded; the act agrees the terms the venue sends by
 * the new `respondBy`), `unchanged` (nothing to do — already kept / not
 * challenged). Null for a release.
 */
export const keepOutcomeSchema = z
  .enum(["booked", "awaiting_terms", "unchanged"])
  .nullable();

export const answerBookingHoldChallengeOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    /** The same hold in the ACT projection — what the wire carries. */
    actHold: actBookingHoldOutputSchema,
    keepOutcome: keepOutcomeSchema,
    /**
     * The draft event a booking keep created (the agree's post-commit mint);
     * null otherwise, or when the mint did not land (the night is booked
     * either way and the venue's "Create event" retries).
     */
    eventId: z.uuid().nullable(),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    /** FR-013 notices for a request-less hold's answer (server-side only). */
    requestlessIntents: z.array(requestlessHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/**
 * What transport puts on the wire for the ACT. The internal output above is
 * for the post-commit dispatcher: its `notificationIntents` name OTHER
 * requests' holds (the movers behind a release), `staffRecipientHint` names
 * venue-internal humans, and the staff `hold` projection carries
 * `placedByHumanId` — none of it may reach the act (FR-013). The wire shape
 * is the act's OWN hold in the ACT projection (`actBookingHoldOutputSchema`,
 * the same one the sent-request list uses), how the keep landed and the
 * act's own booked event — nothing else. Build it with
 * {@link toAnswerBookingHoldChallengeWire}.
 */
export const answerBookingHoldChallengeWireOutputSchema = z
  .object({
    hold: actBookingHoldOutputSchema,
    keepOutcome: keepOutcomeSchema,
    eventId: z.uuid().nullable(),
  })
  .strict();

export type AnswerBookingHoldChallengeInput = z.infer<
  typeof answerBookingHoldChallengeInputSchema
>;
export type AnswerBookingHoldChallengeOutput = z.infer<
  typeof answerBookingHoldChallengeOutputSchema
>;
export type AnswerBookingHoldChallengeWireOutput = z.infer<
  typeof answerBookingHoldChallengeWireOutputSchema
>;

/** The internal output → the act's wire shape (a projection, never a spread). */
export function toAnswerBookingHoldChallengeWire(
  output: AnswerBookingHoldChallengeOutput,
): AnswerBookingHoldChallengeWireOutput {
  return answerBookingHoldChallengeWireOutputSchema.parse({
    hold: output.actHold,
    keepOutcome: output.keepOutcome,
    eventId: output.eventId,
  });
}

export type AnswerBookingHoldChallengeDeps = BookingHoldDeps & {
  /** The agree's swallowed failures (its mint) report here. */
  reportError?: ReporterPort;
  /**
   * Keep = commit (FR-014): the ports "Agree & book"
   * (`respondToBookingAgreement`) needs beyond the hold bag. Production
   * always wires them; a keep that must book with none wired is a
   * programmer error, thrown as such.
   */
  agree?: Omit<
    RespondToBookingAgreementDeps,
    "repos" | "clock" | "logger" | "reportError"
  >;
};

type KeepOutcome = z.infer<typeof keepOutcomeSchema>;

export async function answerBookingHoldChallenge(
  deps: AnswerBookingHoldChallengeDeps,
  rawInput: unknown,
): Promise<AnswerBookingHoldChallengeOutput> {
  const input = parseInput(answerBookingHoldChallengeInputSchema, rawInput);
  const now = deps.clock.now();
  // A request-less hold is answered by its owner, not an act.
  const found = await deps.repos.bookingHolds.getById(input.holdId);
  if (found && found.ownerKind !== "REQUEST") {
    return answerRequestlessChallenge(deps, { input, hold: found, now });
  }
  const ctx = await loadActHoldContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
  );
  const key = { calendarId: ctx.hold.calendarId, date: ctx.hold.date };

  const outcome =
    input.answer === "keep"
      ? await keep(deps, { input, ctx, key, now })
      : await release(deps, { input, ctx, key, now });

  deps.logger?.info("booking_holds.challenge_answered", {
    holdId: outcome.hold.id,
    answer: input.answer,
    keepOutcome: outcome.keepOutcome,
    actorHumanId: input.actorHumanId,
  });

  const actView = await resolveActChallengeView(deps.repos, {
    hold: outcome.hold,
    request: ctx.request,
    placeId: ctx.place.id,
    placeTz: ctx.placeTz,
  });
  return answerBookingHoldChallengeOutputSchema.parse({
    hold: toBookingHoldOutput(outcome.hold, now, ctx.placeTz),
    actHold: toActBookingHoldOutput(outcome.hold, now, ctx.placeTz, actView),
    keepOutcome: outcome.keepOutcome,
    eventId: outcome.eventId,
    notificationIntents: outcome.intents,
    requestlessIntents: [],
    staffRecipientHint: ctx.staffRecipientHint,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// request-less: the owner answers (release; book is step 7's)
// ─────────────────────────────────────────────────────────────────────────────

async function answerRequestlessChallenge(
  deps: AnswerBookingHoldChallengeDeps,
  args: {
    input: z.infer<typeof answerBookingHoldChallengeInputSchema>;
    hold: BookerBookingHoldRecord | PlaceBookingHoldRecord;
    now: Date;
  },
): Promise<AnswerBookingHoldChallengeOutput> {
  const { input, hold, now } = args;
  const { repos } = deps;
  const place = await requireRequestlessHoldPlace(repos, hold);
  const owner = await findRequestlessHoldOwnerAuthority(
    repos,
    hold,
    place,
    input.actorHumanId,
    now,
  );
  // Not the owner: the same answer as a missing hold (the act path's rule).
  if (!owner) throw fail("BOOKING_HOLD_NOT_FOUND");
  if (input.answer === "keep") {
    throw fail("CHALLENGE_ANSWER_NEEDS_BOOK_OR_RELEASE", {
      meta: { holdId: hold.id, answers: ["book", "release"] },
    });
  }

  const placeTz = resolveBookingTimezone(place.timezone);
  const key = { calendarId: hold.calendarId, date: hold.date };
  // Staff routing: the staff owner, else the booker's grant giver (a booker
  // is never staff).
  const staffHumanId =
    owner.kind === "staff" ? input.actorHumanId : owner.booker.grant.grantedByHumanId;
  const staffRecipientHint = staffRecipientHintFor({
    hold: { placedByHumanId: staffHumanId },
    request: null,
    place,
    ownership: owner.kind === "staff" ? owner.ownership : null,
  });

  type Outcome = {
    hold: BookingHoldRecord;
    answered: boolean;
    intents: BookingHoldNotificationIntent[];
  };
  // The booker's "own", re-read on a row under the line lock: a revoke that
  // kept the hold as the place's (same lock, status untouched) moved it off
  // the booker, and a status CAS alone would still match. Not own any more →
  // the not-owner answer. So is an actor who stopped acting for the holder
  // since the gate (an org editor demoted, a delegation withdrawn).
  const requireStillOwn = async (tx: TxRepos, row: BookingHoldRecord): Promise<void> => {
    if (owner.kind !== "booker" || hold.ownerKind !== "BOOKER") return;
    if (
      row.ownerKind === "BOOKER" &&
      sameGrantee(row.holder, hold.holder) &&
      (await actorActsForParty(tx, input.actorHumanId, row.holder))
    ) {
      return;
    }
    throw fail("BOOKING_HOLD_NOT_FOUND");
  };
  const outcome = await repos.tx(async (tx): Promise<Outcome> => {
    const { line, intents } = await settleLine(tx, { ...key, now, placeTz });
    const fresh = line.find((h) => h.id === hold.id);
    if (!fresh) {
      const row = await tx.bookingHolds.getById(hold.id);
      if (row) await requireStillOwn(tx, row);
      if (row?.status === "RELEASED") {
        if (row.releasedReason === "EXPIRED") {
          throw fail("BOOKING_HOLD_CHALLENGE_LAPSED", { meta: { holdId: row.id } });
        }
        // Already released: a repeat release is a no-op.
        return { hold: row, answered: false, intents };
      }
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: hold.id } });
    }
    await requireStillOwn(tx, fresh);
    if (fresh.status !== "CHALLENGED") {
      throw fail("BOOKING_HOLD_NOT_CHALLENGED", { meta: { holdId: fresh.id } });
    }
    const released = await releaseHoldCas(tx, fresh, { reason: "MANUAL", now }, ["CHALLENGED"]);
    if (!released) {
      throw fail("BOOKING_HOLD_NOT_CHALLENGED", { meta: { holdId: fresh.id } });
    }
    const { moved } = await renumberLine(tx, key);
    // The movers' thread lines carry a staff owner's id (the place side sees
    // every thread); a booker's never (an act must not learn who else held).
    const moverIntents = await recordMovers(
      tx,
      moved,
      owner.kind === "staff"
        ? { humanId: input.actorHumanId, kind: "staff" }
        : { humanId: input.actorHumanId, kind: "booker" },
      now,
    );
    await tx.audit.log({
      entity: "booking_hold",
      entityId: released.id,
      action: "booking_hold.released",
      data: {
        actorHumanId: input.actorHumanId,
        ownerKind: released.ownerKind,
        reason: "MANUAL",
        by: owner.kind === "staff" ? "staff" : "booker",
        answer: "release",
      },
      at: now,
    });
    return { hold: released, answered: true, intents: [...intents, ...moverIntents] };
  });

  const requestlessIntents: RequestlessHoldNotificationIntent[] = outcome.answered
    ? [
        {
          kind: "requestless_hold.answered",
          audience: "staff",
          holdId: outcome.hold.id,
          placeId: place.id,
          calendarId: outcome.hold.calendarId,
          date: outcome.hold.date,
          reason: "MANUAL",
          by: owner.kind === "staff" ? "staff" : "booker",
          staffHumanId,
        },
      ]
    : [];

  deps.logger?.info("booking_holds.challenge_answered", {
    holdId: outcome.hold.id,
    answer: input.answer,
    ownerKind: hold.ownerKind,
    actorHumanId: input.actorHumanId,
  });

  return answerBookingHoldChallengeOutputSchema.parse({
    hold: toBookingHoldOutput(outcome.hold, now, placeTz),
    actHold: toActBookingHoldOutput(outcome.hold, now, placeTz),
    keepOutcome: null,
    eventId: null,
    notificationIntents: outcome.intents,
    requestlessIntents,
    staffRecipientHint,
  });
}

type AnswerArgs = {
  input: z.infer<typeof answerBookingHoldChallengeInputSchema>;
  ctx: ActHoldContext;
  key: HoldLineKey;
  now: Date;
};

type AnswerOutcome = {
  /** The act's own hold: always a request hold (`loadActHoldContext`). */
  hold: RequestBookingHoldRecord;
  keepOutcome: KeepOutcome;
  eventId: string | null;
  intents: BookingHoldNotificationIntent[];
};

/**
 * A read of the act's own hold id, narrowed: `loadActHoldContext` admitted a
 * REQUEST hold, and a row never changes owner kind, so anything else is an
 * invariant breach (BOOKING_HOLD_NEEDS_REQUEST), never a crash on a missing
 * request id.
 */
function requestHoldOrNull(
  hold: BookingHoldRecord | null | undefined,
): RequestBookingHoldRecord | null {
  return hold ? requireRequestHold(hold) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// keep
// ─────────────────────────────────────────────────────────────────────────────

async function keep(
  deps: AnswerBookingHoldChallengeDeps,
  { input, ctx, key, now }: AnswerArgs,
): Promise<AnswerOutcome> {
  const staff = {
    assigneeHumanId: ctx.request.assigneeHumanId,
    placedByHumanId: ctx.hold.placedByHumanId,
  };

  // One transaction under the line lock: settle, decide, and — when no terms
  // are with the act — record the keep. A booking keep only DECIDES here; the
  // agree runs after, in its own transaction (its locks, its re-checks).
  type Decided =
    | { kind: "done"; hold: RequestBookingHoldRecord; intents: BookingHoldNotificationIntent[] }
    | { kind: "kept"; hold: RequestBookingHoldRecord; intents: BookingHoldNotificationIntent[] }
    | {
        kind: "agree";
        hold: RequestBookingHoldRecord;
        plan: Extract<KeepPlan, { keepWill: "book_now" }>;
        intents: BookingHoldNotificationIntent[];
      };

  const decided: Decided = await deps.repos.tx(async (tx): Promise<Decided> => {
    const { line, intents } = await settleLine(tx, {
      ...key,
      now,
      placeTz: ctx.placeTz,
    });
    // The act's own hold (same id as `ctx.hold`): a request hold.
    const fresh = requestHoldOrNull(line.find((h) => h.id === ctx.hold.id));

    if (!fresh) {
      const row = requestHoldOrNull(await tx.bookingHolds.getById(ctx.hold.id));
      if (row?.status === "RELEASED" && row.releasedReason === "EXPIRED") {
        throw fail("BOOKING_HOLD_CHALLENGE_LAPSED", {
          meta: { holdId: row.id },
        });
      }
      // Already booked (a keep or an agree got there first): nothing to do.
      if (row?.status === "CONFIRMED") {
        return { kind: "done", hold: row, intents };
      }
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
    }
    // Not under challenge: the hold is the act's already.
    if (fresh.status === "ACTIVE") return { kind: "done", hold: fresh, intents };

    // Decided under the line lock, from the act's own terms.
    const plan = await resolveKeepPlan(tx, {
      hold: fresh,
      request: ctx.request,
      placeId: ctx.place.id,
      placeTz: ctx.placeTz,
    });
    if (plan.keepWill === null) {
      // Terms for this night are already agreed (review W3): the venue books
      // it; there is nothing to keep, and terms can never be asked for again.
      // Sender side: no meta.
      throw fail("TERMS_AGREED_FOR_THIS_NIGHT");
    }
    if (
      input.expectedKeepWill !== undefined &&
      input.expectedKeepWill !== plan.keepWill
    ) {
      // Sender side: no meta (booking-holds FR-013).
      throw fail("TERMS_CHANGED_SINCE_VIEWED");
    }
    if (plan.keepWill === "book_now") {
      // Review W1 — fail closed: booking the night needs the act to have SEEN
      // that Keep books it. No `expectedKeepWill` → refused, nothing written
      // (the throw rolls this transaction back, settlement included).
      if (input.expectedKeepWill === undefined) {
        throw fail("TERMS_CHANGED_SINCE_VIEWED");
      }
      return { kind: "agree", hold: fresh, plan, intents };
    }

    // ask_for_terms — at most once per challenge (the ledger says whether).
    if (await isKeptAwaitingTerms(tx, fresh)) {
      return { kind: "done", hold: fresh, intents };
    }
    const floor = now.getTime() + KEEP_AWAITING_TERMS_WINDOW_MS;
    const respondBy = new Date(
      Math.max(fresh.respondBy?.getTime() ?? 0, floor),
    );
    // Never shortens a deadline the venue gave; the CHECK keeps respondBy
    // set exactly while CHALLENGED, which the hold stays.
    const kept =
      fresh.respondBy && fresh.respondBy.getTime() >= respondBy.getTime()
        ? fresh
        : requireRequestHold(
            await casHoldRespondBy(tx, {
              id: fresh.id,
              respondBy,
              expectedStatus: "CHALLENGED",
            }),
          );
    await appendBookingSystemEntry(tx, {
      bookingRequestId: kept.bookingRequestId,
      kind: "booking_hold.kept",
      data: {
        ...keptEntryMatch(fresh),
        respondBy: respondBy.toISOString(),
      },
      actorHumanId: input.actorHumanId,
    });
    await tx.audit.log({
      entity: "booking_hold",
      entityId: kept.id,
      action: "booking_hold.kept",
      data: {
        actorHumanId: input.actorHumanId,
        bookingRequestId: kept.bookingRequestId,
        keepWill: "ask_for_terms",
        previousRespondBy: fresh.respondBy,
        respondBy,
      },
      at: now,
    });
    const owed: BookingHoldNotificationIntent[] = [
      {
        // Review W2: the keeper's own notice carries the ABSOLUTE deadline
        // this keep set — what the act must agree the terms by.
        kind: "hold.kept",
        bookingRequestId: kept.bookingRequestId,
        holdId: kept.id,
        audience: "act",
        date: kept.date,
        position: kept.position,
        respondBy,
        awaitingTerms: true,
      },
      {
        // FR-014: "send terms to keep this night", with the act's deadline.
        kind: "hold.kept",
        bookingRequestId: kept.bookingRequestId,
        holdId: kept.id,
        audience: "staff",
        date: kept.date,
        position: kept.position,
        respondBy,
        awaitingTerms: true,
        staff,
      },
    ];
    // The act right behind the kept hold in the settled line (by order,
    // never by literal index), told the first hold stands. A request-less
    // hold there has no act; who else is told is FR-013's (later step).
    const next = line[line.findIndex((h) => h.id === fresh.id) + 1];
    if (next && next.ownerKind === "REQUEST") {
      owed.push({
        kind: "hold.kept",
        bookingRequestId: next.bookingRequestId,
        holdId: next.id,
        audience: "act",
        date: next.date,
        position: next.position,
      });
    }
    return { kind: "kept", hold: kept, intents: [...intents, ...owed] };
  });

  if (decided.kind === "done") {
    return {
      hold: decided.hold,
      keepOutcome: "unchanged",
      eventId: null,
      intents: decided.intents,
    };
  }
  if (decided.kind === "kept") {
    return {
      hold: decided.hold,
      keepOutcome: "awaiting_terms",
      eventId: null,
      intents: decided.intents,
    };
  }
  return keepByAgreeing(deps, {
    input,
    ctx,
    key,
    plan: decided.plan,
    settleIntents: decided.intents,
  });
}

/**
 * Keep = "Agree & book" (FR-001), through the one respond path. Runs as the
 * act (the sender) — the agree's own gate (`requireAgreementActSide`) holds.
 */
async function keepByAgreeing(
  deps: AnswerBookingHoldChallengeDeps,
  args: {
    input: AnswerArgs["input"];
    ctx: ActHoldContext;
    key: HoldLineKey;
    plan: Extract<KeepPlan, { keepWill: "book_now" }>;
    settleIntents: BookingHoldNotificationIntent[];
  },
): Promise<AnswerOutcome> {
  const { input, ctx, key, plan, settleIntents } = args;
  if (!deps.agree) {
    throw new Error("answer_booking_hold_challenge_agree_deps_missing");
  }
  let agreed;
  try {
    agreed = await respondToBookingAgreement(
      {
        ...deps.agree,
        repos: deps.repos,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        actorHumanId: input.actorHumanId,
        agreementId: plan.agreement.id,
        action: "accept",
        // The terms Keep was decided on; moved since → refused, never agreed.
        expectedProposedDate: plan.agreement.proposedDate,
      },
    );
  } catch (error) {
    // The agree wrote nothing (every refusal is before its commit). If the
    // night is nonetheless this request's now, a concurrent agree of the
    // same terms booked it: Keep's goal is met. A DELIBERATE SWALLOW (house
    // ReporterPort convention): logged and reported, guarded so a throwing
    // reporter never changes the outcome.
    const booked = await bookedHoldOnLine(deps.repos, ctx.request.id, key);
    if (!booked) {
      // The decide transaction COMMITTED its settlement (lapses on this line
      // it released, the movers it renumbered): those notices are owed even
      // though the keep is refused — carried on the error for the transport
      // to dispatch before mapping it (the committed-intents carrier).
      throw withCommittedHoldIntents(error, {
        notificationIntents: settleIntents,
        staffRecipientHint: ctx.staffRecipientHint,
        bookingRequestId: ctx.request.id,
      });
    }
    deps.logger?.info("booking_holds.keep_agree_raced_booked", {
      holdId: ctx.hold.id,
      bookingRequestId: ctx.request.id,
      agreementId: plan.agreement.id,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "answerBookingHoldChallenge", step: "keep_agree_raced_booked" },
        extra: {
          holdId: ctx.hold.id,
          bookingRequestId: ctx.request.id,
          agreementId: plan.agreement.id,
        },
      });
    } catch {
      // Reporting is best-effort — never let it change the outcome.
    }
    return {
      hold: booked,
      keepOutcome: "booked",
      eventId: null,
      intents: settleIntents,
    };
  }

  const booked =
    (await bookedHoldOnLine(deps.repos, ctx.request.id, key)) ??
    // The agree committed the CONFIRMED hold; a missing read is a race with
    // Cancel booking after the commit — report the row as it was.
    requestHoldOrNull(await deps.repos.bookingHolds.getById(ctx.hold.id)) ??
    ctx.hold;
  return {
    hold: booked,
    keepOutcome: "booked",
    eventId: agreed.eventId,
    intents: [...settleIntents, ...agreed.notificationIntents],
  };
}

/** This request's CONFIRMED hold on `key`, or null. */
async function bookedHoldOnLine(
  repos: Pick<Repos, "bookingHolds">,
  bookingRequestId: string,
  key: HoldLineKey,
): Promise<RequestBookingHoldRecord | null> {
  return (
    (await repos.bookingHolds.listForRequest(bookingRequestId)).find(
      (h) => h.status === "CONFIRMED" && lineKeyOf(h) === lineKeyOf(key),
    ) ?? null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// release
// ─────────────────────────────────────────────────────────────────────────────

async function release(
  deps: AnswerBookingHoldChallengeDeps,
  { input, ctx, key, now }: AnswerArgs,
): Promise<AnswerOutcome> {
  const staff = {
    assigneeHumanId: ctx.request.assigneeHumanId,
    placedByHumanId: ctx.hold.placedByHumanId,
  };
  return deps.repos.tx(async (tx): Promise<AnswerOutcome> => {
    const { line, intents } = await settleLine(tx, {
      ...key,
      now,
      placeTz: ctx.placeTz,
    });
    const fresh = requestHoldOrNull(line.find((h) => h.id === ctx.hold.id));

    if (!fresh) {
      const row = requestHoldOrNull(await tx.bookingHolds.getById(ctx.hold.id));
      if (row?.status === "RELEASED") {
        if (row.releasedReason === "EXPIRED") {
          throw fail("BOOKING_HOLD_CHALLENGE_LAPSED", {
            meta: { holdId: row.id },
          });
        }
        // Already released (manual or otherwise) — a repeat "release" is a
        // no-op.
        return { hold: row, keepOutcome: null, eventId: null, intents };
      }
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
    }

    if (fresh.status !== "CHALLENGED") {
      throw fail("BOOKING_HOLD_NOT_CHALLENGED", { meta: { holdId: fresh.id } });
    }
    const released = requestHoldOrNull(
      await releaseHoldCas(tx, fresh, { reason: "MANUAL", now }, ["CHALLENGED"]),
    );
    if (!released) {
      throw fail("BOOKING_HOLD_NOT_CHALLENGED", { meta: { holdId: fresh.id } });
    }
    await appendBookingSystemEntry(tx, {
      bookingRequestId: released.bookingRequestId,
      kind: "booking_hold.released",
      data: { holdId: released.id, reason: "MANUAL", by: "act" },
      actorHumanId: input.actorHumanId,
    });
    const { moved } = await renumberLine(tx, key);
    // ACT actor: the movers are OTHER acts' requests — their
    // `booking_hold.reordered` entries carry no author (FR-013: an act never
    // learns who else is in line, not even by name on a ledger line). A
    // mover reaching 1st with terms ready gets the venue-only "Send terms"
    // cue there too (N20, `recordMovers`).
    const moverIntents = await recordMovers(
      tx,
      moved,
      { humanId: input.actorHumanId, kind: "act", ownRequestId: ctx.request.id },
      now,
    );
    await tx.audit.log({
      entity: "booking_hold",
      entityId: released.id,
      action: "booking_hold.released",
      data: {
        actorHumanId: input.actorHumanId,
        bookingRequestId: released.bookingRequestId,
        reason: "MANUAL",
        by: "act",
      },
      at: now,
    });
    return {
      hold: released,
      keepOutcome: null,
      eventId: null,
      intents: [
        ...intents,
        {
          kind: "hold.released",
          bookingRequestId: released.bookingRequestId,
          holdId: released.id,
          audience: "staff",
          date: released.date,
          reason: "MANUAL",
          staff,
        },
        ...moverIntents,
      ],
    };
  });
}
