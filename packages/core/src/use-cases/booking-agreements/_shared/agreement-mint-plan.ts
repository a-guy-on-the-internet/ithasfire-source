import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
  type BookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { ORG_EDIT_ROLES, requireOrgMembership } from "../../../lib/rbac";
import { isVenueOwnedEvent } from "../../../lib/venue-confirmation";
import {
  assertBookingEventLive,
  assertBookingEventOnNight,
  resolveBookingEvent,
} from "../../booking-holds/_shared/booking-night";
import {
  requirePlaceBookingAuthority,
  type PlaceBookingAuthorityResult,
} from "../../booking-requests/_shared/place-access";
import type { OwnerContext } from "../../events/_shared/save-event-shared";
import { ensurePlaceActive } from "../../events/_shared/place-access";
import { enforceQuota } from "../../quotas/enforce-quota";
import { assertFinalizeGates } from "../finalize-booking-agreement";
import {
  resolveEventOwnerSide,
  type EventOwnerSide,
} from "./event-owner-side";
import { anchorPreferredDate, parsePreferredDateEntry } from "./pitch-seed";

// ─────────────────────────────────────────────────────────────────────────────
// THE AGREEMENT MINT'S PLAN (booking-the-night, review rounds 4–6).
//
// Every refusal the mint can raise lives here. The mint executes the plan;
// never add a gate to the mint body.
//
// `createEventFromAgreement` (every entry: the manual "Create event", the
// hold variant book-without-terms calls, the night variant the agree calls)
// calls `planAgreementMint` and then only EXECUTES the plan it returns:
// hand back a finalized event, link an event-first origin, hand back (and
// finalize) a live draft, or save a fresh event. Every booking path calls the
// SAME function read-only BEFORE it takes a line (`assertBookingPreflight`,
// booking-preflight.ts), so a refusal the mint would raise after the take is
// raised before it instead — and the two can never drift, because there is
// only one of them.
//
// What can still fail after a take is a race with these reads (a place
// suspended, a quota used up, a role removed, an event cancelled in between)
// or an infrastructure error; the callers report those
// (`reportPostCommitRefusal`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agreement statuses a hold-path mint may anchor a draft on: the negotiation
 * is open (or already settled). Terminal statuses (DECLINED, CANCELLED,
 * EXPIRED, FULFILLED…) never mint, link or hand back a draft.
 */
export const HOLD_MINT_AGREEMENT_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "COUNTERED",
  "ACCEPTED",
] as const;

/**
 * The requester as an event owner: the request's OWNED sender (human or
 * org). An anonymous / unclaimed-inquiry request has nobody to hand the
 * event to — the sender must claim first.
 */
export function resolveRequesterOwner(
  request: BookingRequestRecord,
): OwnerContext {
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned" || isUnclaimedBookingInquiry(request)) {
    throw fail("INVALID_STATUS", {
      message: "requester_not_owned",
      meta: { bookingRequestId: request.id },
    });
  }
  return sender.performerOwnerType === "organization"
    ? { kind: "org", orgId: sender.performerOwnerId }
    : { kind: "human", humanId: sender.performerOwnerId };
}

/**
 * Which entry of the mint runs:
 *   - `hold`   — book without terms (`createEventFromAgreementForHold`):
 *                open terms allowed, never finalized;
 *   - `night`  — the agree's mint (`createEventFromAgreementOnNight`):
 *                ACCEPTED terms, finalized when venue-owned;
 *   - `manual` — the venue's "Create event" (and the venue confirmation's
 *                mint): ACCEPTED terms, finalized when venue-owned.
 */
export type AgreementMintMode = "hold" | "night" | "manual";

/**
 * What the mint does:
 *   - `finalized` — hands back the event the terms were finalized against;
 *   - `link`      — links the live event-first origin (no save, no finalize);
 *   - `draft`     — hands back a live draft anchor (finalized when `finalize`);
 *   - `mint`      — saves a fresh event (then finalizes when `finalize`).
 */
export type AgreementMintOutcome = "finalized" | "link" | "draft" | "mint";

