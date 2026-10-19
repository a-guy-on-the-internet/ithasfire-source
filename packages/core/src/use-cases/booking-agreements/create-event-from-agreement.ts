import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type {
  BookingRequestActRecord,
  BookingRequestActRole,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";
import type { CalendarWithSpacesRow } from "@th/ports/repos/calendars";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { fail, isAppError } from "@th/errors";
import { toSafeExternalUrl } from "@th/types";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import {
  billIdentityOf,
  orgPageUrlFor,
  resolveBillIdentities,
} from "../booking-requests/_shared/bill-items";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  finalizeSaveEvent,
  isoDateTimeSchema,
  normalizeLocation,
  type OwnerContext,
  type SaveEventOutput,
} from "../events/_shared/save-event-shared";
import { saveEventForOrg } from "../events/save-event-for-org";
import { saveEventForHuman } from "../events/save-event-for-human";
import {
  eventOwnerSideSchema,
  type EventOwnerSide,
} from "./_shared/event-owner-side";
import {
  anchorPreferredDate,
  DEFAULT_BOOKING_TIMEZONE,
  DEFAULT_EVENT_DURATION_HOURS,
  parsePreferredDateEntry,
  resolveBookingTimezone,
} from "./_shared/pitch-seed";
import { todayInZone } from "../booking-holds/_shared/booking-hold-lapse";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  withCommittedHoldIntents,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  assessNight,
  failNightTaken,
  resolveNightCalendarId,
  resolvePlaceCalendarId,
  withoutLapsed,
} from "../booking-holds/_shared/booking-night";
import { reportPostCommitRefusal } from "../booking-holds/_shared/post-commit-report";
import { staffRecipientHintFor } from "../booking-holds/_shared/hold-context";
import { isHoldStatusConflict } from "../booking-holds/_shared/hold-line";
import {
  takeRequestNightInTx,
  type TakeRequestNightResult,
} from "../booking-holds/_shared/take-night-for-terms";
import type { HoldLineKey } from "../booking-holds/_shared/hold-line";
import type { TxRepos } from "@th/ports/repos";
import { finalizeBookingAgreement } from "./finalize-booking-agreement";
import { isLiveBookingEvent } from "./_shared/booking-event-liveness";
import {
  HOLD_MINT_AGREEMENT_STATUSES,
  planAgreementMint,
  type AgreementMintMode,
  type AgreementMintPlan,
} from "./_shared/agreement-mint-plan";
import { assertBookingPreflight } from "./_shared/booking-preflight";
// ── P3b (asks) ──
import type { FileStoragePort } from "@th/ports/file-storage";
import { mapAskImageToEvent } from "../booking-requests/asks/map-ask-answers";

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

/**
 * Near-zero failed-marker retention for DETERMINISTIC domain failures inside
 * the idempotency envelope (same rationale + value as `claim-booking-request`
 * / `finalize-booking-agreement`): a deterministic failure re-fails
 * identically on retry, so retaining it for the adapters' default 15 minutes
 * only converts the user's retry into IDEMPOTENCY_LOCK_IN_PROGRESS.
 */
const DETERMINISTIC_FAILURE_KEEP_SECONDS = 1;

/**
 * Upper bound on the stale-generation walk (dead-draft chain). Each hop
 * requires a real, committed mint whose event was then deleted or
 * cancelled/archived (`isLiveBookingEvent`), and event ids are fresh uuids
 * (the chain cannot cycle) — this cap only guards against a corrupt
 * idempotency store looping forever.
 */
const MAX_STALE_DRAFT_GENERATIONS = 20;

// The fallback show LENGTH joined the zone fallback and the default show HOUR
// in `_shared/pitch-seed.ts` (`DEFAULT_EVENT_DURATION_HOURS` /
// `resolveBookingTimezone` / `DEFAULT_BOOKING_TIMEZONE`) — the same module the
// ACCEPT path seeds `Agreement.proposedDate` with, so "the venue's zone", "the
// default show time" and "the default show length" have exactly one definition
// each and the seeded date can never disagree with this mint's fallback. The
// zone still travels with the event: the instant we compute and the
// `Event.timezone` label it displays with are always the same value
// (venue-hierarchy FR-004; `finalizeSaveEvent` falls back identically).

const EVENT_TITLE_MAX = 140; // baseSaveEventInputSchema's title bound
const EXTERNAL_NAME_MAX = 120; // attach-event-human's externalName bound

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const createEventFromAgreementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    /** Kept minimal: everything else is edited in the standard event editor. */
    overrides: z
      .object({
        title: plainTextRequired(EVENT_TITLE_MAX).optional(),
        /** ISO datetime. Defaults to 19:00 (platform zone) on the first preferred date. */
        startsAt: isoDateTimeSchema.optional(),
      })
      .strict()
      .optional(),
    /**
     * Who owns the minted event (venue-confirmation spec "Who mints, who
     * owns"). Omitted = the default by the request's intent: PERFORM → venue,
     * RENT / USE → requester. The venue side stays the mint AUTHORITY either
     * way; only the owner assignment changes.
     */
    ownerOverride: eventOwnerSideSchema.optional(),
  })
  .strict();

export const finalizeBlockedCodeSchema = z.enum([
  "lines_unconfirmed",
  "payee_not_ready",
  /**
   * The mint is REQUESTER-owned (RENT / USE, or the venue's override): the
   * venue actor cannot finalize against an event it does not own
   * (`finalizeBookingAgreement` re-asserts edit access on the event), so no
   * attempt is made. The draft exists in the requester's admin; the
   * requester — a party to the agreement AND the event's owner — finalizes
   * through the standard FinalizeDialog once payouts are ready.
   *
   * THE DEFERRAL IS NOT FREE: `publishEvent` refuses the draft with
   * `BOOKING_TERMS_NOT_FINALIZED` (precondition_failed) while its ACCEPTED
   * booking agreement is not finalize-linked to it — otherwise publish would
   * auto-provision fresh 100%-owner terms and silently bypass whatever the
   * two sides negotiated (an 80/20 door split, say). Finalize first.
   */
  "requester_owned",
  /**
   * The event's deal is frozen (freeze-the-deal FR-004, O1): finalize onto it
   * re-points the event's PRIMARY terms, a frozen change that must be made
   * on purpose (`frozenChange`) so every payee is told. Create never makes
   * that choice for the user: the draft exists, and the editor finalizes
   * from the agreement page, where the change is confirmed.
   */
  "deal_frozen",
]);

export const createEventFromAgreementOutputSchema = z
  .object({
    eventId: z.uuid(),
    /** True when this call found an existing draft/linked event instead of minting one. */
    alreadyLinked: z.boolean(),
    /** True when the agreement is now finalize-linked (`Agreement.eventId` set, terms ACTIVE). */
    finalized: z.boolean(),
    /**
     * Present when `finalized === false`: the finalize gate that blocked the
     * link. The draft event exists either way — the existing FinalizeDialog
     * (or a repeat call of this procedure) links it once payouts are ready.
     */
    finalizeBlocked: finalizeBlockedCodeSchema.optional(),
    /**
     * SERVER-SIDE ONLY. Present when THIS call booked the night (the manual
     * mint on agreed terms, booking-the-night NFR-001): the hold notices the
     * booking owes, for the transport to dispatch. Never on the wire — see
     * {@link createEventFromAgreementWireOutputSchema}.
     */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  })
  .strict();

/** What transport puts on the wire: the booking's notices stay server-side. */
export const createEventFromAgreementWireOutputSchema = z.object(
  createEventFromAgreementOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type CreateEventFromAgreementInput = z.infer<
  typeof createEventFromAgreementInputSchema
>;

/**
 * INTERNAL hold-confirm variant (booking-holds spec FR-008) — NOT reachable
 * from the tRPC input schema above; only `confirm-booking-hold` builds it.
 * Confirming a hold mints the draft event while the agreement is still a
 * DRAFT (the accept just happened in the confirm tx), so this path skips the
 * AGREEMENT_NOT_ACCEPTED gate, places the event on the HOLD's calendar/space
 * at the hold's start, and does NOT attempt finalize (terms are not agreed).
 */
export const createEventFromAgreementForHoldArgsSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    hold: z
      .object({
        id: z.uuid(),
        calendarId: z.uuid(),
        spaceId: z.uuid().nullable(),
        /**
         * The booked night (place-local `YYYY-MM-DD`, the hold's line). An
         * existing event this mint would hand back — a live draft or the
         * event-first origin — must sit on it (review W5): checked again at
         * link time, not only in the caller's pre-flight.
         */
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /**
         * The confirmed night's instant (confirm-booking-hold: the act's
         * named time on that date → calendar default → 19:00, place zone).
         */
        startsAt: z.date(),
        /**
         * The end confirm just wrote to the agreement header (start + the
         * negotiated span / set length), or null when the header names none
         * → the event takes the standard +3h.
         */
        endsAt: z.date().nullable(),
      })
      .strict(),
    /** Pass-through to the shared mint (see the public schema). */
    ownerOverride: eventOwnerSideSchema.optional(),
  })
  .strict();

export type CreateEventFromAgreementForHoldArgs = z.infer<
  typeof createEventFromAgreementForHoldArgsSchema
>;

type HoldMintContext = CreateEventFromAgreementForHoldArgs["hold"];

/**
 * INTERNAL agree-mint variant (booking-the-night FR-001) — NOT reachable from
 * the tRPC input schema; only `respond-to-booking-agreement` builds it, after
 * the sender agreed the terms and the night was booked. It IS the public
 * path (ACCEPTED gate, the agreed `proposedDate`/`proposedEndDate`, the
 * finalize attempt) with one difference: the event is placed on the BOOKED
 * night's calendar (the confirmed hold's) rather than the request's routed
 * calendar, so the event and the hold that books its night can never sit on
 * different calendars.
 */
export const createEventFromAgreementOnNightArgsSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    night: z
      .object({
        calendarId: z.uuid(),
        spaceId: z.uuid().nullable(),
        /**
         * The booked night (place-local `YYYY-MM-DD`). A draft the agreement
         * already anchors must sit on it, or the mint refuses
         * HOLD_DATE_MISMATCHES_EVENT rather than hand back an event on
         * another night.
         */
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict(),
  })
  .strict();

export type CreateEventFromAgreementOnNightArgs = z.infer<
  typeof createEventFromAgreementOnNightArgsSchema
>;

/** Where the event goes when a booked night (or a hold) names it. */
type NightPlacement = {
  calendarId: string;
  spaceId: string | null;
  /** The booked night, when the caller knows it (agree-mint only). */
  date?: string;
};

// `HOLD_MINT_AGREEMENT_STATUSES` lives with the shared booking pre-flight
// (`_shared/booking-preflight.ts`); re-exported for existing imports.
export { HOLD_MINT_AGREEMENT_STATUSES } from "./_shared/agreement-mint-plan";

// The liveness predicate lives in `_shared/booking-event-liveness.ts` (the
// night helpers need it without importing this module); re-exported here so
// existing imports keep working.
export {
  DEAD_BOOKING_EVENT_STATUSES,
  isLiveBookingEvent,
} from "./_shared/booking-event-liveness";

export type CreateEventFromAgreementOutput = z.infer<
  typeof createEventFromAgreementOutputSchema
>;
export type FinalizeBlockedCode = z.infer<typeof finalizeBlockedCodeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type CreateEventFromAgreementDeps = {
  /**
   * Full repo bag — the event mint runs through the standard
   * `saveEventForOrg` / `saveEventForHuman` internals (quota enforcement,
   * place-layout seat materialization, tax stamping), which take `Repos`.
   */
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Threaded into the save internals for the venue's tax-rate stamp. */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * `canManagePlace`, threaded into the save internals (REQUIRED there): a
   * mint by someone who manages the place stamps the venue confirmation
   * (place-address-withholding W1). Wire it from `ctx.authz`.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
  /**
   * Best-effort reporter for the orphan-draft branch (an event committed by
   * the save whose anchor stamp then lost a race) — ReporterPort convention.
   */
  reportError?: ReporterPort;
  /**
   * Base URL of the web app. A GROUP on the lineup (v3 FR-015) is linked by
   * `orgId`, and also carries its PUBLIC page as an absolute `externalUrl`
   * (with its name as `externalName`) so a lineup reader that does not know
   * groups yet still shows a linked name, never a blank row. Absent → that
   * fallback link is null; the `orgId` link is unaffected.
   */
  publicAppUrl?: string | null;
  // ── P3b (asks) ──
  /**
   * The booking's "use as the event image" answer is copied into the minted
   * event as its hero (venue-booking-standards v1.1 V10, FR-009d) — a
   * best-effort step after the mint (`mapAskImageToEvent`, reported, never
   * failing the mint). Absent → no copy; the answer path or the next
   * "Create event" maps it.
   */
  storage?: Pick<FileStoragePort, "getObject" | "putObject" | "getObjectUrl">;
};

