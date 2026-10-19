import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { toPerformerOwnerType } from "../performers/set-performer-mode";
import { fail, isAppError } from "@th/errors";
import {
  resolveBookingTimezone,
  resolveCalendarDefaultStartTime,
} from "../booking-agreements/_shared/pitch-seed";
import { defaultEventOwnerSideForIntent } from "../booking-agreements/_shared/event-owner-side";
import {
  createAcceptAgreement,
  deriveVenueCounterpartyFromPlace,
  type BookingAgreementCounterparty,
} from "./_shared/accept-agreement";
import { CLAIM_TOKEN_PATTERN, hashClaimToken } from "./_shared/claim-token";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

/**
 * Failed-record retention for DETERMINISTIC domain failures inside the
 * idempotency envelope (in practice: the CAS-loser mapping below). The real
 * adapters retain failed markers for 15 minutes by default and `begin` is
 * blocked until the marker expires — which would turn a user's perfectly
 * normal "click the link again" retry into IDEMPOTENCY_LOCK_IN_PROGRESS. A
 * deterministic failure re-fails identically on retry, so it needs no
 * meaningful retention; 1s is the smallest value every adapter accepts
 * (Redis `SET … EX 0` is an error). We still always CALL `fail` — skipping it
 * would leave the `in_progress` marker armed for the full begin TTL (300s),
 * which is strictly worse. Infra/unknown failures keep the adapters' default
 * retention (undefined keepSec).
 */
const DETERMINISTIC_FAILURE_KEEP_SECONDS = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const claimBookingRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** RAW claim token from the invite link (32 bytes base64url = 43 chars). */
    rawToken: z.string().regex(CLAIM_TOKEN_PATTERN),
    performerOwnerType: z.enum(["human", "org"]),
    performerOwnerId: z.uuid(),
  })
  .strict();

export const claimBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    agreementId: z.uuid(),
  })
  .strict();

export type ClaimBookingRequestInput = z.infer<
  typeof claimBookingRequestInputSchema
>;
export type ClaimBookingRequestOutput = z.infer<
  typeof claimBookingRequestOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ClaimBookingRequestDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "agreements"
    | "payoutTerms"
    | "places"
    | "performerProfiles"
    | "authz"
    | "audit"
    // Routed calendar's defaultStartTime — the wall clock a DATE-ONLY pitch
    // is anchored at when seeding the Agreement header (degradable read).
    | "calendars"
    // Consumed inside the claim tx to append the booking-timeline entries.
    | "bookingRequestMessages"
  >;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for the calendar-lookup swallow in the pitch-seed
   * context resolution (ReporterPort convention — a degraded default show
   * time must be visible in Sentry, never silent).
   */
  reportError?: ReporterPort;
};