export type PlanAgreementMintArgs = {
  mode: AgreementMintMode;
  /**
   * The terms. Null = none yet: book without terms on an OPEN request, whose
   * accept drafts them (DRAFT, naming `pendingVenueCounterparty`) in the
   * same transaction that takes the line.
   */
  agreement: AgreementRecord | null;
  pendingVenueCounterparty?: { type: "human" | "organization"; id: string } | null;
  request: BookingRequestRecord;
  /** The request's place; null when the request names none (refused). */
  place: PlaceRecord | null;
  /** The calendar whose line the event lands on; null = the request's routing. */
  calendarId: string | null;
  /**
   * The BOOKED night (place-local day) a handed-back event must sit on: a
   * hold's night, or a night this request booked. Null = no booked night —
   * then no handed-back event is checked against any day.
   */
  nightDate: string | null;
  /**
   * Date-less legacy terms with no booked night: the day a FRESH save falls
   * back to (the override's day, else the first preferred date). Read ONLY to
   * anchor a fresh save's start — never as a night a handed-back event must
   * sit on (review round 6 BLOCKING: a draft the venue moved stays theirs).
   */
  fallbackDay?: string | null;
  placeTz: string;
  /** Whose refusal codes the event checks raise: the sender's (no meta) or the venue's. */
  side: "venue" | "sender";
  ownerOverride: EventOwnerSide | null;
  /**
   * The mint names its start instant (an override, a hold's start, the terms'
   * date). False = it falls back to the pitch's preferred dates, which must
   * then anchor.
   */
  startNamed: boolean;
  /**
   * The venue human the mint runs as. Null = plan without the actor's gates
   * (authority, counterparty, finalize, requester existence, quota)
   * — the agree's pre-flight, where the mint runs after commit as a stand-in
   * and those failures are reported and retried through "Create event".
   */
  actor: { humanId: string; now: Date } | null;
};

export type AgreementMintPlan = {
  outcome: AgreementMintOutcome;
  /** The request's place (the plan refuses a request without one). */
  place: PlaceRecord;
  /** The event handed back or linked; null for `mint`. */
  event: EventRecord | null;
  /**
   * Who owns the event: the handed-back event's REAL owner (venue when its
   * owner is one of the place's), else — for a fresh save — the owner by
   * intent and override.
   */
  ownerSide: EventOwnerSide;
  /** A CANCELLED / ARCHIVED draft anchor a fresh save replaces, else null. */
  deadDraftEventId: string | null;
  /** The actor's staff authority at the place; null without an actor. */
  authority: PlaceBookingAuthorityResult | null;
  /** The mint attempts finalize after handing back / saving. */
  finalize: boolean;
  /** The requester that owns a fresh requester-owned save; else null. */
  requesterOwner: OwnerContext | null;
  /** The preferred-date entry a fresh save anchors on when nothing names its start. */
  defaultStartEntry: string | null;
};

/**
 * Who owns the event a mint hands back or saves — the plan's `ownerSide`,
 * and so who a booking without terms pays (its money goes 100% to the
 * event's owner until terms are added): the handed-back event's REAL owner
 * (venue when its owner is one of the place's), else the owner by intent and
 * override. Exported so the inbox list says the same thing the plan decides.
 * A null `place` (the list's place read found nothing) cannot classify an
 * existing event's owner: null then, never a guess.
 */
type MintOwnerSideArgs<P> = {
  event: Pick<EventRecord, "orgId" | "humanId"> | null;
  place: P;
  request: Pick<PlanAgreementMintArgs["request"], "intent">;
  ownerOverride: EventOwnerSide | null;
};
type OwnerFields = Pick<PlaceRecord, "orgIdsWithAccess" | "humanIdsWithAccess">;
export function mintEventOwnerSide(args: MintOwnerSideArgs<OwnerFields>): EventOwnerSide;
export function mintEventOwnerSide(
  args: MintOwnerSideArgs<OwnerFields | null>,
): EventOwnerSide | null;
export function mintEventOwnerSide(
  args: MintOwnerSideArgs<OwnerFields | null>,
): EventOwnerSide | null {
  if (args.event) {
    if (!args.place) return null;
    return isVenueOwnedEvent(args.event, args.place) ? "place" : "requester";
  }
  return resolveEventOwnerSide(args.request, args.ownerOverride);
}

type PlanRepos = Pick<
  Repos,
  | "events"
  | "authz"
  | "placeBookingGrants"
  | "resourceQuotas"
  | "agreements"
  | "humans"
  | "organizations"
>;

