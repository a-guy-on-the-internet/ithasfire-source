/**
 * plan-link-community-listing-places.ts — the pure decision layer of the
 * two-phase backfill that links PUBLISHED COMMUNITY listings to the Place they
 * already name in their title.
 *
 * Everything here is database-free on purpose: matching is a pure function
 * over rows, and the write routines take a structural `tx` so they can be
 * driven by a plain object of spies. The CLI
 * (`./link-community-listing-places.ts`) owns paging, flags, printing and the
 * plan/apply split.
 *
 * ── The rule this file exists to hold ───────────────────────────────────────
 * PRECISION OVER RECALL. A wrong link puts somebody's open mic on another
 * business's venue page, and venue pages get claimed by real owners. A missed
 * link costs nothing but a row in the review bucket. So every ambiguity is
 * REFUSED, never resolved by picking:
 *
 *   · two or more Places match  -> needs review, never auto
 *   · the matched name is short/generic -> needs review, ALWAYS. A matching
 *     `addressText` is recorded as corroboration for the human reading the
 *     plan, and never promotes the row to an automatic write
 *   · a crude substring hit with no separator -> needs review, never auto
 *   · the Place is not ACTIVE -> needs review
 *   · the event already has a `placeId` -> never touched, at all
 *
 * ── Why the signals are what they are ───────────────────────────────────────
 * A `LIKE '%name%'` probe is enough to SIZE the problem and nowhere near
 * enough to WRITE with: `"Our Spot"` is a substring of a hundred sentences.
 * The signals that survive are the ones whose false-positive story is
 * something a human can state out loud:
 *
 *   at-suffix-exact — the title says " at X" (or " @ X") and X, normalized,
 *     IS the place's whole name. Not "contains" — equals. Every separator
 *     position in the title is tried, so "Jazz at Noon at The Mill" offers
 *     both "noon at the mill" and "the mill"; if two positions resolve to two
 *     different places that is an ambiguity and it is refused.
 *   title-exact — the entire title normalizes to the place's whole name.
 *     Rare, but "Third Coast Comedy Club" as a listing title is unambiguous.
 *
 * Two more fire, and are REVIEW-ONLY by construction. They exist so an
 * operator can SEE the leads the strong signals miss — a lead nobody is shown
 * is worse than a lead in a review bucket — not so the script can write them:
 *
 *   at-suffix-partial — the " at " tail and a place name are token-prefixes
 *     of one another but not equal: "… at Carol Ann's" against a Place row
 *     named "Carol Ann's Home Cooking". Extremely common (people abbreviate
 *     venues) and extremely dangerous to automate ("… at The Bar" prefixes
 *     every "Bar …" in the table), so a human confirms every one.
 *   weak-substring — the place's whole name appears as a token run somewhere
 *     in the title with no separator in front of it. This is the crude probe
 *     that sized the problem, kept visible and kept unwritable.
 *
 * ── The rule that costs the most recall, deliberately ───────────────────────
 * A one- or two-word venue name is not evidence. "The East Room", "Our Spot"
 * and "Carol Ann's" are the SAME shape — there is no length or token rule
 * that keeps the real one and drops the generic one, and tuning until a
 * particular sample comes out right is how a rule that is right on 19 rows
 * becomes confidently wrong on 1,700. So a non-distinctive name is refused,
 * full stop — the recall cost is real (a genuinely distinctive two-word name
 * like "Drkmttr Collective" lands in review too) and it is the cost this
 * backfill is willing to pay.
 *
 * The event's own `addressText` is still compared against the place's stored
 * address (house number, a distinctive street token, and the city must all
 * agree) and the verdict rides every proposal and every review candidate.
 * It is CORROBORATION FOR A HUMAN, not a second vote: a listing and a
 * user-submitted Place stub are quite capable of being two copies of the same
 * original address string, which is not independence. A corroborated
 * short-name refusal is simply the first row an operator promotes by hand.
 *
 * ── Two phases, and why apply does not re-match ─────────────────────────────
 * `--plan-file` writes the proposals as JSON; `--apply --from-plan` writes
 * ONLY what that file contains. A human reads, edits and cuts rows from it
 * between the two. If apply re-ran the matcher, the thing written would not be
 * the thing reviewed and the review would be theatre. `links[]` is the write
 * list; `needsReview[]` is never written, whatever it holds. Promoting a
 * review row means MOVING it into `links[]` by hand (`bucket: "manual"`).
 *
 * Every link carries `priorPlaceId` (always `null` — the candidate set is
 * `placeId IS NULL`), so the applied-file is a complete reversal record.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a venue name or title fragment to a comparable form.
 *
 * ORDER IS LOAD-BEARING. Apostrophes are DELETED before the general
 * punctuation pass, so "Carol Ann's" folds to `carol anns` (two tokens) and
 * not `carol ann s` (three) — the latter would sail past the three-token
 * distinctiveness floor on a name that is exactly the kind this backfill must
 * refuse.
 *
 * A leading "the" is dropped on BOTH sides of every comparison, so "at The
 * Basement East" and a Place named "Basement East" agree.
 */
