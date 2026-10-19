import { z } from "zod";

import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import type { ToVenueBookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail, isAppError } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { requireAgreementParty } from "../booking-agreements/_shared/agreement-access";
import { requireAgreementTermsEditor } from "../booking-agreements/_shared/agreement-editor-side";
import type { NotifyFn } from "../booking-agreements/_shared/notify-party";
import { sendBookingTerms } from "../booking-agreements/send-booking-terms";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import {
  findPlaceBookerGrant,
  findPlaceBookingAuthority,
  requirePlaceBookingAuthority,
  type PlaceBookerAuthorityResult,
  type PlaceBookingAuthorityResult,
} from "../booking-requests/_shared/place-access";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "./_shared/booking-hold-intents";
import { sameGrantee } from "../place-booking-grants/_shared/grant-context";
import { bookerGrantStillCoversUnderLock } from "./_shared/booker-grant-lock";
import {
  bookerBookingHoldOutputSchema,
  bookerForeignHoldOutputSchema,
  bookingHoldOutputSchema,
  failInvalidField,
  holdActorViewSchema,
  requireHold,
  requireHoldCalendarAtPlace,
  requirePlace,
  requireRequest,
  requireRequestlessHoldPlace,
  requireToVenueRequest,
  staffRecipientHintFor,
  toBookerBookingHoldOutput,
  toBookerForeignHoldOutput,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import {
  requestlessHoldNotificationIntentSchema,
  type RequestlessHoldNotificationIntent,
} from "./_shared/requestless-hold-intents";
import { casHoldStatus, type HoldLineKey } from "./_shared/hold-line";
import { resolveKeepPlan, type KeepWill } from "./_shared/keep-will";
import {
  areTermsAgreedForNight,
  findReadyBehind,
} from "./_shared/night-readiness";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// challengeBookingHold (FR-004): challenge the POSITION-1 hold. Only one open
// challenge per line; respondBy = now + 24h by default, an explicit override
// must be at least an hour out. Notifies the challenged act (position 1,
// keep/release), the act at position 2 ("you'll hear by …") and the
// request's assignee.
//
// WHO (holds-without-a-request FR-006, H12; plan item i): anyone with
// booking authority on the hold's calendar — the STAFF gate (owner /
// edit-role member) OR the BOOKER gate (an active grant covering the
// calendar). Staff are tried first. A refusal is the staff gate's own code,
// so a stranger learns nothing about the hold's kind. Extend stays staff-only.
// The booker arm is re-read on the grant row under FOR SHARE in the
// transaction, before the line lock (trap m; lock order place → grant →
// line): a revoke that committed since the gate refuses the challenge with
// the gate's code.
//
// THE DEADLINE IS THE PLACE'S (H13): a booker's challenge always runs the
// 24h default; a `respondBy` from a booker is refused (respond_by_staff_only),
// so a booker can neither shorten another party's night to an hour nor
// freeze the line for years. Staff may set it between 1 hour and 30 days
// out. "Also send terms" is staff's too (send_terms_staff_only).
//
// THE REPLY BY WHO ACTED (H17): staff get the staff view of the challenged
// hold; a booker gets the booker view of its own hold (no request id, no
// staff id) and, of another party's hold (the usual case: it challenges the
// 1st hold from behind), only id, calendar, date, position, status and
// deadline (built by `toChallengeBookingHoldWire` from `viewer` and
// `viewerIsHolder`). A refusal's meta carries no other party's agreement id,
// line position, or request and place ids.
//
// ANY OWNER KIND at 1st (FR-006): a REQUEST hold as below (its act answers
// per N19); a BOOKER or PLACE hold is answered by its owner by booking it or
// releasing it (H13). Notices for a request-less hold (FR-013): the owner
// (the booker; for a PLACE hold, staff) email + in-app, staff in-app, and a
// named party in-app — `requestlessIntents`. "Also send terms" is a request
// hold's terms, so it is refused (BOOKING_HOLD_NEEDS_REQUEST) on any other
// kind, after the gate; for a request hold it keeps its own gate (the terms
// editor), which a booker never passes.
//
// NEEDS A READY ACT (booking-the-night N20 / FR-015): refused NO_ACT_READY
// unless a live hold BEHIND the 1st hold on the line is ready to book the
// night (`findReadyBehind` — the one readiness rule, shared with the
// thread strip's `lineHeads` and with holds-without-a-request). Checked
// under the line lock, after the line is settled: a ready hold released in a
// racing transaction is either gone from the read or still live.
//
// TERMS ALREADY AGREED (review W3): when the 1st hold's own terms for the
// night are ACCEPTED, the challenge is refused TERMS_AGREED_FOR_THIS_NIGHT —
// the venue books the night with Create event instead.
//
// The challenged act never learns WHO is ready: its notice says "another act
// is ready to book" and what Keep will do (`keepWill`, N19 / FR-014).
//
// "ALSO SEND TERMS TO THE 1ST HOLD" (`sendTermsToFirstHold`, N20's dialog
// step): SEQUENTIAL, challenge first, then the existing "Send terms"
// (`sendBookingTerms`) for the 1st hold's night. Not one transaction: the
// send composes the header update and the send-for-review, each its own
// transaction with its own gates and post-commit pings, and folding them in
// would mean re-plumbing both. The order is the failure story:
//   - everything that can be decided up front is, BEFORE the challenge: the
//     1st hold's request has terms, they are DRAFT (or already PROPOSED for
//     that night — nothing to send), and the actor is their terms editor.
//     A refusal there writes nothing;
//   - the challenge commits; then the send runs. If the send fails, the
//     challenge STANDS (the venue's main action), the output says
//     `termsToFirstHold.status: "failed"` with the code, and the failure is
//     logged + reported (a deliberate swallow, ReporterPort). The act's
//     notice then says Keep will ask for terms, and the venue's "Send terms"
//     is the retry — sending terms to the act at 1st hold is always allowed.
//   Sending first instead would leave terms sent with no challenge whenever
//   the challenge lost a race (NO_ACT_READY, a challenge already open).
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CHALLENGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MIN_CHALLENGE_WINDOW_MS = 60 * 60 * 1000;
/** H13: the latest deadline staff may set on a challenge. */
export const MAX_CHALLENGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const challengeBookingHoldInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    holdId: z.uuid(),
    /**
     * Optional override of the keep-or-release deadline, staff only (H13):
     * between now + 1h and now + 30 days.
     */
    respondBy: z.coerce.date().optional(),
    /**
     * N20: also send the 1st hold's DRAFT terms for this night, in the same
     * call (see the module doc for the order and the failure story).
     */
    sendTermsToFirstHold: z.boolean().optional(),
  })
  .strict();

