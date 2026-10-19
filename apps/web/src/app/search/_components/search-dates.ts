/**
 * search-dates — the /search date-preset window maths.
 *
 * Pure and framework-free so it can be tested against a frozen clock. It used
 * to live inline in the facet component, where the two calendar edges below
 * were unreachable by any test:
 *
 *  1. THE SUNDAY EDGE. "This weekend" used to walk BACK to Saturday whenever
 *     today was a Sunday, so a one-tap filter handed back a window whose lower
 *     bound was yesterday. On a Sunday the rest of the weekend is today, and
 *     that is what it returns now.
 *
 *  2. COLLIDING PRESETS. Fixing (1) makes "This weekend" identical to "Today"
 *     on a Sunday — and "This month" is already identical to "Today" on the
 *     last day of a month. Two chips for one window is one chip too many, and
 *     worse, `detectActivePreset` returns the FIRST match, so the chip the
 *     reader pressed would render unselected while its twin lit up.
 *     `datePresetsFor` drops the duplicates, first-declared wins.
 *
 * TIMEZONE. Every value here is a local calendar date (`YYYY-MM-DD`) built
 * from local getters. The caller must parse BOTH bounds on that same basis —
 * see the `dateRange` block in UniversalSearchPage, which appends an explicit
 * `T00:00:00` / `T23:59:59` rather than letting the bare `YYYY-MM-DD` form
 * parse as UTC midnight (which it does, per spec) on one end only.
 */

export type DatePresetId = "today" | "this-weekend" | "next-7" | "this-month";

/** Declaration order is menu order, and it is the tie-break for collisions. */
export const DATE_PRESET_ORDER: readonly DatePresetId[] = [
  "today",
  "this-weekend",
  "next-7",
  "this-month",
];

export type DateRange = { from: string; to: string };

/** Local calendar date as `YYYY-MM-DD`. Never `toISOString()` — that is UTC. */
export function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Midnight-local copy of `now`, so no preset ever inherits a time component. */
const startOfDay = (now: Date): Date => {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * The window a preset means, evaluated against `now` (injectable for tests).
 *
 * No preset ever returns a lower bound in the past: these are shortcuts for
 * "what can I still go to", and a range starting yesterday quietly excludes
 * nothing while implying it includes something.
 */
export function rangeForPreset(
  preset: DatePresetId,
  now: Date = new Date(),
): DateRange {
  const today = startOfDay(now);

  if (preset === "today") {
    const iso = isoDate(today);
    return { from: iso, to: iso };
  }

  if (preset === "this-weekend") {
    // Sun = 0, Sat = 6.
    const dow = today.getDay();
    if (dow === 0) {
      // Already Sunday: the weekend that remains is today.
      const iso = isoDate(today);
      return { from: iso, to: iso };
    }
    const sat = new Date(today.getTime());
    // On Saturday the weekend has started; otherwise jump to the coming one.
    if (dow !== 6) sat.setDate(today.getDate() + (6 - dow));
    const sun = new Date(sat.getTime());
    sun.setDate(sat.getDate() + 1);
    return { from: isoDate(sat), to: isoDate(sun) };
  }

  if (preset === "next-7") {
    const end = new Date(today.getTime());
    end.setDate(today.getDate() + 6);
    return { from: isoDate(today), to: isoDate(end) };
  }

  // this-month — today through the last day of the current month.
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { from: isoDate(today), to: isoDate(end) };
}

/**
 * The presets worth offering right now: every id whose window is not already
 * covered by an earlier one. See (2) in the file header.
 */
export function datePresetsFor(
  now: Date = new Date(),
): readonly { id: DatePresetId; range: DateRange }[] {
  const seen = new Set<string>();
  const out: { id: DatePresetId; range: DateRange }[] = [];
  for (const id of DATE_PRESET_ORDER) {
    const range = rangeForPreset(id, now);
    const key = `${range.from}|${range.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, range });
  }
  return out;
}

/**
 * Which preset (if any) an explicit from/to pair corresponds to.
 *
 * Only ever reports a preset that `datePresetsFor` is actually offering, so
 * the highlighted chip is always a chip that is on screen.
 */
export function detectActivePreset(
  from: string,
  to: string,
  now: Date = new Date(),
): DatePresetId | null {
  if (!from || !to) return null;
  for (const { id, range } of datePresetsFor(now)) {
    if (range.from === from && range.to === to) return id;
  }
  return null;
}
