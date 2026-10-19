export interface PickableSeat {
  id: string;
  row: string | null;
  number: number | null;
}

export function pickContiguousCluster<T extends PickableSeat>(
  available: readonly T[],
  qty: number,
): T[] {
  if (qty <= 0) return [];
  if (available.length < qty) return [];

  const byRow = new Map<string, T[]>();
  for (const seat of available) {
    if (seat.row == null || seat.number == null) continue;
    const rowSeats = byRow.get(seat.row) ?? [];
    rowSeats.push(seat);
    byRow.set(seat.row, rowSeats);
  }

  const rowKeys = [...byRow.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

  for (const rowKey of rowKeys) {
    const rowSeats = byRow.get(rowKey)!;
    rowSeats.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

    let runStart = 0;
    for (let index = 1; index <= rowSeats.length; index += 1) {
      const previous = rowSeats[index - 1]!;
      const current = rowSeats[index];
      const isBreak =
        !current ||
        (previous.number != null &&
          current.number != null &&
          current.number !== previous.number + 1);

      if (isBreak) {
        const runLength = index - runStart;
        if (runLength >= qty) {
          const runCenter = (runStart + (index - 1)) / 2;
          const windowStart = Math.max(
            runStart,
            Math.min(index - qty, Math.round(runCenter - qty / 2)),
          );
          return rowSeats.slice(windowStart, windowStart + qty);
        }
        runStart = index;
      }
    }
  }

  const flat = [...available]
    .filter((seat) => seat.row != null && seat.number != null)
    .sort((a, b) => {
      const rowCompare = (a.row ?? "").localeCompare(b.row ?? "", undefined, {
        numeric: true,
      });
      if (rowCompare !== 0) return rowCompare;
      return (a.number ?? 0) - (b.number ?? 0);
    });

  if (flat.length >= qty) return flat.slice(0, qty);
  return [];
}