/**
 * What happened to "Also send terms" — VENUE side (it is the venue's own
 * action on the 1st hold's request).
 *   not_requested — the dialog step was not taken;
 *   sent          — the terms went to the act at 1st hold;
 *   already_sent  — they were already PROPOSED for this night;
 *   failed        — the challenge stands, the send did not land (`errorCode`).
 */
export const challengeTermsToFirstHoldSchema = z
  .object({
    status: z.enum(["not_requested", "sent", "already_sent", "failed"]),
    errorCode: z.string().max(100).nullable(),
  })
  .strict();

export const challengeBookingHoldOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    termsToFirstHold: challengeTermsToFirstHoldSchema,
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    /** FR-013 notices for a request-less challenged hold (server-side only). */
    requestlessIntents: z.array(requestlessHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
    /** Who challenged: shapes the wire reply (H17). Server-side only. */
    viewer: holdActorViewSchema,
    /** A booker challenged its OWN hold (else another party's). Server-side only. */
    viewerIsHolder: z.boolean(),
  })
  .strict();

/**
 * What transport puts on the wire: the intents, routing hint and viewer stay
 * server-side. `hold` is the staff view for staff, the booker view for a
 * booker's own hold, and the foreign view (`bookerForeignHoldOutputSchema`)
 * for another party's. Build it with {@link toChallengeBookingHoldWire}.
 */
export const challengeBookingHoldWireOutputSchema = z
  .object({
    hold: z.union([
      bookingHoldOutputSchema,
      bookerBookingHoldOutputSchema,
      bookerForeignHoldOutputSchema,
    ]),
    termsToFirstHold: challengeTermsToFirstHoldSchema,
  })
  .strict();