interface StoredCreateRecord {
  response: { eventId: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Create event from this booking" (booking-conversation-and-event-step
 * FR-006): mint a DRAFT event prefilled from an ACCEPTED agreement's booking
 * request — venue place, the NEGOTIATED date when the agreement header
 * carries one (proposedDate/proposedEndDate, falling back to the request's
 * first preferred date at a default evening time), suggested title, performer
 * attached as the headliner EventHuman — or, when the request carries a bill
 * (lineup-booking-requests v2, FR-006), every CONFIRMED act on it in order
 * (`planBookingLineup`) — then run
 * the existing `finalizeBookingAgreement` when the agreement is finalizable.
 *
 * Authorization: the actor must be on the VENUE side — a direct human owner
 * of the request's place or an owning-org member with an edit role
 * (`requirePlaceBookingAuthority`, the staff gate; the same bar as
 * respond/resend). A booking grantee is refused (holds-without-a-request
 * FR-002: minting from an act's agreement is not a booker action). Ownership of the
 * minted event follows the request's INTENT (venue-confirmation spec "Who
 * mints, who owns"; `_shared/event-owner-side.ts`), overridable by the venue
 * side via `ownerOverride`:
 * - PERFORM (default `venue`): the agreement's venue COUNTERPARTY (the
 *   durable business side derived at accept time), NOT the actor's access
 *   path —
 *   · org counterparty → `saveEventForOrg` under that org (its own
 *     ORG_EDIT_ROLES membership check gates the actor);
 *   · human counterparty → `saveEventForHuman` creates under the ACTOR, so
 *     the actor must BE the counterparty human (another direct owner of the
 *     same place gets NOT_RESOURCE_OWNER — we never mint events owned by a
 *     human who didn't ask for them).
 * - RENT / USE (default `requester`): the request's OWNED sender — that
 *   human, or that org — via the shared save internals with the owner set
 *   explicitly (see `saveRequesterOwnedEvent`). The venue is still the mint
 *   authority; the DRAFT simply lands in the requester's admin. Payout terms
 *   for a requester-owned booking are seeded requester-only at accept
 *   (`accept-agreement.ts`).
 *
 * Linkage/idempotency (deliberate design, option "draft anchor"):
 * `Agreement.eventId` stays NULL until the REAL finalize stamps it —
 * eventId-set keeps meaning "finalized" everywhere (reopen fence,
 * FinalizeDialog). The minted draft is anchored on the new
 * `Agreement.draftEventId` (unique, CAS-stamped in the same tx as the lineup
 * attach), so:
 * - a repeat call returns the existing draft and just re-attempts finalize
 *   (the "finalize once payouts are confirmed" retry converges here);
 * - a concurrent double-click is serialized by the idempotency envelope
 *   (`bookingAgreement:createEvent:<agreementId>`), with the draft-anchor CAS
 *   as the durable backstop;
 * - deleting the draft event SetNulls the anchor, letting the venue mint a
 *   fresh one. Retained idempotency records that still point at the deleted
 *   event (24h envelope / 3-day save retention) are NEVER honored: both the
 *   envelope resolution and the save call verify the replayed event still
 *   exists and otherwise advance to deterministic generation-scoped keys
 *   (`…:after:<staleEventId>`) — see `resolveCreateEnvelope`.
 *
 * Atomicity: the event mint itself commits in the save use case's own
 * envelope/tx (keyed by the generation-scoped `clientKey`, so retries
 * converge on ONE event); anchor stamp + EventHuman attach + audit run in one
 * follow-up tx; the finalize attempt is the existing use case, transactional
 * internally. A finalize blocked by its typed gates (`lines_unconfirmed`,
 * `payee_not_ready`) is the DESIGNED partial outcome for a VENUE-owned mint:
 * the draft event exists, `finalized: false` + `finalizeBlocked` tell the UI
 * to say "finalize when payouts are confirmed", and the venue may still
 * publish its own show meanwhile (publish auto-provisions default terms).
 * The REQUESTER-owned exception: finalize is never attempted
 * (`finalizeBlocked: "requester_owned"`) and publish REFUSES the draft with
 * `BOOKING_TERMS_NOT_FINALIZED` until the requester finalizes — the venue
 * side has no edit access to that event, and the negotiated terms must not
 * be replaced by an auto-provisioned 100%-owner default. Unexpected finalize
 * errors propagate.
 *
 * Cross-actor caveat (ACCEPTED risk, deliberately not defended further). It
 * depends on the save key's shape, which depends on the OWNER:
 * - ORG-owned mints (venue-org counterparty, or a requester ORG) use
 *   `saveEventForOrg:<actor>:<org>:new:<clientKey>` — the key embeds the
 *   ACTOR, so if admin A's call dies between the save commit and the anchor
 *   stamp (infra failure), a retry by a DIFFERENT venue admin B mints a
 *   second event (B's save key misses A's replay) and A's event stays an
 *   orphan draft. Reaching it requires venue-side authorization plus an
 *   infra failure; the orphan is Sentry-reported with `orphanEventId` (see
 *   the anchor-stamp catch below) and the quota cost is the owning org's.
 * - a requester-HUMAN mint uses `saveEventForHuman:<requester>:new:<clientKey>`
 *   — actor-independent, so admin B's retry replays A's save and converges
 *   on the same event; no orphan is possible on that path. (A venue-human
 *   counterparty mint is also human-keyed, but there the actor IS the owner.)
 */
export async function createEventFromAgreement(
  deps: CreateEventFromAgreementDeps,
  rawInput: unknown,
): Promise<CreateEventFromAgreementOutput> {
  const input = parseInput(createEventFromAgreementInputSchema, rawInput);
  return runCreateEventFromAgreement(deps, input, null, null);
}

/**
 * Hold-confirm entry (see {@link createEventFromAgreementForHoldArgsSchema}).
 * Same envelope, same anchor CAS, same lineup attach and ledger entry as the
 * public path — only the status gate, the placement source, the start
 * instant and the finalize attempt differ. Called POST-COMMIT by
 * `confirm-booking-hold`; idempotent on the agreement's draft anchor.
 */
export async function createEventFromAgreementForHold(
  deps: CreateEventFromAgreementDeps,
  rawArgs: unknown,
): Promise<CreateEventFromAgreementOutput> {
  const args = parseInput(createEventFromAgreementForHoldArgsSchema, rawArgs);
  return runCreateEventFromAgreement(
    deps,
    {
      actorHumanId: args.actorHumanId,
      agreementId: args.agreementId,
      ...(args.ownerOverride ? { ownerOverride: args.ownerOverride } : {}),
    },
    args.hold,
  );
}

/**
 * Agree-mint entry (see {@link createEventFromAgreementOnNightArgsSchema}).
 * Called POST-COMMIT by `respond-to-booking-agreement` as the venue person
 * who sent the terms; idempotent on the agreement's draft anchor exactly like
 * the public path, so the venue's "Create event" is its retry.
 */
export async function createEventFromAgreementOnNight(
  deps: CreateEventFromAgreementDeps,
  rawArgs: unknown,
): Promise<CreateEventFromAgreementOutput> {
  const args = parseInput(createEventFromAgreementOnNightArgsSchema, rawArgs);
  return runCreateEventFromAgreement(
    deps,
    { actorHumanId: args.actorHumanId, agreementId: args.agreementId },
    null,
    args.night,
  );
}

async function runCreateEventFromAgreement(
  deps: CreateEventFromAgreementDeps,
  input: CreateEventFromAgreementInput,
  hold: HoldMintContext | null,
  /** The booked night's calendar (agree-mint); null = the request's routing. */
  nightArg: NightPlacement | null = null,
): Promise<CreateEventFromAgreementOutput> {
  const logger = deps.logger?.child({ useCase: "createEventFromAgreement" });

  // ── Lookups ───────────────────────────────────────────────────────────────
  // Not gates: the rows the plan is made from. Every booking path holds the
  // same rows when it runs the plan before its take; a row missing here, after
  // a take, is a delete racing the booking.
  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  // Booking-specific procedure: the prefill (place, dates, performer) comes
  // from the originating booking request. Agreements minted elsewhere have
  // nothing to prefill from.
  const request = await deps.repos.bookingRequests.findByAgreementId(
    agreement.id,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND", {
      meta: {
        agreementId: agreement.id,
        reason: "agreement_has_no_booking_request",
      },
    });
  }
  const loadedPlace = request.placeId
    ? await deps.repos.places.getById(request.placeId)
    : null;
  const placeTz = placeTzOf({ timezone: loadedPlace?.timezone ?? null });
  const mode: AgreementMintMode = hold ? "hold" : nightArg ? "night" : "manual";
  const now = deps.clock.now();

  // ── The plan (agreement-mint-plan.ts) ─────────────────────────────────────
  // Every refusal this mint can raise lives in `planAgreementMint`; this body
  // only executes the plan it returns. Never add a gate here.
  const planFor = (
    placement: NightPlacement | null,
    fallbackDay: string | null = null,
  ) =>
    planAgreementMint(deps.repos, {
      mode,
      agreement,
      request,
      place: loadedPlace,
      calendarId: placement?.calendarId ?? null,
      // Only a BOOKED night (a hold's, or one this request booked) is a day a
      // handed-back event must sit on; date-less terms' fallback day is not.
      nightDate: placement?.date ?? null,
      fallbackDay,
      placeTz,
      side: "venue",
      ownerOverride: input.ownerOverride ?? null,
      startNamed: Boolean(
        input.overrides?.startsAt ?? hold?.startsAt ?? agreement.proposedDate,
      ),
      actor: { humanId: input.actorHumanId, now },
    });

  // ── The manual mint's night (booking-the-night NFR-001) ───────────────────
  // No hold and no booked night handed in = the venue's "Create event" (or
  // the venue confirmation's mint). The plan runs first without a night —
  // authority before anything about the request is read — then the night is
  // settled (and, on agreed terms, BOOKED behind the same plan run as the
  // booking pre-flight). Terms already finalized book nothing: the plan
  // hands their event back (or refuses a dead one).
  let night = nightArg;
  let manual: ManualMintNight | null = null;
  if (mode === "manual" && agreement.eventId === null) {
    const first = await planFor(null);
    manual = await bookManualMintNight(deps, {
      agreement,
      request,
      place: first.place,
      // Not a fresh save: the plan hands an existing event back (a live
      // draft, the event-first origin) — its own line is the one to guard.
      handedBack: first.outcome === "mint" ? null : first.event,
      actorHumanId: input.actorHumanId,
      overrideStartsAt: input.overrides?.startsAt ?? null,
      ownerOverride: input.ownerOverride ?? null,
    });
    if (manual.placement) night = manual.placement;
  }
  // A hold names its own calendar/room; so does a booked night.
  const placement: NightPlacement | null = hold ?? night;

  const finish = async (): Promise<CreateEventFromAgreementOutput> => {
    // Date-less terms with nothing booked: the day a FRESH save falls back
    // to — never a night a handed-back draft is checked against.
    const plan = await planFor(placement, manual?.fallbackDay ?? null);
    return executeMintPlan(deps, logger, {
      plan,
      input,
      agreement,
      request,
      place: plan.place,
      hold,
      night,
    });
  };

