import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

import type { ArrivalAreaPin } from "../../../lib/arrival-areas/geometry";
import { isActOnBill } from "../../../lib/event-human-roles";
import { isEmailVerified } from "../../_helpers/ensure-email-verified";
import { isEventPast } from "../../../lib/event-ended";
import {
  eventIsGated,
  projectPublicEventLocation,
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "../../../lib/location/project-public-event-location";
import { placeWithholdsAddress } from "../../../lib/location/redact-place-location";
import { viewerHoldsLiveRsvp } from "../../../lib/location/holder-eligibility";
import { resolveHolderAddress } from "../../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../../lib/venue-confirmation";

// ─────────────────────────────────────────────────────────────────────────────
// WHO SEES AN EVENT'S ARRIVAL AREAS, decided once (arrival-areas FR-004,
// FR-008, FR-009). Extracted from list-arrival-areas-for-viewer so the
// public projection, the editor read and the save-time pin choice share ONE
// rule instead of three copies:
//   · list-arrival-areas-for-viewer — what a viewer is shown;
//   · list-arrival-areas-for-editor — which place areas an event editor sees;
//   · manage-arrival-areas          — which pin an event-only area is
//                                     measured against (FR-005), so the 3 km
//                                     check never answers "near the withheld
//                                     house" for someone who cannot see it.
//
// The address decision is the address's own: `resolveHolderAddress` (public
// when nothing is withheld; else holders, RSVP-ers and acts on the bill), the place's
// managers (`canManagePlace`), and the event's editors only for an address
// that is their own (an event with no place). Editing an event AT a withheld
// place does not entitle anyone to that place's address.
// ─────────────────────────────────────────────────────────────────────────────

export type AreaGrant = {
  /** PARKING and ACCESSIBLE_DROP_OFF. */
  publicKinds: boolean;
  loadIn: boolean;
};

export const NO_GRANT: AreaGrant = { publicKinds: false, loadIn: false };

/**
 * A grant per row source: the PLACE's rows and the event's own rows answer
 * to different people (the place's LOAD_IN is the place's service entrance;
 * an event editor's own event-only rows are theirs).
 */
export type SourceGrants = Record<"PLACE" | "EVENT", AreaGrant>;

export const sameGrant = (grant: AreaGrant): SourceGrants => ({
  PLACE: grant,
  EVENT: grant,
});

export type SourcedRow = ArrivalAreaRow & { source: "PLACE" | "EVENT" };

/**
 * Whether `grants` lets this row's KIND through for its source (pure; no
 * geometry work). Ignores `disabledAt`: the public read drops switched-off
 * rows itself, the editor read lists them.
 */
export function kindAllowedBy(row: SourcedRow, grants: SourceGrants): boolean {
  const grant = grants[row.source];
  if (!grant) return false;
  return row.kind === "LOAD_IN"
    ? grant.loadIn
    : row.kind === "PARKING" || row.kind === "ACCESSIBLE_DROP_OFF"
      ? grant.publicKinds
      : false; // an unknown kind fails closed
}

export type EventAreaAccessDeps = {
  repos: Pick<
    Repos,
    "eventHumans" | "tickets" | "eventRsvps" | "eventDateRsvps" | "humans"
  >;
  /**
   * The ROOT-pool authz probes. Not read when the input carries
   * `precomputedStaff`, which is how a caller inside a transaction must call
   * this: the AuthZ adapter reads on its own connection, and probing it while
   * holding a tx connection plus the Event row lock starves the pool (see
   * events/_shared/venue-manager-stamp.ts, and save-event's
   * `probeManagedPlace`).
   */
  authz?: Pick<AuthZPort, "canEditEvent" | "canManagePlace">;
};

/**
 * Staff answers probed BEFORE a transaction ({@link probeEventAreaStaff}).
 * `placeStaff` speaks for `placeId` only: when the event's place (as read
 * under the lock) is not that place, it counts as false.
 */
export type PrecomputedEventAreaStaff = {
  placeId: string | null;
  placeStaff: boolean;
  eventStaff: boolean;
};

export type EventAreaAccessInput = {
  event: EventRecord;
  /** The event's OWN place (by `event.placeId`), or null. */
  place: PlaceRecord | null;
  viewerHumanId: string | undefined;
  /**
   * TRUE only when the caller has proven this viewer passed the event's
   * password / application gate. Editors are past it by definition.
   */
  gateAccessGranted: boolean;
  now: Date;
  /** Probed before the caller's transaction; when set, `deps.authz` is not called. */
  precomputedStaff?: PrecomputedEventAreaStaff;
};

/**
 * The two staff probes, on the root pool, for a caller about to open a
 * transaction. `placeId` is the event's place as read before the
 * transaction; {@link resolveEventAreaAccess} drops `placeStaff` if the
 * locked row names another place (fail closed).
 */
export async function probeEventAreaStaff(
  authz: Pick<AuthZPort, "canEditEvent" | "canManagePlace">,
  input: { actorHumanId: string; eventId: string; placeId: string | null },
): Promise<PrecomputedEventAreaStaff> {
  const placeStaff = input.placeId
    ? (
        await authz.canManagePlace({
          actorHumanId: input.actorHumanId,
          placeId: input.placeId,
        })
      ).allowed === true
    : false;
  const eventStaff =
    (
      await authz.canEditEvent({
        actorHumanId: input.actorHumanId,
        eventId: input.eventId,
      })
    ).allowed === true;
  return { placeId: input.placeId, placeStaff, eventStaff };
}

export type EventAreaAccess = {
  /** Anyone past the gate sees the exact address. */
  publicOpen: boolean;
  /** The viewer manages the event's place. */
  placeStaff: boolean;
  /** The viewer may edit the event. */
  eventStaff: boolean;
  /** THIS viewer may see the event's exact address. */
  addressVisible: boolean;
  /** Per-source grants for this viewer. */
  grants: SourceGrants;
  /** What an anonymous visitor gets (for cacheability). */
  anonymousGrant: AreaGrant;
};

/** The one access decision for an event's arrival areas (see module header). */
export async function resolveEventAreaAccess(
  deps: EventAreaAccessDeps,
  input: EventAreaAccessInput,
): Promise<EventAreaAccess> {
  const { event, place, viewerHumanId, gateAccessGranted, now } = input;
  // `null` place with a `placeId` reaches `resolveHolderAddress` as an
  // unreadable place (locked, `placeUnavailable`): fail closed by design.
  const placeLocation = place ? toPlaceLocationSource(place) : null;
  const arm = venueConfirmationArm(event, place);

  const addressUnlocked = (activeHolder: boolean, actOnBill: boolean) =>
    !resolveHolderAddress({
      event,
      place: placeLocation,
      venueConfirmationArm: arm,
      activeHolder,
      actOnBill,
      now,
    }).locked;

  // A gate (password / application) not passed hides the location like the
  // rest of the page; only acts and managing staff are past it.
  const gateOpen = !eventIsGated(event) || gateAccessGranted;
  const publicOpen = gateOpen && addressUnlocked(false, false);

  let placeStaff = false;
  let eventStaff = false;
  let act = false;
  let holder = false;
  if (viewerHumanId) {
    const pre = input.precomputedStaff;
    if (pre) {
      // Honoured only for the place it was probed for.
      placeStaff =
        pre.placeStaff &&
        place !== null &&
        pre.placeId !== null &&
        pre.placeId === place.id &&
        event.placeId === place.id;
      eventStaff = pre.eventStaff;
    } else {
      if (!deps.authz) {
        throw new Error("resolveEventAreaAccess: authz or precomputedStaff required");
      }
      if (place) {
        placeStaff =
          (
            await deps.authz.canManagePlace({
              actorHumanId: viewerHumanId,
              placeId: place.id,
            })
          ).allowed === true;
      }
      eventStaff =
        (
          await deps.authz.canEditEvent({
            actorHumanId: viewerHumanId,
            eventId: event.id,
          })
        ).allowed === true;
    }
    // B2: a lineup row can be linked BY EMAIL
    // (`inviteLineupHumanToRegister`) onto an unverified account someone
    // else opened under that address, so an act's grants (load-in, the
    // withheld address) also need the viewer's verified email. Asked only
    // for an act (one read).
    act =
      isActOnBill(await deps.repos.eventHumans.listByEvent(event.id), viewerHumanId) &&
      (await isEmailVerified(deps.repos.humans, viewerHumanId));
    // Holding only ever adds the public kinds behind `addressVisible`; when
    // the address is public anyway it changes nothing, so skip the lookups.
    holder =
      !publicOpen &&
      gateOpen &&
      ((await deps.repos.tickets.viewerHoldsActiveTicketForEvent(
        event.id,
        viewerHumanId,
      )) ||
        (await viewerHoldsLiveRsvp(deps.repos, event, viewerHumanId)));
  }

  // An editor's own address: an event with no place (a freeform or saved
  // location is its organiser's own). At a withheld place, editing grants
  // nothing. At a place that PUBLISHES its address, the editor sees it even
  // when their own event is OBSCURED (the place's address is public anyway;
  // the place's LOAD_IN stays restricted below).
  // Editors are past the event's own gate: a public address is theirs too.
  const eventStaffOwnAddress =
    eventStaff &&
    (!event.placeId ||
      addressUnlocked(false, false) ||
      (place !== null &&
        place.id === event.placeId &&
        !placeWithholdsAddress(place)));
  const holderUnlocked = holder && addressUnlocked(true, false);
  const actUnlocked = act && addressUnlocked(false, true);

  const addressVisible =
    publicOpen ||
    placeStaff ||
    eventStaffOwnAddress ||
    holderUnlocked ||
    actUnlocked;

  const ended = isEventPast(
    { startsAt: event.startsAt, endsAt: event.endsAt ?? null },
    now,
  );
  // Whether the PLACE vouched for this event (its own show, or one it
  // stamped). A community listing or no arm is no vouch: anyone can attach
  // an event to any place, list themselves, and must not get the place's
  // service entrance that way, even at a place that publishes its address.
  const placeVouched = arm === "owner" || arm === "stamp";

  // The place's load-in: its managers; and, at a show the place vouched for
  // and until it has ended, its acts and the event's editors (owner ruling
  // Q3, 2026-10-17: the place vouched for the show, so its organiser gets the
  // service entrance; ending with the show is fail closed, pending the
  // owner). An editor who lists themselves as an act passes on the editor
  // clause anyway. All of it needs `addressVisible`: an editor
  // who cannot see a withheld place's address gets none of its areas.
  // Holders and RSVP-ers never get load-in.
  const placeLoadIn =
    addressVisible &&
    (placeStaff || (placeVouched && !ended && (actUnlocked || eventStaff)));
  // The event's own load-in rows: also the event's editors (they drew them),
  // and its acts until the event has ended.
  const eventLoadIn =
    addressVisible && (placeStaff || eventStaff || (actUnlocked && !ended));

  return {
    publicOpen,
    placeStaff,
    eventStaff,
    addressVisible,
    grants: {
      PLACE: { publicKinds: addressVisible, loadIn: placeLoadIn },
      EVENT: { publicKinds: addressVisible, loadIn: eventLoadIn },
    },
    anonymousGrant: publicOpen ? { publicKinds: true, loadIn: false } : NO_GRANT,
  };
}

/** A pin from two coordinates, or null unless both are finite numbers. */
export function finitePin(
  lat: number | null | undefined,
  lng: number | null | undefined,
): ArrivalAreaPin | null {
  return typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
    ? { lat, lng }
    : null;
}

/**
 * THE PIN an event-only area is measured against (FR-005), for a viewer
 * whose `addressVisible` came from {@link resolveEventAreaAccess}.
 *
 *  - The viewer may see the exact address: the TRUE pin, from where the
 *    truth lives (`resolveHolderAddress` rule 2): the place row for an event
 *    at a place that withholds its address, the event row otherwise.
 *  - Otherwise, at a place that WITHHOLDS its address (or a linked place
 *    that cannot be read): no pin. An editor who cannot see a withheld
 *    place's address draws nothing there (orchestrator ruling, step 4
 *    review: fail closed rather than measure from the public circle).
 *  - Otherwise: the event's PUBLIC pin, from `projectPublicEventLocation`.
 *    Never the stored Event row: a row written before its place was
 *    withheld can still carry the house (see that projection's rule 2).
 *    `gateAccessGranted: true` because only an event editor reaches this,
 *    and editors are past the event's own gate.
 *
 * Null = no pin = the caller refuses with NO_PIN. So the 3 km check can only
 * ever say "within 3 km of a point this viewer can already see".
 */
export function eventAreaPin(
  event: EventRecord,
  place: PlaceRecord | null,
  addressVisible: boolean,
): ArrivalAreaPin | null {
  if (addressVisible) {
    if (event.placeId) {
      // `addressVisible` is never true for an unreadable linked place (it is
      // locked, and nobody manages a row that is not there), so `place` is
      // the event's own place here.
      if (!place || place.id !== event.placeId) return null;
      // A place that publishes its address: the event row, falling back to
      // the (public) place pin for a row saved without coordinates.
      return placeWithholdsAddress(place)
        ? finitePin(place.lat, place.lng)
        : (finitePin(event.lat, event.lng) ?? finitePin(place.lat, place.lng));
    }
    return finitePin(event.lat, event.lng);
  }
  if (event.placeId && (!place || place.id !== event.placeId || placeWithholdsAddress(place))) {
    return null;
  }
  const projected = projectPublicEventLocation(event, {
    place: event.placeId
      ? place && place.id === event.placeId
        ? toPlaceLocationSource(place)
        : unreadablePlaceLocation(event.placeId)
      : undefined,
    gateAccessGranted: true,
  });
  if (projected.hidden) return null;
  return finitePin(projected.lat, projected.lng);
}

/**
 * An area as an EDITOR may receive it (step 4 review, security F1, option A).
 * An event-only area's shape is location data: an editor who may not see the
 * event's exact address (`addressVisible` false: the place became withheld
 * after the shape was drawn, or a co-editor who manages the place drew it)
 * gets every field EXCEPT the geometry, the note and the price text, so they
 * can still recognise and remove it,
 * with `geometryWithheld: true`. Place areas reach editors only through
 * `kindAllowedBy` on a visible address, so they pass `true` here.
 */
export type EditorAreaRow = Omit<ArrivalAreaRow, "geometry"> & {
  geometry: ArrivalAreaRow["geometry"] | null;
  geometryWithheld: boolean;
};

export function projectAreaForEditor(
  row: ArrivalAreaRow,
  addressVisible: boolean,
): EditorAreaRow {
  return addressVisible
    ? { ...row, geometryWithheld: false }
    : // Free text can describe where the lot is ("behind the blue house"):
      // withheld with the shape. Ids, label, kind and cost stay, so the
      // editor can still recognise and remove the row.
      { ...row, geometry: null, note: null, priceText: null, geometryWithheld: true };
}
