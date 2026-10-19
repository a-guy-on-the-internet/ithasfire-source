import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  ORG_EDIT_OR_FINANCE_ROLES,
  ORG_EDIT_ROLES,
  requireOrgMembership,
} from "../../lib/rbac";
import { requireAgreementParty } from "./_shared/agreement-access";
import {
  bookingThreadSideForAgreementSide,
  findLedgerRequestForAgreement,
} from "./_shared/booking-ledger";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  assertBookingEventOnNight,
  bookingEventOwningSide,
  failBookingHasMultipleEvents,
  failEventOwnerNotBookingParty,
} from "../booking-holds/_shared/booking-night";
import { isLiveBookingEvent } from "./_shared/booking-event-liveness";
import { lineKeysOf, lockLines } from "../booking-holds/_shared/hold-line";
import { resolveBookingTimezone } from "./_shared/pitch-seed";
import { fail, isAppError } from "@th/errors";
// ── P4b (deal terms) ──
import { assertPerOrderLinesForActivation } from "../../lib/pricing/per-order-lines-total";
import {
  assertDealWritable,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
} from "../deals/_shared/deal-freeze";

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

/**
 * Failed-record retention for DETERMINISTIC domain failures inside the
 * idempotency envelope (same rationale + value as `claim-booking-request`):
 * the real adapters retain failed markers for 15 minutes by default and
 * `begin` is blocked until the marker expires — which would turn the NORMAL
 * "confirm the pending payout line, then finalize again" flow (and
 * `createEventFromAgreement`'s converging finalize retry) into
 * IDEMPOTENCY_LOCK_IN_PROGRESS. A deterministic gate failure
 * (`lines_unconfirmed`, `payee_not_ready`, status/party gates, CAS losers)
 * re-fails identically — or resolves correctly — on retry, so it needs no
 * meaningful retention; 1s is the smallest value every adapter accepts.
 * Infra/unknown failures keep the adapters' default retention.
 */
const DETERMINISTIC_FAILURE_KEEP_SECONDS = 1;

/**
 * Upper bound on the stale-generation walk (retained finalize records whose
 * linked event was since deleted). Each hop requires a real committed
 * finalize whose event was then deleted; event ids are fresh uuids so the
 * chain cannot cycle — the cap only guards a corrupt idempotency store.
 */