export type ChallengeBookingHoldInput = z.infer<
  typeof challengeBookingHoldInputSchema
>;
export type ChallengeBookingHoldOutput = z.infer<
  typeof challengeBookingHoldOutputSchema
>;
export type ChallengeBookingHoldWireOutput = z.infer<
  typeof challengeBookingHoldWireOutputSchema
>;
export type ChallengeBookingHoldDeps = BookingHoldDeps & {
  /** "Also send terms": the send's in-app ping to the act (best-effort). */
  notify?: NotifyFn;
  /** A failed "Also send terms" after the challenge committed is reported here. */
  reportError?: ReporterPort;
};

type TermsToFirstHold = z.infer<typeof challengeTermsToFirstHoldSchema>;

/** The internal output → the wire shape for whoever challenged (never a spread). */
export function toChallengeBookingHoldWire(
  output: ChallengeBookingHoldOutput,
): ChallengeBookingHoldWireOutput {
  return challengeBookingHoldWireOutputSchema.parse({
    hold:
      output.viewer === "staff"
        ? output.hold
        : output.viewerIsHolder
          ? toBookerBookingHoldOutput(output.hold)
          : toBookerForeignHoldOutput(output.hold),
    termsToFirstHold: output.termsToFirstHold,
  });
}

/** The up-front decision for "Also send terms". */
type TermsPlan =
  | { kind: "not_requested" }
  | { kind: "already_sent" }
  | { kind: "send"; agreementId: string };

