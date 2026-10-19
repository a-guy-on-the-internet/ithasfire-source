/**
 * series-rrule-local-basis.ts — PURE analysis + rewrite of an `EventSeries`
 * RRULE from the legacy UTC token basis to the local (event-timezone) basis.
 *
 * ── What changed and why a rewrite is needed ────────────────────────────────
 * The backend used to drive the `rrule` package on real UTC instants. `rrule`
 * is timezone-blind — it reads a Date's UTC fields as wall-clock — so
 * BYDAY/BYSETPOS were evaluated against the **UTC** calendar. The admin
 * builder compensated by emitting a SHIFTED token: a Nashville Friday-20:00
 * show (= Saturday 01:00 UTC) was stored as `BYDAY=SA` and labelled "Friday".
 *
 * The backend now evaluates in the event timezone, so `BYDAY=SA` would put
 * that series on real local Saturdays. Stored rules written under the old
 * basis must be shifted back to the local basis.
 *
 * Only `EventSeries.schedule` is affected. Community listings live in
 * `Event.recurrenceSchedule` and were ALWAYS written on the local basis
 * (`apps/web/src/lib/recurrence/build-recurrence-schedule.ts`) — they must not
 * be rewritten.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * A shifted rule and an unshifted one are indistinguishable from the rule
 * string alone, so the decision is made against each row's OWN dtstart and
 * timezone:
 *
 *   shift = (utcWeekdayOf(dtstart) - localWeekdayOf(dtstart, tz)) mod 7
 *
 *   - `shift === 0` — the two bases name the same calendar date, so the same
 *     weekday AND the same day-of-month AND the same ordinal. The stored rule
 *     is already correct under either reading and is never rewritten. This is
 *     most daytime events. (A shift-0 rule whose BYDAY does not contain its
 *     own anchor day at all is still surfaced as AMBIGUOUS rather than given a
 *     clean bill — nothing to rewrite, but worth a human's eye.)
 *   - BYDAY contains the UTC anchor day but NOT the local one → written under
 *     the old basis → rewrite.
 *   - BYDAY contains the local anchor day but NOT the UTC one → already on the
 *     local basis (migrated, or written after the flip) → skip. Running this
 *     script twice is therefore a no-op on the second pass.
 *   - BYDAY contains BOTH, or NEITHER → the anchor cannot identify the basis.
 *     Reported as AMBIGUOUS and left alone for a human.
 *
 * MONTHLY rules carry BYSETPOS too, and the ordinal shifts with the day (a
 * local "last Friday of July" is the UTC "first Saturday of August"). BYDAY
 * and BYSETPOS are always rewritten TOGETHER — a rule with a migrated BYDAY
 * and a stale BYSETPOS matches nothing.
 *
 * No luxon: everything zone-aware here goes through `Intl.DateTimeFormat`,
 * which `apps/api` already has.
 */

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type StoredSchedule = {
  kind?: string | null;
  rrule?: string | null;
  dtstart?: string | null;
  [key: string]: unknown;
};

export type Analysis =
  /** FIXED_DATES, or an RRULE row with no rule/dtstart — nothing to do. */
  | { kind: "not-applicable"; reason: string }
  /** dtstart or the rule could not be read. */
  | { kind: "unreadable"; reason: string }
  /** The local and UTC calendars name the same day — both bases agree. */
  | { kind: "no-shift" }
  /** Shifted, but the rule carries no weekday token to rewrite. */
  | { kind: "already-local" }
  | { kind: "needs-migration"; from: string; to: string; shift: number }
  /**
   * Shifted AND anchor-derived (a bare `FREQ=MONTHLY` repeats on dtstart's
   * day-of-month). Its meaning changes with the backend fix, but there is no
   * token in the string to rewrite — surfaced so it can be reviewed by hand.
   */
  | { kind: "anchor-only"; reason: string }
  | { kind: "ambiguous"; reason: string };

/** Nth-or-last position of `day` among same-weekday days of its month. */
export function nthOfMonth(
  year: number,
  monthIndex: number,
  day: number,
): number {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  if (day + 7 > daysInMonth) return -1;
  return Math.floor((day - 1) / 7) + 1;
}

/**
 * Does this datetime string carry an explicit `Z` or ±HH:MM offset? Mirrors
 * the check of the same name in the web builder's `recurrence-helpers.ts`.
 */
function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

