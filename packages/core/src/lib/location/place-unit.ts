/**
 * A place's "Unit or room" line ("Unit A", "Unit A, Floor 2", "Back room"):
 * stored in `Place.addrLine2` AND folded into the formatted address text
 * (`Place.address`) at ONE known position, so every surface shows it once
 * (public ones read the formatted text; staff panels read the street lines).
 *
 * THE POSITION: immediately after the street line, matched as a whole run of
 * comma-separated segments ("2190 Nolensville Pike" in "Red Bicycle, 2190
 * Nolensville Pike, Nashville, …"); at the front when the street line is not
 * in the text as a whole run. The unit is itself a run of segments (split on
 * commas too), so a unit containing a comma round-trips.
 *
 * Fold and strip only ever touch that position. Fold ALWAYS inserts: its
 * input is a text without the unit (a fresh geocoder pick, or the stored text
 * after {@link stripUnitFromFormatted}). It does NOT skip when the unit's
 * text is already there, because "already there" cannot be told apart from a
 * unit that equals the next segment (a unit "Nashville" before the city), and
 * skipping would let a later strip remove the city. strip(fold(x)) === x,
 * byte for byte, which is what makes a re-save leave the text unchanged.
 *
 * PURE and import-free: the web community place dialog imports it
 * (`@th/core/lib/location/place-unit`) to show the Address without the unit.
 */

/** The longest unit the community place write and dialog accept. */
export const PLACE_UNIT_MAX_LENGTH = 80;

/** A blank unit is no unit. */
export function unitOrNull(unit: string | null | undefined): string | null {
  const trimmed = unit?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function runOf(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function runAt(trimmed: string[], at: number, run: string[]): boolean {
  if (run.length === 0 || at + run.length > trimmed.length) return false;
  return run.every((segment, i) => trimmed[at + i] === segment);
}

/**
 * The segment index the unit run starts at: just after the first whole-run
 * match of the street line, else 0.
 */
function unitPosition(trimmed: string[], line1: string | null | undefined): number {
  const street = runOf(line1);
  if (street.length === 0) return 0;
  for (let i = 0; i + street.length <= trimmed.length; i++) {
    if (runAt(trimmed, i, street)) return i + street.length;
  }
  return 0;
}

function segmentsOf(formatted: string): { raw: string[]; trimmed: string[] } {
  const raw = formatted.split(",");
  return { raw, trimmed: raw.map((segment) => segment.trim().toLowerCase()) };
}

/** `formatted` (without the unit) with the unit inserted at its position. */
export function foldUnitIntoFormatted(
  formatted: string,
  line1: string | null | undefined,
  unit: string | null | undefined,
): string {
  const unitText = (unit ?? "")
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(", ");
  if (!unitText) return formatted;
  const { raw, trimmed } = segmentsOf(formatted);
  const at = unitPosition(trimmed, line1);
  if (at === 0) return `${unitText}, ${formatted}`;
  const cut = raw.slice(0, at).join(",").length;
  return `${formatted.slice(0, cut)}, ${unitText}${formatted.slice(cut)}`;
}

/**
 * `formatted` without the unit run at its position. Unchanged when the unit
 * is blank or not at that position (a legacy place whose unit was folded
 * into the street line has a NULL unit, so its text stays as it is). Every
 * other segment keeps its original text and spacing.
 */
export function stripUnitFromFormatted(
  formatted: string,
  line1: string | null | undefined,
  unit: string | null | undefined,
): string {
  const run = runOf(unit);
  if (run.length === 0) return formatted;
  const { raw, trimmed } = segmentsOf(formatted);
  const at = unitPosition(trimmed, line1);
  if (!runAt(trimmed, at, run)) return formatted;
  const kept = [...raw.slice(0, at), ...raw.slice(at + run.length)].join(",");
  return at === 0 ? kept.trimStart() : kept;
}