export async function challengeBookingHold(
  deps: ChallengeBookingHoldDeps,
  rawInput: unknown,
): Promise<ChallengeBookingHoldOutput> {
  const input = parseInput(challengeBookingHoldInputSchema, rawInput);
  const now = deps.clock.now();
  const ctx = await loadChallengeContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
    now,
  );

  // H13: the deadline and "also send terms" are the place's.
  if (ctx.challenger.kind === "booker") {
    if (input.respondBy !== undefined) {
      failInvalidField("respondBy", "respond_by_staff_only");
    }
    if (input.sendTermsToFirstHold) {
      failInvalidField("sendTermsToFirstHold", "send_terms_staff_only");
    }
  }
  const respondBy =
    input.respondBy ?? new Date(now.getTime() + DEFAULT_CHALLENGE_WINDOW_MS);
  if (respondBy.getTime() < now.getTime() + MIN_CHALLENGE_WINDOW_MS) {
    failInvalidField("respondBy", "respond_by_too_soon");
  }
  if (respondBy.getTime() > now.getTime() + MAX_CHALLENGE_WINDOW_MS) {
    failInvalidField("respondBy", "respond_by_too_late");
  }

  const key = { calendarId: ctx.hold.calendarId, date: ctx.hold.date };

  // "Also send terms": every up-front refusal BEFORE the challenge writes.
  // It sends the 1st hold's REQUEST terms: no request, nothing to send.
  if (input.sendTermsToFirstHold && ctx.request === null) {
    throw fail("BOOKING_HOLD_NEEDS_REQUEST", {
      meta: { holdId: ctx.hold.id, ownerKind: ctx.hold.ownerKind },
    });
  }
  const termsPlan: TermsPlan =
    input.sendTermsToFirstHold && ctx.request !== null && ctx.hold.ownerKind === "REQUEST"
      ? await precheckSendTermsToFirstHold(
          deps,
          { request: ctx.request, hold: ctx.hold, place: ctx.place, placeTz: ctx.placeTz },
          input.actorHumanId,
        )
      : { kind: "not_requested" };

  const challenger = ctx.challenger;
  const outcome = await deps.repos.tx(async (tx) => {
    if (challenger.kind === "booker") {
      // Trap m: the booker's grant row FOR SHARE, re-checked before the
      // line lock. Ended since the gate → the gate's own refusal.
      const still = await bookerGrantStillCoversUnderLock(tx, {
        grantId: challenger.booker.grant.id,
        placeId: ctx.place.id,
        calendarId: ctx.hold.calendarId,
        holder: challenger.booker.holder,
        actorHumanId: input.actorHumanId,
        now,
      });
      if (!still) throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
    }
    return challengeLineHeadInTx(tx, {
      holdId: ctx.hold.id,
      key,
      now,
      placeTz: ctx.placeTz,
      respondBy,
      actorHumanId: input.actorHumanId,
      assigneeHumanId: ctx.request?.assigneeHumanId ?? null,
      challenger: challenger.kind === "staff"
        ? { kind: "staff" }
        : { kind: "booker", grantId: challenger.booker.grant.id, holder: challenger.booker.holder },
    });
  });

  // After commit: "Also send terms" (the challenge stands whatever happens).
  const challengedHold = outcome.hold;
  // A send plan exists only for a REQUEST hold (refused above otherwise),
  // and a CAS never changes the owner kind.
  const termsToFirstHold: TermsToFirstHold =
    termsPlan.kind !== "send"
      ? { status: termsPlan.kind, errorCode: null }
      : challengedHold.ownerKind !== "REQUEST"
        ? { status: "not_requested", errorCode: null }
        : await sendTermsAfterChallenge(deps, {
          agreementId: termsPlan.agreementId,
          actorHumanId: input.actorHumanId,
          night: challengedHold.date,
          holdId: challengedHold.id,
          bookingRequestId: challengedHold.bookingRequestId,
        });

  // What Keep will do, as the notice must say it (N19 / FR-014) — read AFTER
  // the send, so the copy matches the terms the act will actually find.
  // (Null — terms already agreed — cannot follow a challenge, which refuses
  // that case; the notice then simply carries no keepWill.) A request-less
  // hold has no Keep (H13).
  const keepWill: KeepWill | null =
    challengedHold.ownerKind === "REQUEST" && ctx.request !== null
      ? (
          await resolveKeepPlan(deps.repos, {
            hold: challengedHold,
            request: ctx.request,
            placeId: ctx.place.id,
            placeTz: ctx.placeTz,
          })
        ).keepWill
      : null;
  const intents = outcome.intents.map((intent) =>
    keepWill !== null &&
    intent.kind === "hold.challenged" &&
    intent.audience === "act" &&
    intent.holdId === outcome.hold.id
      ? { ...intent, keepWill }
      : intent,
  );

  deps.logger?.info("booking_holds.challenged", {
    holdId: outcome.hold.id,
    respondBy: respondBy.toISOString(),
    actorHumanId: input.actorHumanId,
    challenger: ctx.challenger.kind,
    termsToFirstHold: termsToFirstHold.status,
    keepWill,
  });

  return challengeBookingHoldOutputSchema.parse({
    hold: toBookingHoldOutput(outcome.hold, now, ctx.placeTz),
    termsToFirstHold,
    notificationIntents: intents,
    requestlessIntents: requestlessChallengeIntents(outcome.hold, {
      placeId: ctx.place.id,
      respondBy,
      staffHint: ctx.staffRecipientHint,
    }),
    staffRecipientHint: ctx.staffRecipientHint,
    viewer: ctx.challenger.kind,
    viewerIsHolder:
      ctx.challenger.kind === "booker" &&
      outcome.hold.ownerKind === "BOOKER" &&
      sameGrantee(outcome.hold.holder, ctx.challenger.booker.holder),
  });
}

/** Who is challenging: place staff, or a booker under its grant (FR-006). */
type Challenger =
  | { kind: "staff"; ownership: PlaceBookingAuthorityResult }
  | { kind: "booker"; booker: PlaceBookerAuthorityResult };

type ChallengeContext = {
  hold: BookingHoldRecord;
  /** The hold's request; null for a request-less hold. */
  request: ToVenueBookingRequestRecord | null;
  place: PlaceRecord;
  placeTz: string;
  challenger: Challenger;
  staffRecipientHint: BookingHoldStaffRecipientHint;
};

/**
 * Load the hold and its place (through the request, or the calendar for a
 * request-less hold), then the widened gate: staff first, else a booker
 * whose active grant covers the hold's calendar. Neither → the staff gate's
 * own refusal (INSUFFICIENT_ROLE / NOT_RESOURCE_OWNER).
 */