interface StoredClaimRecord {
  response: ClaimBookingRequestOutput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A signed-in performer redeems an invite-to-claim link
 * (booking-request-embed-button FR-007): attaches their identity (self or an
 * org they hold edit roles in) to an ACCEPTED anonymous request, then mints
 * the Agreement exactly as the owned accept path does (shared
 * `createAcceptAgreement` internals — same PayoutTerms cloning behavior).
 *
 * Gate order: sender authorization first (requireOwnerAccess — self for a
 * human sender, ORG_EDIT_ROLES for an org sender — plus the performer-mode
 * gate, both mirroring create-booking-request), THEN the token gates
 * (found → not expired → ACCEPTED → unclaimed). Running authz first keeps the
 * idempotency-cache read behind the same checks as a fresh execution.
 *
 * The token gates run OUTSIDE the idempotency envelope (after the cache
 * check, before `begin`): they are read-only and deterministic, and an
 * expired-link retry is a NORMAL user path — arming the adapters' 15-minute
 * failed-record retention for it would turn the second click into
 * IDEMPOTENCY_LOCK_IN_PROGRESS instead of TOKEN_EXPIRED. The envelope
 * protects only the mutation; races between the gates and the tx are covered
 * by the repo `claim` CAS.
 *
 * Idempotency key: `bookingRequest:claim:<sha256(rawToken)>:<sender>` —
 * deliberately keyed by TOKEN HASH (not bookingRequestId): a successful claim
 * NULLs the hash, so a replayed mutation can no longer find the row and an
 * id-keyed cache would be unreachable; the hash-keyed cache turns the replay
 * into the friendly no-op the spec asks for. The sender suffix stops a
 * DIFFERENT performer from replaying the winner's cached result — they fall
 * through to the (now-dead) lookup and get TOKEN_INVALID.
 *
 * Errors: unknown/rotated/consumed token → TOKEN_INVALID (the pre-gate
 * consumed case carries `meta.reason = "already_claimed"`; the CAS-loser case
 * carries `meta.reason = "token_no_longer_active"` — accurate whether it lost
 * to a concurrent claim OR a concurrent resend rotation); lapsed expiry →
 * TOKEN_EXPIRED; a token pointing at a non-ACCEPTED row (defensive) →
 * INVALID_STATUS.
 *
 * Double-redeem race: the repo `claim` is a CAS on `claimTokenHash` still
 * matching (+ `claimedAt IS NULL` + status ACCEPTED), so two concurrent
 * redeems produce exactly one winner; the loser's adapter conflict is mapped
 * to TOKEN_INVALID/token_no_longer_active here.
 *
 * Open-pair rule (spec decision: CLAIM WINS): if the claimer already has an
 * open (PENDING/VIEWED) request at this place, the claim still proceeds and
 * the other open request is left untouched. Backfilling the owner pair onto
 * this ACCEPTED row cannot violate "BookingRequest_open_pair_key" — that
 * partial unique index only covers status IN ('PENDING','VIEWED') (migration
 * 20260610120000), and this row is CAS-pinned to ACCEPTED.
 */
export async function claimBookingRequest(
  deps: ClaimBookingRequestDeps,
  rawInput: unknown,
): Promise<ClaimBookingRequestOutput> {
  const input = parseInput(claimBookingRequestInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "claimBookingRequest" });

  const ownerType = toPerformerOwnerType(input.performerOwnerType);

  // 1. Sender control — mirrors create-booking-request.
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: input.performerOwnerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  // 2. Performer-mode gate — mirrors create-booking-request.
  const profile = await deps.repos.performerProfiles.getByOwner({
    ownerType,
    ownerId: input.performerOwnerId,
  });
  if (!isPerformerEnabled(profile)) {
    throw fail("PERFORMER_MODE_REQUIRED");
  }

  // Raw token → at-rest hash. The raw token is never persisted or logged.
  const tokenHash = hashClaimToken(input.rawToken);
  const idempotencyKey = `bookingRequest:claim:${tokenHash}:${ownerType}:${input.performerOwnerId}`;

  const cached = await deps.idempotency.get<StoredClaimRecord>(idempotencyKey);
  if (cached) {
    logger?.info("booking_requests.claim.replay_cached", {
      bookingRequestId: cached.response.bookingRequestId,
    });
    return cached.response;
  }