  // A booking this call committed owes notices (lost_date to the acts
  // behind, the sender's "your date is booked"). They ride the output — or,
  // if anything after the commit throws, the error — for the transport to
  // dispatch (review W6 carrier).
  if (!manual || manual.intents.length === 0) {
    return withAskAnswersMapped(deps, request.id, await finish());
  }
  let output: CreateEventFromAgreementOutput;
  try {
    output = await withAskAnswersMapped(deps, request.id, await finish());
  } catch (error) {
    // The night is booked; its event did not land. The plan ran before the
    // take, so a refusal here is a race with those reads — reported, since
    // the backstops drop user-facing refusals.
    reportPostCommitRefusal(deps, error, {
      event: "booking_agreements.create_event.post_commit_refused",
      useCase: "createEventFromAgreement",
      step: "post_commit_mint",
      extra: { agreementId: agreement.id, bookingRequestId: request.id },
    });
    throw withCommittedHoldIntents(error, {
      notificationIntents: manual.intents,
      staffRecipientHint: manual.staffRecipientHint!,
      bookingRequestId: request.id,
    });
  }
  return createEventFromAgreementOutputSchema.parse({
    ...output,
    notificationIntents: manual.intents,
    staffRecipientHint: manual.staffRecipientHint,
  });
}

// ── P3b (asks) ──
/**
 * After every mint entry (venue "Create event", agree-mint, hold mint, book
 * without terms) and every idempotent replay: copy the booking's "use as the
 * event image" answer onto the event when it has no hero (V10). Never throws
 * — `mapAskImageToEvent` logs + reports its own failures — and is idempotent
 * per (ask, event), so a replay costs one ask read.
 */
async function withAskAnswersMapped(
  deps: CreateEventFromAgreementDeps,
  bookingRequestId: string,
  output: CreateEventFromAgreementOutput,
): Promise<CreateEventFromAgreementOutput> {
  await mapAskImageToEvent(
    {
      repos: deps.repos,
      storage: deps.storage,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      bookingRequestId,
      eventId: output.eventId,
      context: "createEventFromAgreement",
    },
  );
  return output;
}

/**
 * Execute a mint plan. No gate lives here (see agreement-mint-plan.ts): a
 * throw below is a lookup, a CAS lost to a concurrent writer, the shared save
 * use case's own defences (reached only by a race with the plan's reads), or
 * an infrastructure error.
 */
async function executeMintPlan(
  deps: CreateEventFromAgreementDeps,
  logger: LoggerPort | undefined,
  args: {
    plan: AgreementMintPlan;
    input: CreateEventFromAgreementInput;
    agreement: AgreementRecord;
    request: BookingRequestRecord;
    place: PlaceRecord;
    hold: HoldMintContext | null;
    night: NightPlacement | null;
  },
): Promise<CreateEventFromAgreementOutput> {
  const { plan, input, agreement, request, place, hold, night } = args;
  const finalizeArgs = {
    actorHumanId: input.actorHumanId,
    agreementId: agreement.id,
    plan,
  };

  switch (plan.outcome) {
    // Already finalize-linked (a FULFILLED agreement still resolves to its
    // event).
    case "finalized":
      return createEventFromAgreementOutputSchema.parse({
        eventId: plan.event!.id,
        alreadyLinked: true,
        finalized: true,
      });

    // Event-first (N11): the request was created FROM an event, so that
    // event IS the request's event — link it, never mint a second one.
    case "link":
      return linkOriginEvent(deps, logger, {
        agreement,
        originEventId: plan.event!.id,
        actorHumanId: input.actorHumanId,
        hold,
        ownerSide: plan.ownerSide,
      });

    // A live draft already minted → idempotent return; re-attempt the
    // finalize so the "confirm payouts, click again" flow converges.
    case "draft": {
      const finalize = await tryFinalize(deps, logger, {
        ...finalizeArgs,
        eventId: plan.event!.id,
      });
      return createEventFromAgreementOutputSchema.parse({
        eventId: plan.event!.id,
        alreadyLinked: true,
        ...finalize,
      });
    }

    case "mint":
      break;
  }

  // A dead (CANCELLED/ARCHIVED) draft anchor is replaced: the venue killed it
  // but only a delete SetNulls the link, so mint FRESH and SWAP the anchor in
  // the CAS below. A gone row (deleted between reads) needs no swap.
  if (plan.deadDraftEventId) {
    logger?.info("booking_agreements.create_event.dead_draft_replaced", {
      agreementId: agreement.id,
      deadEventId: plan.deadDraftEventId,
    });
  }

  // ── Mint (inside the idempotency envelope) ─────────────────────────────────
  // Resolution walks the generation chain: a retained record pointing at a
  // DELETED draft (venue deleted E, FK SetNulled the anchor, but the 24h
  // envelope record / 3-day save record survive) must never be honored — it
  // would either hand the venue a dead event id or brick the key for every
  // org admin until retention lapses.
  const resolution = await resolveCreateEnvelope(deps, agreement.id);

  if (resolution.kind === "replay") {
    logger?.info("booking_agreements.create_event.replay_cached", {
      agreementId: agreement.id,
      eventId: resolution.eventId,
    });
    const finalize = await tryFinalize(deps, logger, {
      ...finalizeArgs,
      eventId: resolution.eventId,
    });
    return createEventFromAgreementOutputSchema.parse({
      eventId: resolution.eventId,
      alreadyLinked: true,
      ...finalize,
    });
  }

  let eventId: string;
  try {
    eventId = await mintDraftEvent(deps, logger, {
      input,
      agreement,
      request,
      place,
      clientKey: resolution.clientKey,
      hold,
      night,
      plan,
    });
    await deps.idempotency.commit<StoredCreateRecord>(
      resolution.idempotencyKey,
      { response: { eventId } },
      IDEMPOTENCY_KEEP_SECONDS,
    );
  } catch (error) {
    await deps.idempotency.fail(
      resolution.idempotencyKey,
      describeError(error),
      isDeterministicCreateFailure(error)
        ? DETERMINISTIC_FAILURE_KEEP_SECONDS
        : undefined,
    );
    throw asKnownError("create_event_from_agreement", error);
  }

  logger?.info("booking_agreements.event_created", {
    agreementId: agreement.id,
    bookingRequestId: request.id,
    eventId,
    actorHumanId: input.actorHumanId,
    holdId: hold?.id ?? null,
    ownerSide: plan.ownerSide,
  });

  // ── Finalize attempt (post-commit; own idempotency envelope inside) ───────
  const finalize = await tryFinalize(deps, logger, { ...finalizeArgs, eventId });

  return createEventFromAgreementOutputSchema.parse({
    eventId,
    alreadyLinked: false,
    ...finalize,
  });
}

/**
 * Event-first link (booking-the-night N11). The origin event already exists —
 * built by the requester, who owns it — so nothing is minted: the agreement's
 * draft anchor is pointed at it (the same CAS a mint's anchor stamp uses, so
 * a concurrent mint/link still has exactly one winner) and it is handed back.
 * The plan already decided it is live, on the night, and that the terms may
 * link (a dead origin is refused there, never replaced — N11).
 *
 * Finalize is NOT attempted. An origin the REQUESTER owns (the usual case)
 * is reported deferred to them (`requester_owned`): the venue actor could not
 * pass finalize's event-edit gate, and the requester finalizes from their own
 * admin. A venue-owned origin reports no block code.
 */
async function linkOriginEvent(
  deps: CreateEventFromAgreementDeps,
  logger: LoggerPort | undefined,
  args: {
    agreement: AgreementRecord;
    originEventId: string;
    actorHumanId: string;
    hold: HoldMintContext | null;
    ownerSide: EventOwnerSide;
  },
): Promise<CreateEventFromAgreementOutput> {
  const { agreement, originEventId } = args;
  if (agreement.draftEventId !== originEventId) {
    await deps.repos.tx(async (tx) => {
      await tx.agreements.setDraftEvent({
        id: agreement.id,
        draftEventId: originEventId,
        // A dead legacy anchor (passed over by the plan) is swapped, not
        // stacked.
        replacingDraftEventId: agreement.draftEventId,
        expectedFrom: args.hold ? HOLD_MINT_AGREEMENT_STATUSES : ["ACCEPTED"],
      });
      await tx.audit.log({
        entity: "booking_agreement",
        entityId: agreement.id,
        action: "booking_agreement.event_linked",
        data: {
          actorHumanId: args.actorHumanId,
          eventId: originEventId,
          replacedDraftEventId: agreement.draftEventId,
          holdId: args.hold?.id ?? null,
          ownerSide: args.ownerSide,
        },
        at: deps.clock.now(),
      });
    });
    logger?.info("booking_agreements.create_event.origin_event_linked", {
      agreementId: agreement.id,
      eventId: originEventId,
    });
  }

  // Not finalized here: a link saves nothing and the plan never finalizes
  // one. Only an origin the REQUESTER owns is reported as deferred to them
  // (`requester_owned`); a venue-owned one is finalized by the venue's own
  // flow, so no block code is claimed for it.
  return createEventFromAgreementOutputSchema.parse({
    eventId: originEventId,
    alreadyLinked: true,
    finalized: false,
    ...(args.ownerSide === "requester"
      ? { finalizeBlocked: "requester_owned" as const }
      : {}),
  });
}

const placeTzOf = (place: Pick<PlaceRecord, "timezone">): string =>
  resolveBookingTimezone(place.timezone);

/** What the manual mint settled about its night (see `bookManualMintNight`). */
type ManualMintNight = {
  /** Where the event goes: the booked hold's line. Null = no booked night. */
  placement: NightPlacement | null;
  /**
   * Date-less terms with nothing booked: the day a fresh save falls back to
   * (the override's day, else the first preferred date). NOT a booked night:
   * a live draft the venue moved elsewhere is still handed back. Null
   * otherwise.
   */
  fallbackDay: string | null;
  /** Notices a booking committed HERE owes ([] when nothing was taken). */
  intents: BookingHoldNotificationIntent[];
  staffRecipientHint: BookingHoldStaffRecipientHint | null;
};

/**
 * The manual mint's night — the venue's "Create event" on agreed terms, and
 * the venue confirmation's mint (booking-the-night NFR-001; review rounds
 * 2–5; owner rulings 2026-10-01 / spec N11).
 *
 * An `overrides.startsAt` may move the TIME on the night, never the night:
 * an override on another day than the booked / agreed night is refused
 * HOLD_DATE_MISMATCHES_EVENT.
 *
 *   1. This request already BOOKED a night (a CONFIRMED hold) → that is the
 *      night: the event goes on that hold's calendar and room, and the
 *      event-first link / draft short-circuit assert it. Agreed terms naming
 *      another day refuse BOOKING_ALREADY_HAS_NIGHT (one booked night per
 *      request); date-less terms name no day, so the booked one stands.
 *      Nothing on the line moves.
 *   2. Agreed terms WITH a date and no booked night → the AGREED night (the
 *      `proposedDate`'s place-local day) is BOOKED here, the way the agree
 *      books it, before anything is minted or linked:
 *        pre-flight (read-only) — the booking pre-flight every line-taking
 *          path calls (`assertBookingPreflight`): the place takes bookings,
 *          then this mint's OWN plan on that night (`planAgreementMint` —
 *          every refusal the mint below could raise); then N6 → NIGHT_TAKEN;
 *        one transaction — `takeManualMintNightInTx`: the shared take
 *          (`takeRequestNightInTx`: locks, the same event checks again under
 *          the locks, then `takeLine`) + ledger `booking_hold.confirmed` (no
 *          `withoutTerms`: the terms are agreed) + audit.
 *      Every competitor that comes after sees this request's CONFIRMED hold.
 *      The notices owed ride the output (or a later error, which is also
 *      reported — `reportPostCommitRefusal`).
 *   3. Terms with NO date (legacy) → nothing is booked (there is no agreed
 *      night to book). What is guarded depends on the plan's first outcome
 *      (`handedBack`, P2b review carry a):
 *        - the plan SAVES a fresh event → it lands on the override's day,
 *          else the first preferred date (`fallbackDay`), through the mint's
 *          own routing. The fallback day is never a night a handed-back
 *          event must sit on (review round 6 BLOCKING); it only anchors the
 *          save. That line is checked TWICE, each time under its lock: here,
 *          before the save, and again in the mint's anchor transaction (W3)
 *          — which also places the event on the line, so a booking that
 *          commits between the two refuses NIGHT_TAKEN there, the
 *          transaction rolls back (no anchor, no placement), and the draft
 *          the save already committed is left an unanchored orphan on no
 *          calendar line, logged and reported. There is no automatic orphan
 *          clean-up today; that draft is the one remaining residue, and it
 *          never occupies the line;
 *        - the plan HANDS BACK an existing event (a live draft the venue may
 *          have moved, the event-first origin) → the fallback day is
 *          irrelevant; that event's OWN line (its calendar, else the
 *          request's routing, on its own day) is checked under that line's
 *          lock instead: another request booked there refuses NIGHT_TAKEN.
 */