async function loadChallengeContext(
  repos: Repos,
  holdId: string,
  actorHumanId: string,
  now: Date,
): Promise<ChallengeContext> {
  const hold = await requireHold(repos, holdId);
  let request: ToVenueBookingRequestRecord | null = null;
  let place: PlaceRecord;
  if (hold.ownerKind === "REQUEST") {
    request = requireToVenueRequest(await requireRequest(repos, hold.bookingRequestId));
    place = await requirePlace(repos, request.placeId);
  } else {
    place = await requireRequestlessHoldPlace(repos, hold);
  }

  const ownership = await findPlaceBookingAuthority(repos, place, actorHumanId);
  let challenger: Challenger;
  if (ownership) {
    challenger = { kind: "staff", ownership };
  } else {
    const booker = await findPlaceBookerGrant(repos, place, actorHumanId, {
      calendarId: hold.calendarId,
      now,
    });
    if (!booker) {
      // Throws the staff gate's code: the same refusal as before FR-006.
      await requirePlaceBookingAuthority(repos, place, actorHumanId);
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
    }
    challenger = { kind: "booker", booker };
  }
  if (request) {
    await requireHoldCalendarAtPlace(repos, hold, request, {
      bareRefusal: challenger.kind === "booker",
    });
  }

  return {
    hold,
    request,
    place,
    placeTz: resolveBookingTimezone(place.timezone),
    challenger,
    staffRecipientHint: staffRecipientHintFor({
      // A request hold's placer is staff. A request-less hold's may not be
      // (a booker's; a place hold kept on a revoke): route to the staff
      // challenger, else the challenging booker's grant giver.
      hold:
        hold.ownerKind === "REQUEST"
          ? hold
          : {
              placedByHumanId:
                challenger.kind === "staff"
                  ? actorHumanId
                  : challenger.booker.grant.grantedByHumanId,
            },
      request,
      place,
      ownership: challenger.kind === "staff" ? challenger.ownership : null,
    }),
  };
}

/**
 * FR-013 "hold challenged" for a request-less hold: the owner (the booker,
 * email + in-app; for a PLACE hold the owner is the place, so staff), staff
 * in-app, and the party a PLACE hold names, in-app. One staff intent either
 * way; the transport picks the channels per audience.
 */
function requestlessChallengeIntents(
  hold: BookingHoldRecord,
  args: { placeId: string; respondBy: Date; staffHint: BookingHoldStaffRecipientHint },
): RequestlessHoldNotificationIntent[] {
  if (hold.ownerKind === "REQUEST") return [];
  const base = {
    kind: "requestless_hold.challenged" as const,
    holdId: hold.id,
    placeId: args.placeId,
    calendarId: hold.calendarId,
    date: hold.date,
    position: hold.position,
    respondBy: args.respondBy,
  };
  // Staff routing: the hint's staff member (the staff challenger, or the
  // challenging booker's grant giver; see `loadChallengeContext`).
  const staffHumanId = args.staffHint.placedByHumanId;
  const intents: RequestlessHoldNotificationIntent[] = [
    { ...base, audience: "staff", staffHumanId },
  ];
  if (hold.ownerKind === "BOOKER") {
    intents.push({ ...base, audience: "booker", party: hold.holder, staffHumanId: null });
  } else if (hold.holder) {
    intents.push({ ...base, audience: "named_party", party: hold.holder, staffHumanId: null });
  }
  return intents;
}

/**
 * The challenge's transaction body (exported so the real-Postgres suite can
 * race it against a release under the real line lock — the same posture as
 * `takeNightForTermsInTx`). Settles the line under its lock, refuses a hold
 * that is not live / not first / on a line with a challenge open, refuses
 * NO_ACT_READY when nobody behind is ready to book the night, then CAS →
 * CHALLENGED with the ledger, the audit row and the notices owed.
 */
