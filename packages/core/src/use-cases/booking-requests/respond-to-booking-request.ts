import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingRequestRecord,
  ToPerformerBookingRequestRecord,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
  OPEN_BOOKING_REQUEST_STATUSES,
} from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { CLAIM_TOKEN_TTL_DAYS, DAY_MS } from "./constants";
import { bookingRequestStatusSchema } from "./list-booking-requests";
import { fail, isAppError } from "@th/errors";
import { createOrganizerAcceptAgreement } from "./_shared/accept-agreement";
import {
  acceptBookingRequestInTx,
  assertRespondable,
  deriveCounterparty,
  requireRespondableInTx,
} from "./_shared/accept-in-tx";
import { releaseHoldsForClosedRequest } from "../booking-holds/_shared/release-for-request";
import {
  assertNoBookedNightAfterReleaseInTx,
  assertNoBookedNightInTx,
} from "./_shared/accepted-request-exit";
import { bookingHoldNotificationIntentSchema } from "../booking-holds/_shared/booking-hold-intents";
import {
  DEFAULT_BOOKING_TIMEZONE,
  resolveBookingTimezone,
  resolveCalendarDefaultStartTime,
} from "../booking-agreements/_shared/pitch-seed";
import { resolvePerformerActName } from "./_shared/act-name";
import {
  fireBookingRequestResponded,
  type NotifyBookingRequestRespondedFn,
} from "./notify-booking-request-responded";
import {
  fireBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedFn,
} from "./notify-booking-lineup-request-closed";
import {
  generateClaimToken,
  isClaimTokenHashCollision,
} from "./_shared/claim-token";
import { sendClaimInviteEmail } from "./_shared/invite-email";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import {
  requirePlaceOwnership,
  type PlaceOwnershipResult,
} from "./_shared/place-access";

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention
/**
 * Failed-record retention for DETERMINISTIC refusals (same rationale and
 * value as finalize's): the adapters keep a failed marker ~15 minutes and
 * block `begin` meanwhile, which would lock the venue's retry out after a
 * decline refused BOOKING_NIGHT_BOOKED — the very flow the refusal points at
 * (Cancel booking, then decline again; review round 3, W3). These re-fail
 * identically or resolve on retry; 1s is the smallest every adapter accepts.
 */
const DETERMINISTIC_FAILURE_KEEP_SECONDS = 1;

/** Refusals that need no failed-marker retention (see above). */
function isDeterministicRespondFailure(error: unknown): boolean {
  return (
    isAppError(error) &&
    (error.code === "BOOKING_NIGHT_BOOKED" || error.code === "BOOKING_CANCELLED")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base object — the transport router derives its input from this
 * (`.omit({ actorHumanId: true })`), so the field list lives in exactly one
 * place.
 *
 * `declineReason` is sanitized free text (NFR-003 — sanitize BEFORE the
 * length floor, house `plainText*` pattern) and OPTIONAL at the schema
 * layer: a TO_VENUE decline still requires it, but the requirement depends
 * on the row's DIRECTION (spec: TO_PERFORMER declines need no reason) and a
 * static schema can't branch on that — it is enforced in the use case after
 * the row is loaded, with the exact error shape the old cross-field
 * `.refine()` produced.
 */
export const respondToBookingRequestBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    action: z.enum(["accept", "decline"]),
    declineReason: plainTextMultilineRequired(1000)
      .pipe(z.string().min(3))
      .optional(),
  })
  .strict();

/**
 * Alias — no cross-field refine since 2026-07-21 (the decline-reason
 * requirement moved behind the direction fork; see the base-schema doc).
 * Kept as a distinct export so call sites keep one import surface.
 */
export const respondToBookingRequestInputSchema =
  respondToBookingRequestBaseSchema;

/**
 * The decline-reason gate the old schema `.refine()` enforced, thrown with a
 * byte-identical `invalid_input` shape so transports/clients see no change on
 * the TO_VENUE path.
 */
