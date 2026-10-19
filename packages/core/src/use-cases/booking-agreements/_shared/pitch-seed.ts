import { DateTime, IANAZone } from "luxon";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { formatMoneyCents } from "../../../lib/currency-utils";
import { sanitizePlainTextMultiline } from "../../../lib/sanitize-plain-text";

// ─────────────────────────────────────────────────────────────────────────────
// Pitch → Agreement seeding (and its provenance)
//
// THE PROBLEM THIS SOLVES. An act pitches "Sep 15, four-piece, 45-minute set,
// $500 guarantee". The venue accepts. Before this module, the minted Agreement
// carried a title and nothing else — `proposedDate`, `proposedEndDate`,
// `guaranteeCents` and `description` were all null — so the venue retyped the
// pitch it had just read into a blank header. And because
// `createEventFromAgreement` inherits from the AGREEMENT, everything dropped
// here was dropped from the event too.
//
// WHY SEEDING IS SAFE WITH MONEY IN IT. `guaranteeCents` is a RECORDED deal
// term — it is never mapped to a `PayoutTermsLine` and the platform never
// settles it (2026-08: deals are recorded, not executed). Seeding it is still
// treated with money-write care because both parties read it as the deal. It
// is acceptable for exactly one reason: the number is the ACT'S OWN ASK, and
// the Agreement is minted DRAFT with PENDING terms — nothing binds until the
// counterparty accepts it back. Seeding turns "retype what they said" into
// "review what they said". Nothing in here may ever activate terms, skip a
// review step, or touch a CAS/authz path.
//
// PROVENANCE WITHOUT A COLUMN. Every seeded field must be identifiable as
// "from the act's pitch" so the venue can see what they did NOT choose — and
// the label must vanish once they edit it. Rather than add a column, the read
// path RE-COMPUTES the seed from the same inputs and compares:
// {@link deriveAgreementPitchProvenance} is literally
// `stored === computeAgreementPitchSeed(...)`, field by field. One function
// produces the value and one comparison judges it, so the two can't drift, and
// no UI can re-implement the rule.
//
// The known cost of derivation-over-storage: if the venue later edits the
// routed calendar's `defaultStartTime` (or the place's address moves its
// timezone), a DATE-ONLY pitch's seeded `proposedDate` stops re-computing to
// the stored instant and the label silently drops off. The failure mode is a
// MISSING hint, never a wrong number or a wrong money value — acceptable for a
// provenance chip, and strictly better than a schema migration for a label.
// (A pitch that named a TIME is immune: nothing about it depends on venue
// config beyond the zone.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fallback IANA zone when the venue place carries no address-derived
 * `Place.timezone` yet (venue-hierarchy FR-004). Shared with — and consumed by
 * — `create-event-from-agreement.ts` so the accept-time anchor and the
 * event-mint anchor can never disagree about what "the venue's zone" means.
 */
export const DEFAULT_BOOKING_TIMEZONE = "America/Chicago";

/** 7pm — a sensible default show time when nothing else names one. */
export const DEFAULT_BOOKING_START_HOUR = 19;

/**
 * Fallback show LENGTH when nothing negotiated one, in hours.
 *
 * Lives here for the same reason the zone and the default hour do: every path
 * that mints an event from a booking — `createEventFromAgreement` and the
 * accept mint (`booking-requests/_shared/accept-mint.ts`) — must answer "how
 * long is a show nobody measured" identically, or the same booking gets a
 * different duration depending on which door it came through.
 */
export const DEFAULT_EVENT_DURATION_HOURS = 3;

/**
 * Upper bound on the seeded description, matching the header editor's own
 * `plainTextMultilineOptional(5000)` bound — a seeded value the venue cannot
 * re-save would be a trap.
 */
const DESCRIPTION_MAX = 5000;

/** The pitch fields that can seed an Agreement header. */
export type AgreementPitchSource = Pick<
  BookingRequestRecord,
  | "preferredDates"
  | "setLengthMinutes"
  | "lineupSize"
  | "techNeeds"
  | "feeType"
  | "feeAmountCents"
  | "feeCurrency"
