/**
 * Layout seat ids → event Seat rows. PURE: no repo access.
 *
 * A place layout names every seat glyph `<sectionId>-<row>-<seat>`: the CSV
 * parser (`parse-place-layout-csv.ts`) builds the id from the trimmed,
 * non-empty `section`, `row` and `seat` columns, and the layout stores the ids
 * in `PlaceLayoutRecord.seatIds`. Materialising an event's seats
 * (`SeatsRepo.materializeSections`) walks those ids per section and creates
 * ONE Seat per derived `label`, keyed `(seatSectionId, label)`, last id wins.
 *
 * THE derivation lives here so the materialiser (adapter) and the readers that
 * map a Seat back to its glyph (`listEventSeatPriceOverridesForEdit`) share it
 * and cannot drift.
 */

export type ParsedLayoutSeatId = {
  label: string;
  row: string | null;
  number: number | null;
};

/** The prefix every seat id of a layout section starts with. */
export function layoutSeatIdPrefix(layoutSectionId: string): string {
  return `${layoutSectionId}-`;
}

/**
 * Derive (row, number, label) from a layout seat id of the form
 * `<sectionId>-<row>-<number>`. Ids without a row/number, or whose trailing
 * segment is not an integer, keep the raw id as their label.
 *
 * The row is everything between the prefix and the LAST dash, so a row may
 * itself contain dashes. The number is `parseInt` of the trailing segment,
 * which is lossy: `"01"`, `"1a"` and `"1.5"` all read as `1`. That is why a
 * Seat's glyph id cannot be rebuilt as `<sectionId>-<row>-<number>` and has to
 * be found by replaying this function over the layout's ids
 * ({@link glyphIdsByLabel}).
 *
 * Malformed ids (non-integer trailing segment, e.g. `sec-A-x`) are NOT
 * rejected: the CSV parser guarantees the `section-row-seat` shape but not a
 * numeric seat, and the pre-batching loop created such seats too. They land
 * with `number: null`, which `pickContiguousCluster` skips — so they are
 * never auto-picked, only sellable by explicit seat selection. The result
 * type has no slot for a malformed count, so this is documented, not
 * reported; layout validation is the place to reject them.
 */
export function parseLayoutSeatId(
  seatId: string,
  prefix: string,
): ParsedLayoutSeatId {
  const afterPrefix = seatId.slice(prefix.length); // e.g. "A-1"
  const dashIdx = afterPrefix.lastIndexOf("-");
  const row = dashIdx >= 0 ? afterPrefix.slice(0, dashIdx) : null;
  const parsedNumber =
    dashIdx >= 0 ? parseInt(afterPrefix.slice(dashIdx + 1), 10) : Number.NaN;
  const number = Number.isInteger(parsedNumber) ? parsedNumber : null;
  const label = row && number != null ? `${row}${number}` : seatId;
  return { label, row, number };
}

/**
 * For one layout section, the glyph id each materialised Seat `label` came
 * from: the exact replay of `materializeSections` (same prefix filter, same
 * parse, same last-wins on a repeated label). A Seat whose label is absent
 * has no glyph in this layout (a manually created seat, or a layout edited
 * since the seats were made).
 *
 * The prefix filter is the materialiser's, so it shares its one ambiguity:
 * with sections `A` and `A-B`, the glyph `A-B-C-1` also lands in section `A`
 * (row `B-C`). Look a glyph up in the map of the section whose
 * `layoutSectionId` equals the glyph's own `sectionId`, never across sections.
 */
export function glyphIdsByLabel(
  layoutSectionId: string,
  layoutSeatIds: readonly string[],
): Map<string, string> {
  const prefix = layoutSeatIdPrefix(layoutSectionId);
  const byLabel = new Map<string, string>();
  for (const seatId of layoutSeatIds) {
    if (!seatId.startsWith(prefix)) continue;
    byLabel.set(parseLayoutSeatId(seatId, prefix).label, seatId);
  }
  return byLabel;
}