const MAX_STALE_EVENT_GENERATIONS = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const finalizeBookingAgreementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    eventId: z.uuid(),
    /**
     * freeze-the-deal FR-004: finalize re-points the event's PRIMARY terms,
     * so on an event whose deal is frozen it is a deal change. Refused
     * DEAL_FROZEN unless the caller says it is changing frozen terms.
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const finalizeBookingAgreementOutputSchema = z
  .object({
    agreementId: z.uuid(),
    eventId: z.uuid(),
    payoutTermsId: z.uuid(),
  })
  .strict();

export type FinalizeBookingAgreementInput = z.infer<
  typeof finalizeBookingAgreementInputSchema
>;
export type FinalizeBookingAgreementOutput = z.infer<
  typeof finalizeBookingAgreementOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type FinalizeBookingAgreementDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "payoutTerms"
    | "payees"
    | "events"
    | "authz"
    | "audit"
    // Consumed inside the finalize tx to append the booking-timeline entry.
    | "bookingRequests"
    | "bookingRequestMessages"
    // The booked night's line the finalized event must sit on (P2c).
    | "bookingHolds"
    | "places"
    // freeze-the-deal: the terms locks, the DealChange row, and the notice's
    // recipients (org payees' members, names).
    | "deals"
    | "organizations"
    | "humans"
  >;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

interface StoredFinalizeRecord {
  payloadHash: string;
  response: FinalizeBookingAgreementOutput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE MONEY PATH (spec FR-004 finalize + NFR-001): stamp an ACCEPTED booking
 * agreement's PayoutTerms onto an event (`Event.payoutTermsId`, the live
 * settlement linkage) and link `Agreement.eventId`.
 *
 * Preconditions:
 * - agreement ACCEPTED, has payout terms, not yet linked to another event;
 * - actor is an agreement party (edit-level) AND has edit access to the
 *   EVENT — stamping payout terms on an event is an event-owner action;
 * - the event isn't already claimed by a DIFFERENT agreement
 *   (`event_already_has_agreement`; `Agreement.eventId` unique backstops);
 * - every `requiresConfirmation` line is CONFIRMED (`lines_unconfirmed`,
 *   pending payee ids in `meta`);
 * - every line payee is ACTIVE with payouts+charges enabled
 *   (`payee_not_ready` — PENDING payees are fine while drafting, but money
 *   can't route to an unonboarded Connect account).
 *
 * Mutation runs in ONE tx behind an idempotency key
 * (`bookingAgreement:finalize:<agreementId>`), mirroring
 * `finalize-from-payment-intent` discipline. Replays return the original
 * result; values are linked verbatim — nothing is recomputed. A retained
 * record whose finalized event was since DELETED (`Agreement.eventId`
 * SetNulled by the FK) is never honored: the envelope advances to a
 * deterministic generation-scoped key (`…:after:<staleEventId>`), so
 * re-finalizing to a NEW event isn't bricked by the dead record's 24h
 * retention (see `resolveFinalizeEnvelope`).
 *
 * Anchor hygiene: when the stamped event DIFFERS from the minted draft
 * (`Agreement.draftEventId`, createEventFromAgreement's anchor), the anchor
 * is retired in the same guarded write — otherwise a later eventId SetNull
 * (linked event deleted) would silently converge the agreement back onto a
 * stale months-old draft via the anchor short-circuit. The draft EVENT row
 * itself is untouched: it's the venue's to keep or delete.
 */