async function bookManualMintNight(
  deps: CreateEventFromAgreementDeps,
  args: {
    agreement: AgreementRecord;
    request: BookingRequestRecord;
    place: PlaceRecord;
    /**
     * The event the plan's first run (no night) hands back instead of
     * saving — a live draft or the event-first origin; null when it saves.
     */
    handedBack: EventRecord | null;
    actorHumanId: string;
    overrideStartsAt: Date | string | null;
    ownerOverride: EventOwnerSide | null;
  },
): Promise<ManualMintNight> {
  const { agreement, request, place } = args;
  const placeTz = placeTzOf(place);
  const nothing: ManualMintNight = {
    placement: null,
    fallbackDay: null,
    intents: [],
    staffRecipientHint: null,
  };
  const overrideDay = args.overrideStartsAt
    ? todayInZone(new Date(args.overrideStartsAt), placeTz)
    : null;
  const termsNight = agreement.proposedDate
    ? todayInZone(agreement.proposedDate, placeTz)
    : null;
  const firstPreferred =
    parsePreferredDateEntry(request.preferredDates[0] ?? "")?.date ?? null;
  // An override may move the TIME on the night, never the night itself: the
  // agreed night (or the booked one) is what was agreed.
  const refuseOverrideOffNight = (night: string): void => {
    if (overrideDay && overrideDay !== night) {
      throw fail("HOLD_DATE_MISMATCHES_EVENT", {
        meta: {
          agreementId: agreement.id,
          eventId: null,
          eventDate: overrideDay,
          holdDate: night,
          reason: "override_on_another_day",
        },
      });
    }
  };

  const requestHolds = await deps.repos.bookingHolds.listForRequest(request.id);
  const booked = requestHolds.find((h) => h.status === "CONFIRMED") ?? null;

  // 1. Already booked: that night is THE night. An override on another day
  //    refuses; so do agreed terms naming another day (one booked night per
  //    request). Date-less terms name no day: the booked one stands — and a
  //    same-day override never stands in for the terms' own day.
  if (booked) {
    refuseOverrideOffNight(booked.date);
    if (termsNight !== null && termsNight !== booked.date) {
      throw fail("BOOKING_ALREADY_HAS_NIGHT");
    }
    return {
      ...nothing,
      placement: {
        calendarId: booked.calendarId,
        spaceId: booked.spaceId,
        date: booked.date,
      },
    };
  }

  // 2. Agreed terms: their night is THE night. 3. Date-less legacy terms: the
  //    mint's own precedence (override, else the first preferred date).
  if (termsNight) refuseOverrideOffNight(termsNight);
  const date = termsNight ?? overrideDay ?? firstPreferred;

  // 3. Legacy terms with no date: nothing to book.
  if (!agreement.proposedDate) {
    // A handed-back event (a live draft the venue may have moved, the
    // event-first origin) is checked on its OWN line — never the fallback
    // day's, which only anchors a fresh save (review carry a).
    if (args.handedBack) {
      await guardDatelessLine(deps, {
        agreement,
        request,
        place,
        calendarId: args.handedBack.calendarId ?? null,
        date: todayInZone(args.handedBack.startsAt, placeTz),
      });
      return { ...nothing, fallbackDay: date };
    }
    if (!date) return nothing; // the mint itself refuses a request with no night
    // A fresh save: guard the line the mint will land on (its own routing)
    // under that line's lock.
    await guardDatelessLine(deps, {
      agreement,
      request,
      place,
      calendarId: null,
      date,
    });
    return { ...nothing, fallbackDay: date };
  }
  if (!date) return nothing; // unreachable: dated terms always name a night

  // 2. Book the agreed night.
  const calendarId = await resolveNightCalendarId(deps.repos, {
    request,
    placeId: place.id,
    night: date,
  });
  if (!calendarId) {
    throw fail("CALENDAR_NOT_FOUND", {
      meta: { reason: "place_has_no_calendar", placeId: place.id },
    });
  }
  const key = { calendarId, date };
  const now = deps.clock.now();

  // The booking pre-flight: the mint's own plan (every refusal it could
  // raise after the take), read-only, before the line moves — plus the
  // place rule.
  await assertBookingPreflight(deps.repos, {
    mode: "manual",
    agreement,
    request,
    place,
    calendarId,
    nightDate: date,
    placeTz,
    side: "venue",
    ownerOverride: args.ownerOverride,
    startNamed: true, // agreed terms name the start
    actor: { humanId: args.actorHumanId, now },
  });

  // Pre-flight N6 (read-only; lapses projected out, never written).
  const preflight = assessNight({
    line: withoutLapsed(await deps.repos.bookingHolds.listLine(key), now, placeTz),
    confirmed: await deps.repos.bookingHolds.listLine({
      ...key,
      statuses: ["CONFIRMED"],
    }),
    bookingRequestId: request.id,
  });
  if (preflight.kind === "taken") {
    failNightTaken(preflight, date);
  }

  let taken: TakeRequestNightResult;
  try {
    taken = await deps.repos.tx((tx) =>
      takeManualMintNightInTx(tx, {
        bookingRequestId: request.id,
        agreementId: agreement.id,
        key,
        placeTz,
        now,
        actorHumanId: args.actorHumanId,
      }),
    );
  } catch (error) {
    if (isLineConfirmedConflictError(error)) {
      // The DB's one-CONFIRMED-per-line unique, behind the lock.
      throw fail("HOLD_LINE_ALREADY_CONFIRMED", {
        meta: { calendarId: key.calendarId, date: key.date },
      });
    }
    if (isHoldStatusConflict(error)) {
      throw fail("HOLD_LINE_CHANGED", {
        meta: { calendarId: key.calendarId, date: key.date },
      });
    }
    throw error;
  }

  return {
    placement: {
      calendarId: taken.hold.calendarId,
      spaceId: taken.hold.spaceId,
      date,
    },
    fallbackDay: null,
    intents: taken.intents,
    staffRecipientHint:
      taken.intents.length > 0
        ? staffRecipientHintFor({
            hold: taken.hold,
            request,
            place,
            ownership: null,
          })
        : null,
  };
}

/**
 * Date-less legacy terms book no night, so the manual mint only GUARDS a
 * line: under that line's lock, another request's CONFIRMED hold on it
 * refuses NIGHT_TAKEN (venue side). The line is `calendarId` when the caller
 * knows it (a handed-back event's own calendar), else the request's routing
 * — exactly the mint's own (`listByPlace`, then `isDefault`) — on `date`.
 * With no calendar at all the event sits on no line and nothing is checked.
 */
async function guardDatelessLine(
  deps: CreateEventFromAgreementDeps,
  args: {
    agreement: AgreementRecord;
    request: BookingRequestRecord;
    place: PlaceRecord;
    calendarId: string | null;
    date: string;
  },
): Promise<void> {
  const { agreement, request, place, date } = args;
  let calendarId = args.calendarId;
  if (!calendarId) {
    try {
      calendarId = await resolvePlaceCalendarId(deps.repos, {
        request,
        placeId: place.id,
      });
    } catch (error) {
      // The mint's own routing degrades on the same outage (to the
      // pre-hierarchy, placement-free mint — reported there too). Mirror
      // it: the stored routed calendar is the only line the event could
      // land on, and with none the event sits on no calendar line at all.
      // Deliberate degrade → logged at error AND reported (ReporterPort).
      deps.logger?.error("booking_agreements.create_event.night_guard_calendars_failed", {
        agreementId: agreement.id,
        bookingRequestId: request.id,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "createEventFromAgreement", step: "manual_night_guard" },
          extra: { agreementId: agreement.id, bookingRequestId: request.id },
        });
      } catch {
        // Reporting is best-effort — never change the outcome.
      }
      calendarId = request.calendarId ?? null;
    }
  }
  if (!calendarId) return; // no calendar line to collide with
  const key = { calendarId, date };
  await deps.repos.tx(async (tx) => {
    await tx.bookingHolds.lockLine(key);
    const confirmed = await tx.bookingHolds.listLine({
      ...key,
      statuses: ["CONFIRMED"],
    });
    // Any CONFIRMED hold but this request's own, request-less ones included
    // (holds-without-a-request): the night is someone else's.
    const other = confirmed.find(
      (h) => h.ownerKind !== "REQUEST" || h.bookingRequestId !== request.id,
    );
    if (other) {
      failNightTaken(
        { kind: "taken", reason: "booked", head: other, challengeable: false },
        date,
      );
    }
  });
}

/**
 * The manual "Create event"'s booking transaction body (NFR-001), in the
 * caller's transaction: the shared take on the venue side
 * (`takeRequestNightInTx` — locks, the event checks again under the locks,
 * N6, `takeLine`), gated on the public mint's own status rule re-read under
 * the locks, then the ledger entry and audit row when THIS call booked the
 * night. A concurrent call that already booked (and even finalized) the
 * same request converges: the take finds the night this request's and
 * writes nothing.
 */
export async function takeManualMintNightInTx(
  tx: TxRepos,
  args: {
    bookingRequestId: string;
    agreementId: string;
    key: HoldLineKey;
    placeTz: string;
    now: Date;
    actorHumanId: string;
  },
): Promise<TakeRequestNightResult> {
  const booking = await takeRequestNightInTx(tx, {
    bookingRequestId: args.bookingRequestId,
    agreementId: args.agreementId,
    key: args.key,
    placeTz: args.placeTz,
    now: args.now,
    side: "venue",
    venueActorHumanId: args.actorHumanId,
    placedByHumanId: args.actorHumanId,
    underLock: ({ agreement: fresh }) => {
      // The public mint's own gate, re-read under the locks. (A concurrent
      // call may have booked AND finalized meanwhile: that is still
      // ACCEPTED, and this call converges — the night is already this
      // request's, so nothing more is taken.)
      if (!fresh || fresh.status !== "ACCEPTED") {
        throw fail("AGREEMENT_NOT_ACCEPTED");
      }
    },
  });
  if (!booking.alreadyBooked) {
    await appendBookingSystemEntry(tx, {
      bookingRequestId: args.bookingRequestId,
      kind: "booking_hold.confirmed",
      data: { holdId: booking.hold.id, eventId: null },
      actorHumanId: args.actorHumanId,
    });
    await tx.audit.log({
      entity: "booking_hold",
      entityId: booking.hold.id,
      action: "booking_hold.confirmed",
      data: {
        actorHumanId: args.actorHumanId,
        via: "manual_create_event",
        agreementId: args.agreementId,
        bookingRequestId: args.bookingRequestId,
        calendarId: booking.hold.calendarId,
        date: booking.hold.date,
        position: booking.hold.position,
        holdCreated: booking.holdCreated,
        releasedHoldIds: booking.released.map((h) => h.id),
      },
      at: args.now,
    });
  }
  return booking;
}

function isLineConfirmedConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_line_confirmed"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope resolution (generation-scoped keys — deleted-draft staleness)
// ─────────────────────────────────────────────────────────────────────────────

type EnvelopeResolution =
  | { kind: "replay"; eventId: string }
  | { kind: "claimed"; idempotencyKey: string; clientKey: string };