/** Weekday index (MO=0) of a UTC-fielded calendar date. */
function weekdayIndexFromUtc(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

type CalendarParts = {
  year: number;
  monthIndex: number;
  day: number;
  weekdayIndex: number;
};

/** The calendar an instant reads as in `timeZone`. */
function partsInZone(instant: Date, timeZone: string): CalendarParts | null {
  try {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
    const [year, month, day] = formatted.split("-").map(Number);
    if (!year || !month || !day) return null;
    // Stamp the local calendar date at UTC midnight so the weekday is read
    // off exactly that date, with no offset in play.
    const stamped = new Date(Date.UTC(year, month - 1, day));
    return {
      year,
      monthIndex: month - 1,
      day,
      weekdayIndex: weekdayIndexFromUtc(stamped),
    };
  } catch {
    return null;
  }
}

/** The calendar an instant reads as in UTC. */
function partsInUtc(instant: Date): CalendarParts {
  return {
    year: instant.getUTCFullYear(),
    monthIndex: instant.getUTCMonth(),
    day: instant.getUTCDate(),
    weekdayIndex: weekdayIndexFromUtc(instant),
  };
}

function shiftWeekdayToken(token: Weekday, shift: number): Weekday {
  const idx = WEEKDAYS.indexOf(token);
  return WEEKDAYS[(idx + ((shift % 7) + 7)) % 7]!;
}

type RuleParts = Array<{ key: string; rawKey: string; value: string }>;

function splitRule(rrule: string): RuleParts | null {
  const parts: RuleParts = [];
  for (const chunk of rrule.split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;
    const rawKey = trimmed.slice(0, eq);
    parts.push({
      key: rawKey.toUpperCase(),
      rawKey,
      value: trimmed.slice(eq + 1),
    });
  }
  return parts.length > 0 ? parts : null;
}

function joinRule(parts: RuleParts): string {
  return parts.map((p) => `${p.rawKey}=${p.value}`).join(";");
}

function findPart(parts: RuleParts, key: string) {
  return parts.find((p) => p.key === key);
}

/**
 * Decide what (if anything) a stored series schedule needs, and produce the
 * rewritten rule string. Pure — no I/O, no clock.
 */
export function analyzeSeriesSchedule(input: {
  schedule: StoredSchedule | null | undefined;
  timezone: string;
}): Analysis {
  const { schedule, timezone } = input;

  if (!schedule || typeof schedule !== "object") {
    return { kind: "not-applicable", reason: "no schedule" };
  }
  if (schedule.kind !== "RRULE") {
    return { kind: "not-applicable", reason: `kind=${String(schedule.kind)}` };
  }
  const rrule = typeof schedule.rrule === "string" ? schedule.rrule : null;
  if (!rrule) {
    return { kind: "not-applicable", reason: "no rrule" };
  }
  const dtstartIso =
    typeof schedule.dtstart === "string" ? schedule.dtstart : null;
  if (!dtstartIso) {
    return { kind: "unreadable", reason: "no dtstart" };
  }

  // The dtstart MUST carry an explicit offset for this script to work.
  //
  // A bare wall clock ("2026-09-04T20:00:00") is NOT unparseable — `new Date`
  // accepts it and resolves it in the SCRIPT PROCESS's local zone, which has
  // nothing to do with the series. On a UTC host a Chicago Friday-evening row
  // then reads as Friday in both calendars, `shift` comes out 0, and an
  // old-basis `BYDAY=SA` rule would be reported as "nothing to do" while
  // staying broken. That error direction — a broken row declared safe — is the
  // one a migration must never take, so bare values are refused and surfaced.
  //
  // Refused rather than resolved — but note this case is DECIDABLE, not a
  // dead end. The old backend also read a bare value as wall clock in the
  // series timezone and handed `.toUTC()` to rrule, so the anchor a bare row
  // was written against is `utcWeekdayOf(resolveInSeriesTz(bare))` and a
  // future pass could migrate these automatically.
  //
  // It is refused here because the safe error direction matters more than the
  // coverage: the live writers always send an offset
  // (`toIsoInTimeZone(...)`), so an offset-less row came from a seed or the
  // API and its provenance is unverified, and the population is expected to be
  // tiny. Surfacing a handful of rows for a human beats silently rewriting a
  // rule on an assumption about who wrote it.
  if (!hasExplicitZone(dtstartIso)) {
    return {
      kind: "unreadable",
      reason:
        `dtstart "${dtstartIso}" carries no UTC offset — cannot establish ` +
        `the UTC anchor without assuming a reading`,
    };
  }

  const instant = new Date(dtstartIso);
  if (Number.isNaN(instant.getTime())) {
    return { kind: "unreadable", reason: `unparseable dtstart ${dtstartIso}` };
  }

  const local = partsInZone(instant, timezone);
  if (!local) {
    return { kind: "unreadable", reason: `unknown timezone ${timezone}` };
  }
  const utc = partsInUtc(instant);

  const shift = (utc.weekdayIndex - local.weekdayIndex + 7) % 7;

  const parts = splitRule(rrule);
  if (!parts) {
    return { kind: "unreadable", reason: `unparseable rrule ${rrule}` };
  }

  const freq = findPart(parts, "FREQ")?.value?.toUpperCase() ?? null;
  const bydayPart = findPart(parts, "BYDAY");

  if (!bydayPart) {
    // No weekday token. A bare FREQ=MONTHLY repeats on dtstart's
    // day-of-month, which differs between the bases (local Jul 31 vs UTC
    // Aug 1) — real drift, but nothing in the string to rewrite. With no
    // shift the two day-of-months are the same, so there is no drift either.
    if (freq === "MONTHLY" && shift !== 0) {
      return {
        kind: "anchor-only",
        reason: "FREQ=MONTHLY with no BYDAY repeats on dtstart's day-of-month",
      };
    }
    // DAILY / WEEKLY without BYDAY simply step from dtstart, so both bases
    // enumerate the same instants.
    return shift === 0 ? { kind: "no-shift" } : { kind: "already-local" };
  }

  const tokens = bydayPart.value.split(",").map((t) => t.trim());
  if (tokens.some((t) => !(WEEKDAYS as readonly string[]).includes(t))) {
    return {
      kind: "ambiguous",
      reason: `BYDAY carries a non-plain token (${bydayPart.value})`,
    };
  }
  const days = tokens as Weekday[];

  const localAnchor = WEEKDAYS[local.weekdayIndex]!;
  const utcAnchor = WEEKDAYS[utc.weekdayIndex]!;
  const hasLocal = days.includes(localAnchor);
  const hasUtc = days.includes(utcAnchor);

  if (shift === 0) {
    // Same calendar date in both readings ⇒ same weekday AND same
    // day-of-month ⇒ same ordinal. Nothing can differ between the bases, so
    // there is nothing to rewrite — but a rule that does not contain its own
    // anchor at all is still worth a human's eye rather than a clean bill.
    if (!hasLocal) {
      return {
        kind: "ambiguous",
        reason: `no shift, but BYDAY (${bydayPart.value}) does not contain the anchor day ${localAnchor}`,
      };
    }
    return { kind: "no-shift" };
  }

  if (hasLocal && hasUtc) {
    return {
      kind: "ambiguous",
      reason: `BYDAY contains BOTH the local (${localAnchor}) and UTC (${utcAnchor}) anchor`,
    };
  }
  if (!hasLocal && !hasUtc) {
    return {
      kind: "ambiguous",
      reason: `BYDAY contains NEITHER the local (${localAnchor}) nor UTC (${utcAnchor}) anchor`,
    };
  }
  if (hasLocal) {
    return { kind: "already-local" };
  }

  // Old basis. Shift every token back, and move BYSETPOS with it.
  const rewritten: RuleParts = parts.map((p) => ({ ...p }));
  const outByday = findPart(rewritten, "BYDAY")!;
  outByday.value = WEEKDAYS.filter((w) =>
    days.map((d) => shiftWeekdayToken(d, -shift)).includes(w),
  ).join(",");

  const setposPart = findPart(rewritten, "BYSETPOS");
  if (setposPart) {
    if (days.length > 1) {
      // BYSETPOS selects within the month's UNION of all BYDAY matches, so
      // shifting each member and swapping in the anchor's own ordinal is NOT
      // meaning-preserving — the result can exclude the event's own start.
      // Reachable: `parseRrule` rejects MONTHLY with >1 BYDAY, so the builder
      // stores such rules verbatim through its raw pass-through.
      return {
        kind: "ambiguous",
        reason: `BYSETPOS with a multi-day BYDAY (${bydayPart.value}) selects within the union of all matches — not soundly rewritable`,
      };
    }
    const stored = Number(setposPart.value);
    if (!Number.isInteger(stored)) {
      return {
        kind: "ambiguous",
        reason: `BYSETPOS is not an integer (${setposPart.value})`,
      };
    }
    const utcNth = nthOfMonth(utc.year, utc.monthIndex, utc.day);
    const localNth = nthOfMonth(local.year, local.monthIndex, local.day);
    if (stored !== utcNth) {
      // BYDAY says old-basis but BYSETPOS does not agree — rewriting only
      // half would build a rule that matches nothing.
      return {
        kind: "ambiguous",
        reason: `BYDAY reads as old-basis but BYSETPOS=${stored} is not the UTC ordinal (${utcNth})`,
      };
    }
    setposPart.value = String(localNth);
  }

  const to = joinRule(rewritten);
  if (to === rrule) {
    return { kind: "already-local" };
  }
  return { kind: "needs-migration", from: rrule, to, shift };
}