export async function finalizeBookingAgreement(
  deps: FinalizeBookingAgreementDeps,
  rawInput: unknown,
): Promise<FinalizeBookingAgreementOutput> {
  const input = parseInput(finalizeBookingAgreementInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({
    useCase: "finalizeBookingAgreement",
  });

  const payloadHash = JSON.stringify({
    agreementId: input.agreementId,
    eventId: input.eventId,
  });

  const resolution = await resolveFinalizeEnvelope(
    deps,
    input.agreementId,
    payloadHash,
  );
  if (resolution.kind === "replay") {
    scopedLogger?.info("booking_agreements.finalize.replay_cached", {
      agreementId: input.agreementId,
    });
    return resolution.response;
  }

  try {
    const result = await finalizeInternal(deps, scopedLogger, input);
    await deps.idempotency.commit<StoredFinalizeRecord>(
      resolution.idempotencyKey,
      { payloadHash, response: result },
      IDEMPOTENCY_KEEP_SECONDS,
    );
    return result;
  } catch (error) {
    await deps.idempotency.fail(
      resolution.idempotencyKey,
      describeError(error),
      isDeterministicFinalizeFailure(error)
        ? DETERMINISTIC_FAILURE_KEEP_SECONDS
        : undefined,
    );
    throw asKnownError("finalize_booking_agreement", error);
  }
}

type FinalizeEnvelopeResolution =
  | { kind: "replay"; response: FinalizeBookingAgreementOutput }
  | { kind: "claimed"; idempotencyKey: string };

/**
 * Resolve which envelope generation this finalize runs under. A committed
 * record is only honored when its finalized event STILL EXISTS; a record
 * pointing at a deleted event advances the walk to
 * `bookingAgreement:finalize:<agreementId>:after:<staleEventId>` —
 * deterministic across concurrent retries (every reader walks the same
 * chain), preserving both the replay semantics and the payload-hash conflict
 * for LIVE events.
 */
async function resolveFinalizeEnvelope(
  deps: FinalizeBookingAgreementDeps,
  agreementId: string,
  payloadHash: string,
): Promise<FinalizeEnvelopeResolution> {
  let idempotencyKey = `bookingAgreement:finalize:${agreementId}`;

  const honor = async (
    record: StoredFinalizeRecord,
  ): Promise<
    | { kind: "response"; response: FinalizeBookingAgreementOutput }
    | { kind: "stale"; staleEventId: string }
  > => {
    if (!(await deps.repos.events.getById(record.response.eventId))) {
      return { kind: "stale", staleEventId: record.response.eventId };
    }
    if (record.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return { kind: "response", response: record.response };
  };

  for (let hop = 0; hop < MAX_STALE_EVENT_GENERATIONS; hop += 1) {
    const cached =
      await deps.idempotency.get<StoredFinalizeRecord>(idempotencyKey);
    if (cached) {
      const outcome = await honor(cached);
      if (outcome.kind === "stale") {
        idempotencyKey = `bookingAgreement:finalize:${agreementId}:after:${outcome.staleEventId}`;
        continue;
      }
      return { kind: "replay", response: outcome.response };
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_KEY_TTL_SECONDS,
    );
    if (claimed) {
      return { kind: "claimed", idempotencyKey };
    }

    const replay =
      await deps.idempotency.get<StoredFinalizeRecord>(idempotencyKey);
    if (replay) {
      const outcome = await honor(replay);
      if (outcome.kind === "stale") {
        idempotencyKey = `bookingAgreement:finalize:${agreementId}:after:${outcome.staleEventId}`;
        continue;
      }
      return { kind: "replay", response: outcome.response };
    }

    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  throw {
    code: "conflict",
    message: "stale_finalize_generations_exhausted",
    meta: { agreementId },
  } as const;
}

/**
 * Domain failures that re-fail identically (or resolve to the correct
 * outcome) on retry — safe to release the idempotency key almost
 * immediately so the user's follow-up attempt re-runs the gates instead of
 * hitting IDEMPOTENCY_LOCK_IN_PROGRESS for the full retention window.
 */
function isDeterministicFinalizeFailure(error: unknown): boolean {
  if (isAppError(error)) {
    return (
      error.code === "AGREEMENT_NOT_FOUND" ||
      error.code === "AGREEMENT_NOT_ACCEPTED" ||
      error.code === "AGREEMENT_LINKED_TO_OTHER_EVENT" ||
      error.code === "AGREEMENT_MISSING_PAYOUT_TERMS" ||
      error.code === "NOT_AGREEMENT_PARTY" ||
      error.code === "INSUFFICIENT_ROLE" ||
      error.code === "NOT_RESOURCE_OWNER" ||
      error.code === "EVENT_NOT_FOUND" ||
      error.code === "EVENT_ARCHIVED" ||
      error.code === "HOLD_DATE_MISMATCHES_EVENT" ||
      error.code === "EVENT_ON_ANOTHER_CALENDAR" ||
      error.code === "EVENT_ON_ANOTHER_NIGHT" ||
      error.code === "EVENT_FIRST_REQUIRES_ORIGIN_EVENT" ||
      error.code === "BOOKING_HAS_MULTIPLE_EVENTS" ||
      error.code === "EVENT_OWNER_NOT_BOOKING_PARTY" ||
      // ── P4b (deal terms) ── the per-order total guard: deterministic for
      // these lines, so a retry after a fix gets its real answer, not a
      // stale cached refusal. (The only deal-era code finalize can throw.)
      error.code === "PAYOUT_LINES_TOTAL_INVALID" ||
      // freeze-the-deal: a frozen event refuses until the caller sends
      // `frozenChange`; that retry must run, not meet a cached refusal.
      error.code === "DEAL_FROZEN"
    );
  }
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : null;
  return (
    code === "lines_unconfirmed" ||
    code === "payee_not_ready" ||
    code === "event_already_has_agreement" ||
    // CAS losers (`agreement_status_changed` / `payout_terms_status_changed`):
    // a retry re-reads the row and surfaces the true post-race state.
    code === "conflict"
  );
}

async function finalizeInternal(
  deps: FinalizeBookingAgreementDeps,
  logger: LoggerPort | undefined,
  input: FinalizeBookingAgreementInput,
): Promise<FinalizeBookingAgreementOutput> {
  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }

  const payoutTermsId = await assertFinalizeGates(deps.repos, {
    agreement,
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
  });

  // Already linked to THIS event (e.g. an earlier finalize whose idempotency
  // record expired) → idempotent success, nothing to re-link.
  if (agreement.eventId === input.eventId) {
    return finalizeBookingAgreementOutputSchema.parse({
      agreementId: agreement.id,
      eventId: input.eventId,
      payoutTermsId,
    });
  }

  // A booked night's terms are finalized against THAT night's event only
  // (booking-the-night P2c, review round 1): the booking's terms, hold and
  // event live and die together, so a link to a show on another night or
  // calendar would let Cancel booking (or anything reading the booking's
  // event) act on the wrong show.
  await assertFinalizeEventMatchesBooking(deps.repos, {
    agreement,
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    tx: null,
  });

  // Fast-fail precheck (non-authoritative): surface unconfirmed lines /
  // unready payees before opening the transaction. The authoritative gate
  // re-runs inside the tx on the same snapshot that gets linked.
  const preLines = await deps.repos.payoutTerms.listLines(payoutTermsId);
  // ── P4b (deal terms) ── terms put in force divide each order as agreed.
  assertPerOrderLinesForActivation(
    preLines,
    await deps.repos.payoutTerms.getById(payoutTermsId),
    { agreementId: agreement.id, payoutTermsId },
  );
  assertLinesConfirmed(preLines);
  await assertPayeesReady(deps.repos.payees, preLines);

  const now = deps.clock.now();

  const change = await deps.repos.tx(async (tx) => {
    // The event row FIRST, for every finalize: the booking checks below
    // run under it (event row → booking lock → lines, the order publish and
    // Cancel booking take), and so does the freeze read (event row → terms
    // rows, the order in deal-freeze.ts). An agreement with no booking
    // request took no event lock before freeze-the-deal; it must now.
    await tx.events.lockRows({ ids: [input.eventId], mode: "update" });

    // The booking's own refusals, authoritative: under the event row, the
    // request's booking lock and the booked line (review round 2, residual d)
    // — the order publish / Cancel booking take them in (event row, booking
    // lock, lines), so no cycle. A booking that lands, or is cancelled, between
    // the read above and these locks is decided on committed state.
    // The agreement as decided on under the locks (re-read in this tx):
    // the anchor the write below retires — or must still find — comes from
    // HERE, never from the pre-transaction read (P2d-2, carry b).
    const decidedOn = await assertFinalizeEventMatchesBooking(tx, {
      agreement,
      eventId: input.eventId,
      actorHumanId: input.actorHumanId,
      tx,
    });

    // freeze-the-deal FR-004. After the event row (and the booking lock and
    // lines), the terms rows: the event's current PRIMARY terms (the deal
    // this link replaces) and the booking's (the deal it puts in), in id
    // order. The gates below then read lines no deal write can move. A
    // frozen event refuses DEAL_FROZEN unless `frozenChange`; with it the
    // link is one recorded change, told to every payee after the commit.
    const lockedEvent = await tx.events.getById(input.eventId);
    const termsToLock = [
      ...new Set(
        [lockedEvent?.payoutTermsId ?? null, payoutTermsId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    ].sort();
    for (const termsId of termsToLock) await tx.deals.lockTerms(termsId);
    const fence = await assertDealWritable(tx, {
      scope: { kind: "EVENT", eventId: input.eventId },
      frozenChange: input.frozenChange,
    });

    // Authoritative confirmation/payee gate: evaluated in-tx so a line edit
    // or payee regression racing between the precheck above and this write
    // can't slip an unconfirmed/unroutable line into the linked terms.
    const lines = await tx.payoutTerms.listLines(payoutTermsId);
    // ── P4b (deal terms) ── authoritative, on the snapshot that gets linked.
    assertPerOrderLinesForActivation(
      lines,
      await tx.payoutTerms.getById(payoutTermsId),
      { agreementId: agreement.id, payoutTermsId },
    );
    assertLinesConfirmed(lines);
    await assertPayeesReady(tx.payees, lines);

    // CAS at write time: still ACCEPTED and eventId still NULL — a
    // concurrent finalize / cancel surfaces as conflict (or
    // `event_already_has_agreement` via the unique index) instead of a
    // double-link.
    await tx.agreements.updateStatus({
      id: agreement.id,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      eventId: input.eventId,
      // P2d-2 (carry b): the anchor must still be the one the checks above
      // saw. A mint's `setDraftEvent` landing after that re-read (it takes
      // neither the event row nor the booking lock) would otherwise put a
      // LIVE draft beside the linked event — two live events on one booking.
      // Instead this write matches zero rows and the finalize is refused as
      // a conflict (retry re-reads and decides on the new anchor).
      expectedDraftEventId: decidedOn.draftEventId,
      // Divergent hand-picked event: retire the minted-draft anchor in the
      // same guarded write, so a later eventId SetNull (linked event deleted)
      // can't resurrect the stale draft through createEventFromAgreement's
      // anchor short-circuit. Same-event finalize (the create flow) keeps it.
      // Only a DEAD anchor is retired: a request-linked agreement whose draft
      // is still LIVE was refused above (`assertFinalizeEventMatchesBooking`,
      // BOOKING_HAS_MULTIPLE_EVENTS — review round 3, B2), never dropped.
      // Decided from the in-tx re-read, not the pre-tx `agreement`.
      ...(decidedOn.draftEventId && decidedOn.draftEventId !== input.eventId
        ? { clearDraftEventId: true }
        : {}),
    });

    await tx.events.linkPayoutTerms({
      eventId: input.eventId,
      payoutTermsId,
      kind: "PRIMARY",
    });

    // Terms linked to a real event by an ACCEPTED agreement are now
    // validated-in-force: CAS-activate booking-cloned PENDING terms so the
    // publish gate and settlement pipeline see ACTIVE. On a 0-match, re-read
    // (mirrors publishEvent): a row that's already ACTIVE (re-finalize after
    // idempotency expiry, or a concurrent activation) is a benign no-op —
    // the winner owns the audit trail — but anything else (ARCHIVED /
    // deleted) must fail HERE, rolling back the whole tx. Silently
    // finalizing would link unusable terms to the event and defer the
    // failure to an opaque publish error later.
    const activatedTerms = await tx.payoutTerms.activate({
      payoutTermsId,
      expectedFrom: ["PENDING"],
    });
    if (activatedTerms) {
      await tx.audit.log({
        entity: "payoutTerms",
        entityId: payoutTermsId,
        action: "activated",
        data: {
          reason: "activated_on_booking_finalize",
          agreementId: agreement.id,
          eventId: input.eventId,
        },
        at: now,
      });
    } else {
      const currentTerms = await tx.payoutTerms.getById(payoutTermsId);
      if (!currentTerms || currentTerms.status !== "ACTIVE") {
        throw {
          code: "conflict",
          message: "payout_terms_status_changed",
          meta: {
            payoutTermsId,
            status: currentTerms?.status ?? null,
          },
        } as const;
      }
    }

    // Ledger entry, same tx as the money link. Reached only on a REAL
    // finalize: the already-linked short-circuit and the idempotency replay
    // both return before this transaction opens, so a retried finalize never
    // doubles the entry.
    const request = await findLedgerRequestForAgreement(tx, agreement.id);
    if (request) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_agreement.finalized",
        data: { agreementId: agreement.id, eventId: input.eventId },
        actorHumanId: input.actorHumanId,
      });
    }

    await tx.audit.log({
      entity: "booking_agreement",
      entityId: agreement.id,
      action: "booking_agreement.finalized",
      data: {
        actorHumanId: input.actorHumanId,
        eventId: input.eventId,
        payoutTermsId,
        lineCount: lines.length,
      },
      at: now,
    });

    // freeze-the-deal FR-005: the event's deal before (its old PRIMARY
    // terms) and after (the booking's), when the deal was frozen.
    return recordDealChange(tx, fence, {
      actorHumanId: input.actorHumanId,
      at: now,
    });
  });

  // freeze-the-deal FR-006: after the commit. Best effort: never throws.
  if (change) await notifyDealChange(deps, change);

  logger?.info("booking_agreements.finalized", {
    agreementId: agreement.id,
    eventId: input.eventId,
    payoutTermsId,
    actorHumanId: input.actorHumanId,
  });

  return finalizeBookingAgreementOutputSchema.parse({
    agreementId: agreement.id,
    eventId: input.eventId,
    payoutTermsId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finalize's deterministic, read-only gates — the single source for this use
 * case AND for the booking mint's plan (`planAgreementMint`), which runs them
 * before a booking takes a line when the mint will finalize. In order:
 *   1. the actor is a party with an edit role (NOT_AGREEMENT_PARTY);
 *   2. the terms are ACCEPTED (AGREEMENT_NOT_ACCEPTED), not linked to
 *      another event (AGREEMENT_LINKED_TO_OTHER_EVENT), and carry payout
 *      terms (AGREEMENT_MISSING_PAYOUT_TERMS);
 *   3. for an EXISTING event not yet linked here: the actor may stamp payout
 *      terms on it (INSUFFICIENT_ROLE / NOT_RESOURCE_OWNER / EVENT_NOT_FOUND
 *      / EVENT_ARCHIVED), and no other agreement is linked to it
 *      (`event_already_has_agreement`).
 * `eventId: null` = the event is about to be minted by this actor (the
 * mint's own counterparty gates cover step 3 for it). Returns the payout
 * terms id. The line / payee gates (`lines_unconfirmed`, `payee_not_ready`)
 * are designed "finalize later" outcomes, not refusals, and stay in the use
 * case.
 */
export async function assertFinalizeGates(
  repos: Pick<Repos, "authz" | "events" | "agreements">,
  args: {
    agreement: AgreementRecord;
    eventId: string | null;
    actorHumanId: string;
  },
): Promise<string> {
  const { agreement, eventId, actorHumanId } = args;
  await requireAgreementParty(repos, {
    agreement,
    actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  const payoutTermsId = requireFinalizableAgreement(agreement, eventId);
  if (eventId === null || agreement.eventId === eventId) {
    return payoutTermsId;
  }
  await ensureEventEditable({ repos }, eventId, actorHumanId);
  const linked = await repos.agreements.getByEventId(eventId);
  if (linked && linked.id !== agreement.id) {
    throw {
      code: "event_already_has_agreement",
      message: "event_already_has_agreement",
      meta: { existingAgreementId: linked.id },
    } as const;
  }
  return payoutTermsId;
}

function requireFinalizableAgreement(
  agreement: AgreementRecord,
  eventId: string | null,
): string {
  if (agreement.status !== "ACCEPTED") {
    throw fail("AGREEMENT_NOT_ACCEPTED");
  }
  if (agreement.eventId && agreement.eventId !== eventId) {
    throw fail("AGREEMENT_LINKED_TO_OTHER_EVENT");
  }
  if (!agreement.payoutTermsId) {
    throw fail("AGREEMENT_MISSING_PAYOUT_TERMS");
  }
  return agreement.payoutTermsId;
}

/**
 * Stamping payout terms on an event is an event-owner action (org event →
 * edit/finance role; human event → the owner; ARCHIVED events can't take
 * terms). The since-deleted `upsertAgreementForEvent` used the same rule.
 */
async function ensureEventEditable(
  deps: { repos: Pick<Repos, "events" | "authz"> },
  eventId: string,
  actorHumanId: string,
): Promise<void> {
  const event = await deps.repos.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_OR_FINANCE_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else if (event.humanId !== actorHumanId) {
    // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28) — see
    // `ensurePayoutRoutingActor` in `lib/event-edit-rights.ts`.
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
  }

  if (event.status === "ARCHIVED") {
    throw fail("EVENT_ARCHIVED");
  }
}

function assertLinesConfirmed(lines: PayoutTermsLineRecord[]): void {
  const pending = lines.filter(
    (line) =>
      line.requiresConfirmation && line.confirmationStatus !== "CONFIRMED",
  );
  if (pending.length > 0) {
    throw {
      code: "lines_unconfirmed",
      message: "lines_unconfirmed",
      meta: {
        pendingPayeeIds: pending.map((line) => line.payeeId),
        pendingLineIds: pending.map((line) => line.id),
      },
    } as const;
  }
}

/**
 * Draft lines tolerate PENDING payees; at finalize money becomes routable so
 * every payee must be ACTIVE with payouts AND charges enabled (the same bar
 * as `ensurePayeesActive`, surfaced as `payee_not_ready` →
 * PRECONDITION_FAILED so the editor can prompt Connect onboarding).
 */
async function assertPayeesReady(
  payees: Repos["payees"],
  lines: PayoutTermsLineRecord[],
): Promise<void> {
  if (lines.length === 0) return;

  const payeeIds = [...new Set(lines.map((line) => line.payeeId))];
  const records = await payees.getByIds(payeeIds);
  const byId = new Map(records.map((payee) => [payee.id, payee]));

  const notReady = payeeIds.filter((id) => {
    const payee = byId.get(id);
    return (
      !payee ||
      payee.status !== "ACTIVE" ||
      !payee.payoutsEnabled ||
      !payee.chargesEnabled
    );
  });

  if (notReady.length > 0) {
    throw {
      code: "payee_not_ready",
      message: "payee_not_ready",
      meta: { payeeIds: notReady },
    } as const;
  }
}

/**
 * The booking behind the agreement decides which event it may be finalized
 * against (booking-the-night P2c, review rounds 1 and 2): the booking's terms,
 * hold and event live and die together, so a link to the wrong show would let
 * Cancel booking (or anything reading the booking's event) act on it.
 *   - EVENT-FIRST (the request has an `originEventId`): only that event.
 *     Anything else is EVENT_FIRST_REQUIRES_ORIGIN_EVENT;
 *   - (request to a venue) a LIVE draft anchor other than the event being
 *     finalized to is never dropped (review round 3, B2): the booking would
 *     then point at two live events and Cancel booking would cancel one and
 *     free the night under the other — BOOKING_HAS_MULTIPLE_EVENTS. The
 *     agreement is RE-READ under the locks for this, so an anchor a racing
 *     mint set after the pre-flight read is caught too. A dead anchor is
 *     retired by the link write as before;
 *   - (request to a venue) the event must belong to the VENUE side or the
 *     SENDER pair (review round 3, W1a): a third party's event is never
 *     linked to a booking — EVENT_OWNER_NOT_BOOKING_PARTY;
 *   - a BOOKED night (a CONFIRMED hold on a request to a venue): the event must
 *     sit on that hold's line — its place-local day and, when the event names
 *     one, its calendar — else HOLD_DATE_MISMATCHES_EVENT /
 *     EVENT_ON_ANOTHER_CALENDAR.
 * No request, or an organiser's request without an origin: nothing to check.
 * The refusals follow the FINALIZER's side — venue: the codes above with the
 * event / calendar ids; sender (the act): the meta-free twins
 * (EVENT_ON_ANOTHER_NIGHT, EVENT_FIRST_REQUIRES_ORIGIN_EVENT, and the bare
 * BOOKING_HAS_MULTIPLE_EVENTS / EVENT_OWNER_NOT_BOOKING_PARTY), nothing of the
 * venue's calendar structure or event ids (booking-holds FR-013).
 *
 * Called twice: read-only before the transaction (fast fail; `tx` null), and
 * authoritatively inside it (`tx` set), where the CALLER already holds the
 * event row and this takes the request's booking lock and the booked line.
 *
 * Returns the agreement the checks were decided on: inside the transaction,
 * a re-read taken after the locks (P2d-2, carry b — the link write fences on
 * its `draftEventId` and retires the anchor from it); outside, the caller's.
 */
async function assertFinalizeEventMatchesBooking(
  repos: Omit<FinalizeBookingAgreementDeps["repos"], "tx">,
  args: {
    agreement: AgreementRecord;
    eventId: string;
    actorHumanId: string;
    tx: TxRepos | null;
  },
): Promise<AgreementRecord> {
  const { agreement, eventId, tx } = args;
  const reread = async (): Promise<AgreementRecord> =>
    tx ? ((await repos.agreements.getById(agreement.id)) ?? agreement) : agreement;
  const request = await repos.bookingRequests.findByAgreementId(agreement.id);
  if (!request) return reread();
  if (tx) {
    // Event row → booking lock → lines (never the reverse: Cancel booking and
    // publish hold the event row first). The caller already holds the event
    // row FOR UPDATE (`finalizeInternal` takes it first in the transaction).
    await tx.bookingHolds.lockRequestBooking(request.id);
  }

  const party = await requireAgreementParty(repos, {
    agreement,
    actorHumanId: args.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  const side =
    bookingThreadSideForAgreementSide(request, agreement, party.side) ===
    "PERFORMER"
      ? ("sender" as const)
      : ("venue" as const);

  if (request.originEventId && request.originEventId !== eventId) {
    if (side === "sender") throw fail("EVENT_FIRST_REQUIRES_ORIGIN_EVENT");
    throw fail("EVENT_FIRST_REQUIRES_ORIGIN_EVENT", {
      meta: {
        agreementId: agreement.id,
        eventId,
        originEventId: request.originEventId,
      },
    });
  }

  if (request.direction !== "TO_VENUE") return reread();

  // A live draft anchor beside the event being linked (B2). Under the locks
  // the agreement is re-read: the anchor may have been set since the
  // pre-flight read (a mint racing this finalize). A mint landing AFTER
  // this re-read is caught by the link write's `expectedDraftEventId`.
  const current = await reread();
  if (current.draftEventId && current.draftEventId !== eventId) {
    const draft = await repos.events.getById(current.draftEventId);
    if (isLiveBookingEvent(draft)) {
      failBookingHasMultipleEvents({
        side,
        bookingRequestId: request.id,
        eventIds: [current.draftEventId, eventId],
      });
    }
  }

  const event = await repos.events.getById(eventId);
  if (!event) return current; // the finalize gates already refused a missing event
  const place = await repos.places.getById(request.placeId);
  // The event must be one party's (W1a). A request to a venue always has its
  // place; a missing row is a corrupt fixture, and the owner check needs the
  // place's owners, so it is the one thing skipped without one.
  if (place && bookingEventOwningSide(event, place, request) === "neither") {
    failEventOwnerNotBookingParty({ side, agreementId: agreement.id, eventId });
  }

  const holds = await repos.bookingHolds.listForRequest(request.id);
  const booked = holds.find((h) => h.status === "CONFIRMED");
  if (!booked) return current;
  if (tx) {
    await lockLines(tx, lineKeysOf([booked]));
  }
  assertBookingEventOnNight(
    { kind: "event", event },
    {
      night: booked.date,
      placeTz: resolveBookingTimezone(place?.timezone ?? null),
      side,
      agreementId: agreement.id,
      calendarId: booked.calendarId,
    },
  );
  return current;
}
