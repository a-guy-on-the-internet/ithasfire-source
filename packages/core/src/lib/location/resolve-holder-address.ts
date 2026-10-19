import type { AddressRevealPreset, EventLocationMode } from "@th/types";

import type { VenueConfirmationArm } from "../venue-confirmation";
import { publicEventAddressText } from "./public-coordinate";
import {
  applyPlaceLocationFloor,
  placeWithholdsAddress,
  type PlaceLocationSource,
} from "./redact-place-location";

/**
 * THE one decision for "what address does a TICKET HOLDER get for this event,
 * right now?" Every holder surface goes through this: the purchase email, the
 * order page, the my-tickets list, the wallet pass, the reveal notification,
 * the event page's ticket-holder view, RSVP notices and lists, volunteer
 * calendars and reminders, and dispute evidence. Before it existed each
 * surface decided for itself, and two of
 * them (the order page and the wallet pass) printed `event.addressText` with no
 * check at all, including for events whose organizer chose NEVER.
 *
 * TWO questions, answered in order:
 *
 *   1. IS IT LOCKED? Nothing is locked when the EFFECTIVE mode is EXACT: that
 *      address is public anyway. The effective mode is the event's own mode
 *      FLOORED by its venue (`applyPlaceLocationFloor`): an event at a venue
 *      that withholds its address is OBSCURED whatever its row says. Only the
 *      literal "EXACT" counts as exact; anything else fails closed.
 *
 *      Otherwise it is locked, with a `reason`, when the first of these holds:
 *        - `never`: the reveal preset is `NEVER` (a choice, locked forever,
 *          even if a stale row also carries a date);
 *        - `placeUnavailable`: the event names a venue but the caller could
 *          not read it (a transient read failure, or a row that vanished):
 *          nothing can be said about the venue, so nothing is released;
 *        - `venueUnconfirmed`: the venue withholds its address and has not
 *          vouched for THIS event in a way that releases it (see "WHO THE
 *          VENUE RELEASES ITS ADDRESS TO" below);
 *        - `notHolder`: the viewer is not an ACTIVE holder right now (the
 *          surface decides that and passes `activeHolder`), nor an act on
 *          the bill (`actOnBill`, arrival-areas FR-009: acts skip the
 *          event's own schedule but never the place's gates);
 *        - `notYetRevealed`: the effective reveal date is null (an invariant
 *          violation; fails closed) or still in the future.
 *
 *   WHO THE VENUE RELEASES ITS ADDRESS TO (C1, 2026-09-25). A venue that
 *   withholds its address is usually somebody's home, and any signed-in user
 *   can attach their own event to any ACTIVE place. If the event's reveal
 *   schedule alone released the Place's street, anyone could learn where a
 *   withheld house is by attaching a free event, choosing IMMEDIATELY, and
 *   claiming a ticket. So for an event at a withheld venue the Place's truth
 *   is released only when the VENUE vouched for this event, and the arm of
 *   `isVenueConfirmed` it vouched through decides when
 *   (`venueConfirmationArm`):
 *        - `owner`  — the venue's own show: the event's schedule applies;
 *        - `stamp`  — the venue explicitly confirmed this event (a withdrawn
 *                     stamp does not count): the LATER of the event's reveal
 *                     and `max(startsAt, venueConfirmedStartsAt) − 24h`, so a
 *                     third party cannot reveal a venue's address earlier
 *                     than a day before the show — neither the show as it is
 *                     now NOR the show the venue confirmed. The confirmed date
 *                     is what closes N1: the live `startsAt` is the third
 *                     party's to edit, so a floor on it alone let them
 *                     confirm a date three months out, move the show to
 *                     tomorrow, collect the reveal and move it back. Moving
 *                     it LATER still defers the reveal. NEVER stays NEVER.
 *                     A stamp is also written when someone who MANAGES the
 *                     venue saves or publishes the event (W1); the EDITOR
 *                     bar for that is ruled acceptable — an EDITOR of the
 *                     owning org can already read the address and create
 *                     venue-owned events;
 *        - `community`, or no arm at all → locked for good (`venueUnconfirmed`).
 *                     Blanket consent to ownerless community listings is not
 *                     a vouch for any one of them: a listing anyone wrote is
 *                     the same exploit.
 *   A venue that publishes its address has nothing to protect, and a
 *   freeform event's address is its organizer's own, so neither reads the arm.
 *
 *   2. IF UNLOCKED, WHERE DOES THE TRUTH LIVE? For an event at a venue that
 *      withholds its address, the Event row's location columns are the
 *      venue's PUBLIC projection (area label, public circle centre or null,
 *      no postcode). The true address exists only on the Place row, so that
 *      is what an unlocked holder gets. Every other event (freeform address,
 *      or a venue that publishes its address) reads the Event row, exactly as
 *      before.
 *
 * The locked label is the SAME ladder the purchase email has always used:
 * the coarse "locality, region" first (via `publicEventAddressText`, the
 * derivation every pre-reveal surface shares), then the organizer's
 * `locationLabel`, then null. It is never the street, never the venue name,
 * and never the Place's own label. A linked venue's name is a de-facto exact
 * address while locked, so callers must not print `place.name` either.
 */

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * Structurally typed so the full `EventRecord`, a repo projection, or a test
 * fake all fit. Every field except `locationMode` is optional; an absent
 * value reads as null, which is the fail-closed direction for each of them.
 */