export function normalizeName(raw: string): string {
  return (
    raw
      .normalize("NFKD")
      // Combining marks left over by NFKD: "Cafe\u0301" -> "cafe".
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      // Every apostrophe variant, DELETED (not spaced) - see the note above.
      .replace(/[\u0027\u2018\u2019\u02bc\u02bb\u055a\u0060\u00b4]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/^the\s+/, "")
      .trim()
  );
}

/** Tokens of an already-normalized string. */
export function tokensOf(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * Whole-token prefix: `"carol anns"` prefixes `"carol anns home cooking"`, and
 * `"bar"` does NOT prefix `"barrelhouse"`. Equality counts as a prefix, so
 * callers that mean "prefix but not equal" check that themselves.
 */
export function isTokenPrefix(prefix: string, of: string): boolean {
  if (prefix.length === 0) return false;
  return `${of} `.startsWith(`${prefix} `);
}

/** Whole-token containment: `" a b "` inside `" x a b y "`, never `beast`. */
export function containsTokenRun(
  haystackNormalized: string,
  needleNormalized: string,
): boolean {
  if (needleNormalized.length === 0) return false;
  return ` ${haystackNormalized} `.includes(` ${needleNormalized} `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Distinctiveness
// ─────────────────────────────────────────────────────────────────────────────

/** At least three words. Two-word venue names over-match; see the header. */
export const DISTINCTIVE_MIN_TOKENS = 3;
/** At least twelve letters/digits, spaces excluded. */
export const DISTINCTIVE_MIN_CHARS = 12;

/**
 * Words that carry no identifying force in a venue name. A name built
 * ENTIRELY from these is refused however long it is ("the live music venue"),
 * which is a second net independent of the length/token floors above.
 */
export const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  "a", "an", "and", "at", "of", "on", "the", "our", "your", "my", "new", "old",
  "bar", "pub", "club", "cafe", "coffee", "house", "room", "rooms", "spot",
  "place", "lounge", "tavern", "grill", "grille", "kitchen", "eatery",
  "theater", "theatre", "hall", "venue", "center", "centre", "stage",
  "studio", "studios", "patio", "garden", "gardens", "deck", "taproom",
  "brewery", "brewing", "restaurant", "shop", "store", "market", "hotel",
  "inn", "saloon", "diner", "bistro", "pizzeria", "winery", "distillery",
  "music", "live", "arts", "art", "social", "public", "local", "downtown",
  "north", "south", "east", "west", "upper", "lower", "big", "little",
]);

/**
 * Whether a normalized Place name is distinctive enough to stand alone as
 * evidence for an automatic link.
 *
 * EXPECTED TO DEGRADE AT SCALE in one direction only: it gets STRICTER
 * relative to the real world as venue names get shorter, so at production
 * scale it pushes more rows into review. That is the failure mode this file
 * wants.
 */
export function isDistinctivePlaceName(normalized: string): boolean {
  const tokens = tokensOf(normalized);
  if (tokens.length < DISTINCTIVE_MIN_TOKENS) return false;
  if (normalized.replace(/ /g, "").length < DISTINCTIVE_MIN_CHARS) return false;
  if (tokens.every((token) => GENERIC_NAME_TOKENS.has(token))) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Address corroboration — the ONLY thing that rescues a non-distinctive name
// ─────────────────────────────────────────────────────────────────────────────

/** Street-type and unit words: present in every address, so worthless as evidence. */
const ADDRESS_STOPWORDS: ReadonlySet<string> = new Set([
  "street", "st", "road", "rd", "avenue", "ave", "av", "boulevard", "blvd",
  "drive", "dr", "lane", "ln", "court", "ct", "circle", "cir", "place", "pl",
  "parkway", "pkwy", "highway", "hwy", "pike", "trail", "terrace", "way",
  "suite", "ste", "unit", "apt", "apartment", "floor", "fl", "building", "bldg",
  "north", "south", "east", "west", "ne", "nw", "se", "sw", "usa", "us",
]);

/** Leading house number of an address (or of its first comma segment). */
export function streetNumberOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /^\s*(\d+)\b/.exec(raw.trim());
  return match ? match[1]! : null;
}

/** Identifying tokens of a street line: >= 4 chars, not a street-type word. */
export function distinctiveAddressTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return tokensOf(normalizeName(raw)).filter(
    (token) =>
      token.length >= 4 && !ADDRESS_STOPWORDS.has(token) && !/^\d+$/.test(token),
  );
}

export type PlaceAddressFields = {
  address: string;
  addrLine1: string | null;
  city: string | null;
  postcode: string | null;
};

/**
 * Whether the event's free-text `addressText` independently agrees with the
 * place's stored address. Deliberately strict — this is a RESCUE signal for
 * names that are otherwise refused, so every additional requirement costs
 * only recall (more rows land in review) and buys precision.
 *
 * All three must hold:
 *   1. both carry a leading house number and the numbers are equal;
 *   2. at least one distinctive street-name token of the place's line 1
 *      appears in the event's address text;
 *   3. if the place records a city, that city appears in the event's address.
 *
 * A postcode present on BOTH sides and disagreeing is a veto on its own.
 */