export async function challengeLineHeadInTx(
  tx: TxRepos,
  args: {
    holdId: string;
    key: HoldLineKey;
    now: Date;
    placeTz: string;
    respondBy: Date;
    actorHumanId: string;
    assigneeHumanId: string | null;
    /** Recorded on the audit row (FR-013's challenger notice reads it later). Default: staff. */
    challenger?:
      | { kind: "staff" }
      | { kind: "booker"; grantId: string; holder: { kind: "org"; orgId: string } | { kind: "person"; humanId: string } };
  },
): Promise<{
  hold: BookingHoldRecord;
  intents: BookingHoldNotificationIntent[];
}> {
  const { key, now, respondBy } = args;
  // H17: a booker's refusal names no other party's agreement or position.
  const byBooker = args.challenger?.kind === "booker";
  const { line, intents } = await settleLine(tx, {
    ...key,
    now,
    placeTz: args.placeTz,
  });

  const fresh = line.find((h) => h.id === args.holdId);
  if (!fresh) {
    throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: args.holdId } });
  }
  // One open challenge per line — including "this very hold is already
  // under challenge".
  if (line.some((h) => h.status === "CHALLENGED")) {
    throw fail("BOOKING_HOLD_CHALLENGE_OPEN", {
      meta: {
        holdId: args.holdId,
        calendarId: key.calendarId,
        date: key.date,
      },
    });
  }
  if (line[0]!.id !== fresh.id) {
    throw fail("BOOKING_HOLD_NOT_FIRST", {
      meta: byBooker
        ? { holdId: fresh.id }
        : { holdId: fresh.id, position: fresh.position },
    });
  }
  // The line with each hold's terms, under the line lock `settleLine` took,
  // after the settle — what both checks below read.
  const withTerms = await tx.bookingHolds.listLineWithTerms(key);
  // Review W3: the 1st hold's own terms for this night are already AGREED —
  // the venue books it (Create event); a challenge would only ask the act
  // to keep a night it has agreed, for terms that can never be sent again.
  // (A request-less hold has no terms: `terms` is null on its row.)
  const target = withTerms.find((h) => h.id === fresh.id);
  if (target && areTermsAgreedForNight(target.terms, key.date, args.placeTz)) {
    throw fail("TERMS_AGREED_FOR_THIS_NIGHT", {
      meta: byBooker
        ? { holdId: fresh.id, date: key.date }
        : {
            holdId: fresh.id,
            agreementId: target.terms!.agreementId,
            date: key.date,
          },
    });
  }
  // N20 / FR-015: someone behind must be ready to book this night. Venue
  // side: the meta names the 1st hold and its line, never the other acts.
  const ready = findReadyBehind({
    line: withTerms,
    target: fresh,
    now,
    placeTz: args.placeTz,
  });
  if (!ready) {
    throw fail("NO_ACT_READY", {
      meta: {
        holdId: fresh.id,
        calendarId: key.calendarId,
        date: key.date,
      },
    });
  }

  // Same row as `fresh` (a CAS never changes the owner kind).
  const challenged = await casHoldStatus(tx, {
    id: fresh.id,
    status: "CHALLENGED",
    expectedFrom: ["ACTIVE"],
    challengedAt: now,
    respondBy,
  });
  const bookingRequestId =
    challenged.ownerKind === "REQUEST" ? challenged.bookingRequestId : null;

  // A request-less hold has no thread (H20): the audit row is its history.
  if (bookingRequestId !== null) {
    await appendBookingSystemEntry(tx, {
      bookingRequestId,
      kind: "booking_hold.challenged",
      data: { holdId: challenged.id, respondBy: respondBy.toISOString() },
      // A booker is stamped on no request's thread (H17), as moverActorHumanId rules.
      actorHumanId: byBooker ? null : args.actorHumanId,
    });
  }

  await tx.audit.log({
    entity: "booking_hold",
    entityId: challenged.id,
    action: "booking_hold.challenged",
    data: {
      actorHumanId: args.actorHumanId,
      ownerKind: challenged.ownerKind,
      bookingRequestId,
      calendarId: key.calendarId,
      date: key.date,
      respondBy,
      challenger: args.challenger ?? { kind: "staff" },
    },
    at: now,
  });

  const staff = {
    assigneeHumanId: args.assigneeHumanId,
    placedByHumanId: challenged.placedByHumanId,
  };
  // Positions come off the settled rows, never a literal: the line was
  // renumbered from one ordered read above and the rows are the truth.
  // A request-less challenged hold's own notices are `requestlessIntents`
  // (the caller's); the act behind it still hears below.
  const owed: BookingHoldNotificationIntent[] =
    bookingRequestId === null
      ? []
      : [
          {
            kind: "hold.challenged",
            bookingRequestId,
            holdId: challenged.id,
            audience: "act",
            date: challenged.date,
            position: challenged.position,
            respondBy,
          },
          {
            kind: "hold.challenged",
            bookingRequestId,
            holdId: challenged.id,
            audience: "staff",
            date: challenged.date,
            position: challenged.position,
            respondBy,
            staff,
          },
        ];
  // The act right behind the challenged hold, by line order. A request-less
  // hold there has no act; who else is told is FR-013's (later step).
  const next = line[line.findIndex((h) => h.id === fresh.id) + 1];
  if (next && next.ownerKind === "REQUEST") {
    owed.push({
      kind: "hold.challenged",
      bookingRequestId: next.bookingRequestId,
      holdId: next.id,
      audience: "act",
      date: next.date,
      position: next.position,
      respondBy,
    });
  }

  return { hold: challenged, intents: [...intents, ...owed] };
}