function failDeclineReasonRequired(): never {
  throw {
    code: "invalid_input",
    message: "invalid_input",
    issues: [
      {
        code: "custom",
        message: "decline_reason_required",
        path: ["declineReason"],
      },
    ],
  } as const;
}

export const respondToBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    status: bookingRequestStatusSchema,
    agreementId: z.uuid().optional(),
    /**
     * Booking-holds FR-009: a TO_VENUE decline releases every live hold the
     * request owned (same tx) — these are the move-up notifications owed to
     * the OTHER acts in each line. Absent on accepts and TO_PERFORMER rows.
     * Step 3 wires them to notify(); core returns data only.
     */
    holdNotificationIntents: z
      .array(bookingHoldNotificationIntentSchema)
      .optional(),
  })
  .strict();

/** What transport puts on the wire: the hold intents stay server-side. */
export const respondToBookingRequestWireOutputSchema = z.object(
  respondToBookingRequestOutputSchema.omit({ holdNotificationIntents: true })
    .shape,
);

export type RespondToBookingRequestInput = z.infer<
  typeof respondToBookingRequestInputSchema
>;
export type RespondToBookingRequestOutput = z.infer<
  typeof respondToBookingRequestOutputSchema
>;
export type RespondToBookingRequestWireOutput = z.infer<
  typeof respondToBookingRequestWireOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type RespondToBookingRequestDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "agreements"
    | "payoutTerms"
    | "places"
    | "authz"
    | "audit"
    // Routed calendar's defaultStartTime — the wall clock a DATE-ONLY pitch
    // is anchored at when seeding the Agreement header (degradable read).
    | "calendars"
    // Consumed inside the respond tx to append the booking-timeline entry.
    | "bookingRequestMessages"
    // TO_PERFORMER branch (organizer-booking-requests FR-005): attached-event
    // prefill + act-name resolution for the minted Agreement title.
    | "events"
    | "performerBookingDefaults"
    | "entityPages"
    | "humans"
    | "organizations"
    // FR-009: a TO_VENUE decline releases the request's live holds in-tx.
    | "bookingHolds"
  >;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * The sender hears the answer (booking-the-night N9 / FR-008): post-commit,
   * both directions, through `booking.request-responded` — the venue's
   * accept / decline (with its reason) to a TO_VENUE request's sender pair,
   * the act's accept / decline to a TO_PERFORMER request's organiser org
   * (organizer-booking-requests FR-006, folded in). Composed by the
   * transport layer. Deliberate swallow (logger.error + reportError) — a
   * throwing notifier never fails the committed response.
   */
  notifyBookingRequestResponded?: NotifyBookingRequestRespondedFn;
  /**
   * Lineup v3 (L7 / FR-012b): a TO_VENUE decline tells every act that JOINED
   * the bill that the request isn't going ahead — never the reason.
   * Post-commit, swallowed + reported; absent = nobody is told.
   */
  notifyBookingLineupRequestClosed?: NotifyBookingLineupRequestClosedFn;
  /**
   * Invite-to-claim email (FR-007), anonymous accepts only. The submitter has
   * no humanId, so notify() is unusable — this sends directly through
   * MailerPort. Optional so existing callers/tests keep compiling; missing at
   * anonymous-accept time is a REPORTED failure (the accept still succeeds —
   * NFR-004; the inbox gets a resend affordance).
   */
  mailer?: MailerPort;
  /**
   * Base web URL for the claim link. Same posture as `mailer`: optional at
   * the type level, required in practice for the anonymous fork — missing
   * config surfaces via the email swallow's reportError, never as a failed
   * accept.
   */
  publicAppUrl?: string | null;
  /** Best-effort reporter for the email swallow branch (ReporterPort convention). */
  reportError?: ReporterPort;
};