/**
 * Every refusal the mint can raise lives here. The mint executes the plan;
 * never add a gate to the mint body.
 *
 * Read-only. In order:
 *   1. the request is venue-bound, and its place exists;
 *   2. the actor's staff authority at the place (never a booking grantee);
 *   3. the request's event: a dead event-first origin / a finalized link to a
 *      dead event refuse; a live one must sit on the BOOKED night (none
 *      without one);
 *   4. (retired: the grantee rule. A grantee no longer passes 2,
 *      holds-without-a-request FR-002.)
 *   5. (not for a finalized link) the terms' status: open for the hold
 *      path, ACCEPTED for the others — terms that are cancelled or declined
 *      never link, hand back or save;
 *   6. a fresh save: the place is ACTIVE, a requester owner exists for a
 *      requester-owned one, the start anchors;
 *   7. actor gates: the save and the finalize run as the actor, so a venue
 *      counterparty must be the actor or an org they edit; the requester
 *      owner's row exists; finalize's own gates; the owning org's quota.
 */
export async function planAgreementMint(
  repos: PlanRepos,
  args: PlanAgreementMintArgs,
): Promise<AgreementMintPlan> {
  const { agreement, request, side, actor, mode } = args;
  const agreementId = agreement?.id ?? null;

  // 1. Venue-bound requests only: the mint is venue-side machinery (an
  //    organizer request has no venue anchor), and the place must exist.
  if (request.direction !== "TO_VENUE") {
    throw fail("INVALID_STATUS", {
      message: "organizer_agreement_event_creation_unsupported",
      meta: { agreementId, direction: request.direction },
    });
  }
  const place = args.place;
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const intendedOwnerSide = resolveEventOwnerSide(request, args.ownerOverride);

  // 2. Venue-side authority: the place's STAFF only. A booking grantee does
  //    not mint from an act's agreement (holds-without-a-request FR-002).
  const authority = actor
    ? await requirePlaceBookingAuthority(repos, place, actor.humanId)
    : null;

  // 3. The request's event.
  const resolved = await resolveBookingEvent(repos, { agreement, request });
  if (args.nightDate) {
    assertBookingEventOnNight(resolved, {
      night: args.nightDate,
      placeTz: args.placeTz,
      side,
      agreementId,
      // The booked night's LINE: its calendar too (review carry d).
      calendarId: args.calendarId,
    });
  } else {
    assertBookingEventLive(resolved, { side, agreementId });
  }
  let outcome: AgreementMintOutcome = "mint";
  let event: EventRecord | null = null;
  if (resolved.kind === "event") {
    event = resolved.event;
    outcome =
      agreement?.eventId === event.id
        ? "finalized"
        : event.id === request.originEventId
          ? "link"
          : "draft";
  }
  const ownerSide = mintEventOwnerSide({
    event,
    place,
    request,
    ownerOverride: args.ownerOverride,
  });
  const finalize =
    mode !== "hold" &&
    ownerSide === "place" &&
    (outcome === "draft" || outcome === "mint");
  const saves = outcome === "mint";

  const base = {
    outcome,
    place,
    event,
    ownerSide,
    deadDraftEventId: null as string | null,
    authority,
    finalize,
    requesterOwner: null as OwnerContext | null,
    defaultStartEntry: null as string | null,
  };
  if (outcome === "finalized") {
    return base;
  }

  // 5. The terms' status.
  const status = agreement?.status ?? "DRAFT";
  if (mode === "hold") {
    if (!(HOLD_MINT_AGREEMENT_STATUSES as readonly string[]).includes(status)) {
      throw fail("INVALID_STATUS", {
        message: "agreement_terminal",
        meta: { agreementId, status },
      });
    }
  } else if (status !== "ACCEPTED") {
    throw fail("AGREEMENT_NOT_ACCEPTED");
  }

  // 6. What a fresh save needs.
  if (saves) {
    ensurePlaceActive(place);
    if (agreement?.draftEventId) {
      // Passed over by the resolution, so dead (a row) or gone (null).
      const dead = await repos.events.getById(agreement.draftEventId);
      base.deadDraftEventId = dead ? agreement.draftEventId : null;
    }
    if (intendedOwnerSide === "requester") {
      base.requesterOwner = resolveRequesterOwner(request);
    }
    if (!args.startNamed) {
      base.defaultStartEntry = defaultStartEntryOf(
        request,
        args.nightDate ?? args.fallbackDay ?? null,
        args.placeTz,
      );
    }
  }

  // Without an actor (the agree's pre-flight) the actor's gates — and the
  // QUOTA — are not asked. That skip is LOAD-BEARING for the sender's
  // privacy, not only a degrade: `enforceQuota` throws a plain
  // `{ code: "forbidden", meta: { subjectId, limitValue, currentUsage } }`
  // naming the venue org's numbers, and on the agree path that would reach
  // the SENDER. (respond-to-booking-agreement also strips meta from any
  // non-AppError refusal, as a second line.)
  if (!actor || !authority) {
    return base;
  }

  // 7. The actor's gates.
  if ((saves && intendedOwnerSide === "place") || finalize) {
    const counterparty = agreement
      ? { type: agreement.counterpartyType, id: agreement.counterpartyId }
      : (args.pendingVenueCounterparty ?? null);
    if (counterparty?.type === "organization") {
      await requireOrgMembership({
        repos,
        orgId: counterparty.id,
        actorHumanId: actor.humanId,
        roles: ORG_EDIT_ROLES,
      });
    } else if (counterparty && counterparty.id !== actor.humanId) {
      // The save runs as the ACTOR, and finalize asks for the event's owner:
      // a human counterparty must create their own event.
      throw fail("NOT_RESOURCE_OWNER", {
        meta: {
          entity: "agreement_counterparty",
          counterpartyId: counterparty.id,
        },
      });
    }
  }
  if (base.requesterOwner) {
    if (base.requesterOwner.kind === "human") {
      if (!(await repos.humans.getById(base.requesterOwner.humanId))) {
        throw fail("HUMAN_NOT_FOUND");
      }
    } else if (!(await repos.organizations.getById(base.requesterOwner.orgId))) {
      throw fail("ORGANIZATION_NOT_FOUND");
    }
  }
  if (finalize && agreement) {
    await assertFinalizeGates(repos, {
      agreement,
      eventId: outcome === "draft" ? (event?.id ?? null) : null,
      actorHumanId: actor.humanId,
    });
  }
  if (saves) {
    await assertSaveQuota(repos, args, base.requesterOwner);
  }
  return base;
}

