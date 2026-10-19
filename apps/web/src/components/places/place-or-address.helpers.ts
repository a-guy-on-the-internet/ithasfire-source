import type { GeocodingResult } from "@/lib/maps/geocoding";

import type { PlacePickerItem } from "./PlacePicker";

/**
 * Pure pieces of the one-box Location field (`PlaceOrAddressField`) and the
 * community place dialog (`PlaceDialog`). Kept free of React so they can be
 * unit-tested directly.
 */

/** A geocoded address the field holds when no place is linked. */
export type AddressValue = {
  formatted: string;
  /** Street line ("2190 Nolensville Pike"); null when the geocoder had none. */
  line1: string | null;
  /** The business the geocoder named at that address, if any. */
  poiName: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
};

/** What the field is holding: a place on Ithas Fire, a bare address, or nothing. */
export type PlaceOrAddressValue =
  | { kind: "place"; place: PlacePickerItem }
  | { kind: "address"; address: AddressValue }
  | null;

export function geocodingResultToAddressValue(
  result: GeocodingResult,
): AddressValue {
  return {
    formatted: result.formattedAddress,
    line1: result.streetLine,
    poiName: result.name,
    city: result.locality,
    region: result.regionCode ?? result.region,
    postalCode: result.postalCode,
    countryCode: result.countryCode,
    lat: result.lat,
    lng: result.lng,
  };
}

/**
 * The second line of a place row: the street, then the city when the street
 * line does not already carry it. Two places at one address differ by NAME on
 * the first line; this line is what tells two same-name places apart.
 */
export function placeRowSubtitle(
  subtitle: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const street = subtitle?.trim() || null;
  const town = city?.trim() || null;
  if (street && town) {
    return street.toLowerCase().includes(town.toLowerCase())
      ? street
      : `${street}, ${town}`;
  }
  return street ?? town;
}

// "Unit or room": sent on its own (`address.line2`, or top-level `line2` on
// a unit-only edit), stored in `Place.addrLine2`, and folded into the
// formatted text by the SERVER. Fold and strip have ONE implementation,
// `@th/core/lib/location/place-unit`, which PlaceDialog imports.

// ── Reading the server's refusals ──────────────────────────────────────────

function errorMeta(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  const meta = (err as { data?: { meta?: unknown } }).data?.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : null;
}

/** `PLACE_ALREADY_EXISTS` carries the place to use in `meta.existingPlace`. */
export function readExistingPlace(err: unknown): PlacePickerItem | null {
  const raw = errorMeta(err)?.existingPlace;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.placeId !== "string" || typeof p.name !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    placeId: p.placeId,
    name: p.name,
    formattedAddress: str(p.formattedAddress),
    city: str(p.city),
    region: str(p.region),
    lat: num(p.lat),
    lng: num(p.lng),
    timezone: str(p.timezone),
    status: str(p.status) ?? "ACTIVE",
    verificationStatus: str(p.verificationStatus) ?? "UNVERIFIED",
  };
}

export type PlaceRefusalReason =
  | "OWNED"
  | "CLAIM_PENDING"
  | "OWNED_EVENTS_AT_PLACE"
  | "NOT_ACTIVE"
  | "NOT_COMMUNITY_ARCHIVED"
  | "ADDRESS_WITHHELD";

const REFUSAL_REASONS = new Set<string>([
  "OWNED",
  "CLAIM_PENDING",
  "OWNED_EVENTS_AT_PLACE",
  "NOT_ACTIVE",
  "NOT_COMMUNITY_ARCHIVED",
  "ADDRESS_WITHHELD",
]);

/**
 * A `getPlaceEditability` reason as one the UI has copy for. The server's list
 * grows (restore-only reasons such as DUPLICATE_ACTIVE); anything unknown
 * reads as NOT_ACTIVE ("can't be changed here") rather than breaking.
 */
export function toRefusalReason(reason: string | null): PlaceRefusalReason {
  return reason !== null && REFUSAL_REASONS.has(reason)
    ? (reason as PlaceRefusalReason)
    : "NOT_ACTIVE";
}

/** `PLACE_HAS_OWNER`'s `meta.reason`, when it is one the UI has copy for. */
export function readRefusalReason(err: unknown): PlaceRefusalReason | null {
  const reason = errorMeta(err)?.reason;
  return typeof reason === "string" && REFUSAL_REASONS.has(reason)
    ? (reason as PlaceRefusalReason)
    : null;
}

/** `PLACE_HAS_LIVE_LISTINGS`'s `meta.linkedListingCount`. */
export function readLinkedListingCount(err: unknown): number | null {
  const count = errorMeta(err)?.linkedListingCount;
  return typeof count === "number" ? count : null;
}

/** The tRPC rate-limit middleware's refusal (`TOO_MANY_REQUESTS`). */
export function isRateLimited(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (
    (err as { data?: { code?: unknown } }).data?.code === "TOO_MANY_REQUESTS"
  );
}

/**
 * When a rate-limited write may be tried again. The middleware only says it
 * in its message ("… Try again in 1234s."), so this reads that, and answers
 * null when the message does not carry it.
 */
export function readRetryAt(err: unknown, now: Date): Date | null {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  const match = /try again in (\d+)\s*s/i.exec(message);
  if (!match) return null;
  return new Date(now.getTime() + Number(match[1]) * 1000);
}

/**
 * How long until `retryAt`, in the words a person uses: "in 57 minutes",
 * "in 2 hours" ("dentro de 57 minutos" in Spanish). Rounds up, to the minute
 * and then to the hour, so it never promises a retry that would still be
 * refused; switches to hours from an hour on.
 */
export function formatRetryIn(retryAt: Date, now: Date, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  const minutes = Math.max(
    1,
    Math.ceil((retryAt.getTime() - now.getTime()) / 60_000),
  );
  if (minutes < 60) return rtf.format(minutes, "minute");
  return rtf.format(Math.ceil(minutes / 60), "hour");
}
