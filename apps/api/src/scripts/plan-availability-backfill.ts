/**
 * The decision half of the `PlaceAvailability → CalendarAvailability` backfill,
 * kept pure so it can be tested without a database.
 *
 * WHY THIS EXISTS: the public booking date picker used to read the legacy
 * Place-level `PlaceAvailability` rows. It now reads `CalendarAvailability`.
 * A pre-hierarchy venue whose hours only live in the old table therefore
 * answers "no rules" — which the picker renders as CLOSED on every date, with
 * no error, because the query succeeded. A silently dead picker is worse than
 * a loud failure, so the rows move BEFORE the old reader goes away.
 *
 * The copy uses `calendarId: null`, which is exact rather than approximate:
 * the legacy rows were scoped to the PLACE, and a null-calendar row is defined
 * as applying to every calendar of that place (venue-hierarchy FR-007). One
 * row in, one row out, same meaning.
 */

/** The legacy row, narrowed to the fields that carry meaning. */
export interface LegacyAvailabilityRow {
  placeId: string;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  isOpen: boolean;
  note: string | null;
}

/** An existing calendar-scoped row, as read back for the idempotency check. */
export interface ExistingAvailabilityRow {
  placeId: string;
  calendarId: string | null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  isOpen: boolean;
}

export interface PlannedAvailabilityRow {
  placeId: string;
  /** Always null — see the module docblock. */
  calendarId: null;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  isOpen: boolean;
  note: string | null;
}

/**
 * Identity of a rule, for the idempotency check.
 *
 * `note` is DELIBERATELY excluded: it is a private annotation, and an owner
 * who edits the note on an already-migrated row must not cause the source row
 * to be copied a second time. Everything that changes WHEN the venue is open
 * is included.
 *
 * A date is keyed by its instant, matching how both tables store it.
 */
function ruleKey(row: {
  placeId: string;
  dayOfWeek: number | null;
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  isOpen: boolean;
}): string {
  return [
    row.placeId,
    row.dayOfWeek ?? "-",
    row.date ? row.date.getTime() : "-",
    row.startTime ?? "-",
    row.endTime ?? "-",
    row.isOpen ? "open" : "closed",
  ].join("|");
}

/**
 * Which legacy rows still need copying.
 *
 * Idempotent in both directions:
 *   · a legacy row already present as a PLACE-WIDE calendar row is skipped, so
 *     re-running the script writes nothing;
 *   · two identical legacy rows produce ONE planned row, so a duplicated
 *     source never fans out.
 *
 * A row already present but scoped to a SPECIFIC calendar does NOT count as
 * migrated — that is a different rule (it applies to one stream, the legacy row
 * applied to the whole venue), and treating it as a match would quietly drop
 * hours from every other calendar.
 */
export function planAvailabilityBackfill(
  legacy: readonly LegacyAvailabilityRow[],
  existing: readonly ExistingAvailabilityRow[],
): PlannedAvailabilityRow[] {
  const seen = new Set<string>();
  for (const row of existing) {
    // Only place-wide rows can satisfy a place-wide legacy row.
    if (row.calendarId !== null) continue;
    seen.add(ruleKey(row));
  }

  const planned: PlannedAvailabilityRow[] = [];
  for (const row of legacy) {
    const key = ruleKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    planned.push({
      placeId: row.placeId,
      calendarId: null,
      dayOfWeek: row.dayOfWeek,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      isOpen: row.isOpen,
      note: row.note,
    });
  }
  return planned;
}
