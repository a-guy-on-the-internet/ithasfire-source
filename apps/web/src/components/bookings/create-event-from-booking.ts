/**
 * Pure helpers for the "Create event from this booking" path — shared by
 * FinalizeDialog on `/agreements/{id}` and `CreateEventFromBookingAction`
 * inside the venue inbox's conversation (booking-conversation-and-event-step
 * FR-007).
 *
 * Copy is deliberately literal English (PlaceProfileEditor precedent): the
 * i18n catalogs (`src/i18n/messages/*.ts`) are owned by a concurrent pass and
 * out of this change's footprint — move these strings into `admin.baCreate*`
 * keys in a follow-up.
 *
 * Pure (no React) so the gating/routing/copy rules can be unit-tested like
 * `@/lib/booking-agreements`.
 */

import { isoDateToLocal } from "@/lib/booking-requests";

/** Wire shape of `bookingAgreements.createEventFromAgreement`'s output. */
export type CreateEventFromBookingOutcome = {
  eventId: string;
  /** True when the call short-circuited to an existing draft/linked event. */
  alreadyLinked: boolean;
  /** True when the agreement is now finalize-linked (eventId set, terms ACTIVE). */
  finalized: boolean;
  /**
   * Present when `finalized === false`: the gate that blocked the link.
   * `requester_owned` is not a gate the venue can clear — the event belongs
   * to the requester (RENT / USE), so finalize was never attempted; the
   * draft sits in THEIR admin and they finalize from there. `deal_frozen`:
   * the event's deal is frozen, so finalizing is a change to it that every
   * payee is told about; it is made from the agreement page, never by create.
   */
  finalizeBlocked?: "lines_unconfirmed" | "payee_not_ready" | "requester_owned" | "deal_frozen";
};

/**
 * Structural subset of `OwnerEntityWithSlug` (useEventOwnerEntities) needed
 * for venue-side gating and editor routing.
 */
export type OwnerEntityForBooking =
  | { kind: "human"; humanId: string; adminSlug: string }
  | { kind: "org"; orgId: string; role: string; adminSlug: string };

/**
 * Client-side mirror of ORG_EDIT_ROLES — the bar `saveEventForOrg` (and
 * `requirePlaceOwnership` on the create-event use case) enforces server-side.
 * Narrower than the finalize picker's EVENT_EDIT_ROLES (no FINANCE): a
 * FINANCE member's create call would 403 on the event save.
 */
const CREATE_EVENT_ORG_ROLES = new Set(["OWNER", "ADMIN", "EDITOR"]);

/**
 * Whether to OFFER the create-event action. Server truth
 * (`createEventFromAgreement`): agreement must be booking-minted and the
 * actor must be on the VENUE side — for booking-minted agreements the venue
 * is always the COUNTERPARTY (`respond-to-booking-request` derives it at
 * accept time). While the owners query hasn't resolved, default open (same
 * posture as `mayAct` in AgreementEditor): a wrong FORBIDDEN beats wrongly
 * hiding the action from a legit venue admin.
 */
export function mayCreateEventFromBooking(args: {
  bookingMinted: boolean;
  counterpartyType: "human" | "organization";
  counterpartyId: string;
  owners: OwnerEntityForBooking[] | undefined;
}): boolean {
  if (!args.bookingMinted) return false;
  if (args.owners === undefined) return true;
  if (args.counterpartyType === "organization") {
    return args.owners.some(
      (owner) =>
        owner.kind === "org" &&
        owner.orgId === args.counterpartyId &&
        CREATE_EVENT_ORG_ROLES.has(owner.role),
    );
  }
  return args.owners.some(
    (owner) => owner.kind === "human" && owner.humanId === args.counterpartyId,
  );
}

/**
 * Canonical event-editor URL for the minted draft:
 * `/admin/{adminSlug}/events/{eventId}` (same shape as
 * `useCreateDraftEvent` / admin events `getEditUrl`).
 *
 * Slug derivation mirrors event OWNERSHIP in `createEventFromAgreement`:
 * - org counterparty → the event is owned by that org → its admin slug
 *   (orgSlug, falling back to orgId — same rule as `toOrgAdminSlug`);
 * - human counterparty → the save runs under the ACTOR, who must BE the
 *   counterparty human for the call to have succeeded → the viewer's own
 *   human admin slug (`@username`, falling back to `@{id}` — same rule as
 *   `toHumanAdminSlug`).
 */
export function venueEventEditorUrl(args: {
  eventId: string;
  counterpartyType: "human" | "organization";
  counterpartyId: string;
  owners: OwnerEntityForBooking[] | undefined;
}): string {
  return `/admin/${venueAdminSlug(args)}/events/${args.eventId}`;
}

/**
 * The venue counterparty's admin slug — the shell its booking inbox and its
 * events live under. Shared by {@link venueEventEditorUrl} and the
 * conversation link the outcome notice offers when the event went to the
 * REQUESTER's admin instead (there is no venue-side event to open, but the
 * thread is still the venue's).
 */
export function venueAdminSlug(args: {
  counterpartyType: "human" | "organization";
  counterpartyId: string;
  owners: OwnerEntityForBooking[] | undefined;
}): string {
  const owners = args.owners ?? [];
  if (args.counterpartyType === "organization") {
    const org = owners.find(
      (owner) => owner.kind === "org" && owner.orgId === args.counterpartyId,
    );
    return org?.adminSlug ?? args.counterpartyId;
  }
  const human = owners.find(
    (owner) =>
      owner.kind === "human" && owner.humanId === args.counterpartyId,
  );
  return human?.adminSlug ?? `@${args.counterpartyId}`;
}