interface StoredRespondRecord {
  response: RespondToBookingRequestOutput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue response to a booking request (spec FR-003). TO_PERFORMER rows fork
 * to the performer-side branch (`respondToPerformerRequest`); everything
 * below the fork is the TO_VENUE flow. Authorization ALWAYS runs before the
 * idempotency cache is consulted (review 2026-07-21) — see the ordering note
 * in the function body.
 *
 * - `decline` records the reason (required on TO_VENUE; optional on
 *   TO_PERFORMER per spec) and stamps respondedAt.
 * - `accept` is the money-adjacent path: it clones the place's default
 *   PRIMARY PayoutTerms into a fresh PENDING instance (lines copied,
 *   requiresConfirmation lines reset to PENDING) — or creates a bare PENDING
 *   PRIMARY draft when the place has no default — then creates an Agreement
 *   DRAFT (proposer = the request's performer owner, counterparty = the venue
 *   side), SEEDED FROM THE PITCH (proposed dates, guarantee, and the
 *   operational asks — see `pitch-seed.ts`), and stamps the request ACCEPTED
 *   with the agreement link. The whole accept runs in one tx behind an
 *   idempotency key, mirroring `finalize-from-payment-intent` discipline.
 * - `accept` on an ANONYMOUS embed inquiry (booking-request-embed-button
 *   FR-007) forks to invite-to-claim instead: ACCEPTED + a single-use claim
 *   token (sha256-hashed at rest, `CLAIM_TOKEN_TTL_DAYS` expiry) in one tx,
 *   then a post-commit `booking.invite_to_claim` email to the submitter's
 *   contactEmail. NO Agreement yet — `claim-booking-request` mints it when
 *   the performer attaches an identity. Email failure never fails the accept
 *   (NFR-004 swallow: logger.error + reportError).
 *
 * Counterparty derivation: when the actor's access to the place comes through
 * an owning org, the counterparty is that organization; a direct human owner
 * becomes the counterparty themselves.
 */
export async function respondToBookingRequest(
  deps: RespondToBookingRequestDeps,
  rawInput: unknown,
): Promise<RespondToBookingRequestOutput> {
  const input = parseInput(respondToBookingRequestInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({
    useCase: "respondToBookingRequest",
  });

  // ── Authorize BEFORE serving the idempotency cache (review 2026-07-21) ─────
  // The respond cache key is actor-INDEPENDENT by design: any authorized
  // responder replaying a completed respond must converge on the same cached
  // result. That makes serving the cache before authz an oracle — any
  // authenticated actor who learns a request UUID could replay the outcome
  // (status + minted agreementId). So: load the row and run the
  // direction-appropriate responder check FIRST; only then consult the cache.
  // Side benefit: unauthorized (and not-found) probes can no longer arm the
  // envelope's failed-marker retention against the legitimate responder.
  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }

  // Venue-side context (TO_VENUE only) — resolved during authz, reused by the
  // mutation so it isn't loaded twice.
  let venue: { place: PlaceRecord; ownership: PlaceOwnershipResult } | null =
    null;

  if (request.direction === "TO_PERFORMER") {
    // PERFORMER-side responder (organizer-booking-requests FR-004): the act
    // itself, or an edit-role member of the act org. Accept is
    // money-adjacent (mints an Agreement) — same bar as the venue side.
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType:
        request.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
      ownerId: request.performerOwnerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  } else {
    const place = await deps.repos.places.getById(request.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }

    // Money-adjacent (accept creates an Agreement + clones PayoutTerms), so
    // an org-membership path requires an edit-level role — viewing-only
    // members can list/markViewed but never respond.
    const ownership = await requirePlaceOwnership(
      deps.repos,
      place,
      input.actorHumanId,
      { requiredOrgRoles: ORG_EDIT_ROLES },
    );

    // TO_VENUE declines still require a reason (moved here from the old
    // schema `.refine()` — the requirement is direction-dependent now;
    // TO_PERFORMER declines may omit it per spec). Deterministic validation,
    // deliberately BEFORE the envelope so it never arms a failed marker.
    if (input.action === "decline" && input.declineReason === undefined) {
      failDeclineReasonRequired();
    }

    venue = { place, ownership };
  }

  const idempotencyKey = `bookingRequest:respond:${input.bookingRequestId}:${input.action}`;

  const cached =
    await deps.idempotency.get<StoredRespondRecord>(idempotencyKey);
  if (cached) {
    scopedLogger?.info("booking_requests.respond.replay_cached", {
      bookingRequestId: input.bookingRequestId,
      action: input.action,
    });
    return cached.response;
  }

  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_KEY_TTL_SECONDS,
  );
  if (!claimed) {
    const replay =
      await deps.idempotency.get<StoredRespondRecord>(idempotencyKey);
    if (replay) return replay.response;
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result =
      request.direction === "TO_PERFORMER"
        ? await respondToPerformerRequest(deps, scopedLogger, input, request)
        : await respondInternal(deps, scopedLogger, input, {
            request,
            place: venue!.place,
            ownership: venue!.ownership,
          });
    // The cached record carries NO hold intents: they were dispatched once,
    // by the call that committed the decline. A replayed decline that
    // re-emitted them would re-notify every mover (FR-016's keys would
    // dedupe most of it, but not a differently-keyed later dispatcher — and
    // an intent list is a side effect, not a response).
    const { holdNotificationIntents: _dispatchedOnce, ...cacheable } = result;
    await deps.idempotency.commit<StoredRespondRecord>(
      idempotencyKey,
      { response: cacheable },
      IDEMPOTENCY_KEEP_SECONDS,
    );
    return result;
  } catch (error) {
    await deps.idempotency.fail(
      idempotencyKey,
      describeError(error),
      isDeterministicRespondFailure(error)
        ? DETERMINISTIC_FAILURE_KEEP_SECONDS
        : undefined,
    );
    throw asKnownError("respond_to_booking_request", error);
  }
}