/**
 * "Also send terms", up front (read-only): the 1st hold's request has terms;
 * the actor is their terms editor (the send's own gate, applied first so a
 * challenger who may not edit terms is refused before anything is written); and they are DRAFT. Terms already PROPOSED for this
 * night need no send. Anything else refuses the whole call.
 */
async function precheckSendTermsToFirstHold(
  deps: ChallengeBookingHoldDeps,
  ctx: {
    request: ToVenueBookingRequestRecord;
    hold: RequestBookingHoldRecord;
    place: PlaceRecord;
    placeTz: string;
  },
  actorHumanId: string,
): Promise<TermsPlan> {
  const agreementId = ctx.request.agreementId;
  const agreement = agreementId
    ? await deps.repos.agreements.getById(agreementId)
    : null;
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND", {
      meta: {
        bookingRequestId: ctx.request.id,
        reason: "first_hold_has_no_terms",
      },
    });
  }
  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);
  const plan = await resolveKeepPlan(deps.repos, {
    hold: ctx.hold,
    request: ctx.request,
    placeId: ctx.place.id,
    placeTz: ctx.placeTz,
  });
  // Already sent for this night: Keep will agree them; nothing to send.
  // Agreed already (review W3): book it, don't challenge — refused before
  // anything is written (the transaction re-checks this under the lock).
  if (plan.keepWill === null) {
    throw fail("TERMS_AGREED_FOR_THIS_NIGHT", {
      meta: { holdId: ctx.hold.id, agreementId: agreement.id, date: ctx.hold.date },
    });
  }
  if (plan.keepWill === "book_now") return { kind: "already_sent" };
  if (agreement.status !== "DRAFT") {
    throw fail("AGREEMENT_NOT_DRAFT", {
      meta: { agreementId: agreement.id, status: agreement.status },
    });
  }
  return { kind: "send", agreementId: agreement.id };
}

/**
 * The send, after the challenge committed. A failure here is a DELIBERATE
 * SWALLOW (the challenge stands; see the module doc): logged at error AND
 * reported, guarded so a throwing reporter never changes the outcome.
 */
async function sendTermsAfterChallenge(
  deps: ChallengeBookingHoldDeps,
  args: {
    agreementId: string;
    actorHumanId: string;
    night: string;
    holdId: string;
    bookingRequestId: string;
  },
): Promise<TermsToFirstHold> {
  try {
    await sendBookingTerms(
      {
        repos: deps.repos,
        clock: deps.clock,
        logger: deps.logger,
        notify: deps.notify,
        reportError: deps.reportError,
      },
      {
        actorHumanId: args.actorHumanId,
        agreementId: args.agreementId,
        night: args.night,
      },
    );
    return { status: "sent", errorCode: null };
  } catch (error) {
    const errorCode = isAppError(error)
      ? error.code
      : typeof error === "object" &&
          error !== null &&
          typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code: string }).code.slice(0, 100))
        : "unknown";
    deps.logger?.error("booking_holds.challenge_send_terms_failed", {
      holdId: args.holdId,
      bookingRequestId: args.bookingRequestId,
      agreementId: args.agreementId,
      errorCode,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "challengeBookingHold", step: "send_terms_to_first_hold" },
        extra: {
          holdId: args.holdId,
          bookingRequestId: args.bookingRequestId,
          agreementId: args.agreementId,
          errorCode,
        },
      });
    } catch {
      // Reporting is best-effort — never let it change the outcome.
    }
    return { status: "failed", errorCode };
  }
}