>;

/**
 * Venue-side context the pitch's wall clocks and money are interpreted
 * against. Resolved by the CALLER (both the accept mint and the agreement
 * read) so this module stays pure and does no I/O.
 */
export type AgreementPitchContext = {
  /**
   * IANA zone the pitch's dates/times are expressed in — the venue's local
   * time, which is what a bill means by "doors at 8". Resolve with
   * {@link resolveBookingTimezone}.
   */
  timezone: string;
  /**
   * The routed calendar's `defaultStartTime` ("HH:mm" wall clock, FR-009
   * template default), or null. Used ONLY for a date-only pitch — a pitch that
   * named its own time keeps it.
   */
  calendarDefaultStartTime: string | null;
  /**
   * Settlement currency of the Agreement's PayoutTerms. A fee ask denominated
   * in anything else must NOT become `guaranteeCents` (that number is read by
   * both parties as an amount in THIS currency). `null` = unknown, which is
   * treated as "cannot verify" and blocks the guarantee seed.
   */
  settlementCurrency: string | null;
};

/** The header fields a pitch can fill in. `null` = the pitch said nothing. */
export type AgreementPitchSeed = {
  proposedDate: Date | null;
  proposedEndDate: Date | null;
  /** Integer cents — never floats. */
  guaranteeCents: number | null;
  description: string | null;
};

/**
 * Per-field "this is still exactly what the act asked for". `false` means
 * either the pitch never produced a value for that field, or the venue has
 * since changed it.
 */
export type AgreementPitchProvenance = {
  proposedDate: boolean;
  proposedEndDate: boolean;
  guaranteeCents: boolean;
  description: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Wall-clock parsing
//
// NEVER `new Date(`${iso}T00:00:00`)`: `preferredDates` entries may ALREADY
// carry a time (`bookingPreferredDateSchema` admits `YYYY-MM-DD` and
// `YYYY-MM-DDTHH:MM`), so that construction yields
// "2026-09-18T20:00T00:00:00" → Invalid Date. Everything below goes through
// luxon with an explicit zone.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `bookingPreferredDateSchema`'s shape, capturing the parts. */
const PREFERRED_DATE_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;

/** The calendar template's wall-clock default, written as strict "HH:mm". */
const WALL_CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type BookingWallClock = { hour: number; minute: number };

/**
 * Parse a calendar `defaultStartTime`. A malformed stored value (the column is
 * only schema-checked at write time by manage-calendars) yields null so the
 * caller falls back to {@link DEFAULT_BOOKING_START_HOUR} rather than failing.
 */
export function parseBookingWallClock(
  value: string | null | undefined,
): BookingWallClock | null {
  const match = value ? WALL_CLOCK_PATTERN.exec(value) : null;
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Split a `preferredDates` entry into its calendar day and (optional) named
 * wall clock. Returns null for anything that isn't the schema's shape —
 * legacy/corrupt rows must degrade, never throw from a read path.
 */
export function parsePreferredDateEntry(
  entry: string,
): { date: string; time: BookingWallClock | null } | null {
  const match = PREFERRED_DATE_PATTERN.exec(entry);
  if (!match) return null;
  return {
    date: match[1]!,
    time:
      match[2] === undefined
        ? null
        : { hour: Number(match[2]), minute: Number(match[3]) },
  };
}

/**
 * Anchor a preferred-date entry to a real instant in `zone`.
 *
 * Precedence for the TIME: the pitch's own wall clock (the act picked that
 * slot out of the venue's availability) → the routed calendar's
 * `defaultStartTime` → {@link DEFAULT_BOOKING_START_HOUR}. The DATE always
 * comes from the entry.
 *
 * Returns null when the entry is unparseable or names an impossible day
 * (`2026-02-31`) — callers decide whether that's a degrade or a failure.
 */
export function anchorPreferredDate(
  entry: string,
  zone: string,
  calendarDefaultStartTime: string | null,
): Date | null {
  const parts = parsePreferredDateEntry(entry);
  if (!parts) return null;

  const day = DateTime.fromISO(parts.date, { zone });
  if (!day.isValid) return null;

  const clock =
    parts.time ??
    parseBookingWallClock(calendarDefaultStartTime) ?? {
      hour: DEFAULT_BOOKING_START_HOUR,
      minute: 0,
    };

  return day
    .set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 })
    .toJSDate();
}