  // 3. Token gates — deterministic, read-only, OUTSIDE the envelope (see the
  // use-case doc). A TOKEN_EXPIRED/TOKEN_INVALID here leaves no idempotency
  // marker behind, so an immediate retry sees the same domain error again.
  const now = deps.clock.now();
  const gated = await runClaimGates(deps, tokenHash, now);

  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_KEY_TTL_SECONDS,
  );
  if (!claimed) {
    const replay =
      await deps.idempotency.get<StoredClaimRecord>(idempotencyKey);
    if (replay) return replay.response;
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await claimInternal(deps, logger, input, {
      ownerType,
      tokenHash,
      now,
      ...gated,
    });
    await deps.idempotency.commit<StoredClaimRecord>(
      idempotencyKey,
      { response: result },
      IDEMPOTENCY_KEEP_SECONDS,
    );
    return result;
  } catch (error) {
    // Deterministic domain failures (the CAS-loser mapping) get near-zero
    // retention so a user retry re-runs and re-fails with the REAL error
    // instead of IDEMPOTENCY_LOCK_IN_PROGRESS; infra failures keep the
    // adapters' default retention. See DETERMINISTIC_FAILURE_KEEP_SECONDS.
    await deps.idempotency.fail(
      idempotencyKey,
      describeError(error),
      isDeterministicClaimFailure(error)
        ? DETERMINISTIC_FAILURE_KEEP_SECONDS
        : undefined,
    );
    throw asKnownError("claim_booking_request", error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gates (pre-envelope, deterministic, read-only)
// ─────────────────────────────────────────────────────────────────────────────

type ClaimGatesResult = {
  request: BookingRequestRecord;
  place: PlaceRecord;
  counterparty: BookingAgreementCounterparty;
};

async function runClaimGates(
  deps: ClaimBookingRequestDeps,
  tokenHash: string,
  now: Date,
): Promise<ClaimGatesResult> {
  const request =
    await deps.repos.bookingRequests.findByClaimTokenHash(tokenHash);
  if (!request) {
    // Never issued, rotated away by a resend, or already consumed (claim
    // NULLs the hash) — indistinguishable by design; single friendly surface.
    throw fail("TOKEN_INVALID");
  }

  if (request.direction !== "TO_VENUE") {
    // Structurally unreachable (claim tokens are only ever written on
    // anonymous TO_VENUE rows; TO_PERFORMER rows are DB-CHECKed ownerful with
    // null token columns) — direction-guarded anyway per NFR-001 so the
    // invite-to-claim machinery can never touch an organizer request.
    throw fail("TOKEN_INVALID", {
      meta: { reason: "wrong_direction", bookingRequestId: request.id },
    });
  }

  if (
    request.claimTokenExpiresAt &&
    request.claimTokenExpiresAt.getTime() <= now.getTime()
  ) {
    throw fail("TOKEN_EXPIRED");
  }

  if (request.status !== "ACCEPTED") {
    // Defensive: tokens are only written on ACCEPTED rows and NFR-003 revokes
    // on leaving ACCEPTED, so a live token on another status is a corrupt row.
    throw fail("INVALID_STATUS", {
      meta: { reason: "not_accepted", bookingRequestId: request.id },
    });
  }

  if (request.claimedAt !== null) {
    // Defensive: a consumed claim NULLs the hash, so normally unreachable.
    throw fail("TOKEN_INVALID", { meta: { reason: "already_claimed" } });
  }

  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Venue side of the Agreement (no venue actor at claim time — derived from
  // the place's access lists; see deriveVenueCounterpartyFromPlace for the
  // deliberate org-first divergence from respond-time precedence).
  const counterparty = deriveVenueCounterpartyFromPlace(place);

  // NOTE(claim wins): deliberately NO findOpenByPerformerAndPlace check here —
  // see the use-case doc. The claimer's other open request (if any) stays
  // untouched, and the ACCEPTED backfill can't trip the open-pair index.

  return { request, place, counterparty };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation (inside the idempotency envelope)
// ─────────────────────────────────────────────────────────────────────────────

async function claimInternal(
  deps: ClaimBookingRequestDeps,
  logger: LoggerPort | undefined,
  input: ClaimBookingRequestInput,
  args: ClaimGatesResult & {
    ownerType: "human" | "organization";
    tokenHash: string;
    now: Date;
  },
): Promise<ClaimBookingRequestOutput> {
  const { ownerType, tokenHash, now, request, place, counterparty } = args;

  // Pitch-seed context, resolved OUTSIDE the tx (read-only; the calendar
  // lookup is a degradable best-effort that must never widen the claim's
  // write lock — or fail it).
  const pitchContext = {
    timezone: resolveBookingTimezone(place.timezone),
    calendarDefaultStartTime: await resolveCalendarDefaultStartTime(deps, {
      placeId: place.id,
      calendarId: request.calendarId,
    }),
  };

  const outcome = await deps.repos.tx(async (tx) => {
    // Single-winner CAS: backfill identity + consume the token. Two
    // concurrent redeems (or a redeem racing a resend rotation) produce
    // exactly one winner; the loser surfaces the friendly
    // token-no-longer-active shape of TOKEN_INVALID.
    let fresh: BookingRequestRecord;
    try {
      fresh = await tx.bookingRequests.claim({
        id: request.id,
        expectedClaimTokenHash: tokenHash,
        performerOwnerType: ownerType,
        performerOwnerId: input.performerOwnerId,
        claimedAt: now,
      });
    } catch (error) {
      if (isAlreadyClaimedConflict(error)) {
        // Lost the CAS to EITHER a concurrent claim or a concurrent resend
        // rotation — "already_claimed" would lie to debuggers in the second
        // case, so the meta says exactly what is true in both: this token no
        // longer matches a live, unclaimed row.
        throw fail("TOKEN_INVALID", {
          meta: { reason: "token_no_longer_active" },
        });
      }
      throw error;
    }

    // The bill (lineup-booking-requests v2). An anonymous inquiry's own act
    // was written as free text — EXTERNAL row 0, from the form's `actName` —
    // because the request had no sender to point at. The claim just gave it
    // one, and the claimant IS that act: the row becomes their SELF row
    // (owner pair copied off the request by the adapter, CONFIRMED), so the
    // bill and the event minted from it name a platform identity instead of
    // a typed string. A pre-bill inquiry (no act rows) has nothing to
    // convert, and a bill that already has a SELF row is left alone.
    const bill = await tx.bookingRequests.listActsForRequests([fresh.id]);
    const inquiryAct = bill.find(
      (act) => act.source === "EXTERNAL" && act.sortOrder === 0,
    );
    const selfAct =
      inquiryAct && !bill.some((act) => act.source === "SELF")
        ? await tx.bookingRequests.promoteActToSelf({
            bookingRequestId: fresh.id,
            actId: inquiryAct.id,
          })
        : null;

    // Mint the Agreement EXACTLY as the owned accept does (shared internals —
    // same PayoutTerms cloning), then link it. The ACCEPTED→ACCEPTED CAS is a
    // plain guarded write; the row can't leave ACCEPTED mid-tx.
    const agreement = await createAcceptAgreement(tx, {
      place,
      proposerType: ownerType,
      proposerId: input.performerOwnerId,
      counterparty,
      // Seed from the FRESH row — the claim just backfilled the owner pair,
      // but the pitch fields are the ones the venue accepted on.
      pitch: fresh,
      pitchContext,
      // Owner-side terms (venue-confirmation spec): same rule as the owned
      // accept — RENT / USE seed requester-only terms.
      eventOwnerSide: defaultEventOwnerSideForIntent(fresh.intent),
    });

    const updated = await tx.bookingRequests.updateStatus({
      id: fresh.id,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      agreementId: agreement.agreementId,
    });

    // Ledger, same tx as the mint. The anonymous accept already logged
    // `booking_request.accepted` with `agreementId: null`; THIS is where the
    // agreement finally appears on the thread, so without it a reader would
    // see a draft arrive from nowhere. There is deliberately no
    // `booking_request.claimed` kind — claiming is an identity backfill, not a
    // change to the booking's state (the request was, and stays, ACCEPTED).
    await appendBookingSystemEntry(tx, {
      bookingRequestId: updated.id,
      kind: "booking_agreement.drafted",
      data: { agreementId: agreement.agreementId },
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: updated.id,
      action: "booking_request.claimed",
      data: {
        actorHumanId: input.actorHumanId,
        performerOwnerType: ownerType,
        performerOwnerId: input.performerOwnerId,
        placeId: place.id,
        agreementId: agreement.agreementId,
        payoutTermsId: agreement.payoutTermsId,
        counterpartyType: counterparty.type,
        counterpartyId: counterparty.id,
        clonedFromDefaultTerms: agreement.clonedFromDefaultTerms,
        // The inquiry's own act, now the claimant's SELF row (null: nothing
        // to convert).
        selfActId: selfAct?.id ?? null,
        // Deliberately NO token material — not even the hash.
      },
      at: now,
    });

    return { request: updated, agreementId: agreement.agreementId };
  });

  logger?.info("booking_requests.claimed", {
    bookingRequestId: outcome.request.id,
    agreementId: outcome.agreementId,
    actorHumanId: input.actorHumanId,
    performerOwnerType: ownerType,
    performerOwnerId: input.performerOwnerId,
  });

  return claimBookingRequestOutputSchema.parse({
    bookingRequestId: outcome.request.id,
    agreementId: outcome.agreementId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Adapter conflict thrown by the repo `claim` CAS when the redeem lost. */
function isAlreadyClaimedConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { message?: unknown }).message ===
      "booking_request_already_claimed"
  );
}

/**
 * Domain failures that re-fail identically on retry — safe (and user-kind)
 * to release the idempotency key almost immediately. Everything the
 * pre-envelope gates throw never reaches `fail()` at all; this covers the
 * same code family when raised inside the envelope (CAS loser, defensive
 * in-tx guards).
 */
function isDeterministicClaimFailure(error: unknown): boolean {
  return (
    isAppError(error) &&
    (error.code === "TOKEN_INVALID" ||
      error.code === "TOKEN_EXPIRED" ||
      error.code === "INVALID_STATUS" ||
      error.code === "PLACE_NOT_FOUND")
  );
}