/**
 * The pitch entry a fresh save anchors on when nothing names its start: the
 * booked night (the act's named time on it when the pitch named one), else
 * the pitch's first preferred date. Refused when there is none, or it is not
 * a real day.
 */
function defaultStartEntryOf(
  request: BookingRequestRecord,
  /** The booked night, else the date-less fallback day; null = neither. */
  day: string | null,
  placeTz: string,
): string {
  const entry = day
    ? (request.preferredDates.find((candidate) => {
        const parts = parsePreferredDateEntry(candidate);
        return parts !== null && parts.date === day && parts.time !== null;
      }) ?? day)
    : request.preferredDates[0];
  if (!entry) {
    throw fail("INVALID_STATUS", {
      meta: { reason: "booking_request_missing_preferred_dates" },
    });
  }
  if (!anchorPreferredDate(entry, placeTz, null)) {
    throw fail("INVALID_STATUS", {
      meta: { reason: "booking_request_invalid_preferred_date", date: entry },
    });
  }
  return entry;
}

/**
 * `enforceQuota` READS (effective quota + pending expansion) and throws the
 * save's own `forbidden: quota_exceeded`; it writes nothing, so it runs on
 * the root repos here. A requester org's refusal carries the message the
 * mint uses for it (`quota_exceeded_for_requester`).
 */
async function assertSaveQuota(
  repos: Pick<Repos, "resourceQuotas">,
  args: PlanAgreementMintArgs,
  requesterOwner: OwnerContext | null,
): Promise<void> {
  const quotaRepos = repos as unknown as TxRepos;
  if (requesterOwner) {
    if (requesterOwner.kind !== "org") return;
    try {
      await enforceQuota(quotaRepos, {
        subjectType: "ORG",
        subjectId: requesterOwner.orgId,
        kind: "EVENTS_PER_ORG",
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { message?: unknown }).message === "quota_exceeded"
      ) {
        throw { ...error, message: "quota_exceeded_for_requester" as const };
      }
      throw error;
    }
    return;
  }
  const venueParty = args.agreement
    ? { type: args.agreement.counterpartyType, id: args.agreement.counterpartyId }
    : (args.pendingVenueCounterparty ?? null);
  if (venueParty?.type !== "organization") return;
  await enforceQuota(quotaRepos, {
    subjectType: "ORG",
    subjectId: venueParty.id,
    kind: "EVENTS_PER_ORG",
  });
}
