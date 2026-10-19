/**
 * Splits `totalCents` across `items` in proportion to each item's weight,
 * using largest-remainder rounding: every share is floored, then the leftover
 * cents go to the largest fractional remainders (ties broken by id, so the
 * result is deterministic and independent of input order).
 *
 * The defining property is EXACTNESS — `Σ allocations === totalCents` — which
 * plain per-item rounding does not give you. Callers rely on it so that
 * refunding every item returns every cent.
 *
 * Moved here from `refund-full-order.ts` (verbatim) so the refund-tax
 * attribution in `refund-tax-share.ts` shares ONE rounding rule with the money
 * math instead of re-deriving it.
 */
export function allocateProportionalCents<T extends { id: string }>(
  items: T[],
  totalCents: number,
  getWeight: (item: T) => number,
): Map<string, number> {
  const allocations = new Map<string, number>();

  if (items.length === 0 || totalCents <= 0) {
    return allocations;
  }

  const weightedItems = items.map((item) => ({
    item,
    weight: Math.max(0, getWeight(item)),
  }));
  const totalWeight = weightedItems.reduce(
    (sum, entry) => sum + entry.weight,
    0,
  );

  if (totalWeight <= 0) {
    allocations.set(weightedItems[0]!.item.id, totalCents);
    return allocations;
  }

  let assignedCents = 0;
  const remainders = weightedItems.map(({ item, weight }) => {
    const exactShare = (weight * totalCents) / totalWeight;
    const baseShare = Math.floor(exactShare);
    allocations.set(item.id, baseShare);
    assignedCents += baseShare;

    return { id: item.id, remainder: exactShare - baseShare };
  });

  let remainderCents = totalCents - assignedCents;
  remainders.sort(
    (left, right) =>
      right.remainder - left.remainder || left.id.localeCompare(right.id),
  );

  for (let index = 0; remainderCents > 0; index += 1) {
    const target = remainders[index % remainders.length];
    if (!target) break;

    allocations.set(target.id, (allocations.get(target.id) ?? 0) + 1);
    remainderCents -= 1;
  }

  return allocations;
}
