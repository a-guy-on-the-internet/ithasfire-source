import { haversineDistance } from "../../../lib/geo/haversine";

/**
 * How far a listing's pin must move, when it is linked (or re-synced) to a
 * place or its typed address is edited, before attendees are told the venue
 * changed (FR-013 VENUE_CHANGED).
 * Below this the "move" is a geocoder disagreement about the same building,
 * not a different venue.
 */
export const VENUE_MOVE_THRESHOLD_METERS = 50;

type Pin = { lat?: number | null; lng?: number | null };

/**
 * Whether an address change (a place link or a typed edit) PHYSICALLY
 * moves the listing: the pin moves more than
 * {@link VENUE_MOVE_THRESHOLD_METERS} (haversine). A listing with no pin that
 * gains one has moved (a map appears where there was none), and so has one
 * that loses its pin.
 * This is the PIN half of {@link addressVenueChanged}; the street line is the
 * other half. Used alone it is only right where the street line is known not
 * to differ (a re-sync to the same place).
 */
export function venueMoved(before: Pin, after: Pin): boolean {
  const beforeHasPin = typeof before.lat === "number" && typeof before.lng === "number";
  const afterHasPin = typeof after.lat === "number" && typeof after.lng === "number";
  if (!beforeHasPin || !afterHasPin) {
    return beforeHasPin !== afterHasPin;
  }
  return (
    haversineDistance(
      before.lat as number,
      before.lng as number,
      after.lat as number,
      after.lng as number,
    ) > VENUE_MOVE_THRESHOLD_METERS
  );
}

/**
 * Suffix and directional words folded to one spelling, so a re-pick that
 * spells "Avenue North" where the stored text said "Ave N" reads the same.
 * Ordinals ("27th") and house numbers are kept as they are: they are what
 * tells one building from the next.
 */
const STREET_WORD_FOLDS: Readonly<Record<string, string>> = {
  street: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  place: "pl",
  court: "ct",
  highway: "hwy",
  parkway: "pkwy",
  square: "sq",
  terrace: "ter",
  circle: "cir",
  suite: "ste",
  apartment: "apt",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One comma-separated segment: punctuation and spacing collapsed, words folded. */
function normalizeSegment(segment: string): string {
  return segment
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => STREET_WORD_FOLDS[word] ?? word)
    .join(" ");
}

/**
 * A leading unit segment ("Unit A", "Ste. 4", "Suite #4", "Apt 2", "#4"): the
 * door within a building. Captures the unit's id. A separator (space, "." or
 * "#") is required after the word, so "United Artists" is not a unit.
 */