export function addressCorroborates(
  eventAddressText: string | null,
  place: PlaceAddressFields,
): boolean {
  if (!eventAddressText || eventAddressText.trim() === "") return false;

  const placeLine = place.addrLine1 ?? place.address;
  const placeNumber = streetNumberOf(placeLine);
  const eventNumber = streetNumberOf(eventAddressText);
  if (!placeNumber || !eventNumber || placeNumber !== eventNumber) return false;

  const eventNormalized = normalizeName(eventAddressText);

  const streetTokens = distinctiveAddressTokens(placeLine);
  if (streetTokens.length === 0) return false;
  if (!streetTokens.some((token) => containsTokenRun(eventNormalized, token))) {
    return false;
  }

  if (place.city && place.city.trim() !== "") {
    const cityNormalized = normalizeName(place.city);
    if (
      cityNormalized.length > 0 &&
      !containsTokenRun(eventNormalized, cityNormalized)
    ) {
      return false;
    }
  }

  if (place.postcode && place.postcode.trim() !== "") {
    const placePostcode = normalizeName(place.postcode).split(" ")[0];
    const eventPostcode = /\b(\d{5})(?:-\d{4})?\b/.exec(eventAddressText)?.[1];
    if (placePostcode && eventPostcode && placePostcode !== eventPostcode) {
      return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Title -> candidate venue-name fragments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Separators that introduce a venue in a listing title. Matched
 * case-insensitively with surrounding whitespace, so "Beat At Bar" and
 * "Bathhouse" are untouched.
 */
const SEPARATOR_PATTERN = /\s+(?:at|@)\s+/gi;

export type TitleFragment = {
  /** Raw text as it appears in the title — what the operator reads back. */
  raw: string;
  normalized: string;
  /** How the fragment was cut out of the title. */
  kind: "at-suffix" | "whole-title";
};

/**
 * Every venue-name candidate a title offers: the text after EACH separator
 * position, plus the whole title.
 *
 * All positions are offered rather than just the last one because the last
 * one is not reliably the venue ("Sips at Sunset" nested in a longer title).
 * Offering all of them cannot manufacture a wrong link on its own: a fragment
 * only counts when it EQUALS a whole Place name, and two fragments resolving
 * to two different Places is an ambiguity that gets refused.
 */
export function titleFragments(title: string): TitleFragment[] {
  const fragments: TitleFragment[] = [];
  const seen = new Set<string>();

  const push = (raw: string, kind: TitleFragment["kind"]) => {
    const normalized = normalizeName(raw);
    if (normalized.length === 0) return;
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    fragments.push({ raw: raw.trim(), normalized, kind });
  };

  SEPARATOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEPARATOR_PATTERN.exec(title)) !== null) {
    push(title.slice(match.index + match[0].length), "at-suffix");
  }
  push(title, "whole-title");

  return fragments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows in / decision out
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceCandidate = {
  id: string;
  name: string;
  address: string;
  addrLine1: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  /** Prisma `PlaceStatus`. Only "ACTIVE" is auto-linkable. */
  status: string;
  listedInDirectory: boolean;
};

export type ListingCandidate = {
  eventId: string;
  title: string;
  startsAt: Date;
  addressText: string | null;
  placeId: string | null;
  /** Prisma `EventStewardship`. */
  stewardship: string;
  /** Prisma `EventStatus`. */
  status: string;
};

export type MatchSignal =
  | "at-suffix-exact"
  | "title-exact"
  /**
   * The " at " tail and the Place name are token-prefixes of one another —
   * "… at Carol Ann's" against a Place row named "Carol Ann's Home Cooking".
   * REVIEW-ONLY. Venues really are referred to by a shortened form, so this
   * is a common and genuine shape; it is also exactly where the false
   * positives live ("… at The Bar" prefixes every "Bar …" in the table), so
   * the script surfaces it for a human and never writes it.
   */
  | "at-suffix-partial"
  | "weak-substring"
  /** Only ever set by a human promoting a review row into `links[]`. */
  | "manual";

export type MatchConfidence = "high" | "medium";

export type ReviewReason =
  /** Two or more different Places matched a strong signal. */
  | "ambiguous-multiple-places"
  /** Two or more Places share the SAME name — duplicate venue rows. */
  | "duplicate-place-name"
  /** Exactly one Place matched, but its name is too short/generic to stand alone. */
  | "generic-place-name"
  /**
   * The title's " at " tail and a Place name are prefixes of one another but
   * not equal. Never auto-linked; a human confirms the abbreviation.
   */
  | "partial-name-match"
  /** Only the crude substring probe fired. Never auto-linked. */
  | "weak-substring-only"
  /** The only match is a SUSPENDED/ARCHIVED Place. */
  | "inactive-place"
  /** The row is not the shape this backfill scopes to. Defensive. */
  | "unexpected-listing-state";

export type ReviewCandidatePlace = {
  placeId: string;
  placeName: string;
  placeAddress: string;
  placeStatus: string;
  listedInDirectory: boolean;
  signal: MatchSignal;
  matchedText: string;
  addressCorroborated: boolean;
};

export type ProposedLink = {
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  eventAddressText: string | null;
  /**
   * ROLLBACK VALUE. Always `null` by construction — the candidate set is
   * `placeId IS NULL` and the write CASes on it — but stored explicitly so
   * the applied-file is a self-contained reversal record.
   */
  priorPlaceId: null;
  placeId: string;
  placeName: string;
  placeAddress: string;
  placeListedInDirectory: boolean;
  signal: MatchSignal;
  /** The exact text from the title that matched the place's name. */
  matchedText: string;
  confidence: MatchConfidence;
  addressCorroborated: boolean;
  bucket: "auto" | "manual";
};

export type ReviewEntry = {
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  eventAddressText: string | null;
  reason: ReviewReason;
  note: string;
  candidates: ReviewCandidatePlace[];
};

export type Classification =
  | { kind: "already-linked"; placeId: string }
  | { kind: "no-match" }
  | { kind: "auto"; link: ProposedLink }
  | { kind: "needs-review"; entry: ReviewEntry };

/**
 * The place corpus, indexed for the two lookups the matcher makes. Built once
 * per run by the CLI.
 *
 * `byFirstToken` is what keeps the weak-substring probe from being
 * O(listings x places): a whole-token run inside a title must START with one
 * of the title's own tokens, so only places whose first token appears in the
 * title need the containment test at all.
 */
export type PlaceIndex = {
  byNormalizedName: Map<string, PlaceCandidate[]>;
  byFirstToken: Map<string, PlaceCandidate[]>;
  size: number;
};

export function buildPlaceIndex(places: readonly PlaceCandidate[]): PlaceIndex {
  const byNormalizedName = new Map<string, PlaceCandidate[]>();
  const byFirstToken = new Map<string, PlaceCandidate[]>();

  for (const place of places) {
    const normalized = normalizeName(place.name);
    // A place whose name normalizes to nothing (punctuation only) can never
    // be evidence for anything; leaving it out keeps it from matching the
    // empty string anywhere downstream.
    if (normalized.length === 0) continue;

    const named = byNormalizedName.get(normalized) ?? [];
    named.push(place);
    byNormalizedName.set(normalized, named);

    const first = tokensOf(normalized)[0]!;
    const tokened = byFirstToken.get(first) ?? [];
    tokened.push(place);
    byFirstToken.set(first, tokened);
  }

  return { byNormalizedName, byFirstToken, size: places.length };
}

type StrongHit = {
  place: PlaceCandidate;
  fragment: TitleFragment;
};

function toReviewCandidate(
  place: PlaceCandidate,
  signal: MatchSignal,
  matchedText: string,
  addressText: string | null,
): ReviewCandidatePlace {
  return {
    placeId: place.id,
    placeName: place.name,
    placeAddress: place.address,
    placeStatus: place.status,
    listedInDirectory: place.listedInDirectory,
    signal,
    matchedText,
    addressCorroborated: addressCorroborates(addressText, place),
  };
}

function reviewEntry(
  listing: ListingCandidate,
  reason: ReviewReason,
  note: string,
  candidates: ReviewCandidatePlace[],
): Classification {
  return {
    kind: "needs-review",
    entry: {
      eventId: listing.eventId,
      eventTitle: listing.title,
      eventStartsAt: listing.startsAt.toISOString(),
      eventAddressText: listing.addressText,
      reason,
      note,
      candidates,
    },
  };
}

/**
 * Decide what, if anything, to propose for ONE listing. Pure.
 *
 * The order of the branches IS the precision policy: every refusal is checked
 * before the single accept, so nothing reaches the accept branch that had an
 * unresolved alternative.
 */
export function matchListing(
  listing: ListingCandidate,
  index: PlaceIndex,
): Classification {
  // NEVER overwrite an existing link. Checked first so no later branch can
  // reach a row that already has a venue.
  if (listing.placeId !== null) {
    return { kind: "already-linked", placeId: listing.placeId };
  }

  // Defensive: the CLI scopes the query, but a hand-edited plan or a widened
  // query must not silently write to an owned or unpublished row.
  if (listing.stewardship !== "COMMUNITY" || listing.status !== "PUBLISHED") {
    return reviewEntry(
      listing,
      "unexpected-listing-state",
      `stewardship=${listing.stewardship} status=${listing.status} — this backfill only touches PUBLISHED COMMUNITY listings`,
      [],
    );
  }

  const fragments = titleFragments(listing.title);

  // ── Strong signals: a fragment EQUALS a whole place name ──────────────────
  const strongByPlaceId = new Map<string, StrongHit>();
  for (const fragment of fragments) {
    for (const place of index.byNormalizedName.get(fragment.normalized) ?? []) {
      // First fragment to claim a place wins the provenance; `at-suffix`
      // fragments are enumerated before the whole title, so the more specific
      // signal is the one reported.
      if (!strongByPlaceId.has(place.id)) {
        strongByPlaceId.set(place.id, { place, fragment });
      }
    }
  }

  const strong = [...strongByPlaceId.values()];
  const strongActive = strong.filter((hit) => hit.place.status === "ACTIVE");
  const strongInactive = strong.filter((hit) => hit.place.status !== "ACTIVE");

  const signalFor = (fragment: TitleFragment): MatchSignal =>
    fragment.kind === "at-suffix" ? "at-suffix-exact" : "title-exact";

  if (strongActive.length > 1) {
    const names = new Set(
      strongActive.map((hit) => normalizeName(hit.place.name)),
    );
    // Same name on two rows is a duplicate-venue problem (merge them);
    // different names is a genuinely ambiguous title. Different fixes, so
    // they are counted apart.
    const reason: ReviewReason =
      names.size === 1 ? "duplicate-place-name" : "ambiguous-multiple-places";
    return reviewEntry(
      listing,
      reason,
      reason === "duplicate-place-name"
        ? `${strongActive.length} ACTIVE places share the name "${strongActive[0]!.place.name}" — merge them, then re-run`
        : `${strongActive.length} different ACTIVE places match this title — refusing to pick`,
      strongActive.map((hit) =>
        toReviewCandidate(
          hit.place,
          signalFor(hit.fragment),
          hit.fragment.raw,
          listing.addressText,
        ),
      ),
    );
  }

  if (strongActive.length === 1) {
    const { place, fragment } = strongActive[0]!;
    const signal = signalFor(fragment);
    const corroborated = addressCorroborates(listing.addressText, place);
    const distinctive = isDistinctivePlaceName(normalizeName(place.name));

    // A SHORT NAME IS NEVER AUTO-LINKED, corroborating address or not. The
    // address is evidence FOR A HUMAN, not a substitute for the name: it is
    // not independent enough to carry the decision alone (a listing and a
    // user-submitted Place stub can easily be two copies of the same original
    // typo-ridden address), and "Our Spot" is precisely the name this
    // backfill must not guess at. The corroboration flag rides the review
    // candidate instead, so a corroborated one is the first thing an operator
    // promotes by hand — a one-line edit in the plan file.
    if (!distinctive) {
      return reviewEntry(
        listing,
        "generic-place-name",
        `"${place.name}" is too short or too generic to stand alone as evidence` +
          (corroborated
            ? " — but the listing's address MATCHES this place, so this is a likely approval"
            : ", and the listing's address does not corroborate it"),
        [
          toReviewCandidate(
            place,
            signal,
            fragment.raw,
            listing.addressText,
          ),
        ],
      );
    }

    return {
      kind: "auto",
      link: {
        eventId: listing.eventId,
        eventTitle: listing.title,
        eventStartsAt: listing.startsAt.toISOString(),
        eventAddressText: listing.addressText,
        priorPlaceId: null,
        placeId: place.id,
        placeName: place.name,
        placeAddress: place.address,
        placeListedInDirectory: place.listedInDirectory,
        signal,
        matchedText: fragment.raw,
        // The matcher only ever emits "high": it auto-links exactly when the
        // name alone carried the decision. "medium" exists on the wire for a
        // human promoting a review row into links[] by hand.
        confidence: "high",
        addressCorroborated: corroborated,
        bucket: "auto",
      },
    };
  }

  if (strongInactive.length > 0) {
    return reviewEntry(
      listing,
      "inactive-place",
      `the only name match is a non-ACTIVE place (${strongInactive
        .map((hit) => `${hit.place.name}: ${hit.place.status}`)
        .join(", ")})`,
      strongInactive.map((hit) =>
        toReviewCandidate(
          hit.place,
          signalFor(hit.fragment),
          hit.fragment.raw,
          listing.addressText,
        ),
      ),
    );
  }

  // ── Partial signal: an abbreviated venue name, review-only ────────────────
  // Requires >= 2 tokens in the tail. A one-token tail prefixes half the
  // table ("… at The Bar" -> "bar" -> every "Bar …" row), which is noise, not
  // a lead.
  const partialSeen = new Set<string>();
  const partials: Array<{ place: PlaceCandidate; fragment: TitleFragment }> = [];
  for (const fragment of fragments) {
    if (fragment.kind !== "at-suffix") continue;
    const tokens = tokensOf(fragment.normalized);
    if (tokens.length < 2) continue;
    for (const place of index.byFirstToken.get(tokens[0]!) ?? []) {
      if (partialSeen.has(place.id)) continue;
      const nameNormalized = normalizeName(place.name);
      if (nameNormalized === fragment.normalized) continue; // handled above
      if (
        !isTokenPrefix(fragment.normalized, nameNormalized) &&
        !isTokenPrefix(nameNormalized, fragment.normalized)
      ) {
        continue;
      }
      partialSeen.add(place.id);
      partials.push({ place, fragment });
    }
  }

  if (partials.length > 0) {
    return reviewEntry(
      listing,
      "partial-name-match",
      `the title's venue fragment and ${partials.length} place name(s) are prefixes of one another but not equal — confirm the abbreviation by hand`,
      partials.map((hit) =>
        toReviewCandidate(
          hit.place,
          "at-suffix-partial",
          hit.fragment.raw,
          listing.addressText,
        ),
      ),
    );
  }

  // ── Weak signal: the crude probe, review-only ─────────────────────────────
  const titleNormalized = normalizeName(listing.title);
  const weakSeen = new Set<string>();
  const weak: PlaceCandidate[] = [];
  for (const token of new Set(tokensOf(titleNormalized))) {
    for (const place of index.byFirstToken.get(token) ?? []) {
      if (weakSeen.has(place.id)) continue;
      if (!containsTokenRun(titleNormalized, normalizeName(place.name))) continue;
      weakSeen.add(place.id);
      weak.push(place);
    }
  }

  if (weak.length > 0) {
    return reviewEntry(
      listing,
      "weak-substring-only",
      `${weak.length} place name(s) appear inside the title with no " at " separator — substring hits are not evidence`,
      weak.map((place) =>
        toReviewCandidate(
          place,
          "weak-substring",
          place.name,
          listing.addressText,
        ),
      ),
    );
  }

  return { kind: "no-match" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE proposal, two lines (three with `verbose`). Compact on purpose: the
 * whole point of the dry run is that a human reads every proposed link, and a
 * five-line-per-row format turns 17 proposals into something nobody scrolls
 * through.
 */
export function describeLink(link: ProposedLink, verbose = false): string {
  const marks = [
    link.signal,
    link.addressCorroborated ? "addr-corroborated" : "addr-unconfirmed",
    link.placeListedInDirectory ? "directory" : "not-in-directory",
  ].join(" | ");
  return (
    `  [${link.confidence.padEnd(6)}] ${link.eventTitle}\n` +
    `            -> ${link.placeName}  (${link.placeId})\n` +
    `               ${marks}  matched "${link.matchedText}"` +
    (verbose
      ? `\n               event addr: ${link.eventAddressText ?? "(none)"}` +
        `\n               place addr: ${link.placeAddress}`
      : "")
  );
}

/** ONE refusal, with every candidate it declined to pick between. */
export function describeReview(entry: ReviewEntry): string {
  const head = `  ${entry.eventTitle}\n    ${entry.reason.toUpperCase()} — ${entry.note}`;
  if (entry.candidates.length === 0) return `${head}\n    event ${entry.eventId}`;
  const lines = entry.candidates.map(
    (candidate) =>
      `      candidate: ${candidate.placeName} (${candidate.placeId})` +
      ` [${candidate.placeStatus}]` +
      ` ${candidate.signal}` +
      (candidate.addressCorroborated ? " addr-corroborated" : ""),
  );
  return `${head}\n    event ${entry.eventId}\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan file
// ─────────────────────────────────────────────────────────────────────────────

export const PLAN_VERSION = 1 as const;
export const SCRIPT_NAME = "link-community-listing-places" as const;

export const PLAN_README =
  "links[] is the WRITE LIST: `--apply --from-plan` writes exactly these rows and nothing else. " +
  "needsReview[] is NEVER written — to promote one, move it into links[] by hand with bucket:\"manual\". " +
  "Deleting a row from links[] is how you reject a proposed link. " +
  "priorPlaceId on every link is the rollback value.";

const proposedLinkSchema = z
  .object({
    eventId: z.string().min(1),
    eventTitle: z.string(),
    eventStartsAt: z.string(),
    eventAddressText: z.string().nullable(),
    priorPlaceId: z.null(),
    placeId: z.string().min(1),
    placeName: z.string(),
    placeAddress: z.string(),
    placeListedInDirectory: z.boolean(),
    signal: z.enum([
      "at-suffix-exact",
      "title-exact",
      "at-suffix-partial",
      "weak-substring",
      "manual",
    ]),
    matchedText: z.string(),
    confidence: z.enum(["high", "medium"]),
    addressCorroborated: z.boolean(),
    bucket: z.enum(["auto", "manual"]),
  })
  .strict();

const reviewCandidateSchema = z
  .object({
    placeId: z.string(),
    placeName: z.string(),
    placeAddress: z.string(),
    placeStatus: z.string(),
    listedInDirectory: z.boolean(),
    signal: z.enum([
      "at-suffix-exact",
      "title-exact",
      "at-suffix-partial",
      "weak-substring",
      "manual",
    ]),
    matchedText: z.string(),
    addressCorroborated: z.boolean(),
  })
  .strict();

const reviewEntrySchema = z
  .object({
    eventId: z.string(),
    eventTitle: z.string(),
    eventStartsAt: z.string(),
    eventAddressText: z.string().nullable(),
    reason: z.enum([
      "ambiguous-multiple-places",
      "duplicate-place-name",
      "generic-place-name",
      "partial-name-match",
      "weak-substring-only",
      "inactive-place",
      "unexpected-listing-state",
    ]),
    note: z.string(),
    candidates: z.array(reviewCandidateSchema),
  })
  .strict();

/**
 * `.strict()` throughout: a hand-edited plan with a typo'd key must be a hard
 * error before anything is written, not a silently-dropped field.
 */
export const planFileSchema = z
  .object({
    version: z.literal(PLAN_VERSION),
    script: z.literal(SCRIPT_NAME),
    _readme: z.string(),
    generatedAt: z.string(),
    databaseHost: z.string(),
    counts: z.record(z.string(), z.number()),
    links: z.array(proposedLinkSchema),
    needsReview: z.array(reviewEntrySchema),
  })
  .strict();

export type PlanFile = z.infer<typeof planFileSchema>;

export function buildPlanFile(args: {
  generatedAt: Date;
  databaseHost: string;
  counts: Record<string, number>;
  links: ProposedLink[];
  needsReview: ReviewEntry[];
}): PlanFile {
  return {
    version: PLAN_VERSION,
    script: SCRIPT_NAME,
    _readme: PLAN_README,
    generatedAt: args.generatedAt.toISOString(),
    databaseHost: args.databaseHost,
    counts: args.counts,
    links: args.links,
    needsReview: args.needsReview,
  };
}

/**
 * Read a plan back. Rejects duplicate `eventId`s in `links[]` — a hand-edit
 * that copies a row would otherwise write twice and log two audit rows, and
 * the second write's CAS failure would read as a race that never happened.
 */
export function parsePlanFile(raw: unknown): PlanFile {
  const plan = planFileSchema.parse(raw);
  const seen = new Set<string>();
  for (const link of plan.links) {
    if (seen.has(link.eventId)) {
      throw new Error(
        `plan links[] names event ${link.eventId} more than once — remove the duplicate before applying`,
      );
    }
    seen.add(link.eventId);
  }
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// The write routines
// ─────────────────────────────────────────────────────────────────────────────

type EventStateRow = {
  id: string;
  title: string;
  placeId: string | null;
  stewardship: string;
  status: string;
};

type PlaceStateRow = {
  id: string;
  name: string;
  status: string;
  /** Prisma `EventLocationMode`. Only the literal "EXACT" may be linked to. */
  locationMode: string;
};

/**
 * The structural slice of a Prisma transaction the write routines use. Typed
 * here rather than imported so the tests can drive it with spies and no
 * database.
 */
export type LinkBackfillTx = {
  event: {
    findUnique(args: {
      where: { id: string };
      select: {
        id: true;
        title: true;
        placeId: true;
        stewardship: true;
        status: true;
      };
    }): Promise<EventStateRow | null>;
    updateMany(args: {
      where: {
        id: string;
        placeId: string | null;
        stewardship: "COMMUNITY";
      };
      data: { placeId: string | null };
    }): Promise<{ count: number }>;
  };
  place: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; name: true; status: true; locationMode: true };
    }): Promise<PlaceStateRow | null>;
  };
};

/**
 * Audit, injected. The CLI passes the REAL repo method
 * (`makeAuditRepo(tx).log`) so a backfilled link lands the same shape of
 * AuditLog row every other write in the system does, in the same transaction.
 */
export type LinkBackfillDeps = {
  logAudit(entry: {
    entity: string;
    entityId: string;
    action: string;
    data: Record<string, unknown>;
  }): Promise<void>;
};

export type LinkOutcome =
  | { kind: "linked"; eventId: string; placeId: string }
  | { kind: "skipped"; eventId: string; reason: string }
  /** The plan's row is already in its post-state. Expected on a re-run. */
  | { kind: "already-applied"; eventId: string; placeId: string };

export const AUDIT_ACTION_LINKED = "event.community_place_backfilled";
export const AUDIT_ACTION_REVERTED = "event.community_place_backfill_reverted";

/**
 * Apply ONE reviewed link, re-verifying every fact the review depended on.
 *
 * The re-verification is the point of the two-phase split: a plan may have
 * been read by a human hours ago, and anything that moved since invalidates
 * the evidence. The TITLE check in particular is not paranoia — the match was
 * DERIVED from the title, so a retitled listing has no surviving evidence and
 * must not be written from a stale conclusion.
 */
export async function applyProposedLink(
  tx: LinkBackfillTx,
  deps: LinkBackfillDeps,
  link: ProposedLink,
  meta: { planGeneratedAt: string },
): Promise<LinkOutcome> {
  const event = await tx.event.findUnique({
    where: { id: link.eventId },
    select: {
      id: true,
      title: true,
      placeId: true,
      stewardship: true,
      status: true,
    },
  });

  if (!event) {
    return { kind: "skipped", eventId: link.eventId, reason: "event no longer exists" };
  }
  if (event.placeId !== null) {
    // Idempotency: the same place is this script's own post-state, so a second
    // run over the same plan is a clean no-op. A DIFFERENT place is somebody
    // else's decision and is never overwritten.
    return event.placeId === link.placeId
      ? { kind: "already-applied", eventId: link.eventId, placeId: link.placeId }
      : {
          kind: "skipped",
          eventId: link.eventId,
          reason: `already linked to a different place (${event.placeId}) — never overwritten`,
        };
  }
  if (event.stewardship !== "COMMUNITY") {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: `stewardship is now ${event.stewardship}, not COMMUNITY`,
    };
  }
  if (event.status !== "PUBLISHED") {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: `status is now ${event.status}, not PUBLISHED`,
    };
  }
  if (event.title !== link.eventTitle) {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: "title changed since the plan was written — the match was derived from the title, so the evidence is gone",
    };
  }

  const place = await tx.place.findUnique({
    where: { id: link.placeId },
    select: { id: true, name: true, status: true, locationMode: true },
  });
  if (!place) {
    return { kind: "skipped", eventId: link.eventId, reason: "place no longer exists" };
  }
  if (place.status !== "ACTIVE") {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: `place is now ${place.status}, not ACTIVE`,
    };
  }
  if (place.name !== link.placeName) {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: `place renamed since the plan was written ("${link.placeName}" -> "${place.name}")`,
    };
  }
  // HARD GUARD (place-address-withholding D1). This write sets `placeId`
  // ONLY; the listing keeps its typed `addressText` / coordinates / postcode.
  // At a venue that withholds its address those typed values are, in all
  // likelihood, the very house being hidden — and an Event linked to a
  // withheld place must hold only the venue's public projection. Refused,
  // fail-closed on anything but the literal "EXACT"; such a listing is linked
  // through the event builder, whose save stores the projection.
  if (place.locationMode !== "EXACT") {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: `place withholds its address (locationMode ${String(place.locationMode)}) — this script would leave the listing's typed street on an event at a withheld venue; link it through the event builder instead`,
    };
  }

  // CAS on the null we read above. A concurrent writer between the read and
  // here matches zero rows and nothing is written.
  const written = await tx.event.updateMany({
    where: { id: link.eventId, placeId: null, stewardship: "COMMUNITY" },
    data: { placeId: link.placeId },
  });
  if (written.count !== 1) {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: "compare-and-swap matched no row (the listing moved between the read and the write)",
    };
  }

  await deps.logAudit({
    entity: "event",
    entityId: link.eventId,
    action: AUDIT_ACTION_LINKED,
    data: {
      script: SCRIPT_NAME,
      planGeneratedAt: meta.planGeneratedAt,
      priorPlaceId: link.priorPlaceId,
      placeId: link.placeId,
      placeName: link.placeName,
      signal: link.signal,
      matchedText: link.matchedText,
      confidence: link.confidence,
      addressCorroborated: link.addressCorroborated,
      bucket: link.bucket,
    },
  });

  return { kind: "linked", eventId: link.eventId, placeId: link.placeId };
}

/**
 * Reverse ONE applied link. CASed on the value this script wrote, so a row a
 * human has since re-pointed somewhere else is left alone.
 */
export async function revertAppliedLink(
  tx: LinkBackfillTx,
  deps: LinkBackfillDeps,
  link: ProposedLink,
): Promise<LinkOutcome> {
  const written = await tx.event.updateMany({
    where: { id: link.eventId, placeId: link.placeId, stewardship: "COMMUNITY" },
    data: { placeId: link.priorPlaceId },
  });
  if (written.count !== 1) {
    return {
      kind: "skipped",
      eventId: link.eventId,
      reason: `not linked to ${link.placeId} any more — left alone`,
    };
  }

  await deps.logAudit({
    entity: "event",
    entityId: link.eventId,
    action: AUDIT_ACTION_REVERTED,
    data: {
      script: SCRIPT_NAME,
      revertedPlaceId: link.placeId,
      restoredPlaceId: link.priorPlaceId,
    },
  });

  return { kind: "linked", eventId: link.eventId, placeId: link.placeId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag parsing
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BATCH_SIZE = 25;
export const MAX_BATCH_SIZE = 200;

export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  // A NaN limit must NOT fall through to `undefined` and mean "the whole
  // table", and a negative one must not invert the slice.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer (got "${raw}")`);
  }
  return n;
}

export function parseBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--batch-size must be a positive integer (got "${raw}")`);
  }
  // The bound is the transaction bound: every link in a batch is written in
  // ONE interactive transaction, and an unbounded batch is an unbounded lock
  // hold on live event rows.
  if (n > MAX_BATCH_SIZE) {
    throw new Error(
      `--batch-size must be <= ${MAX_BATCH_SIZE} (got ${n}) — each batch is ` +
        `one transaction`,
    );
  }
  return n;
}

export function parseRequiredPath(
  raw: string | undefined,
  flag: string,
): string {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${flag} needs a path`);
  }
  return raw;
}