/**
 * The show date the explainer cites — mirrors the server's `startsAt`
 * preference in `createEventFromAgreement`: the agreement's negotiated
 * `proposedDate` when one exists, falling back to the request's first
 * preferred date (anchored at local midnight, same as the header card's
 * preferred-dates display).
 */
export function explainerShowDate(args: {
  proposedDate: Date | null;
  preferredDates: string[] | undefined;
}): Date | null {
  if (args.proposedDate) return args.proposedDate;
  const first = args.preferredDates?.[0];
  return first ? isoDateToLocal(first) : null;
}

/**
 * Calm explainer under the create button. Full sentence only when all three
 * facts are on hand (venue from the page's place query, date from
 * `explainerShowDate`, and act from the agreement's proposer display name);
 * otherwise a generic line.
 */
export function createEventExplainerCopy(args: {
  venueName: string | null;
  dateLabel: string | null;
  actName: string | null;
}): string {
  const { venueName, dateLabel, actName } = args;
  if (venueName && dateLabel && actName) {
    return `Creates a draft show at ${venueName} on ${dateLabel} with ${actName} on the bill. Fine-tune details in the event editor before publishing.`;
  }
  return "Creates a draft event prefilled from this booking — place, date, and lineup. Fine-tune details in the event editor before publishing.";
}

/**
 * Success-state copy. A FRESH finalized mint (`finalized && !alreadyLinked`)
 * is handled by toast + navigation in the dialog; the already-linked and
 * blocked variants render inline (role="status") — already-linked because a
 * concurrent admin may have linked an event outside the counterparty's admin
 * shell, so an explicit link beats a blind redirect. The `requester_owned`
 * variant says where the draft went instead of promising a finalize the
 * venue cannot perform.
 */
export function createEventOutcomeCopy(outcome: CreateEventFromBookingOutcome): {
  title: string;
  detail: string | null;
} {
  if (outcome.finalized) {
    return {
      title: outcome.alreadyLinked
        ? "This agreement is already linked to its event."
        : "Event created and agreement finalized",
      detail: null,
    };
  }
  if (outcome.finalizeBlocked === "requester_owned") {
    return {
      title: "Event created in the requester's admin",
      detail:
        "They own this one: the draft is in their admin, and they finalize the agreement onto it before it can publish. There's nothing to finalize on your side.",
    };
  }
  if (outcome.finalizeBlocked === "deal_frozen") {
    return {
      title: "Event created. Its deal is frozen",
      detail:
        "The draft event exists now. Its deal is frozen, so finalizing the agreement onto it changes the deal and tells everyone on it. Finalize from the agreement page.",
    };
  }
  if (outcome.finalizeBlocked === "payee_not_ready") {
    return {
      title: "Event created — finalize when payees are ready",
      detail:
        "The draft event exists now. Once every payee can receive payouts, create-event or the finalize flow below will link the agreement onto it.",
    };
  }
  return {
    title: "Event created — finalize when payouts are confirmed",
    detail:
      "The draft event exists now. Once every payout line is confirmed, create-event or the finalize flow below will link the agreement onto it.",
  };
}

/**
 * Typed-code → calm message mapping for `createEventFromAgreement` failures.
 * Reads the structured `data.appCode` first (error-contract shape), falling
 * back to the message (AppError messages default to the code itself).
 * Returns null for unmapped errors — callers fall back to
 * `formatErrorMessage`.
 */
const CREATE_EVENT_ERROR_MESSAGES: Record<string, string> = {
  AGREEMENT_NOT_ACCEPTED:
    "This agreement isn't accepted anymore, so an event can't be created from it. Refresh to see its current status.",
  AGREEMENT_NOT_FOUND:
    "This agreement could not be found. Refresh and try again.",
  INVALID_STATUS:
    "This booking is missing the details needed to create an event. Refresh and try again.",
  BOOKING_REQUEST_NOT_FOUND:
    "This agreement didn't come from a booking request, so there's no booking to create an event from.",
  PLACE_NOT_FOUND:
    "The place on this booking no longer exists, so an event can't be created from it.",
  NOT_RESOURCE_OWNER:
    "Only the place on this agreement can create the event.",
  INSUFFICIENT_ROLE:
    "Only the place on this agreement can create the event.",
  IDEMPOTENCY_LOCK_IN_PROGRESS:
    "This event is already being created. Give it a moment, then try again.",
  // Anchor-CAS loser / stale generations — a retry converges on the winner's
  // draft via the use case's short-circuit, so invite one.
  CONFLICT:
    "Something changed while creating the event. Try again — it will pick up the existing draft.",
  STALE_DRAFT_GENERATIONS_EXHAUSTED:
    "Something changed while creating the event. Try again — it will pick up the existing draft.",
};

export function createEventFromBookingErrorMessage(
  err: unknown,
): string | null {
  const e = err as {
    message?: string;
    data?: { code?: string; appCode?: string } | null;
  };
  const candidates = [e?.data?.appCode, e?.message, e?.data?.code];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const mapped = CREATE_EVENT_ERROR_MESSAGES[candidate.toUpperCase()];
    if (mapped) return mapped;
  }
  return null;
}