/**
 * The venue's zone for booking anchoring: the address-derived
 * `Place.timezone` when it is a real IANA zone, else the platform default.
 * The column is free text at the DB level, so a garbage value must degrade —
 * never fail a mint or a read.
 */
export function resolveBookingTimezone(
  timezone: string | null | undefined,
): string {
  return timezone && IANAZone.isValidZone(timezone)
    ? timezone
    : DEFAULT_BOOKING_TIMEZONE;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the pitch can say about the Agreement header, as a pure function
 * of the pitch + venue context. Deterministic: the same inputs ALWAYS produce
 * the same output, which is what makes {@link deriveAgreementPitchProvenance}
 * sound.
 *
 * - `proposedDate` ← the FIRST preferred date, anchored per
 *   {@link anchorPreferredDate}. (First, not "best": the picker orders the
 *   act's own preference, and picking any other one would be the platform
 *   choosing a night on the venue's behalf.)
 * - `proposedEndDate` ← `proposedDate + setLengthMinutes`, only when both are
 *   known. Added in the ZONE so a set that straddles a DST boundary still ends
 *   the right number of minutes later.
 * - `guaranteeCents` ← `feeAmountCents`, ONLY for `feeType === "GUARANTEE"`
 *   and only when the ask's currency matches the terms' settlement currency.
 *   A DOOR_SPLIT or NEGOTIABLE ask is NOT a guarantee and must never land on a
 *   floor.
 * - `description` ← the operational asks that have NO structured home
 *   (lineup size, set length, tech needs) plus the fee ask when it isn't
 *   expressible as `guaranteeCents`. Deliberately NOT the pitch `message` —
 *   that is the act's own prose, it is already rendered on the agreement page
 *   in the "From the booking request" block, and turning marketing copy into
 *   contract text is a category error.
 */
export function computeAgreementPitchSeed(
  pitch: AgreementPitchSource,
  context: AgreementPitchContext,
): AgreementPitchSeed {
  const proposedDate = resolveProposedDate(pitch, context);
  return {
    proposedDate,
    proposedEndDate: addSetLength(proposedDate, pitch.setLengthMinutes),
    guaranteeCents: resolveGuaranteeCents(pitch, context),
    description: composePitchDescription(pitch, context),
  };
}

function resolveProposedDate(
  pitch: AgreementPitchSource,
  context: AgreementPitchContext,
): Date | null {
  const first = pitch.preferredDates?.[0];
  if (!first) return null;
  return anchorPreferredDate(
    first,
    context.timezone,
    context.calendarDefaultStartTime,
  );
}

/**
 * A start plus the pitch's set length, or null when either is unknown.
 *
 * Exact minutes, deliberately: a set length is a DURATION, not a calendar
 * span, so a 45-minute set is 45 real minutes even across a DST boundary. The
 * zone matters for choosing the START instant (see {@link anchorPreferredDate})
 * and nowhere after it.
 *
 * Shared with the organizer mint, which applies the same span to an ATTACHED
 * EVENT's start — one rule for "set length becomes an end time".
 */
export function addSetLength(
  start: Date | null,
  setLengthMinutes: number | null | undefined,
): Date | null {
  if (!start) return null;
  const minutes = setLengthMinutes;
  if (minutes == null || !Number.isInteger(minutes) || minutes <= 0) return null;
  return new Date(start.getTime() + minutes * 60_000);
}

/**
 * The act's guarantee ask, or null. Three independent gates, all of which must
 * pass before a number the platform did not choose becomes a money floor:
 * the ask must BE a guarantee, the amount must be a positive integer number of
 * cents, and its currency must be the one the terms settle in.
 */
function resolveGuaranteeCents(
  pitch: AgreementPitchSource,
  context: AgreementPitchContext,
): number | null {
  if (pitch.feeType !== "GUARANTEE") return null;

  const cents = pitch.feeAmountCents;
  if (cents == null || !Number.isInteger(cents) || cents <= 0) return null;

  if (!currencyMatchesSettlement(pitch.feeCurrency, context)) return null;

  return cents;
}

/**
 * A fee ask in a currency the Agreement does not settle in cannot become
 * `guaranteeCents` — the column carries no currency of its own, so the number
 * would silently be re-denominated. A NULL `feeCurrency` (rows written before
 * the column existed) is treated as the settlement currency, which is what it
 * was. An UNKNOWN settlement currency blocks the seed: unverifiable is not the
 * same as fine.
 */
function currencyMatchesSettlement(
  feeCurrency: string | null,
  context: AgreementPitchContext,
): boolean {
  if (!context.settlementCurrency) return false;
  if (!feeCurrency) return true;
  return (
    feeCurrency.trim().toLowerCase() ===
    context.settlementCurrency.trim().toLowerCase()
  );
}

/**
 * The pitch facts that would otherwise be retyped, as plain text on the
 * agreement itself. Null when the pitch carried none of them.
 *
 * The free-text `techNeeds` is re-sanitized here BEFORE it is measured or
 * clipped (house `plainText*` ordering) even though the create path already
 * sanitized it at write time — this composes a NEW stored value, so it gets
 * the boundary treatment again rather than trusting the row.
 */
function composePitchDescription(
  pitch: AgreementPitchSource,
  context: AgreementPitchContext,
): string | null {
  const bullets: string[] = [];

  const lineup = pitch.lineupSize;
  if (lineup != null && Number.isInteger(lineup) && lineup > 0) {
    bullets.push(
      `- Lineup: ${lineup} ${lineup === 1 ? "performer" : "performers"}`,
    );
  }

  const setLength = pitch.setLengthMinutes;
  if (setLength != null && Number.isInteger(setLength) && setLength > 0) {
    bullets.push(`- Set length: ${setLength} minutes`);
  }

  const fee = describeFeeAsk(pitch, context);
  if (fee) bullets.push(`- Fee ask: ${fee}`);

  const techNeeds = pitch.techNeeds
    ? sanitizePlainTextMultiline(pitch.techNeeds)
    : "";

  if (bullets.length === 0 && !techNeeds) return null;

  const blocks = ["From the booking request:", bullets.join("\n")].filter(
    (block) => block.length > 0,
  );
  if (techNeeds) blocks.push(`Tech needs:\n${techNeeds}`);

  const composed = blocks.join("\n\n");
  return composed.length > DESCRIPTION_MAX
    ? composed.slice(0, DESCRIPTION_MAX).trimEnd()
    : composed;
}

/**
 * How the fee ask reads on the agreement.
 *
 * DOOR_SPLIT is deliberately PROSE, not payout-terms lines. A
 * `PayoutTermsLine` is `(payee, percent, floorCents, cap, priority)` — it
 * cannot express "we agreed on a door split" without a PERCENTAGE, and the act
 * never stated one (`feeType` carries no split field; `feeAmountCents` on a
 * door split is a target, not a share). Writing a made-up percentage into
 * money terms the counterparty later accepts would be far worse than leaving
 * the terms alone, so the split is recorded where the venue reads it and
 * negotiates from — and the payout lines stay exactly as the venue's defaults
 * left them.
 *
 * A GUARANTEE that made it into `guaranteeCents` is omitted here: it already
 * has a structured home and repeating it invites the two to disagree after an
 * edit. A guarantee BLOCKED by the currency gate is still written out — the
 * number must not vanish just because we refused to re-denominate it.
 */
function describeFeeAsk(
  pitch: AgreementPitchSource,
  context: AgreementPitchContext,
): string | null {
  if (!pitch.feeType) return null;

  const amount = formatFeeAmount(pitch);

  if (pitch.feeType === "GUARANTEE") {
    if (!amount) return "guarantee (amount to be agreed)";
    if (currencyMatchesSettlement(pitch.feeCurrency, context)) return null;
    return `guarantee of ${amount}`;
  }

  if (pitch.feeType === "DOOR_SPLIT") {
    return amount ? `door split (asking ${amount})` : "door split";
  }

  return "negotiable";
}

function formatFeeAmount(pitch: AgreementPitchSource): string | null {
  const cents = pitch.feeAmountCents;
  if (cents == null || !Number.isInteger(cents) || cents <= 0) return null;
  return formatMoneyCents(cents, {
    currency: pitch.feeCurrency ?? "usd",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/** The stored header fields provenance is judged against. */
export type AgreementPitchTarget = {
  proposedDate: Date | null;
  proposedEndDate: Date | null;
  guaranteeCents: number | null;
  description: string | null;
};

/**
 * Which header fields still hold exactly what the pitch produced.
 *
 * SINGLE SOURCE OF TRUTH: this re-runs {@link computeAgreementPitchSeed} and
 * compares — there is no second copy of the rule to drift, and the UI reads
 * the answer rather than deriving one. A field the pitch never filled is
 * `false` (nothing to attribute), and any edit — including clearing the field
 * — flips it to `false` on the next read.
 */
export function deriveAgreementPitchProvenance(
  stored: AgreementPitchTarget,
  pitch: AgreementPitchSource,
  context: AgreementPitchContext,
): AgreementPitchProvenance {
  const seed = computeAgreementPitchSeed(pitch, context);
  return {
    proposedDate: sameInstant(stored.proposedDate, seed.proposedDate),
    proposedEndDate: sameInstant(stored.proposedEndDate, seed.proposedEndDate),
    guaranteeCents:
      seed.guaranteeCents !== null &&
      stored.guaranteeCents === seed.guaranteeCents,
    description:
      seed.description !== null && stored.description === seed.description,
  };
}

function sameInstant(stored: Date | null, seeded: Date | null): boolean {
  if (!seeded || !stored) return false;
  return stored.getTime() === seeded.getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context resolution (the one piece that needs I/O)
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveCalendarDefaultStartTimeDeps = {
  repos: Pick<Repos, "calendars">;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * The routed calendar's `defaultStartTime`, or null.
 *
 * Read via `listByPlace` so the SAME-PLACE assert is structural (a cross-place
 * or deleted calendarId simply isn't in the place's list) — the same posture
 * `createEventFromAgreement` uses, so the accept-time seed and the later event
 * mint resolve the identical calendar.
 *
 * DELIBERATE SWALLOW (ReporterPort convention): this only supplies a default
 * SHOW TIME. A broken calendars read must degrade the seed to 19:00, never
 * fail an accept — a venue unable to accept a booking because a template
 * lookup hiccuped is a far worse outcome than a suggested time being an hour
 * off. Logged at error AND reported; a throwing reporter changes nothing.
 */
export async function resolveCalendarDefaultStartTime(
  deps: ResolveCalendarDefaultStartTimeDeps,
  args: { placeId: string; calendarId: string | null },
): Promise<string | null> {
  if (!args.calendarId) return null;

  try {
    const calendars = await deps.repos.calendars.listByPlace(args.placeId);
    return (
      calendars.find((calendar) => calendar.id === args.calendarId)
        ?.defaultStartTime ?? null
    );
  } catch (error) {
    deps.logger?.error("booking_agreements.pitch_seed.calendar_lookup_failed", {
      placeId: args.placeId,
      calendarId: args.calendarId,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "resolveCalendarDefaultStartTime" },
        extra: { placeId: args.placeId, calendarId: args.calendarId },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never change the
      // degraded-but-correct outcome above.
    }
    return null;
  }
}