export function parseOptionalValue(
  raw: string | undefined,
  flag: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  // `--start-after=` parses as an empty string and would silently widen the
  // run to the WHOLE table — the opposite of what an operator asked for.
  if (value === "") {
    throw new Error(`${flag} needs a value (got an empty string)`);
  }
  return value;
}

/**
 * Bucket counts for the confidence distribution an operator reads before
 * deciding whether to run this on production at all.
 */
export function summarizeLinks(links: readonly ProposedLink[]): {
  high: number;
  medium: number;
  addressCorroborated: number;
  directoryListed: number;
  atSuffix: number;
  titleExact: number;
  manual: number;
} {
  return {
    high: links.filter((l) => l.confidence === "high").length,
    medium: links.filter((l) => l.confidence === "medium").length,
    addressCorroborated: links.filter((l) => l.addressCorroborated).length,
    directoryListed: links.filter((l) => l.placeListedInDirectory).length,
    atSuffix: links.filter((l) => l.signal === "at-suffix-exact").length,
    titleExact: links.filter((l) => l.signal === "title-exact").length,
    manual: links.filter((l) => l.signal === "manual").length,
  };
}

/**
 * How many refusals carry an address that agrees anyway. The operator's
 * shortlist: these are the review rows most likely to be real links.
 */
export function countCorroboratedReviews(
  entries: readonly ReviewEntry[],
): number {
  return entries.filter((entry) =>
    entry.candidates.some((candidate) => candidate.addressCorroborated),
  ).length;
}

export function summarizeReviews(
  entries: readonly ReviewEntry[],
): Record<ReviewReason, number> {
  const counts: Record<ReviewReason, number> = {
    "ambiguous-multiple-places": 0,
    "duplicate-place-name": 0,
    "generic-place-name": 0,
    "partial-name-match": 0,
    "weak-substring-only": 0,
    "inactive-place": 0,
    "unexpected-listing-state": 0,
  };
  for (const entry of entries) counts[entry.reason] += 1;
  return counts;
}