const UNIT_SEGMENT =
  /^(?:(?:unit|suite|ste|apt|apartment)\.?\s*#\s*|(?:unit|suite|ste|apt|apartment)\.?\s+|#\s*)([\p{L}\p{N}][\p{L}\p{N}-]*)$/u;

/** A segment that starts with a number followed by a word ("211 27th ave n"). */
const NUMBER_LED = /^\p{N}\S*\s+\S/u;

/** A segment with a digit anywhere ("hauptstraße 5", "studio 54"). */
const HAS_DIGIT = /\p{N}/u;

/**
 * The street segment(s) of an address's normalized segments, unit removed
 * (rule 3 of {@link normalizeStreetLine}).
 */
function pickStreet(segments: ReadonlyArray<string>): string {
  const first = segments[0];
  if (first === undefined) return "";
  if (NUMBER_LED.test(first)) return first;
  if (HAS_DIGIT.test(first)) {
    const later = segments.slice(1).find((segment) => NUMBER_LED.test(segment));
    return later ? `${first} ${later}` : first;
  }
  return segments.find((segment) => NUMBER_LED.test(segment)) ?? first;
}

/**
 * The street line of an address, normalized for comparison
 * ({@link streetLineChanged}).
 *
 * The rule, and why:
 * 1. Lowercase, accents stripped, and every `postalCodes` value removed as a
 *    whole token (both sides' postcodes are passed, so a corrected postcode
 *    never reads as a different street, and a European "10115 Berlin" segment
 *    is not mistaken for a house number).
 * 2. Split on commas. A LEADING unit segment ("Unit A", "Ste 4", "#4") is
 *    kept, in one form (`#a`, `#4`): "Unit A, 2190 Nolensville Pike" and
 *    "Unit C, 2190 Nolensville Pike" are different doors.
 * 3. The street, from the segments after the unit:
 *    - the first segment, when it starts with a number followed by a word
 *      (street-first: `211 27th Avenue North, Nashville, TN 37203, United
 *      States of America`);
 *    - the first segment, when it holds a digit anywhere (street-name-first:
 *      `Hauptstraße 5, 10115 Berlin`), joined with the first later segment
 *      that starts with a number, if any. Without a known postcode the
 *      "10115 Berlin" segment is number-led, so taking it ALONE would read
 *      "Hauptstraße 7" next door as unchanged; taking the first segment
 *      alone would read a house-number change behind a numbered name
 *      ("Building 3, 100 Main St" vs "Building 3, 102 Main St") as
 *      unchanged. Joined, both count;
 *    - otherwise the first segment that starts with a number (name-first:
 *      `Virgin Hotel, 1 Music Square West, Nashville`, or a name after the
 *      unit: `Unit A, Red Bicycle, 2190 Nolensville Pike`): the name in front
 *      is skipped, and locality, region, postcode and country come after it;
 *    - no such segment (a name-only address, "Centennial Park, Nashville"):
 *      the first segment.
 * 4. Punctuation and spacing collapsed; suffixes and directionals folded
 *    ({@link STREET_WORD_FOLDS}).
 *
 * Re-picking the same suggestion gives the same text and so the same line;
 * reformatting it ("Ave" for "Avenue", country dropped) folds to the same
 * line. The failure direction is deliberate: a street line the rule cannot
 * match (one side has a house number or a unit, the other does not) reads as
 * CHANGED, so the moderator is asked and RSVPers are told. Missing a real
 * move is worse than one extra confirm.
 *
 * Empty string for an empty or missing address.
 */
export function normalizeStreetLine(
  text: string | null | undefined,
  postalCodes: ReadonlyArray<string | null | undefined> = [],
): string {
  if (!text) return "";
  let folded = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  for (const code of postalCodes) {
    const needle = code?.normalize("NFKD").toLowerCase().trim();
    if (!needle) continue;
    folded = folded.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`,
        "gu",
      ),
      " ",
    );
  }
  const segments = folded
    .split(",")
    .map((raw) => ({ raw: raw.trim(), normalized: normalizeSegment(raw) }))
    .filter((segment) => segment.normalized !== "");
  if (segments.length === 0) return "";
  const unitMatch = UNIT_SEGMENT.exec(segments[0]!.raw);
  const unit = unitMatch ? `#${unitMatch[1]!.replace(/-/g, "")}` : "";
  const street = pickStreet(
    (unitMatch ? segments.slice(1) : segments).map(
      (segment) => segment.normalized,
    ),
  );
  return [unit, street].filter((part) => part !== "").join(" ");
}

/** An address's text, and its postcode so that a postcode never counts. */
export type AddressLine = {
  addressText?: string | null;
  postalCode?: string | null;
};

/**
 * Whether two addresses name different street lines
 * ({@link normalizeStreetLine}). Postcode, locality, region and country never
 * count; a different house number or street always does, whatever the pin
 * says.
 */
export function streetLineChanged(before: AddressLine, after: AddressLine): boolean {
  const codes = [before.postalCode, after.postalCode];
  return (
    normalizeStreetLine(before.addressText, codes) !==
    normalizeStreetLine(after.addressText, codes)
  );
}

/**
 * Whether an address change (a typed edit, or a link to a different place)
 * is a VENUE CHANGE that the moderator confirms and RSVPers are told about
 * (FR-013 VENUE_CHANGED): the pin moved ({@link venueMoved}) OR the street
 * line differs ({@link streetLineChanged}).
 *
 * The pin alone is not enough: the building next door, or across the street,
 * is within 50 m, and a reverse geocode of an unchanged pin can name a
 * different street address. The text alone is not enough either: the same
 * address re-picked comes back reformatted. The builder and the server both
 * call this, so the confirm and the notice cannot disagree.
 */
export function addressVenueChanged(
  before: Pin & AddressLine,
  after: Pin & AddressLine,
): boolean {
  return venueMoved(before, after) || streetLineChanged(before, after);
}