/**
 * Resolve which envelope generation this create runs under.
 *
 * A committed record is only honored when its event STILL EXISTS
 * (`repos.events.getById`). When the venue deleted the draft (FK SetNulled
 * the anchor, but the retained envelope/save records survive up to 24h/3d),
 * we advance to GENERATION-SCOPED keys suffixed with the stale event id:
 *
 *   envelope  `bookingAgreement:createEvent:<agreementId>:after:<staleId>`
 *   save      `bookingAgreement:<agreementId>:after:<staleId>`
 *
 * Deterministic across concurrent retries: every reader walks the same chain
 * of committed records and lands on the same generation, so the envelope
 * still serializes them and the `setDraftEvent` CAS remains the one-event
 * backstop. The chain cannot cycle (fresh uuids per mint); the cap only
 * guards a corrupt store.
 */
async function resolveCreateEnvelope(
  deps: CreateEventFromAgreementDeps,
  agreementId: string,
): Promise<EnvelopeResolution> {
  let idempotencyKey = `bookingAgreement:createEvent:${agreementId}`;
  let clientKey = `bookingAgreement:${agreementId}`;

  const advance = (staleEventId: string) => {
    idempotencyKey = `bookingAgreement:createEvent:${agreementId}:after:${staleEventId}`;
    clientKey = `bookingAgreement:${agreementId}:after:${staleEventId}`;
  };

  for (let hop = 0; hop < MAX_STALE_DRAFT_GENERATIONS; hop += 1) {
    const cached =
      await deps.idempotency.get<StoredCreateRecord>(idempotencyKey);
    if (cached) {
      if (
        isLiveBookingEvent(
          await deps.repos.events.getById(cached.response.eventId),
        )
      ) {
        return { kind: "replay", eventId: cached.response.eventId };
      }
      advance(cached.response.eventId);
      continue;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_KEY_TTL_SECONDS,
    );
    if (claimed) {
      return { kind: "claimed", idempotencyKey, clientKey };
    }

    const replay =
      await deps.idempotency.get<StoredCreateRecord>(idempotencyKey);
    if (replay) {
      if (
        isLiveBookingEvent(
          await deps.repos.events.getById(replay.response.eventId),
        )
      ) {
        return { kind: "replay", eventId: replay.response.eventId };
      }
      // Committed while we waited, but its event is already gone (or dead) —
      // walk on.
      advance(replay.response.eventId);
      continue;
    }

    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  throw {
    code: "conflict",
    message: "stale_draft_generations_exhausted",
    meta: { agreementId },
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mint internals
// ─────────────────────────────────────────────────────────────────────────────

async function mintDraftEvent(
  deps: CreateEventFromAgreementDeps,
  logger: LoggerPort | undefined,
  args: {
    input: CreateEventFromAgreementInput;
    agreement: AgreementRecord;
    request: BookingRequestRecord;
    place: PlaceRecord;
    /**
     * Generation-scoped save clientKey from `resolveCreateEnvelope` — ties
     * event creation to the agreement so retries (even after this use case's
     * own envelope failed post-save) converge on the SAME event via the save
     * internals' idempotency replay.
     */
    clientKey: string;
    /** Hold-confirm placement + start (see createEventFromAgreementForHold). */
    hold: HoldMintContext | null;
    /** Agree-mint placement only (see createEventFromAgreementOnNight). */
    night: NightPlacement | null;
    /**
     * The plan (agreement-mint-plan.ts) this save executes: its owner side and
     * requester owner, the dead draft anchor it replaces, the pitch entry its
     * start falls back to, and the actor's authority.
     */
    plan: AgreementMintPlan;
  },
): Promise<string> {
  const { input, agreement, request, place, hold, night, plan } = args;
  const replacingDraftEventId = plan.deadDraftEventId;

  // ── Calendar routing (venue-hierarchy FR-005/FR-009) ──────────────────────
  // The request's routed calendar drives the title composition, the
  // defaultStartTime prefill, and the calendarId/spaceId stamp below. Null
  // (unrouted / pre-hierarchy row) falls back to the pre-hierarchy behaviour
  // everywhere it is consumed.
  const routing = await resolveCalendarRouting(
    deps,
    logger,
    request,
    place,
    hold ?? night,
  );

  // The VENUE's zone (address-derived Place.timezone, FR-004) anchors the
  // wall-clock default AND is stored on the event — always together, so the
  // instant we computed and the zone label the event displays with can never
  // disagree. Platform fallback for places that predate the tz cache — and
  // for a malformed stored value (the column is free text at the DB level;
  // a garbage zone must degrade to the default, never fail the mint).
  const eventTimezone = resolveBookingTimezone(place.timezone);

  // Date precedence: explicit override → NEGOTIATED date (the agreement
  // header's proposedDate, actively edited during negotiation — the request's
  // preferredDates are only the performer's opening ask) → the routed
  // calendar's defaultStartTime (FR-009 template default) → 19:00, on the
  // first preferred date, anchored in `eventTimezone`. `proposedDate` is
  // stored by the header editor as a BARE INSTANT (`z.coerce.date()`, no
  // timezone captured), so it is used AS-IS — no anchoring — while the event
  // keeps the venue timezone LABEL, matching how every display surface
  // formats that instant.
  // A hold pins the night: its start (date + calendar default, place zone —
  // computed by confirm-booking-hold) outranks even the negotiated date.
  const startOverride = input.overrides?.startsAt ?? hold?.startsAt ?? null;
  // Nothing names the start (date-less terms): the pitch entry the plan
  // picked and checked — the booked night (the act's named time on it), else
  // the first preferred date — at the routed calendar's default time.
  const startsAt =
    startOverride ??
    agreement.proposedDate ??
    anchorPreferredDate(
      plan.defaultStartEntry ?? "",
      eventTimezone,
      routing.calendar?.defaultStartTime ?? null,
    );
  if (!startsAt) {
    // The plan validated this entry; reaching here is a programming error.
    throw new Error("mint_plan_without_anchorable_start");
  }

  // endsAt: honor the negotiated proposedEndDate ONLY when the negotiated
  // start was actually used (an override to a different night must not
  // inherit a stale multi-day span) and it's strictly after the start (the
  // header editor allows equality; the event schema requires
  // endsAt > startsAt). Otherwise the standard +3h show length.
  //
  // Since accept seeds `proposedEndDate` from the pitch's `setLengthMinutes`,
  // most bookings now arrive here with a REAL duration and the +3h is what it
  // was always meant to be: the fallback for when nobody said.
  const negotiatedEnd =
    !startOverride &&
    agreement.proposedDate &&
    agreement.proposedEndDate &&
    agreement.proposedEndDate.getTime() > agreement.proposedDate.getTime()
      ? agreement.proposedEndDate
      : null;
  // A hold hands in the end confirm-booking-hold just wrote to the agreement
  // header (start + the negotiated span / set length) so the event's duration
  // and the agreement's cannot disagree; null (header names none) → +3h.
  const holdEnd =
    hold?.endsAt && hold.endsAt.getTime() > startsAt.getTime()
      ? hold.endsAt
      : null;
  const endsAt =
    holdEnd ??
    negotiatedEnd ??
    new Date(startsAt.getTime() + DEFAULT_EVENT_DURATION_HOURS * 60 * 60 * 1000);
  const title =
    input.overrides?.title ??
    (await buildDefaultTitle(
      deps.repos,
      request,
      place,
      routing.calendar,
      await resolveBillTitleLead(deps.repos, request),
    ));

  const saveDeps = {
    repos: deps.repos,
    idempotency: deps.idempotency,
    clock: deps.clock,
    logger: deps.logger,
    taxRateLookup: deps.taxRateLookup ?? null,
    // Threaded so the save internals' deliberate swallows (timezone lookup,
    // create-time slug assignment) reach Sentry from the mint path too.
    reportError: deps.reportError,
    authz: deps.authz,
  };

  // ── Owner by intent (venue-confirmation spec "Who mints, who owns") ───────
  // PERFORM → the venue (the agreement's venue counterparty — today's
  // behaviour, byte-identical); RENT / USE → the REQUESTER: the request's
  // owned sender, never a derivation off the place (accept-agreement's
  // `deriveVenueCounterpartyFromPlace` picks the smallest human owner — the
  // wrong party by construction here). The venue side overrides at confirm.
  // The plan decided both (and refused a human counterparty other than the
  // actor: saveEventForHuman always creates under the ACTOR).
  const ownerSide = plan.ownerSide;
  const requesterOwner = plan.requesterOwner;

  // Venue-owned mint: owner = the agreement's venue counterparty (see the
  // use-case doc).
  const humanOwned = agreement.counterpartyType !== "organization";

  // The save's own idempotency record outlives this use case's envelope
  // (3-day vs 24h retention), so a save REPLAY can hand back an event the
  // venue deleted in between — never accept a dead id; advance the save
  // clientKey generation (same deterministic `:after:<staleId>` scheme as
  // the envelope) and mint fresh.
  let clientKey = args.clientKey;
  let eventId: string;
  let mintedRecord: { categoryId?: string | null } | null = null;
  for (let hop = 0; ; hop += 1) {
    const savePayload = {
      actorHumanId: input.actorHumanId,
      title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      location: { placeId: place.id },
      timezone: eventTimezone,
      clientKey,
    };
    const result = requesterOwner
      ? await saveRequesterOwnedEvent(saveDeps, logger, {
          owner: requesterOwner,
          place,
          payload: savePayload,
        })
      : humanOwned
        ? await saveEventForHuman(saveDeps, savePayload)
        : await saveEventForOrg(saveDeps, {
            ...savePayload,
            orgId: agreement.counterpartyId,
          });
    eventId = result.eventId;

    const live = await deps.repos.events.getById(eventId);
    if (isLiveBookingEvent(live)) {
      mintedRecord = live;
      break;
    }

    if (hop >= MAX_STALE_DRAFT_GENERATIONS) {
      throw {
        code: "conflict",
        message: "stale_draft_generations_exhausted",
        meta: { agreementId: agreement.id },
      } as const;
    }
    logger?.info("booking_agreements.create_event.save_replayed_deleted_event", {
      agreementId: agreement.id,
      staleEventId: eventId,
    });
    clientKey = `bookingAgreement:${agreement.id}:after:${eventId}`;
  }

  // ── Venue-hierarchy placement (FR-005/FR-009) ─────────────────────────────
  // Routed calendar wins. When routing resolved to NOTHING (unrouted request,
  // cross-place/deleted calendarId), a place-linked mint must still land in
  // the space system: fall back to the place's DEFAULT calendar + its first
  // ACTIVE space. Only when THAT also fails does the event stay spaceless (and
  // that is reported — see resolveFallbackPlacement). Freeform events (no
  // place) never reach this use case, so they stay outside the space system
  // by construction.
  // defaultCategoryId applied ONLY when the minted draft carries no category
  // of its own (template-as-default, never an override), and ONLY while that
  // category is active: `setEventCategory` and `createCommunityListing` refuse
  // an inactive category, so a mint must not put an event in one either. A
  // missing or inactive default leaves the event uncategorised; the calendar
  // keeps its default, so reactivating the category restores it for later
  // mints.
  const calendarDefaultCategory =
    routing.calendar?.defaultCategoryId != null &&
    (mintedRecord?.categoryId ?? null) === null
      ? await deps.repos.categories.getById(routing.calendar.defaultCategoryId)
      : null;
  const placement: VenuePlacement | null = routing.calendar
    ? {
        calendarId: routing.calendar.id,
        spaceId: routing.spaceId,
        ...(calendarDefaultCategory?.active
          ? { categoryId: calendarDefaultCategory.id }
          : {}),
      }
    : await resolveFallbackPlacement(deps, logger, request, place, routing);

  // Anchor stamp + lineup attach + audit — one tx (NFR-003). If the CAS
  // loses (concurrent create slipped past the envelope), the tx rolls back:
  // no half-linked lineup, but the save-committed event is now orphaned —
  // report it (with its id) and surface the conflict; a retry returns the
  // winner's draft via the anchor short-circuit.
  //
  // `identity` is the SENDER as a lineup row — the pre-bill headliner, and
  // what a SELF row on the bill becomes (see `planBookingLineup`). Read
  // before the tx, with the org sender's absolute page link (the fallback
  // `externalUrl` of an org row, see `publicAppUrl`).
  const identity = await resolveLineupIdentity(deps.repos, request);
  const senderOrgPageUrl = await resolveSenderOrgPageUrl(
    deps.repos,
    request,
    deps.publicAppUrl,
  );
  const appBaseUrl = normalizeAppBaseUrl(deps.publicAppUrl);
  try {
    await deps.repos.tx(async (tx) => {
      // NFR-001, re-checked in the SAME transaction that anchors the event
      // and places it on its calendar line (review W3): under the line's
      // lock, another party's CONFIRMED hold there refuses NIGHT_TAKEN. The
      // whole transaction rolls back — no anchor, and no placement either —
      // so the draft the save just committed stays an unanchored orphan on
      // no calendar line, logged and reported below like any orphan (there
      // is no automatic orphan clean-up path today). Only the date-less
      // legacy mint can reach this: every other mint holds the night's
      // CONFIRMED hold itself, so the filter below always passes for it.
      if (placement) {
        const lineKey = {
          calendarId: placement.calendarId,
          date: todayInZone(startsAt, eventTimezone),
        };
        await tx.bookingHolds.lockLine(lineKey);
        const confirmed = await tx.bookingHolds.listLine({
          ...lineKey,
          statuses: ["CONFIRMED"],
        });
        // Any CONFIRMED hold but this request's own, request-less ones
        // included (holds-without-a-request): the night is someone else's.
        const other = confirmed.find(
          (h) => h.ownerKind !== "REQUEST" || h.bookingRequestId !== request.id,
        );
        if (other) {
          failNightTaken(
            { kind: "taken", reason: "booked", head: other, challengeable: false },
            lineKey.date,
          );
        }
      }
      await tx.agreements.setDraftEvent({
        id: agreement.id,
        draftEventId: eventId,
        replacingDraftEventId,
        // Hold-confirm mints while the negotiation is still open (the
        // accept just happened); the public path keeps its ACCEPTED-only CAS.
        expectedFrom: hold ? HOLD_MINT_AGREEMENT_STATUSES : ["ACCEPTED"],
      });

      if (placement) {
        await tx.events.setVenuePlacement({
          eventId,
          calendarId: placement.calendarId,
          spaceId: placement.spaceId,
          ...(placement.categoryId !== undefined
            ? { categoryId: placement.categoryId }
            : {}),
        });
      }

      // ── Lineup (lineup-booking-requests v2, FR-006) ─────────────────────
      // The bill is read UNDER ITS LOCK, in this tx: an artist withdrawing
      // consent (`declineBookingRequestAct`) takes the same lock before
      // reading the minted event's lineup, so the two serialize and neither acts
      // on the other's pre-commit state — a DECLINED act can never flow onto
      // the event. (Lock order: this tx already holds the agreement row from
      // `setDraftEvent`; the answer path only READS the agreement, so there
      // is no cycle.) A request that never recorded a bill
      // (`billRecorded` false: sent before bills, RENT/USE, TO_PERFORMER)
      // and has no act rows attaches exactly what it always did: the sender
      // as the headliner. A request that recorded a bill attaches its live
      // joined acts — NOTHING when the bill is empty (v3 L12) or every act
      // was removed.
      await tx.bookingRequests.lockBill(request.id);
      const bill = await tx.bookingRequests.listActsForRequests([request.id], {
        includeRemoved: true,
      });
      // Names + page links for TAGGED groups (v3 L17/L18), in this tx: an
      // org row carries them as its fallback display (see `publicAppUrl`).
      const groupIdentities = await resolveBillIdentities(
        tx,
        bill.filter(
          (act) =>
            act.source === "TAGGED" &&
            act.actOwnerType === "organization" &&
            act.confirmation === "CONFIRMED" &&
            !act.removedAt,
        ),
      );
      const lineup = planBookingLineup(bill, request.billRecorded, identity, {
        senderOrgPageUrl,
        groupNameOf: (act) => {
          const found = billIdentityOf(act, groupIdentities);
          return {
            externalName: clipName(found.displayName),
            externalUrl: absoluteOrgPageUrl(appBaseUrl, found.href),
          };
        },
      });
      const attachedRows: Array<{ id: string; row: BookingLineupRow }> = [];
      for (const [index, row] of lineup.rows.entries()) {
        const attached = await tx.eventHumans.attach({
          eventId,
          humanId: row.humanId,
          orgId: row.orgId,
          externalName: row.externalName,
          externalUrl: row.externalUrl,
          role: row.role,
          customRoleLabel: row.customRoleLabel,
          // Dense 0..n-1 in bill order (0 = headliner): skipped acts leave
          // no gaps on the event's lineup.
          sortOrder: index,
        });
        attachedRows.push({ id: attached.id, row });
      }

      // Ledger entry — the moment the booking becomes a show. Same tx as the
      // anchor stamp, so an event can never be anchored to this agreement
      // without the thread saying so. `startsAt` is SNAPSHOTTED (schema doc):
      // the entry must still read correctly after a later reschedule, which
      // arrives as its own `booking_event.modified`.
      await appendBookingSystemEntry(tx, {
        bookingRequestId: request.id,
        kind: "booking_event.created",
        data: {
          eventId,
          agreementId: agreement.id,
          startsAt: startsAt.toISOString(),
        },
        actorHumanId: input.actorHumanId,
      });

      const now = deps.clock.now();
      for (const { id, row } of attachedRows) {
        await tx.audit.log({
          entity: "event_human",
          entityId: id,
          action: "attached",
          data: {
            eventId,
            humanId: row.humanId,
            ...(row.orgId ? { orgId: row.orgId } : {}),
            externalName: row.externalName,
            role: row.role,
            actorHumanId: input.actorHumanId,
            ...(row.actId ? { bookingRequestActId: row.actId } : {}),
          },
          at: now,
        });
      }
      const headliner = lineup.rows[0] ?? null;
      await tx.audit.log({
        entity: "booking_agreement",
        entityId: agreement.id,
        action: "booking_agreement.event_created",
        data: {
          actorHumanId: input.actorHumanId,
          bookingRequestId: request.id,
          placeId: place.id,
          eventId,
          startsAt: startsAt.toISOString(),
          performerHumanId: headliner?.humanId ?? null,
          performerOrgId: headliner?.orgId ?? null,
          performerExternalName: headliner?.externalName ?? null,
          lineup: {
            source: lineup.source,
            attached: lineup.rows.length,
            skippedPending: lineup.skippedPending,
            skippedDeclined: lineup.skippedDeclined,
          },
          calendarId: placement?.calendarId ?? null,
          spaceId: placement?.spaceId ?? null,
          holdId: hold?.id ?? null,
          replacedDraftEventId: replacingDraftEventId,
          ownerSide,
          ownerOverride: input.ownerOverride ?? null,
        },
        at: now,
      });
    });
  } catch (error) {
    logger?.error("booking_agreements.create_event.anchor_stamp_failed", {
      agreementId: agreement.id,
      orphanEventId: eventId,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "createEventFromAgreement" },
        extra: { agreementId: agreement.id, orphanEventId: eventId },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never mask the
      // real anchor-stamp failure being rethrown below.
    }
    throw error;
  }

  return eventId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Requester-owned mint (RENT / USE by default, or the venue's override)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a DRAFT owned by the REQUESTER while the VENUE is the actor.
 *
 * The public wrappers cannot express this: `saveEventForHuman` always creates
 * under the actor and gates the place on the OWNER's access list, and
 * `saveEventForOrg` requires the actor to hold an edit role in the owning org
 * — a requester owns neither the venue nor a seat in the venue's org, and the
 * venue holds no seat in the requester's org. Both gates are the venue's
 * "may this owner name my room" question, and here the venue is the one
 * answering it: `requirePlaceBookingAuthority` (the staff gate) has
 * already passed for the actor at this place. So the mint goes straight to
 * the shared `finalizeSaveEvent` internals the wrappers themselves call —
 * same idempotency envelope (owner-scoped key + the generation clientKey),
 * quota, placement, tax stamp, slug — with the owner set explicitly and the
 * actor kept truthful for the audit row.
 *
 * What the wrappers' place gate (`ensureLoadedPlaceAccessible`) does and
 * what survives here: its ACCESS half (owner on the place's list) is the
 * part deliberately SKIPPED — that is the whole point; its LIVENESS half
 * (`ensurePlaceActive`: a suspended / retired place takes no new events) is
 * KEPT — in the mint's plan (`planAgreementMint`), on the place the mint
 * already loaded — and so are the existence checks the wrappers run
 * (`HUMAN_NOT_FOUND` / `ORGANIZATION_NOT_FOUND`).
 *
 * Quota: an org requester's EVENTS_PER_ORG quota is charged (the event is
 * theirs). The save internals' `forbidden: quota_exceeded` names the
 * requester org in `meta` but reads as an opaque "forbidden" to the venue
 * actor, so it is re-thrown here as `quota_exceeded_for_requester` — same
 * code, same meta, a message the venue can act on ("ask them to expand").
 */
async function saveRequesterOwnedEvent(
  saveDeps: Parameters<typeof finalizeSaveEvent>[0],
  logger: LoggerPort | undefined,
  args: {
    owner: OwnerContext;
    /** Already loaded by the mint; only its liveness is asserted here. */
    place: PlaceRecord;
    payload: {
      actorHumanId: string;
      title: string;
      startsAt: string;
      endsAt: string;
      location: { placeId: string };
      timezone: string;
      clientKey: string;
    };
  },
): Promise<SaveEventOutput> {
  const { owner, payload } = args;
  // The place's liveness and the owner row's existence are the plan's
  // (agreement-mint-plan.ts): checked there, before any booking takes a line.
  try {
    return await finalizeSaveEvent(saveDeps, logger, {
      owner,
      actorHumanId: payload.actorHumanId,
      eventId: null,
      existingEvent: null,
      title: payload.title,
      startsAt: new Date(payload.startsAt),
      endsAt: new Date(payload.endsAt),
      location: normalizeLocation(payload.location),
      timezone: payload.timezone,
      clientKey: payload.clientKey,
    });
  } catch (error) {
    if (isQuotaExceeded(error)) {
      throw { ...error, message: "quota_exceeded_for_requester" as const };
    }
    throw error;
  }
}

/** `enforceQuota`'s typed refusal (`{ code: "forbidden", message: "quota_exceeded" }`). */
function isQuotaExceeded(
  error: unknown,
): error is { code: "forbidden"; message: "quota_exceeded"; meta?: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "forbidden" &&
    (error as { message?: unknown }).message === "quota_exceeded"
  );
}

type CalendarRoutingResult = {
  calendar: CalendarWithSpacesRow | null;
  spaceId: string | null;
  /**
   * True when the calendars READ itself threw (already logged + reported).
   * `resolveFallbackPlacement` skips its own lookup then — the repo is down;
   * hitting it again would just double-report the same outage per mint.
   */
  repoFailed?: boolean;
};

/** Placement columns stamped inside the anchor tx (`setVenuePlacement`). */
type VenuePlacement = {
  calendarId: string;
  spaceId: string | null;
  /** Present ONLY when applying a calendar's defaultCategoryId. */
  categoryId?: string | null;
};

/**
 * Resolve the request's routed calendar for the mint (FR-005/FR-009):
 * - `calendar`: the routed calendar WITH its spaces — resolved via
 *   `listByPlace(place.id)` so the SAME-PLACE assert is structural (a
 *   cross-place calendarId simply doesn't appear in the place's list and
 *   resolves to null → default-calendar fallback via
 *   `resolveFallbackPlacement`, mirroring the CALENDAR_NOT_FOUND posture
 *   without failing an otherwise-valid mint);
 * - `spaceId`: the calendar's first ACTIVE space (spaces come back sortOrder
 *   asc). A calendar with NO active spaces yields null and is REPORTED
 *   (guarded) — a mint must never fail over a placement default.
 *
 * Deliberate swallow on repo failure (catch-and-fallback): the calendar only
 * feeds prefill defaults, so a broken calendars read degrades to the
 * pre-hierarchy mint — logged at error AND reported per the ReporterPort
 * convention (a throwing reporter never changes behaviour).
 */
async function resolveCalendarRouting(
  deps: CreateEventFromAgreementDeps,
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  place: Pick<PlaceRecord, "id">,
  /** A hold's or a booked night's calendar/room; null = the request's routing. */
  hold: NightPlacement | null,
): Promise<CalendarRoutingResult> {
  // A hold names its calendar (and optionally its room) — that is the
  // placement, not the request's routing. Otherwise: unrouted request →
  // pre-hierarchy behaviour (fallback placement still applies via
  // resolveFallbackPlacement).
  const routedCalendarId = hold?.calendarId ?? request.calendarId;
  if (!routedCalendarId) {
    return { calendar: null, spaceId: null };
  }

  try {
    const calendars = await deps.repos.calendars.listByPlace(place.id);
    const calendar =
      calendars.find((c) => c.id === routedCalendarId) ?? null;
    if (!calendar) {
      // Cross-place or deleted calendarId — fall back, don't fail the mint.
      logger?.info("booking_agreements.create_event.calendar_unresolved", {
        bookingRequestId: request.id,
        calendarId: routedCalendarId,
        placeId: place.id,
      });
      return { calendar: null, spaceId: null };
    }

    const holdSpace = hold?.spaceId
      ? calendar.spaces.find(
          (space) => space.id === hold.spaceId && space.status === "ACTIVE",
        )
      : undefined;
    if (holdSpace) {
      return { calendar, spaceId: holdSpace.id };
    }

    const activeSpace = calendar.spaces.find((space) => space.status === "ACTIVE");
    if (!activeSpace) {
      // No physical space to block — stamp calendarId only. Reported: a
      // calendar taking bookings with zero active spaces means every event it
      // mints is invisible to conflict detection.
      logger?.error("booking_agreements.create_event.calendar_has_no_active_spaces", {
        bookingRequestId: request.id,
        calendarId: calendar.id,
        placeId: place.id,
      });
      try {
        deps.reportError?.(
          new Error("booking_agreement_calendar_has_no_active_spaces"),
          {
            tags: { useCase: "createEventFromAgreement" },
            extra: {
              bookingRequestId: request.id,
              calendarId: calendar.id,
              placeId: place.id,
            },
          },
        );
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail
        // the mint.
      }
      return { calendar, spaceId: null };
    }

    return { calendar, spaceId: activeSpace.id };
  } catch (error) {
    logger?.error("booking_agreements.create_event.calendar_routing_failed", {
      bookingRequestId: request.id,
      calendarId: routedCalendarId,
      placeId: place.id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "createEventFromAgreement" },
        extra: {
          bookingRequestId: request.id,
          calendarId: routedCalendarId,
          placeId: place.id,
        },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never fail the
      // mint.
    }
    return { calendar: null, spaceId: null, repoFailed: true };
  }
}

/**
 * Spaceless-mint fallback (FR-005): a place-linked event whose request routed
 * to no usable calendar still belongs in the space system — otherwise it is
 * invisible to conflict detection and the venue's calendar surfaces. Resolve
 * the place's DEFAULT calendar and its first ACTIVE space and stamp that.
 *
 * Reads via `listByPlace` + `isDefault` rather than
 * `CalendarsRepo.findDefaultForPlace`: the fallback needs the calendar's
 * SPACES, which only the listByPlace row carries, and the `isDefault` row IS
 * findDefaultForPlace's row (at most one default per place — the SQL partial
 * unique on the port doc).
 *
 * Only when THIS also fails (no default calendar, default has no ACTIVE
 * space, or the read throws) does the event stay spaceless — and that outcome
 * is error-logged AND reported (guarded ReporterPort convention): a venue
 * whose mints silently bypass conflict detection is an operator-visible
 * fault, not an info-log.
 *
 * Returns null (no stamp) when routing already failed on a thrown repo read
 * (already reported once — see CalendarRoutingResult; the repo is down, and
 * hitting it again would just double-report the same outage per mint).
 */
async function resolveFallbackPlacement(
  deps: CreateEventFromAgreementDeps,
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  place: Pick<PlaceRecord, "id">,
  routing: CalendarRoutingResult,
): Promise<VenuePlacement | null> {
  if (routing.repoFailed) {
    return null;
  }

  const reportSpaceless = (reason: string) => {
    logger?.error("booking_agreements.create_event.spaceless_mint", {
      bookingRequestId: request.id,
      placeId: place.id,
      requestedCalendarId: request.calendarId,
      reason,
    });
    try {
      deps.reportError?.(new Error("booking_agreement_spaceless_mint"), {
        tags: { useCase: "createEventFromAgreement" },
        extra: {
          bookingRequestId: request.id,
          placeId: place.id,
          requestedCalendarId: request.calendarId,
          reason,
        },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never fail the
      // mint.
    }
  };

  try {
    const calendars = await deps.repos.calendars.listByPlace(place.id);
    const defaultCalendar = calendars.find((c) => c.isDefault) ?? null;
    if (!defaultCalendar) {
      reportSpaceless("no_default_calendar");
      return null;
    }
    const activeSpace = defaultCalendar.spaces.find(
      (space) => space.status === "ACTIVE",
    );
    if (!activeSpace) {
      reportSpaceless("default_calendar_has_no_active_spaces");
      return null;
    }
    // Placement ONLY — the default calendar's template prefills (title,
    // defaultStartTime, defaultCategoryId) stay reserved for EXPLICITLY
    // routed requests (FR-009); an inferred fallback must not restyle the
    // event.
    return { calendarId: defaultCalendar.id, spaceId: activeSpace.id };
  } catch (error) {
    logger?.error("booking_agreements.create_event.fallback_placement_failed", {
      bookingRequestId: request.id,
      placeId: place.id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "createEventFromAgreement" },
        extra: { bookingRequestId: request.id, placeId: place.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never fail the
      // mint.
    }
    return null;
  }
}


/**
 * Suggested title (FR-009; v3 L20 for a request with a bill):
 * - the ACT is `billLead` when the request has a bill (see
 *   {@link resolveBillTitleLead}: the first act that JOINED, else the
 *   sender's name — never an invited act); otherwise, as before, the pitch
 *   `actName`, or the OWNED sender's display name;
 * - `"{act} at {calendar.name}"` when the request routes to a calendar AND an
 *   act label exists;
 * - otherwise the pre-hierarchy `"{act} at {place.name}"` (anonymous
 *   inquiries without an actName land here).
 * Clipped to the title bound either way. A prefill, never a constraint —
 * venue staff edit freely before publish.
 *
 * TODO(FR-009): `Calendar.eventTemplate.titleTemplate` is STORED (schema +
 * manage-calendars accept it) but not yet consumed here — the hardcoded
 * "{act} at {calendar}" composition above is the only title source. Wiring
 * the stored template in is blocked on the spec's open question of what
 * template syntax it uses (placeholder grammar, escaping, unknown-token
 * behaviour).
 */
async function buildDefaultTitle(
  repos: Repos,
  request: BookingRequestRecord,
  place: Pick<PlaceRecord, "name">,
  calendar: Pick<CalendarWithSpacesRow, "name"> | null,
  billLead: string | null,
): Promise<string> {
  if (calendar) {
    const act = billLead ?? (await resolveComposedActLabel(repos, request));
    if (act) {
      return clipTitle(`${act} at ${calendar.name}`);
    }
  }
  const performer =
    billLead ?? (await resolvePerformerLabel(repos, request)).trim();
  return clipTitle(`${performer} at ${place.name}`);
}

/**
 * The act a BILL titles the event after (v3 L20): the first act in bill
 * order that has JOINED — the act the minted lineup will headline — and,
 * when none has, the SENDER's own name. Never an invited act (NFR-002: an
 * invited act's name never becomes the booking's display name), and never
 * a passed or removed one.
 *
 * "Joined" is read as "goes onto the lineup": CONFIRMED rows, which includes
 * the sender's SELF row (named like the pre-bill headliner: the pitch
 * `actName`, else the sender) and by-name acts (CONFIRMED by construction —
 * the sender vouches for them, and they are attached like the rest).
 *
 * Null when the request never recorded a bill and has no act rows (the
 * `planBookingLineup` LEGACY case: sent before bills, RENT/USE, TO_PERFORMER)
 * — the caller keeps the pre-bill rule — or when no name resolves. A prefill: read OUTSIDE the mint's bill lock, so an answer
 * that lands in between can make the title name a different joined act than
 * the lineup's first row; staff edit the title freely.
 */
async function resolveBillTitleLead(
  repos: Repos,
  request: BookingRequestRecord,
): Promise<string | null> {
  const all = await repos.bookingRequests.listActsForRequests([request.id], {
    includeRemoved: true,
  });
  if (!request.billRecorded && all.length === 0) return null;

  const firstJoined = all.find(
    (act) => !act.removedAt && act.confirmation === "CONFIRMED",
  );
  if (!firstJoined) return resolveSenderTitleName(repos, request);

  switch (firstJoined.source) {
    case "SELF":
      return resolveComposedActLabel(repos, request);
    case "EXTERNAL":
      return clipName(firstJoined.externalName);
    case "TAGGED": {
      const identities = await resolveBillIdentities(repos, [firstJoined]);
      return clipName(billIdentityOf(firstJoined, identities).displayName);
    }
    default: {
      const exhaustive: never = firstJoined.source;
      throw new Error(`unknown bill act source: ${String(exhaustive)}`);
    }
  }
}

/**
 * The SENDER's own name for a bill title with no joined act (v3 L20):
 * deliberately NOT `actName` — on a bill without the sender it may hold an
 * act's name (a by-name act's, copied at create), and every act on it has
 * gone. Owned → the human / org name; anonymous → the contact name typed.
 */
async function resolveSenderTitleName(
  repos: Repos,
  request: BookingRequestRecord,
): Promise<string | null> {
  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous") return clipName(sender.contactName);
  if (sender.performerOwnerType === "human") {
    const human = await repos.humans.getById(sender.performerOwnerId);
    return clipName(human?.name);
  }
  const org = await repos.organizations.getById(sender.performerOwnerId);
  return clipName(org?.name);
}

function clipTitle(title: string): string {
  return title.length > EVENT_TITLE_MAX
    ? title.slice(0, EVENT_TITLE_MAX).trim()
    : title;
}

/**
 * Act label for the calendar-composed title: pitch `actName`, else the OWNED
 * sender's display name. Null for anonymous inquiries without an actName —
 * FR-009's open question resolves to falling back to the existing behaviour
 * rather than composing a contact name with a calendar name.
 */
async function resolveComposedActLabel(
  repos: Repos,
  request: BookingRequestRecord,
): Promise<string | null> {
  if (request.actName?.trim()) return request.actName.trim();

  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous") return null;

  if (sender.performerOwnerType === "human") {
    const human = await repos.humans.getById(sender.performerOwnerId);
    return human?.name?.trim() || null;
  }
  const org = await repos.organizations.getById(sender.performerOwnerId);
  return org?.name?.trim() || null;
}

async function resolvePerformerLabel(
  repos: Repos,
  request: BookingRequestRecord,
): Promise<string> {
  if (request.actName) return request.actName;

  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous") return sender.contactName;

  if (sender.performerOwnerType === "human") {
    const human = await repos.humans.getById(sender.performerOwnerId);
    if (human?.name) return human.name;
  } else {
    const org = await repos.organizations.getById(sender.performerOwnerId);
    if (org?.name) return org.name;
  }
  return "Live music";
}

/** The sender as a lineup row (see {@link resolveLineupIdentity}). */
type SenderLineupIdentity = {
  humanId: string | null;
  /** v3 FR-015: an org sender is a GROUP row. Never set with `humanId`. */
  orgId: string | null;
  externalName: string | null;
};

/**
 * EventHuman identity for the sender's row (the pre-bill headliner, and a
 * bill's SELF row — `orgId` is used by the SELF row only, see
 * `planBookingLineup`'s LEGACY branch):
 * - owned HUMAN sender (incl. claimed) → `humanId`, keeping `actName` as the
 *   displayed stage name when present (mirrors `linkHuman` semantics);
 * - owned ORG sender → `orgId` (v3 FR-015: a lineup row can be a group),
 *   keeping the act/org display name as `externalName` the same way — the
 *   name a reader that does not know groups yet still shows;
 * - anonymous sender → free-text from actName/contactName.
 */
async function resolveLineupIdentity(
  repos: Repos,
  request: BookingRequestRecord,
): Promise<SenderLineupIdentity> {
  const sender = getBookingRequestSender(request);

  if (sender.kind === "owned" && sender.performerOwnerType === "human") {
    return {
      humanId: sender.performerOwnerId,
      orgId: null,
      externalName: clipName(request.actName),
    };
  }

  if (sender.kind === "owned") {
    const org = await repos.organizations.getById(sender.performerOwnerId);
    return {
      humanId: null,
      orgId: sender.performerOwnerId,
      externalName:
        clipName(request.actName) ?? clipName(org?.name) ?? "Performer",
    };
  }

  return {
    humanId: null,
    orgId: null,
    externalName:
      clipName(request.actName) ?? clipName(sender.contactName) ?? "Performer",
  };
}

/** One EventHuman the mint attaches, before its sortOrder is assigned. */
type BookingLineupRow = {
  /** The bill row it came from; null for the pre-bill sender headliner. */
  actId: string | null;
  humanId: string | null;
  /** A group row (v3 FR-015). Never set with `humanId`. */
  orgId: string | null;
  externalName: string | null;
  externalUrl: string | null;
  role: BookingRequestActRole;
  /** Beside role OTHER only (v3 L13) — flows onto the lineup as is. */
  customRoleLabel: string | null;
};

type BookingLineupPlan = {
  /** `bill` when the request has act rows, `legacy` when it predates them. */
  source: "bill" | "legacy";
  /** In bill order; the mint numbers them 0..n-1. */
  rows: BookingLineupRow[];
  skippedPending: number;
  skippedDeclined: number;
};

/**
 * The event's lineup from the request's bill (FR-006) — pure.
 *
 * `bill` is the request's act rows INCLUDING sender-removed ones (v3
 * FR-001); `billRecorded` is the request's own column (v3 L12). Together they
 * tell "no bill" from "a bill that is empty":
 *
 * LEGACY (`billRecorded` false AND no act rows at all — sent before bills,
 * RENT/USE, or a TO_PERFORMER request): exactly the pre-bill behaviour — the sender as the one headliner row,
 * `identity` as `resolveLineupIdentity` builds it, byte-identical to before
 * bills: an org sender stays a free-text row with no link (its `orgId` is
 * used by a bill's SELF row only — linking pre-bill headliners is not part
 * of v3).
 *
 * BILL (`billRecorded`, or any act row — a v2 row recorded a bill before the
 * column existed): every LIVE CONFIRMED act, in `sortOrder` (the port's
 * order), with its role and label (v3 L13). A bill with nothing joined —
 * every act removed, or an empty bill (v3 L12) — attaches NOTHING: an empty
 * lineup.
 *   · SELF → the sender, mapped the way the pre-bill headliner always was
 *     (`identity`): a human sender → `{ humanId }` keeping `actName` as the
 *     displayed stage name; an org sender → `{ orgId }` (v3 FR-015) with its
 *     name and PUBLIC page (`senderOrgPageUrl`) as the fallback display;
 *   · TAGGED (joined) → `{ humanId }` for a person, `{ orgId }` for a group
 *     (v3 L17/L18) with its name and page from `groupNameOf`;
 *   · EXTERNAL → `{ externalName, externalUrl }` (the URL only if it is
 *     still http(s) — it was validated at write; this is the sink).
 * PENDING acts never attach (consent carries through — the event editor sees
 * them as suggestions, `listBookingLineupSuggestions`); DECLINED never flow;
 * REMOVED rows are not on the bill.
 */
function planBookingLineup(
  bill: readonly BookingRequestActRecord[],
  billRecorded: boolean,
  identity: SenderLineupIdentity,
  orgDisplay: {
    senderOrgPageUrl: string | null;
    groupNameOf: (act: BookingRequestActRecord) => {
      externalName: string | null;
      externalUrl: string | null;
    };
  },
): BookingLineupPlan {
  if (!billRecorded && bill.length === 0) {
    return {
      source: "legacy",
      rows: [
        {
          actId: null,
          humanId: identity.humanId,
          orgId: null,
          externalName: identity.externalName,
          externalUrl: null,
          role: "PERFORMER",
          customRoleLabel: null,
        },
      ],
      skippedPending: 0,
      skippedDeclined: 0,
    };
  }

  const rows: BookingLineupRow[] = [];
  let skippedPending = 0;
  let skippedDeclined = 0;
  for (const act of bill) {
    if (act.removedAt) continue;
    if (act.confirmation === "PENDING") {
      skippedPending += 1;
      continue;
    }
    if (act.confirmation === "DECLINED") {
      skippedDeclined += 1;
      continue;
    }
    const roleFields = {
      role: act.role,
      customRoleLabel:
        act.role === "OTHER" ? (act.customRoleLabel ?? null) : null,
    };
    switch (act.source) {
      case "SELF":
        rows.push({
          actId: act.id,
          humanId: identity.humanId,
          orgId: identity.orgId,
          externalName: identity.externalName,
          externalUrl: identity.orgId ? orgDisplay.senderOrgPageUrl : null,
          ...roleFields,
        });
        break;
      case "TAGGED": {
        // TAGGED always carries an owner pair (SQL CHECK); a row that does
        // not would be corrupt — skipped rather than attached nameless.
        if (!act.actOwnerId) continue;
        if (act.actOwnerType === "human") {
          rows.push({
            actId: act.id,
            humanId: act.actOwnerId,
            orgId: null,
            externalName: null,
            externalUrl: null,
            ...roleFields,
          });
        } else if (act.actOwnerType === "organization") {
          rows.push({
            actId: act.id,
            humanId: null,
            orgId: act.actOwnerId,
            ...orgDisplay.groupNameOf(act),
            ...roleFields,
          });
        }
        break;
      }
      case "EXTERNAL":
        rows.push({
          actId: act.id,
          humanId: null,
          orgId: null,
          externalName: clipName(act.externalName) ?? "Performer",
          externalUrl: toSafeExternalUrl(act.externalUrl)
            ? act.externalUrl
            : null,
          ...roleFields,
        });
        break;
      default: {
        const exhaustive: never = act.source;
        throw new Error(`unknown bill act source: ${String(exhaustive)}`);
      }
    }
  }
  return { source: "bill", rows, skippedPending, skippedDeclined };
}

/** attach-event-human's `externalUrl` bound. */
const EXTERNAL_URL_MAX = 500;

/**
 * Absolute link to an ORG sender's PUBLIC page (`${publicAppUrl}/orgs/{slug}`)
 * — the fallback `externalUrl` on the org's lineup row (see `publicAppUrl`)
 * — or null: not an org sender, no base URL, no PUBLIC org page, or a URL
 * that would not pass the EventHuman `externalUrl` rule (http(s), ≤ 500).
 * One read, org senders only.
 */
async function resolveSenderOrgPageUrl(
  repos: Pick<Repos, "entityPages">,
  request: BookingRequestRecord,
  publicAppUrl: string | null | undefined,
): Promise<string | null> {
  const base = publicAppUrl?.trim().replace(/\/+$/, "");
  if (!base) return null;
  if (isUnclaimedBookingInquiry(request)) return null;
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned" || sender.performerOwnerType !== "organization") {
    return null;
  }
  const page = await repos.entityPages.getByOwner(
    "ORGANIZATION",
    sender.performerOwnerId,
  );
  if (!page || page.visibility !== "PUBLIC" || !page.slug.trim()) return null;
  return absoluteOrgPageUrl(base, orgPageUrlFor(page.slug));
}

/** `publicAppUrl` without trailing slashes, or null when unset / blank. */
function normalizeAppBaseUrl(url: string | null | undefined): string | null {
  const base = url?.trim().replace(/\/+$/, "");
  return base ? base : null;
}

/**
 * `${base}${href}` for a relative org page link (`/orgs/{slug}`), or null
 * when either is missing or the result would not pass the EventHuman
 * `externalUrl` rule (http(s), ≤ 500).
 */
function absoluteOrgPageUrl(
  base: string | null,
  href: string | null,
): string | null {
  if (!base || !href) return null;
  const url = `${base}${href}`;
  return url.length <= EXTERNAL_URL_MAX && toSafeExternalUrl(url) ? url : null;
}

function clipName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > EXTERNAL_NAME_MAX
    ? trimmed.slice(0, EXTERNAL_NAME_MAX).trim()
    : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize attempt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the EXISTING finalize use case against the draft. Its typed gate
 * failures (`lines_unconfirmed` / `payee_not_ready`, and DEAL_FROZEN as
 * `deal_frozen`) are the designed "created, finalize later" outcome;
 * everything else propagates unchanged
 * (never swallow unexpected errors — house rule).
 */
async function tryFinalize(
  deps: CreateEventFromAgreementDeps,
  logger: LoggerPort | undefined,
  args: {
    actorHumanId: string;
    agreementId: string;
    eventId: string;
    /** `finalize` and the event's REAL owner side come from the plan. */
    plan: AgreementMintPlan;
  },
): Promise<{ finalized: boolean; finalizeBlocked?: FinalizeBlockedCode }> {
  if (!args.plan.finalize) {
    // Requester-owned (decided on the event the plan hands back, not on the
    // request's intent): the venue actor cannot pass finalize's event-edit
    // gate on an event the requester owns — and must not (see the enum doc).
    // The requester finalizes from their own admin.
    if (args.plan.ownerSide === "requester") {
      logger?.info("booking_agreements.create_event.finalize_deferred_to_owner", {
        agreementId: args.agreementId,
        eventId: args.eventId,
      });
      return { finalized: false, finalizeBlocked: "requester_owned" };
    }
    // Hold-confirm: the agreement is (usually) still a DRAFT — terms are not
    // agreed, so finalize is not attempted. The draft event exists; finalize
    // runs later through the normal agreement flow.
    return { finalized: false };
  }
  try {
    await finalizeBookingAgreement(
      {
        repos: deps.repos,
        idempotency: deps.idempotency,
        clock: deps.clock,
        logger: deps.logger,
      },
      {
        actorHumanId: args.actorHumanId,
        agreementId: args.agreementId,
        eventId: args.eventId,
      },
    );
    return { finalized: true };
  } catch (error) {
    const blocked = asFinalizeBlockedCode(error);
    if (blocked) {
      logger?.info("booking_agreements.create_event.finalize_blocked", {
        agreementId: args.agreementId,
        eventId: args.eventId,
        finalizeBlocked: blocked,
      });
      return { finalized: false, finalizeBlocked: blocked };
    }
    throw error;
  }
}

function asFinalizeBlockedCode(error: unknown): FinalizeBlockedCode | null {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : null;
  if (code === "lines_unconfirmed" || code === "payee_not_ready") return code;
  // A frozen deal (AppError DEAL_FROZEN): created, finalize from the
  // agreement page with the change confirmed (see the enum doc).
  if (isAppError(error) && error.code === "DEAL_FROZEN") return "deal_frozen";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure classification (envelope retention)
// ─────────────────────────────────────────────────────────────────────────────

/** Domain failures that re-fail identically on retry — near-zero retention. */
function isDeterministicCreateFailure(error: unknown): boolean {
  if (isAppError(error)) {
    return (
      error.code === "NOT_RESOURCE_OWNER" ||
      error.code === "INSUFFICIENT_ROLE" ||
      error.code === "PLACE_NOT_FOUND" ||
      error.code === "PLACE_NOT_ACTIVE" ||
      error.code === "ORGANIZATION_NOT_FOUND" ||
      error.code === "HUMAN_NOT_FOUND" ||
      error.code === "INVALID_STATUS" ||
      error.code === "IDEMPOTENCY_KEY_CONFLICT"
    );
  }
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : null;
  // invalid_input (save schema), forbidden (quota_exceeded), conflict
  // (anchor-CAS loser — retry resolves via the draft short-circuit).
  return code === "invalid_input" || code === "forbidden" || code === "conflict";
}
