import type { EventLocationMode } from "@th/types";

import { eventCircleSubject } from "./event-circle-subject";
import { obfuscateCoordinate } from "./redact-location";

/**
 * Standard obfuscation radius (metres) — matches the Prisma column default.
 * NOTE: a null `locationRadiusMeters` no longer falls back to this value; it
 * is the FULLY-HIDDEN sentinel (no public coordinate at all).
 */
export const DEFAULT_OBFUSCATION_RADIUS_METERS = 500;

export interface PublicEventCoordinateInput {
  /** The event; the circle's last-resort subject (`eventCircleSubject`). */
  eventId: string;
  /**
   * Owner + the true point key the circle (`eventCircleSubject`), so every
   * event an organizer runs at one point draws one circle chain. Omit the
   * owner and the circle is keyed to the event alone — which differs from
   * what `projectPublicEventLocation` draws for an owned event.
   */
  orgId?: string | null;
  humanId?: string | null;
  /** Unused by the circle since it is keyed by the point; kept for callers. */
  addressText?: string | null;
  seriesId?: string | null;
  /**
   * The event's location mode. Only the literal "EXACT" is treated as exact;
   * null/undefined/unknown values fail closed (obscured). Typed loosely so
   * callers don't need a `?? "EXACT"` coercion that would defeat the gate.
   */
  locationMode: EventLocationMode | string | null | undefined;
  lat: number | null;
  lng: number | null;
  locationRadiusMeters: number | null;
}

/**
 * Returns the coordinate that is safe to expose on PUBLIC surfaces (nearby/geo
 * map markers, search index, embeds — anywhere that isn't the ticket-holder
 * reveal path).
 *
 * PREFER `projectPublicEventLocation`: it also applies the venue's privacy
 * floor. This is the event-row-only primitive underneath it.
 *
 * EXACT               → the true { lat, lng } (unchanged behaviour).
 * OBSCURED w/ radius  → the keyed obfuscation centre (`obfuscateCoordinate`,
 *                       keyed by `eventCircleSubject`) at the radius snapped
 *                       UP to the ladder, within it of the true point —
 *                       identical on every surface for the same radius; null
 *                       when the obfuscation key is missing (fail closed) or
 *                       the radius is above the top rung.
 * OBSCURED w/ null    → FULLY HIDDEN: returns null — NO public coordinate at
 *   radius              all (the map drops the marker entirely).
 * null coords         → null (caller should drop the row).
 *
 * Fail-closed: this is a security gate, so ONLY the literal "EXACT" passes the
 * true pin through. Anything else — null, undefined, "", or an unrecognised
 * value — is treated as obscured (and hidden when the radius is null).
 */
export function publicEventCoordinate(
  input: PublicEventCoordinateInput,
): { lat: number; lng: number } | null {
  const { eventId, locationMode, lat, lng, locationRadiusMeters } = input;
  const subject = eventCircleSubject({
    id: eventId,
    orgId: input.orgId,
    humanId: input.humanId,
    lat,
    lng,
    seriesId: input.seriesId,
  });
  if (lat === null || lng === null) {
    return null;
  }
  if (locationMode === "EXACT") {
    return { lat, lng };
  }
  if (locationRadiusMeters === null) {
    // Fully hidden: no public map point exists for this event pre-reveal.
    return null;
  }
  return obfuscateCoordinate({
    lat,
    lng,
    radiusMeters: locationRadiusMeters,
    scope: subject.scope,
    subjectId: subject.id,
  });
}

export interface PublicEventAddressTextInput {
  /**
   * The event's location mode. Only the literal "EXACT" returns the true
   * street address; null/undefined/unknown values fail closed (coarse label or
   * null), so callers don't need a `?? "EXACT"` coercion.
   */
  locationMode: EventLocationMode | string | null | undefined;
  addressText: string | null;
  locality?: string | null;
  region?: string | null;
}

/**
 * Returns the address label that is safe to expose on PUBLIC surfaces.
 *
 * EXACT     → the true `addressText`.
 * non-EXACT → a coarse "locality, region" area label if available, otherwise
 *             null. NEVER the street-level `addressText`.
 *
 * Fail-closed: only the literal "EXACT" returns the true address; null,
 * undefined, "", or an unrecognised value is treated as obscured.
 *
 * Mirrors the area-label logic in redact-location.ts.
 */
export function publicEventAddressText(
  input: PublicEventAddressTextInput,
): string | null {
  const { locationMode, addressText, locality, region } = input;
  if (locationMode === "EXACT") {
    return addressText ?? null;
  }
  const parts = [locality, region].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}