export interface HolderAddressEventSource {
  /** Only the literal "EXACT" is exact; anything else is OBSCURED. */
  locationMode: EventLocationMode | string | null | undefined;
  /**
   * The event's venue link. When set and `place` does not resolve, the venue
   * is treated as withholding and fully hidden (see `resolveHolderAddress`).
   * Absent = the caller has no venue link to report.
   */
  placeId?: string | null;
  /** Obfuscation radius; only feeds the venue floor here. */
  locationRadiusMeters?: number | null;
  addressRevealAt?: Date | null;
  addressRevealPreset?: AddressRevealPreset | string | null;
  /**
   * The event's start. Read only under the venue's STAMP arm, where the
   * reveal may not come earlier than `startsAt − 24h`. Absent or invalid
   * there = no usable date = stays locked.
   */
  startsAt?: Date | null;
  /**
   * The start the venue vouched for when it stamped the event
   * (`Event.venueConfirmedStartsAt`, written by the stamp itself). Read only
   * under the STAMP arm: the floor is `max(startsAt, this) − 24h`. Absent or
   * null = no recorded date = the live start alone (the floor can only be
   * RAISED by this field, never lowered). Every holder surface's projection
   * must carry it — a projection that drops it silently falls back to the
   * editable live start.
   */
  venueConfirmedStartsAt?: Date | null;
  addressText?: string | null;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
  locationLabel?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ResolveHolderAddressInput {
  event: HolderAddressEventSource;
  /**
   * The event's OWN venue, loaded by `event.placeId`, or null for a freeform
   * event (or a venue row that no longer resolves). Never pass some other
   * place: its truth would be served as this event's address.
   */
  place: PlaceLocationSource | null | undefined;
  /**
   * HOW the event's venue vouched for it: `venueConfirmationArm(event,
   * placeRecord)` from `lib/venue-confirmation`, computed from the SAME place
   * row. Read only when that venue withholds its address.
   *
   * A REQUIRED key, so a new caller cannot forget it and silently get the
   * old behaviour. `null`, `undefined`, or any unrecognised value = the venue
   * did not vouch = locked (`venueUnconfirmed`). Fail closed.
   */
  venueConfirmationArm: VenueConfirmationArm | null | undefined;
  /**
   * Whether the viewer is an ACTIVE holder of this event right now. The
   * surface decides, because only it knows what "holder" means there: a paid
   * order (SUCCEEDED / PART_REFUNDED / DISPUTED) whose buyer still holds a
   * live ticket, a VALID ticket for the wallet pass, an RSVP that still
   * exists, an APPROVED / CHECKED_IN volunteer. See `holder-eligibility.ts`.
   *
   * Read only when the address is gated; an EXACT address is public, so
   * nobody is refused it. Anything but literal `true` is "not a holder".
   */
  activeHolder: boolean;
  /**
   * Whether the viewer is an ACT ON THE BILL of this event (arrival-areas
   * FR-009, owner ruling 2026-10-16): a signed-in human listed on the event
   * by an `EventHuman` row whose `humanId` is the viewer's own and whose role
   * is in `ACT_ON_BILL_ROLES` (`isActOnBill` in `lib/event-human-roles`).
   * The caller computes it from the event's lineup rows; free-text rows and
   * group (org) rows are never acts.
   *
   * A REQUIRED key, like `venueConfirmationArm`, so no caller silently skips
   * the decision. Anything but literal `true` is "not an act". Every holder
   * surface (emails, wallet passes, notifications, dispute evidence, SEO)
   * passes `false`; only a surface that shows the viewer their OWN event-page
   * view, or the arrival-area projection, may pass a computed value.
   *
   * What it changes, and what it does not (see "ACTS ON THE BILL" on
   * `resolveHolderAddress`): an act counts as a holder for `notHolder` and
   * skips the event's OWN reveal schedule. The PLACE's gates still bind:
   * `placeUnavailable`, `venueUnconfirmed`, the stamp arm's 24h floor, and
   * (fail closed, pending the owner) `never`.
   */
  actOnBill: boolean;
  /** Current time, injected so callers and tests control the reveal edge. */
  now: Date;
}

/** How long before the start a venue's STAMP arm may release its address. */
export const STAMP_ARM_REVEAL_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * What a linked venue that cannot be read stands in as: withholding, fully
 * hidden. Same fail-closed posture as the public read path
 * (`resolvePlaceLocations`): an unreadable venue is never "no venue", which
 * would let the event row speak for a venue that may have withheld its
 * address. `Event.placeId` is `onDelete: SetNull`, so in practice this is a
 * read race, not a steady state.
 */
const UNREADABLE_PLACE: PlaceLocationSource = {
  locationMode: "OBSCURED",
  locationRadiusMeters: null,
};

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * Why a holder surface may not print the address. Surfaces pick their copy
 * from this, never from `revealAt` alone:
 *   - `never`            — the organizer chose never to share it;
 *   - `placeUnavailable` — the event's venue could not be read right now
 *                          (usually transient); nothing is promised, and it
 *                          is NOT the venue's "no" — copy must not say the
 *                          venue has not confirmed;
 *   - `venueUnconfirmed` — the venue withholds its address and has not
 *                          confirmed this event ("ask the organizer");
 *   - `notHolder`        — the viewer is not an active holder (unpaid,
 *                          refunded, transferred away, pending volunteer);
 *                          no special copy, and no date is promised;
 *   - `notYetRevealed`   — the reveal date is ahead (`revealAt` set), or the
 *                          row carries no usable date (`revealAt` null).
 */
export type HolderAddressLockReason =
  | "never"
  | "placeUnavailable"
  | "venueUnconfirmed"
  | "notHolder"
  | "notYetRevealed";

export interface LockedHolderAddress {
  locked: true;
  reason: HolderAddressLockReason;
  /**
   * Coarse, publishable label ("Nashville, TN", or the organizer's area
   * label), or null when the event has neither. Never a street, never a
   * venue name.
   */
  label: string | null;
  /**
   * When the address unlocks for THIS viewer. Set only for
   * `notYetRevealed` with a real date (for a venue-confirmed event it is the
   * venue's effective date, which may be later than the event's own). Null
   * for every other reason: nothing is promised.
   */
  revealAt: Date | null;
  /** True when the organizer chose NEVER (`reason === "never"`). */
  never: boolean;
}

/**
 * The true location, shaped like the Event row's own columns. For a PLACE
 * source it is exactly what an EXACT event at that venue stores (the
 * historical copy: `addressText` = the place's formatted address, `locality`
 * = its city), so a revealed withheld venue reads the same as a public one on
 * every surface.
 */
export interface UnlockedHolderAddress {
  locked: false;
  /**
   * Which row the truth came from. `PLACE` means the Event row is only a
   * public projection and was deliberately not read.
   */
  source: "PLACE" | "EVENT";
  addressText: string | null;
  locality: string | null;
  lat: number | null;
  lng: number | null;
  postalCode: string | null;
}

export type HolderAddress = LockedHolderAddress | UnlockedHolderAddress;

// ── Helpers ─────────────────────────────────────────────────────────────────

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The Place's true street text, as the historical place-to-event copy stored
 * it: the place's `formattedAddress` (`Place.address`). A row without one
 * falls back to its street lines. The city is NOT folded in here; it travels
 * as `locality`, the same split the Event row has.
 */
function placeAddressText(place: PlaceLocationSource): string | null {
  const formatted = nonEmpty(place.formattedAddress);
  if (formatted) return formatted;
  const lines = [nonEmpty(place.addressLine1), nonEmpty(place.addressLine2)]
    .filter((part): part is string => part !== null);
  return lines.length > 0 ? lines.join(", ") : null;
}

function lockedLabel(event: HolderAddressEventSource): string | null {
  // `addressText: null` + a non-EXACT mode makes this return ONLY the coarse
  // "locality, region" — it cannot hand back a street by construction.
  const coarse = publicEventAddressText({
    locationMode: "OBSCURED",
    addressText: null,
    locality: event.locality ?? null,
    region: event.region ?? null,
  });
  return coarse ?? nonEmpty(event.locationLabel);
}

function validDate(value: Date | null | undefined): Date | null {
  // Brand check rather than `instanceof`, so a Date from another realm is
  // still read as a date instead of failing closed.
  return Object.prototype.toString.call(value) === "[object Date]" &&
    !Number.isNaN((value as Date).getTime())
    ? (value as Date)
    : null;
}

// ── Reveal schedule ─────────────────────────────────────────────────────────

/**
 * WHEN an event's address is released to its holders, independent of who is
 * asking and of the clock. `resolveHolderAddress` is this plus the viewer and
 * `now`; it is exported for the surfaces that must PROMISE a date without a
 * holder in hand (the public event page's "shared with ticket holders on
 * {date}" line, the reveal notification's scan), so no surface re-derives the
 * venue rule.
 *
 *   - `open`             — effective mode EXACT: nothing is withheld;
 *   - `never`            — NEVER preset;
 *   - `placeUnavailable` — the event names a venue the caller could not read;
 *   - `venueUnconfirmed` — a withheld venue that did not vouch for it;
 *   - `scheduled`        — released at `revealAt` (null = no usable date,
 *                          which never releases).
 */
export type HolderRevealSchedule =
  | { kind: "open" }
  | { kind: "never" }
  | { kind: "placeUnavailable" }
  | { kind: "venueUnconfirmed" }
  | { kind: "scheduled"; revealAt: Date | null };

export function holderRevealSchedule(
  input: Pick<ResolveHolderAddressInput, "event" | "place" | "venueConfirmationArm">,
): HolderRevealSchedule {
  const { event } = input;
  const place = input.place ?? (event.placeId ? UNREADABLE_PLACE : null);

  const effective = applyPlaceLocationFloor(
    {
      locationMode: event.locationMode === "EXACT" ? "EXACT" : "OBSCURED",
      locationRadiusMeters: event.locationRadiusMeters ?? null,
    },
    place,
  );
  if (effective.locationMode === "EXACT") return { kind: "open" };

  if (event.addressRevealPreset === "NEVER") return { kind: "never" };

  // A venue link the caller could not resolve. The fail-closed stand-in
  // above already locked it (it withholds, fully hidden); this only names
  // WHY, so a surface does not tell a holder "the venue has not confirmed"
  // when the truth is "we could not read the venue just now".
  if (input.place == null && nonEmpty(event.placeId ?? null) !== null) {
    return { kind: "placeUnavailable" };
  }

  const eventRevealAt = validDate(event.addressRevealAt);

  // A venue that publishes its address has nothing to protect; a freeform
  // event's address is its organizer's own. Only a WITHHELD venue's truth
  // needs the venue's word.
  if (!place || !placeWithholdsAddress(place)) {
    return { kind: "scheduled", revealAt: eventRevealAt };
  }

  switch (input.venueConfirmationArm) {
    case "owner":
      // The venue's own show: it chose this schedule.
      return { kind: "scheduled", revealAt: eventRevealAt };
    case "stamp": {
      // The venue confirmed a third party's show. That party's schedule
      // still applies, but never earlier than a day before the start — the
      // LATER of the start as it is now and the start the venue confirmed.
      const startsAt = validDate(event.startsAt);
      if (eventRevealAt === null || startsAt === null) {
        return { kind: "scheduled", revealAt: null };
      }
      return {
        kind: "scheduled",
        revealAt: new Date(
          Math.max(eventRevealAt.getTime(), stampArmVenueFloorMs(event, startsAt)),
        ),
      };
    }
    default:
      // `community`, null, undefined, or anything unrecognised.
      return { kind: "venueUnconfirmed" };
  }
}

/**
 * The stamp arm's venue floor, in epoch ms: a day before the LATER of the
 * live start and the start the venue confirmed. The confirmed date can only
 * raise the floor — an absent or invalid one leaves the live start alone.
 */
function stampArmVenueFloorMs(
  event: Pick<HolderAddressEventSource, "venueConfirmedStartsAt">,
  startsAt: Date,
): number {
  const confirmedStartsAt = validDate(event.venueConfirmedStartsAt);
  const anchorMs = Math.max(
    startsAt.getTime(),
    confirmedStartsAt?.getTime() ?? startsAt.getTime(),
  );
  return anchorMs - STAMP_ARM_REVEAL_LEAD_MS;
}

// ── Acts on the bill (arrival-areas FR-009) ────────────────────────────────

/**
 * When a gated (non-`open`) address is released to ONE audience: locked by a
 * gate that binds that audience for good, or released at `revealAt` (null =
 * no usable date = never released).
 */
type AudienceRelease =
  | {
      kind: "locked";
      reason: Extract<
        HolderAddressLockReason,
        "never" | "placeUnavailable" | "venueUnconfirmed"
      >;
    }
  | { kind: "at"; revealAt: Date | null };

/** The release an act gets the moment it is listed: any instant already past. */
const RELEASED_ON_LISTING = new Date(0);

function holderRelease(schedule: HolderRevealSchedule): AudienceRelease {
  switch (schedule.kind) {
    case "never":
    case "placeUnavailable":
    case "venueUnconfirmed":
      return { kind: "locked", reason: schedule.kind };
    case "scheduled":
      return { kind: "at", revealAt: schedule.revealAt };
    default:
      // `open` is handled before any audience is asked.
      return { kind: "at", revealAt: RELEASED_ON_LISTING };
  }
}

/**
 * The release for an ACT ON THE BILL. Acts skip the EVENT's own reveal
 * schedule ("from the moment they are listed, whatever the reveal date"), but
 * every gate that protects the PLACE binds them exactly as it binds holders:
 * an organiser can list anyone as a performer, themselves included
 * (`EventHuman` has no consent field), so without the place's gates
 * "attach your event to a withheld house and list yourself" would reveal it
 * (the C1 exploit).
 */
function actRelease(
  input: ResolveHolderAddressInput,
  schedule: HolderRevealSchedule,
): AudienceRelease {
  if (schedule.kind === "never") {
    // OWNER QUESTION (arrival areas, 2026-10-16): does the organiser's NEVER
    // release the address to acts? Built fail closed: NEVER locks acts too.
    // To release to acts instead (still behind every place gate), replace
    // this line with:
    //   return actRelease(input, holderRevealSchedule({ ...input, event: { ...input.event, addressRevealPreset: null } }));
    return { kind: "locked", reason: "never" };
  }
  if (schedule.kind === "placeUnavailable" || schedule.kind === "venueUnconfirmed") {
    return { kind: "locked", reason: schedule.kind };
  }

  const place =
    input.place ?? (input.event.placeId ? UNREADABLE_PLACE : null);
  if (
    place &&
    placeWithholdsAddress(place) &&
    input.venueConfirmationArm === "stamp"
  ) {
    // OWNER QUESTION (arrival areas, 2026-10-16): does the stamp arm's 24h
    // floor (N1) bind acts? Built fail closed: an act at a third party's
    // show at a withheld place gets the address no earlier than a day before
    // `max(startsAt, venueConfirmedStartsAt)`, the same floor holders get
    // (the act skips only the event's own schedule). To release on listing
    // instead, replace this block's body with:
    //   return { kind: "at", revealAt: RELEASED_ON_LISTING };
    const startsAt = validDate(input.event.startsAt);
    return {
      kind: "at",
      revealAt:
        startsAt === null
          ? null
          : new Date(stampArmVenueFloorMs(input.event, startsAt)),
    };
  }

  // The place's own show (`owner` arm), or an event whose address is its
  // organiser's own (freeform) or public anyway: released on listing.
  return { kind: "at", revealAt: RELEASED_ON_LISTING };
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * ACTS ON THE BILL (arrival-areas FR-009). `actOnBill: true` widens the
 * audience of a gated address to an act listed on the event. The decision is
 * per audience: the viewer is unlocked when ANY audience they belong to
 * (holder, act) is released now. When none is, the lock reported is the
 * earliest scheduled release among them, else the first gate that locked
 * them, in the historical order (`never`, `placeUnavailable`,
 * `venueUnconfirmed`, then `notHolder` when they belong to no audience). With
 * `actOnBill` not `true` this is exactly the holder-only decision it always
 * was.
 */
export function resolveHolderAddress(
  input: ResolveHolderAddressInput,
): HolderAddress {
  const { event, now } = input;
  const place = input.place ?? (event.placeId ? UNREADABLE_PLACE : null);
  const schedule = holderRevealSchedule(input);

  if (schedule.kind !== "open") {
    const lock = (
      reason: HolderAddressLockReason,
      revealAt: Date | null = null,
    ): LockedHolderAddress => ({
      locked: true,
      reason,
      label: lockedLabel(event),
      revealAt,
      never: reason === "never",
    });

    const releases: AudienceRelease[] = [];
    if (input.activeHolder === true) releases.push(holderRelease(schedule));
    if (input.actOnBill === true) releases.push(actRelease(input, schedule));

    if (releases.length === 0) {
      // In no audience. The gates still speak first, so the copy a surface
      // picks ("the organizer chose never") does not change.
      const gate = holderRelease(schedule);
      if (gate.kind === "locked") return lock(gate.reason);
      return lock("notHolder");
    }

    const released = releases.some(
      (r) =>
        r.kind === "at" &&
        r.revealAt !== null &&
        now.getTime() >= r.revealAt.getTime(),
    );
    if (!released) {
      const scheduled = releases.filter(
        (r): r is Extract<AudienceRelease, { kind: "at" }> => r.kind === "at",
      );
      if (scheduled.length === 0) {
        // Every audience is locked by a gate; the first one (the holder's,
        // when the viewer is one) names it.
        const first = releases[0] as Extract<AudienceRelease, { kind: "locked" }>;
        return lock(first.reason);
      }
      const dates = scheduled
        .map((r) => r.revealAt)
        .filter((d): d is Date => d !== null)
        .map((d) => d.getTime());
      return lock(
        "notYetRevealed",
        dates.length > 0 ? new Date(Math.min(...dates)) : null,
      );
    }
  }

  // Unlocked. A withheld venue's truth lives on the Place; the Event row is
  // its public projection and must not be served as the address. (Reaching
  // here for a withheld venue means the venue vouched: owner or stamp arm.)
  if (place && placeWithholdsAddress(place)) {
    return {
      locked: false,
      source: "PLACE",
      addressText: placeAddressText(place),
      locality: nonEmpty(place.city),
      lat: finiteOrNull(place.lat),
      lng: finiteOrNull(place.lng),
      postalCode: nonEmpty(place.postalCode),
    };
  }

  return {
    locked: false,
    source: "EVENT",
    addressText: event.addressText ?? null,
    locality: event.locality ?? null,
    lat: event.lat ?? null,
    lng: event.lng ?? null,
    postalCode: event.postalCode ?? null,
  };
}

/**
 * The ONE line a holder surface prints where an address goes, for surfaces
 * that have a single slot (a calendar LOCATION, a reminder's "Where"): the
 * true street once unlocked, the coarse label while locked. Null when there
 * is nothing to say, including when the event could not be resolved at all.
 */
export function holderAddressLine(
  address: HolderAddress | null | undefined,
): string | null {
  if (!address) return null;
  return address.locked ? address.label : address.addressText;
}