async function respondInternal(
  deps: RespondToBookingRequestDeps,
  logger: LoggerPort | undefined,
  input: RespondToBookingRequestInput,
  ctx: {
    /** Loaded + venue-authorized by the caller (authz-before-cache). */
    request: ToVenueBookingRequestRecord;
    place: PlaceRecord;
    ownership: PlaceOwnershipResult;
  },
): Promise<RespondToBookingRequestOutput> {
  const { request, place, ownership } = ctx;

  const now = deps.clock.now();

  assertRespondable(request, now);

  if (input.action === "decline") {
    const declined = await deps.repos.tx(async (tx) => {
      // The request's booking lock first (before any line lock), like every
      // path that books, un-books or closes a request: the read below decides
      // on committed state.
      await tx.bookingHolds.lockRequestBooking(request.id);
      const fresh = await requireRespondableInTx(tx, request.id, now);
      // A night that is BOOKED (a CONFIRMED hold — an event-first request whose
      // hold a venue confirm made CONFIRMED before anyone answered) is not
      // declined away: the decline would leave a DECLINED request holding a
      // CONFIRMED hold nobody can free. Same refusal as the sender's Withdraw;
      // the undo for both is Cancel booking (review round 2, W5).
      await assertNoBookedNightInTx(tx, fresh.id);

      const updated = await tx.bookingRequests.updateStatus({
        id: fresh.id,
        status: "DECLINED",
        expectedFrom: OPEN_BOOKING_REQUEST_STATUSES,
        respondedAt: now,
        declineReason: input.declineReason ?? null,
      });

      // Ledger entry, same tx as the CAS. The reason is COPIED onto the entry
      // (schema doc): a ledger records what was said at that moment, and
      // `BookingRequest.declineReason` is mutable.
      await appendBookingSystemEntry(tx, {
        bookingRequestId: updated.id,
        kind: "booking_request.declined",
        data: { reason: input.declineReason ?? null },
        actorHumanId: input.actorHumanId,
      });

      // FR-009: a closed request cannot keep a place in any line. Same tx as
      // the status CAS, so the request and its holds never disagree.
      const holds = await releaseHoldsForClosedRequest(tx, {
        bookingRequestId: updated.id,
        now,
        actor: { humanId: input.actorHumanId, kind: "staff" },
      });
      // Defence: nothing booked the night between the read above and the line
      // locks the release just took.
      await assertNoBookedNightAfterReleaseInTx(tx, updated.id);

      await tx.audit.log({
        entity: "booking_request",
        entityId: updated.id,
        action: "booking_request.declined",
        data: {
          actorHumanId: input.actorHumanId,
          placeId: place.id,
          declineReason: input.declineReason,
          releasedHoldIds: holds.released.map((hold) => hold.id),
        },
        at: now,
      });

      return { request: updated, holdIntents: holds.intents };
    });

    logger?.info("booking_requests.declined", {
      bookingRequestId: declined.request.id,
      actorHumanId: input.actorHumanId,
      releasedHoldCount: declined.holdIntents.length,
    });

    // The sender hears the answer, with the reason (N9 / FR-008).
    await fireBookingRequestResponded(
      { ...deps, logger },
      {
        bookingRequest: declined.request,
        action: "declined",
        agreementId: declined.request.agreementId ?? null,
        reason: input.declineReason ?? null,
        actorHumanId: input.actorHumanId,
      },
      "respondToBookingRequest",
    );

    // Joined acts hear it isn't going ahead (v3 L7) — no reason, ever.
    await fireBookingLineupRequestClosed(
      { ...deps, logger },
      {
        bookingRequest: declined.request,
        closedBy: "declined",
        actorHumanId: input.actorHumanId,
      },
      "respondToBookingRequest",
    );

    return respondToBookingRequestOutputSchema.parse({
      bookingRequestId: declined.request.id,
      status: declined.request.status,
      holdNotificationIntents: declined.holdIntents,
    });
  }

  // ── Accept: fork on CLAIM STATE (FR-007) ──────────────────────────────────
  // Unclaimed embed inquiries get ACCEPTED + a claim token + an invite email
  // — the Agreement is minted later, at claim time, when the submitter has an
  // identity to propose as. Owned requests keep the immediate-Agreement flow.
  //
  // The fork is `isUnclaimedBookingInquiry`, NOT the sender narrowing: since
  // booking-inquirer-outreach an inquiry the venue has REPLIED TO carries a
  // shadow owner pair, and narrowing on the sender would send it down the
  // owned path — minting an Agreement naming a shadow Human nobody can sign in
  // as, and silently killing invite-to-claim for exactly the inquiries a venue
  // engaged with. The two predicates agree on every other row.
  if (isUnclaimedBookingInquiry(request) && request.contactEmail !== null) {
    return acceptAnonymous(deps, logger, input, {
      request,
      place,
      contactEmail: request.contactEmail,
      now,
    });
  }
  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous") {
    // Structurally unreachable (an anonymous row is always unclaimed and
    // contact-bearing), but the compiler needs the narrowing and a corrupt row
    // must not silently take the owned path.
    throw fail("INVALID_STATUS", {
      message: "sender_changed",
      meta: { bookingRequestId: request.id },
    });
  }

  // ── Owned accept: clone payout terms + create the Agreement DRAFT ─────────
  const counterparty = deriveCounterparty(ownership, place, input.actorHumanId);

  // Pitch-seed context, resolved OUTSIDE the tx (read-only, and the calendar
  // lookup is a degradable best-effort — keeping it out of the transaction
  // means a slow/failing calendars read never widens the accept's write lock).
  const pitchContext = {
    timezone: resolveBookingTimezone(place.timezone),
    calendarDefaultStartTime: await resolveCalendarDefaultStartTime(deps, {
      placeId: place.id,
      calendarId: request.calendarId,
    }),
  };

  // The accept body lives in `_shared/accept-in-tx.ts` (booking-holds step
  // 2) so `confirm-booking-hold` can run the SAME accept inside its own tx.
  const outcome = await deps.repos.tx((tx) =>
    acceptBookingRequestInTx(tx, {
      request,
      place,
      counterparty,
      pitchContext,
      actorHumanId: input.actorHumanId,
      now,
    }),
  );

  logger?.info("booking_requests.accepted", {
    bookingRequestId: outcome.request.id,
    agreementId: outcome.agreementId,
    actorHumanId: input.actorHumanId,
  });

  // The sender hears the venue said yes — terms follow (N9 / FR-008).
  await fireBookingRequestResponded(
    { ...deps, logger },
    {
      bookingRequest: outcome.request,
      action: "accepted",
      agreementId: outcome.agreementId,
      reason: null,
      actorHumanId: input.actorHumanId,
    },
    "respondToBookingRequest",
  );

  return respondToBookingRequestOutputSchema.parse({
    bookingRequestId: outcome.request.id,
    status: outcome.request.status,
    agreementId: outcome.agreementId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TO_PERFORMER response (organizer-booking-requests FR-004/FR-005)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performer-side accept/decline of an organizer request. Authz: the ACT
 * responds — self for a human act, ORG_EDIT_ROLES for an org act (accept is
 * money-adjacent: it mints an Agreement).
 *
 * Accept mints the Agreement per FR-005: proposer = the ORGANIZER org,
 * counterparty = the act owner, payout terms = bare PENDING PRIMARY draft
 * (no venue defaults exist in this direction), `placeId` = the attached
 * event's venue when present else null, proposedDate/proposedEndDate
 * auto-populated from the attached event (user decision 2026-07-21) and
 * otherwise from the org's own pitch, title "Booking — {act name}"
 * (PerformerBookingDefaults.actName → entity page displayName → canonical
 * name → fallback).
 *
 * Both outcomes fire the post-commit organizer notification (FR-006) as a
 * deliberate swallow — the response is durable before the notify runs.
 */
async function respondToPerformerRequest(
  deps: RespondToBookingRequestDeps,
  logger: LoggerPort | undefined,
  input: RespondToBookingRequestInput,
  /** Loaded + act-authorized by the caller (authz-before-cache). */
  request: ToPerformerBookingRequestRecord,
): Promise<RespondToBookingRequestOutput> {
  const now = deps.clock.now();
  assertRespondable(request, now);

  if (input.action === "decline") {
    const declined = await deps.repos.tx(async (tx) => {
      await requireRespondableInTx(tx, request.id, now);

      const updated = await tx.bookingRequests.updateStatus({
        id: request.id,
        status: "DECLINED",
        expectedFrom: OPEN_BOOKING_REQUEST_STATUSES,
        respondedAt: now,
        declineReason: input.declineReason ?? null,
      });

      // Ledger entry, same tx. TO_PERFORMER declines may carry no reason per
      // spec — the entry records null rather than omitting the field.
      await appendBookingSystemEntry(tx, {
        bookingRequestId: updated.id,
        kind: "booking_request.declined",
        data: { reason: input.declineReason ?? null },
        actorHumanId: input.actorHumanId,
      });

      await tx.audit.log({
        entity: "booking_request",
        entityId: updated.id,
        action: "booking_request.declined",
        data: {
          direction: "TO_PERFORMER",
          actorHumanId: input.actorHumanId,
          organizerOrgId: request.organizerOrgId,
          declineReason: input.declineReason,
        },
        at: now,
      });

      return updated;
    });

    await fireBookingRequestResponded(
      { ...deps, logger },
      {
        bookingRequest: request,
        action: "declined",
        agreementId: null,
        reason: input.declineReason ?? null,
        actorHumanId: input.actorHumanId,
      },
      "respondToBookingRequest",
    );

    logger?.info("booking_requests.declined", {
      bookingRequestId: declined.id,
      direction: "TO_PERFORMER",
      actorHumanId: input.actorHumanId,
    });

    return respondToBookingRequestOutputSchema.parse({
      bookingRequestId: declined.id,
      status: declined.status,
    });
  }

  // ── Accept: mint the organizer-proposed Agreement (FR-005) ────────────────
  // Read-only prefills resolved OUTSIDE the tx: the act's display name and
  // the attached event's live venue/dates (the request stores the id only; a
  // deleted event has already SetNull-detached).
  const actName = await resolvePerformerActName(deps.repos, {
    ownerType: request.performerOwnerType,
    ownerId: request.performerOwnerId,
  });

  let attachedEvent: {
    placeId: string | null;
    startsAt: Date;
    endsAt: Date | null;
  } | null = null;
  if (request.attachedEventId) {
    const event = await deps.repos.events.getById(request.attachedEventId);
    if (event) {
      attachedEvent = {
        placeId: event.placeId,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
      };
    }
  }

  const outcome = await deps.repos.tx(async (tx) => {
    await requireRespondableInTx(tx, request.id, now);

    const agreement = await createOrganizerAcceptAgreement(tx, {
      organizerOrgId: request.organizerOrgId,
      performerOwnerType: request.performerOwnerType,
      performerOwnerId: request.performerOwnerId,
      actName,
      attachedEvent,
      pitch: request,
      // No venue anchor in this direction (placeId is NULL by DB CHECK, and
      // organizer→act requests are never calendar-routed), so the pitch's
      // wall clocks are read in the platform default zone.
      pitchContext: {
        timezone: DEFAULT_BOOKING_TIMEZONE,
        calendarDefaultStartTime: null,
      },
    });

    const updated = await tx.bookingRequests.updateStatus({
      id: request.id,
      status: "ACCEPTED",
      expectedFrom: OPEN_BOOKING_REQUEST_STATUSES,
      respondedAt: now,
      agreementId: agreement.agreementId,
    });

    // Ledger, same tx as the accept (mirrors the TO_VENUE branch): ONE entry,
    // carrying the minted agreement's id. See that branch for why a second
    // `booking_agreement.drafted` in the same transaction is both redundant
    // and unorderable.
    await appendBookingSystemEntry(tx, {
      bookingRequestId: updated.id,
      kind: "booking_request.accepted",
      data: { agreementId: agreement.agreementId },
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: updated.id,
      action: "booking_request.accepted",
      data: {
        direction: "TO_PERFORMER",
        actorHumanId: input.actorHumanId,
        organizerOrgId: request.organizerOrgId,
        agreementId: agreement.agreementId,
        payoutTermsId: agreement.payoutTermsId,
        attachedEventId: request.attachedEventId,
        counterpartyType: request.performerOwnerType,
        counterpartyId: request.performerOwnerId,
      },
      at: now,
    });

    return { request: updated, agreementId: agreement.agreementId };
  });

  await fireBookingRequestResponded(
    { ...deps, logger },
    {
      bookingRequest: request,
      action: "accepted",
      agreementId: outcome.agreementId,
      reason: null,
      actorHumanId: input.actorHumanId,
    },
    "respondToBookingRequest",
  );

  logger?.info("booking_requests.accepted", {
    bookingRequestId: outcome.request.id,
    direction: "TO_PERFORMER",
    agreementId: outcome.agreementId,
    actorHumanId: input.actorHumanId,
  });

  return respondToBookingRequestOutputSchema.parse({
    bookingRequestId: outcome.request.id,
    status: outcome.request.status,
    agreementId: outcome.agreementId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Anonymous accept (invite-to-claim, FR-007)
// ─────────────────────────────────────────────────────────────────────────────

async function acceptAnonymous(
  deps: RespondToBookingRequestDeps,
  logger: LoggerPort | undefined,
  input: RespondToBookingRequestInput,
  args: {
    request: BookingRequestRecord;
    place: PlaceRecord;
    contactEmail: string;
    now: Date;
  },
): Promise<RespondToBookingRequestOutput> {
  const { request, place, contactEmail, now } = args;
  const claimTokenExpiresAt = new Date(
    now.getTime() + CLAIM_TOKEN_TTL_DAYS * DAY_MS,
  );

  // Retry ONCE on a claimTokenHash unique collision (256-bit token —
  // astronomically unlikely; documented choice over a typed dependency
  // error so the venue's accept never fails on cosmic-ray odds). A second
  // collision propagates as the conflict it would genuinely be.
  let token = generateClaimToken();
  let updated: BookingRequestRecord;
  try {
    updated = await acceptAnonymousInTx(deps, input, {
      requestId: request.id,
      place,
      tokenHash: token.tokenHash,
      claimTokenExpiresAt,
      now,
    });
  } catch (error) {
    if (!isClaimTokenHashCollision(error)) throw error;
    token = generateClaimToken();
    updated = await acceptAnonymousInTx(deps, input, {
      requestId: request.id,
      place,
      tokenHash: token.tokenHash,
      claimTokenExpiresAt,
      now,
    });
  }

  // ── Invite email — post-commit, best-effort (NFR-004) ─────────────────────
  // The accept is durably committed above; sendClaimInviteEmail never throws
  // (swallow = logger.error + guarded reportError). The raw token exists only
  // in this call's claim link.
  await sendClaimInviteEmail(
    {
      mailer: deps.mailer,
      publicAppUrl: deps.publicAppUrl,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      useCase: "respondToBookingRequest",
      bookingRequestId: updated.id,
      placeId: place.id,
      placeName: place.name,
      actName: updated.actName,
      contactEmail,
      rawToken: token.rawToken,
      claimTokenExpiresAt,
    },
  );

  logger?.info("booking_requests.accepted", {
    bookingRequestId: updated.id,
    actorHumanId: input.actorHumanId,
    inviteToClaim: true,
  });

  return respondToBookingRequestOutputSchema.parse({
    bookingRequestId: updated.id,
    status: updated.status,
  });
}

async function acceptAnonymousInTx(
  deps: RespondToBookingRequestDeps,
  input: RespondToBookingRequestInput,
  args: {
    requestId: string;
    place: PlaceRecord;
    tokenHash: string;
    claimTokenExpiresAt: Date;
    now: Date;
  },
): Promise<BookingRequestRecord> {
  const { requestId, place, tokenHash, claimTokenExpiresAt, now } = args;

  return deps.repos.tx(async (tx) => {
    const fresh = await requireRespondableInTx(tx, requestId, now);
    // In-tx re-check on CLAIM STATE, not the sender narrowing: a shadow owner
    // pair attached by venue outreach is not a claim, and treating it as one
    // here would refuse the anonymous accept for every inquiry the venue had
    // already replied to. The authoritative race guard stays the `setClaimToken`
    // CAS below (`claimedAt IS NULL`).
    if (!isUnclaimedBookingInquiry(fresh)) {
      throw fail("INVALID_STATUS", {
        message: "sender_changed",
        meta: { bookingRequestId: fresh.id },
      });
    }

    await tx.bookingRequests.updateStatus({
      id: fresh.id,
      status: "ACCEPTED",
      expectedFrom: OPEN_BOOKING_REQUEST_STATUSES,
      respondedAt: now,
    });

    // Token write is an UPDATE by contract (never part of create — see the
    // port doc); CAS re-checks ACCEPTED + anonymous-unclaimed at write time.
    const updated = await tx.bookingRequests.setClaimToken({
      id: fresh.id,
      claimTokenHash: tokenHash,
      claimTokenExpiresAt,
      expectedFrom: ["ACCEPTED"],
    });

    // Ledger entry, same tx. `agreementId: null` is the WHOLE POINT of the
    // nullable field: accepting an anonymous embed inquiry mints NO agreement
    // — `claim-booking-request` does that later, when the submitter attaches
    // an identity, and emits `booking_agreement.drafted` there.
    await appendBookingSystemEntry(tx, {
      bookingRequestId: fresh.id,
      kind: "booking_request.accepted",
      data: { agreementId: null },
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: fresh.id,
      action: "booking_request.accepted",
      data: {
        actorHumanId: input.actorHumanId,
        placeId: place.id,
        inviteToClaim: true,
        claimTokenExpiresAt,
        // Deliberately NO token material here — not even the hash.
      },
      at: now,
    });

    return updated;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// `assertRespondable`, `requireRespondableInTx` and `deriveCounterparty`
// moved to `_shared/accept-in-tx.ts` (shared with confirm-booking-hold).
