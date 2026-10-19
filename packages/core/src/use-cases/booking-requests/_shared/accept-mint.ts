import type { LoggerPort } from "@th/ports/logger";
import type { CalendarWithSpacesRow } from "@th/ports/repos/calendars";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { TxRepos } from "@th/ports/repos";
import type { BookingHoldRecord } from "@th/types/repos/booking-holds";
import { fail } from "@th/errors";
import { z } from "zod";

import { parseInput } from "../../../lib/io";
import { plainTextRequired } from "../../../lib/sanitize-plain-text";
import {
  addSetLength,
  anchorPreferredDate,
  DEFAULT_EVENT_DURATION_HOURS,
  parsePreferredDateEntry,
  resolveBookingTimezone,
} from "../../booking-agreements/_shared/pitch-seed";
import { ensureLoadedPlaceAccessible } from "../../events/_shared/place-access";
import {
  prepareEventTaxRate,
  type PreparedEventTaxRate,
} from "../../events/_shared/resolve-event-tax-rate";
import {
  ensureEndsAfterStarts,
  finalizeSaveEventInCallerTx,
  saveEventTaxRateLocationRef,
  type FinalizeParams,
  type NormalizedLocation,
  type OwnerContext,
  type SaveEventDeps,
  type SaveEventOutput,
} from "../../events/_shared/save-event-shared";
import type { BookingAgreementCounterparty } from "./accept-agreement";
import type { PlaceBookingAuthorityResult } from "./place-access";
import {
  deriveVenueBookingParty,
  ownerContextForVenueBookingParty,
} from "./venue-booking-party";

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPT MINT (FR-001 step 6, docs/specs/2026-09-05/
// booking-accept-is-the-mint-point.spec.md). "Accept is the pen": when a venue
// books a held night, the event is minted INSIDE the accept transaction, so
// either the whole booking happened or none of it did.
//
// WHY THIS MODULE EXISTS AT ALL. `finalizeSaveEventInCallerTx` (FR-004) can
// join a caller's transaction, but its docblock lists FIVE THINGS A CALLER
// OWNS — and one of them is AUTHORIZATION: nothing inside the save checks that
// `params.owner` may attach to `params.location.placeId`, because on the
// standalone path the `saveEventForOrg` / `saveEventForHuman` wrappers did it
// first. FR-001 mints under a party who is NOT always the actor, which is
// exactly the case where "the wrapper did it" stops being true. Leaving the
// accept procedure to remember five separate obligations — one of them a
// security check whose omission is silent — is how that goes wrong once.
//
// So core grows ONE purpose-built entry point for the accept mint and the
// accept procedure cannot assemble it wrongly.
//
// THREE PHASES, AND EACH PHASE'S OUTPUT IS THE ONLY WAY TO REACH THE NEXT:
//
//   const plan    = await prepareBookingAcceptMint(deps, input); // BEFORE the tx
//   // caller: opens tx, locks lines, settles, takes the line, accepts
//   const minted  = await plan.mintInTx(tx);                     // INSIDE the tx
//   // caller: commits
//   const result  = await minted.runAfterCommit();               // AFTER the commit
//
// You cannot reach `mintInTx` without `prepareBookingAcceptMint` having run
// (it is the only producer of a {@link BookingAcceptMintPlan}), cannot reach
// `runAfterCommit` without minting (only `mintInTx` produces a
// {@link MintedBookingAcceptEvent}), and cannot get the save's output — the
// notification intents included — without draining the deferred work, because
// `runAfterCommit` is the only thing that returns it. The obligations are not
// a checklist any more; they are the call graph.
//
// WHAT THE PHASES COST YOU IF YOU IGNORE THE ORDER. `mintInTx` refuses a
// non-transactional bag (the root `Repos` carries `.tx`, a `TxRepos` never
// does — the one structural tell TypeScript cannot use, since `Repos` is
// assignable to `TxRepos` through a named variable) and refuses a second call.
// `runAfterCommit` is idempotent: draining twice would log a duplicate
// `event.slug_assigned` audit row, so the second call returns the first
// result.
//
// WHAT THIS DOES NOT OWN — deliberately, and the caller MUST do all of it:
//
//  · THE IDEMPOTENCY ENVELOPE. FR-005 gives the whole accept exactly ONE:
//    `bookingRequest:accept:<requestId>`, `begin(key, 120)` — never shorter
//    than the transaction ceiling, or a lock that expires mid-transaction lets
//    a retry start a second one. There is no inner envelope here and there
//    must not be: two nested envelopes over one transaction is a deadlock
//    waiting to be discovered in production.
//  · HOLD-LINE LOCKING, `settleLine`, `takeLine`. Take the advisory locks
//    FIRST, in the global sorted order (`booking-holds/_shared/hold-line.ts`),
//    and only then open anything here — see lock-order note 4 on
//    `FinalizeSaveEventInCallerTxParams` for the row locks this save then adds
//    and holds for the rest of YOUR transaction.
//  · `acceptBookingRequestInTx` — the request status CAS, the agreement, the
//    payout terms. This mint runs AFTER it (FR-001 step 5, then step 6).
//  · THE LEDGER AND AUDIT FOR THE ACCEPT (`booking_hold.confirmed` carrying
//    the real `eventId`, FR-001 step 7). `minted.eventId` is readable inside
//    the transaction precisely so that entry can carry it.
//  · NOTIFICATION DISPATCH. Intents ride out as data and the transport sends
//    them after the use case resolves, exactly as today.
//
// ONE PARTY, TWO USES. `plan.venueParty` is the Agreement's venue-side
// counterparty AND the owner this event is minted under — derived once, by
// `deriveVenueBookingParty` (FR-006), and exposed on the plan so FR-001 step 5
// can stamp the agreement with the same answer step 6 mints under. Same for
// `plan.startsAt` / `plan.endsAt`: the agreement header's `proposedDate` is the
// hold's night (FR-001 step 5's one change), and it is THIS instant, so the
// agreement and the event can never disagree about when the show is.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the mint needs from the composition root — the save's own bag. */
export type BookingAcceptMintDeps = SaveEventDeps;

/**
 * The FIFTH caller obligation, discharged here rather than named and left on
 * the caller — which would rebuild the checklist this module deletes.
 *
 * `FinalizeSaveEventInCallerTxParams` lists "the Zod parse that sanitizes free
 * text through `plainTextRequired`" among the wrapper checks that do NOT run
 * inside the save. `FinalizeParams.title` is a bare `string`, and
 * `runSaveEventTxBody` writes it verbatim into `Event.title`, an unbounded
 * text column. `baseSaveEventInputSchema` (`save-event-shared.ts:163`) applies
 * `plainTextRequired(140)` on the wrapper path, so every save that goes
 * through `saveEventForOrg` / `saveEventForHuman` gets tags stripped to a
 * fixpoint, bidi and zero-width characters removed, and a 1..140 bound. A
 * caller-tx save gets none of that unless it does this.
 *
 * The reachable path is not hypothetical: an anonymous embed inquiry's
 * `actName` is bounded `min(1).max(120)` with no `plainText*` anywhere, and
 * FR-001 composes the accept's title out of it the way `buildDefaultTitle`
 * does. `plainTextRequired` sanitizes BEFORE it measures, so a title made
 * entirely of markup collapses to `""` and fails `min(1)` — which is the
 * correct outcome, not a truncation.
 *
 * Parsed through `parseInput` so the refusal is the same typed
 * `invalid_input` (with Zod issues) every other save path returns.
 */
const acceptMintTitleSchema = z.object({ title: plainTextRequired(140) });

export type PrepareBookingAcceptMintInput = {
  /** The staff human (or grantee) pressing Accept. */
  actorHumanId: string;
  /** The request being accepted — context for logs and the save's client key. */
  bookingRequestId: string;
  /**
   * The venue, ALREADY LOADED by the caller's authority gate. Taken rather
   * than re-read so the row that let the actor in, the row the owner is
   * derived from, and the row the attach gate checks are the same row.
   */
  place: PlaceRecord;
  /**
   * What `requirePlaceBookingAuthority` (or `requirePlaceOwnership`) answered
   * for THIS actor at THIS place. The owner rule needs to know how the actor
   * got in and must not guess — see {@link deriveVenueBookingParty}.
   */
  ownership: Pick<PlaceBookingAuthorityResult, "via" | "orgId">;
  /** The held night being booked. Its calendar and date anchor the event. */
  hold: Pick<BookingHoldRecord, "id" | "calendarId" | "spaceId" | "date">;
  /**
   * The event's title. Composed by the caller — it is the one thing here that
   * needs the act's name — and SANITIZED HERE, not by the caller. See
   * {@link acceptMintTitleSchema}.
   */
  title: string;
  /**
   * The pitch's set length. Seeds `endsAt` through the SAME `addSetLength` the
   * agreement header's `proposedEndDate` is seeded with, so the event's
   * duration and the agreement's cannot disagree. Null / absent → the platform
   * fallback show length.
   */
  setLengthMinutes?: number | null;
  /**
   * The request's `preferredDates`. A TIMED entry (`YYYY-MM-DDTHH:MM`) whose
   * day IS the hold's night means the act picked that slot out of the venue's
   * published availability, and it outranks the calendar default — the same
   * precedence `confirmBookingHold` applies today, carried over so FR-002's
   * retirement of that entry point is not a silent behaviour change. First
   * timed entry on the day wins: picker order is the act's own preference.
   */
  preferredDates?: readonly string[];
  /**
   * The space, when the accept dialog asked for one ("room" only in the copy
   * the dialog shows — CONTEXT.md). Absent / null → derived: the hold's own
   * space, else the calendar's first active space, else the place's default
   * calendar's — else spaceless.
   */
  spaceId?: string | null;
};

/**
 * Phase 1's output: everything decided BEFORE the caller's transaction opens —
 * who owns the booking, when the show is, where in the venue it sits, and the
 * admission tax rate (resolved here precisely because a cache miss reaches the
 * tax provider over HTTP, and P-1 exists to keep that call out of a
 * transaction holding advisory locks on hold lines).
 *
 * The fields are readable, not just carriable: FR-001 step 5 stamps the
 * agreement from `venueParty`, `startsAt` and `endsAt` before step 6 calls
 * {@link mintInTx}.
 */
export type BookingAcceptMintPlan = {
  /** The Agreement's venue-side counterparty AND the event's owner (FR-006). */
  readonly venueParty: BookingAgreementCounterparty;
  /** The same party in the save's vocabulary. */
  readonly owner: OwnerContext;
  /** The hold's night as an instant, in the place's zone. */
  readonly startsAt: Date;
  /** `startsAt` + the pitched set length, else the fallback show length. */
  readonly endsAt: Date;
  /** The `Event.timezone` label, always the zone `startsAt` was anchored in. */
  readonly timezone: string;
  /** Always the HOLD's calendar. */
  readonly calendarId: string;
  /** The resolved space, or null when the venue has no active space to give. */
  readonly spaceId: string | null;
  /**
   * Mint the draft, inside the transaction the caller has already opened and
   * already taken its hold-line locks in.
   *
   * @throws when handed a non-transactional repo bag, or when called twice.
   */
  mintInTx(tx: TxRepos): Promise<MintedBookingAcceptEvent>;
};

/**
 * Phase 2's output. `eventId` is readable immediately because the caller needs
 * it INSIDE the transaction — the `booking_hold.confirmed` ledger entry carries
 * it (FR-001 step 7) and the agreement's draft-event link is stamped with it.
 * Everything else waits for the commit.
 */
export type MintedBookingAcceptEvent = {
  readonly eventId: string;
  /**
   * Drain the save's deferred post-commit work and hand back its output.
   *
   * CALL THIS AFTER YOUR COMMIT — and this is the ONE ordering rule in the
   * three-phase handoff that no type and no runtime guard enforces.
   *
   * THE FAILURE. This handle is returned from inside your transaction, so it
   * is callable there. Called there, `assignSlugOnCreate` opens a FRESH
   * transaction off the root Prisma client, which blocks on the hold-line
   * advisory locks your transaction still holds, waits out Prisma's `maxWait`
   * (10s) and dies — taking a connection with it, and rolling back an accept
   * that had otherwise succeeded. It is the worst of the three misuses and the
   * only one with no tell.
   *
   * WHY THERE IS NO GUARD. A guard would have to answer "has the caller's
   * transaction committed", and nothing reachable from here knows. The
   * candidates were weighed and rejected: probing the recorded `tx` handle with
   * a throwaway read (Prisma throws once a transaction is closed) makes every
   * drain pay a query, depends on adapter error text, and is a false positive
   * against any fake — whose handle never closes — so it would refuse in every
   * test and be untestable where it matters. Taking a "committed" signal as an
   * argument only moves the same trust to a boolean the caller can pass
   * wrongly. Owning the transaction would close it properly and is exactly what
   * FR-004 forbids. So: prose, plus a test that demonstrates the hazard
   * (`accept-mint.test.ts`, "draining inside the caller's transaction").
   *
   * Skipping it entirely is the benign end of the range — a slugless draft
   * whose public page 500s on the builder's own "open preview" link, repaired
   * by `backfill-event-slugs.ts` — which is why the save's output sits behind
   * it rather than beside it.
   *
   * Best-effort by construction (the step swallows and reports its own
   * failures) and safe to call twice: the second call returns the first result
   * without re-running anything.
   */
  runAfterCommit(): Promise<BookingAcceptMintResult>;
};

/** Phase 3's output: the save's own, intents included. */
export type BookingAcceptMintResult = SaveEventOutput;

/**
 * PHASE 1. Everything the accept mint can decide before a transaction exists:
 * the owner rule, the attach gate, the times, the placement, and the tax rate.
 *
 * Does NO writes. Every refusal here happens before the caller has released a
 * single competing hold, which is the point of doing it first: the accept
 * transaction is irreversible for the acts it bumps off the night.
 *
 * @throws `{ code: "NOT_RESOURCE_OWNER" }` when no venue party can be derived.
 * @throws `{ code: "PLACE_NOT_FOUND" }` when the derived owner is somehow not
 *   on the place's access list (unreachable by construction — see
 *   {@link deriveVenueBookingParty}'s invariant — and kept as an assertion
 *   because the failure it guards is silent: a third-party mint creates a
 *   `BookingRequest` inside the caller's transaction).
 * @throws `{ code: "PLACE_NOT_ACTIVE" }` when the venue is suspended / retired.
 * @throws `{ code: "CALENDAR_NOT_FOUND" }` when the hold names a calendar this
 *   place does not have.
 * @throws `{ code: "INVALID_STATUS" }` when the hold's date cannot be anchored.
 * @throws `{ code: "invalid_input" }` when the derived span is not positive, or
 *   when the title is empty / over-long once sanitized.
 */
export async function prepareBookingAcceptMint(
  deps: BookingAcceptMintDeps,
  input: PrepareBookingAcceptMintInput,
): Promise<BookingAcceptMintPlan> {
  const logger = deps.logger;
  const { place, hold } = input;
  const logContext = {
    bookingRequestId: input.bookingRequestId,
    holdId: hold.id,
    placeId: place.id,
    actorHumanId: input.actorHumanId,
  };

  // ── Who owns this booking (FR-006) ───────────────────────────────────────
  // The free text, cleaned before anything else looks at it — see
  // {@link acceptMintTitleSchema} for why this lives here and not on the
  // caller.
  const { title } = parseInput(acceptMintTitleSchema, { title: input.title });

  const venueParty = deriveVenueBookingParty(
    input.ownership,
    place,
    input.actorHumanId,
  );
  const owner = ownerContextForVenueBookingParty(venueParty);

  // ── The attach gate, on the DERIVED OWNER — not the actor ────────────────
  // The check `saveEventForOrg` / `saveEventForHuman` run before they call the
  // save, and which does NOT run inside `finalizeSaveEventInCallerTx` (the
  // fifth thing a caller owns).
  //
  // `ensureLoadedPlaceAccessible`, not `ensureLoadedPlaceAttachable`: the
  // attachable rule's second arm lets a NON-owner name any ACTIVE place as a
  // third party, and a third-party mint is not a thing an accept can ever be.
  // It would also drag `createBookingRequestFromEvent` into the caller's
  // transaction — a BookingRequest row lock the accept already holds, taken a
  // second time on a row set the caller thought it had bounded. The two rules
  // are identical for a derived owner (who is on the access list by
  // construction), so this costs nothing and shuts that door for any party
  // that is still an owner at mint time.
  //
  // NOT a total guarantee, and the residual is inherent to the phase split
  // rather than to this gate: the save re-reads the place through `tx` to
  // classify trust, so a `PlaceOwnership` revoked between phase 1 and
  // `mintInTx` flips the classification to third_party and the save creates
  // the booking request inside the caller's transaction after all. Vanishingly
  // narrow — a revocation landing inside one accept transaction's window — and
  // closing it would mean re-deriving the owner from the in-tx row, which
  // moves the authorization decision inside the transaction it is supposed to
  // gate.
  ensureLoadedPlaceAccessible(place, owner);

  // ── When (FR-001 step 6) ─────────────────────────────────────────────────
  // The venue's address-derived zone anchors the wall clock AND is stored on
  // the event, always together, so the instant and the label it displays with
  // can never disagree. A missing or malformed zone degrades to the platform
  // default — the column is free text at the DB level and a garbage value must
  // never fail a booking.
  const timezone = resolveBookingTimezone(place.timezone);

  const routing = await resolveHoldCalendarRouting(deps, logger, input, logContext);

  // TIME precedence: a slot the act NAMED on the hold's night → the HOLD's
  // calendar `defaultStartTime` → 19:00 (`anchorPreferredDate`). The hold's
  // calendar, never the request's routed one: the venue moved the booking to
  // this calendar by holding it there.
  const namedSlotOnHoldDate = (input.preferredDates ?? []).find((entry) => {
    const parts = parsePreferredDateEntry(entry);
    return parts?.date === hold.date && parts.time !== null;
  });
  const startsAt = anchorPreferredDate(
    namedSlotOnHoldDate ?? hold.date,
    timezone,
    routing.defaultStartTime,
  );
  if (!startsAt) {
    // An impossible day (`2026-02-31`) on a stored hold. Refused before the
    // caller writes anything.
    throw fail("INVALID_STATUS", {
      message: "hold_date_unanchorable",
      meta: { holdId: hold.id, date: hold.date },
    });
  }

  // The span the agreement header will be seeded with, computed the same way
  // (`addSetLength`) so the two cannot differ; the fallback show length when
  // the pitch measured nothing.
  const endsAt =
    addSetLength(startsAt, input.setLengthMinutes ?? null) ??
    new Date(startsAt.getTime() + DEFAULT_EVENT_DURATION_HOURS * 60 * 60 * 1000);
  ensureEndsAfterStarts(startsAt, endsAt);

  // ── Where (FR-001 step 6, "Space") ───────────────────────────────────────
  const spaceId = input.spaceId ?? routing.fallbackSpaceId;
  if (spaceId === null) {
    reportSpacelessMint(deps, logger, logContext, routing.spacelessReason);
  }

  // ── The tax rate, BEFORE the transaction (P-1) ───────────────────────────
  // A cache miss reaches the provider — in production a live ZipTax call with
  // a 5s timeout. Resolving it inside the caller's transaction would put that
  // call inside a transaction holding advisory locks on hold lines: one
  // venue's slow third party becomes another venue's hung inbox.
  //
  // Built with `saveEventTaxRateLocationRef`, NOT `eventTaxRateLocationRef`:
  // the latter reads an event's PERSISTED columns (there is no event yet) and
  // its inline arm demands postal code AND country. A place-linked mint takes
  // the `place` arm of either, but the helper the save's own contract names is
  // the one that stays correct if this ever mints anywhere else.
  const location: NormalizedLocation = { kind: "place", placeId: place.id };
  const preparedTaxRate: PreparedEventTaxRate = await prepareEventTaxRate(
    {
      taxRateLookup: deps.taxRateLookup ?? null,
      clock: deps.clock,
      reportError: deps.reportError,
    },
    deps.repos,
    // No freeform SavedLocation: a place-linked save never has one.
    saveEventTaxRateLocationRef(location, null),
    logger,
    logContext,
  );

  const params: FinalizeParams = {
    owner,
    actorHumanId: input.actorHumanId,
    // ALWAYS a create. Never pass an existing event here: the FR-018
    // held-dates settle inside the save body is gated on
    // `existingEvent && status === "PUBLISHED"` and takes `lockLines` of its
    // OWN, which would be a line lock taken outside the caller's pre-locked
    // set — out of order, and a deadlock (see lock-order note 4 on
    // `FinalizeSaveEventInCallerTxParams`).
    eventId: null,
    existingEvent: null,
    title,
    startsAt,
    endsAt,
    location,
    timezone,
    calendarId: hold.calendarId,
    spaceId,
    // Deterministic, and the same string FR-005's envelope is keyed on, so a
    // retry of the same accept hashes to the same payload.
    clientKey: `bookingRequest:accept:${input.bookingRequestId}`,
  };

  return makePlan(deps, logger, params, preparedTaxRate, {
    venueParty,
    owner,
    startsAt,
    endsAt,
    timezone,
    calendarId: hold.calendarId,
    spaceId,
  });
}

/** The plan's read-only half, so {@link makePlan} takes it as one bag. */
type BookingAcceptMintFacts = Omit<BookingAcceptMintPlan, "mintInTx">;

function makePlan(
  deps: BookingAcceptMintDeps,
  logger: LoggerPort | undefined,
  params: FinalizeParams,
  preparedTaxRate: PreparedEventTaxRate,
  facts: BookingAcceptMintFacts,
): BookingAcceptMintPlan {
  let minted = false;

  return {
    ...facts,
    async mintInTx(tx: TxRepos): Promise<MintedBookingAcceptEvent> {
      // A TxRepos is structurally `Omit<Repos, "tx">`, so the ROOT bag is
      // assignable to it through a named variable and TypeScript cannot catch
      // `plan.mintInTx(deps.repos)`. The extra property IS the tell, and this
      // is the same guard `finalizeSaveEvent` carries for the mirror-image
      // mistake. Loud, and before any write: a save that quietly ran off the
      // root bag would commit the event independently of the accept, which is
      // the atomicity this whole spec exists to establish.
      if ("tx" in (tx as object)) {
        throw new Error(
          "prepareBookingAcceptMint: `mintInTx` was handed a repo bag that " +
            "has `.tx` — that is the ROOT `Repos`, not a transaction handle. " +
            "The mint must run inside the accept transaction; a save on the " +
            "root bag commits independently of the accept, so a later " +
            "rollback would leave a live event for a booking that never " +
            "happened. Pass the `tx` your `repos.tx(async (tx) => …)` gave you.",
        );
      }
      if (minted) {
        throw new Error(
          "prepareBookingAcceptMint: `mintInTx` was called twice on one plan. " +
            "The second call would upsert a second draft inside the same " +
            "transaction. One accept mints one event; build a fresh plan for " +
            "a fresh mint.",
        );
      }
      minted = true;

      const saved = await finalizeSaveEventInCallerTx(deps, logger, {
        ...params,
        tx,
        preparedTaxRate,
      });

      const { deferred, ...output } = saved;
      let drained: BookingAcceptMintResult | null = null;

      return {
        eventId: output.eventId,
        async runAfterCommit(): Promise<BookingAcceptMintResult> {
          // Idempotent: `assignSlugOnCreate` derives the identical slug on a
          // second run (it reuses the stored `shortId`), but it logs its audit
          // row unconditionally — so draining twice would leave a duplicate
          // `event.slug_assigned` entry on the event's trail.
          if (drained) return drained;
          await deferred.runAfterCommit();
          drained = output;
          return output;
        },
      };
    },
  };
}

/**
 * What the hold's calendar says about start time and space, plus the space the
 * placement falls back to.
 */
type HoldCalendarRouting = {
  /** The hold calendar's `defaultStartTime` ("HH:mm"), or null for 19:00. */
  defaultStartTime: string | null;
  /**
   * The space to use when the accept dialog named none: the hold's own space
   * (when it is still an ACTIVE space of that calendar) → the calendar's first
   * ACTIVE space → the place's DEFAULT calendar's first ACTIVE space → null.
   */
  fallbackSpaceId: string | null;
  /** Why `fallbackSpaceId` is null, for the report. Null when it is not. */
  spacelessReason: string | null;
};

/**
 * The hold's calendar, its default show time, and the space the event lands in.
 *
 * THE CALENDAR IS ALWAYS THE HOLD'S. FR-001 step 6 says the event is created
 * "on the hold's calendar" and then describes the space fallback as
 * `resolveFallbackPlacement` ("the place's default calendar + first active
 * space") — read literally those two move the booking to a different calendar
 * than the venue held it on. They do not conflict once you notice the fallback
 * is about the SPACE: a calendar is how a venue programmes, a space is where
 * the show physically happens (CONTEXT.md), and only the second one is missing
 * when a calendar has no active space. So the calendar never moves off the hold and
 * the space falls through to the default calendar's, which is exactly what
 * `resolveFallbackPlacement` contributes in `createEventFromAgreement`.
 *
 * Read through `listByPlace` so the SAME-PLACE assert is structural — a
 * cross-place or deleted calendar id simply is not in the place's list — the
 * posture `resolveCalendarRouting` and `resolveFallbackPlacement` already use.
 * Unlike them, an unresolvable HOLD calendar is REFUSED rather than degraded:
 * `resolveVenuePlacement` inside the save would throw `CALENDAR_NOT_FOUND`
 * mid-transaction and roll the whole accept back, so finding it out here — with
 * no competitor holds released yet — is strictly better.
 *
 * DELIBERATE SWALLOW on a thrown read (ReporterPort convention): the calendars
 * repo being down must not turn into a bogus `CALENDAR_NOT_FOUND` refusal, and
 * it must not fail a booking over a default show time. It degrades to "19:00,
 * spaceless" and is logged at error AND reported; a throwing reporter changes
 * nothing.
 *
 * WHAT THAT DEGRADE COSTS, stated because nothing surfaces it to the venue:
 * the show SILENTLY MOVES from the calendar's `defaultStartTime` to 19:00, and
 * the event lands outside the space system. Both are editable afterwards and
 * neither is worth refusing a booking over, but the `reportError` is the only
 * signal anyone gets — which is why it is `logger.error` plus a report and
 * must never be demoted to `warn` (warn is not captured).
 */
async function resolveHoldCalendarRouting(
  deps: BookingAcceptMintDeps,
  logger: LoggerPort | undefined,
  input: PrepareBookingAcceptMintInput,
  logContext: Record<string, unknown>,
): Promise<HoldCalendarRouting> {
  let calendars: CalendarWithSpacesRow[];
  try {
    calendars = await deps.repos.calendars.listByPlace(input.place.id);
  } catch (error) {
    logger?.error("booking_requests.accept_mint.calendar_routing_failed", {
      ...logContext,
      calendarId: input.hold.calendarId,
      err: error,
    });
    report(deps, error, { ...logContext, calendarId: input.hold.calendarId });
    return {
      defaultStartTime: null,
      fallbackSpaceId: null,
      spacelessReason: "calendar_read_failed",
    };
  }

  const holdCalendar =
    calendars.find((calendar) => calendar.id === input.hold.calendarId) ?? null;
  if (!holdCalendar) {
    throw fail("CALENDAR_NOT_FOUND", {
      meta: {
        reason: "hold_calendar_not_at_place",
        holdId: input.hold.id,
        calendarId: input.hold.calendarId,
        placeId: input.place.id,
      },
    });
  }

  // The hold's own space, when the venue still has it. `listByPlace` hydrates
  // ALL joined spaces including RETIRED ones (port posture), so the status
  // check is load-bearing: a retired space takes no new events.
  const heldSpace = input.hold.spaceId
    ? (holdCalendar.spaces.find(
        (space) => space.id === input.hold.spaceId && space.status === "ACTIVE",
      ) ?? null)
    : null;
  if (heldSpace) {
    return {
      defaultStartTime: holdCalendar.defaultStartTime,
      fallbackSpaceId: heldSpace.id,
      spacelessReason: null,
    };
  }

  const calendarSpace =
    holdCalendar.spaces.find((space) => space.status === "ACTIVE") ?? null;
  if (calendarSpace) {
    return {
      defaultStartTime: holdCalendar.defaultStartTime,
      fallbackSpaceId: calendarSpace.id,
      spacelessReason: null,
    };
  }

  // The hold's calendar has no space to give. Fall through to the place's
  // DEFAULT calendar's first active space — placement only; a default
  // calendar's template prefills stay reserved for calendars a booking was
  // actually routed to.
  const defaultCalendar = calendars.find((calendar) => calendar.isDefault) ?? null;
  const defaultSpace =
    defaultCalendar?.spaces.find((space) => space.status === "ACTIVE") ?? null;

  return {
    defaultStartTime: holdCalendar.defaultStartTime,
    fallbackSpaceId: defaultSpace?.id ?? null,
    spacelessReason: defaultSpace
      ? null
      : defaultCalendar
        ? "no_active_space_on_hold_or_default_calendar"
        : "no_active_space_and_no_default_calendar",
  };
}

/**
 * A booking that landed in no space. Error-logged AND reported rather than
 * info-logged: an event outside the space system is invisible to conflict
 * detection and to the venue's own calendar surfaces, which is an
 * operator-visible fault — the same posture `resolveFallbackPlacement` takes.
 * Never a refusal: a venue must be able to book a night before it has finished
 * modelling its spaces.
 */
function reportSpacelessMint(
  deps: BookingAcceptMintDeps,
  logger: LoggerPort | undefined,
  logContext: Record<string, unknown>,
  reason: string | null,
): void {
  logger?.error("booking_requests.accept_mint.spaceless_mint", {
    ...logContext,
    reason,
  });
  report(deps, new Error("booking_accept_spaceless_mint"), {
    ...logContext,
    reason,
  });
}

/** Guarded report — a throwing reporter must never change an outcome. */
function report(
  deps: BookingAcceptMintDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "prepareBookingAcceptMint" },
      extra,
    });
  } catch {
    // Reporting is best-effort — never let it fail a booking.
  }
}
