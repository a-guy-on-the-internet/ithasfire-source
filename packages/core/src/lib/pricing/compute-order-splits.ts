import { z } from "zod";

import {
  payoutTermsLineRoundingSchema,
  payoutTermsLineSchema,
} from "./compute-ticket-price-for-agreement";
import { distributeRemainder, lineCapCents } from "./distribute-remainder";

const orderSplitLineSchema = payoutTermsLineSchema.pick({
  id: true,
  payeeId: true,
  percent: true,
  capPercent: true,
  priority: true,
  rounding: true,
  // ── P4b (deal terms) ── FR-005: refuse any line that is not a PERCENT
  // clause on the GROSS basis (see `payoutTermsLineSchema`).
  amountType: true,
  basis: true,
});

const computeOrderSplitsInputSchema = z.object({
  amountCents: z.number().int(),
  lines: z.array(orderSplitLineSchema).min(1),
});

export type ComputeOrderSplitsInput = z.infer<
  typeof computeOrderSplitsInputSchema
>;

export type OrderSplitResult = {
  payeeId: string;
  amountCents: number;
};

export type ComputeOrderSplitsOutput = {
  splits: OrderSplitResult[];
  totalCents: number;
  /**
   * `amountCents - totalCents` when the caps prevented full allocation — i.e.
   * money the order took that no payee is credited for. Non-zero only for an
   * all-capped line set whose caps fall short of 100% (refused by
   * `SPLITS_CAPS_UNSATISFIABLE` at publish and at every terms editor, so only
   * pre-gate terms can produce it).
   *
   * Callers that PERSIST these splits must report a non-zero value, not just
   * log it: the short rows are written, credited and then checked against
   * themselves by `verifyLedgerInvariants`, so nothing downstream can notice.
   */
  unallocatedCents: number;
};

const sortLines = (lines: ComputeOrderSplitsInput["lines"]) =>
  [...lines].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.payeeId.localeCompare(b.payeeId),
  );

// NOTE: `floorCents` is deliberately NOT honoured here, and is not even
// picked into this function's input.
//
// This function is a DISTRIBUTION, not an obligation ledger: `computeOrderSplits`
// normalises allocations so they sum to exactly the order basis
// (see `distributeRemainder`). A floor is a fixed amount, so raising a line to
// its floor pushes the total over the basis and the remainder pass then erodes
// it back down — the floor was never actually honoured. Measured: a $600 floor
// on a 50/50 split of a $1000 order paid $550, and the payee with NO floor was
// docked to part-fund the one that had it.
//
// Per-order flooring is also the wrong shape for the thing people want it for:
// a guarantee is an EVENT-level minimum, and applying it per order over-allocates
// catastrophically across many small orders.
//
// Product decision (2026-08): the platform RECORDS deals, it does not execute
// them. Deal minimums are recorded terms, settled off-platform by the venue.
// Do not reintroduce a fixed amount into this function — a fixed obligation
// cannot survive a sum-to-basis contract. It needs an event-level settlement
// phase, which is deliberately not built.
const applyLineRounding = (
  basisTotal: number,
  line: ComputeOrderSplitsInput["lines"][number],
) => {
  const base = (basisTotal * line.percent) / 100;
  const roundingMode =
    line.rounding ?? payoutTermsLineRoundingSchema.enum.FLOOR;
  const amount =
    roundingMode === "NEAREST" ? Math.round(base) : Math.floor(base);

  // The cap clamps the line here AND withholds remainder from it in
  // `distributeRemainder` — both off the same `lineCapCents` ceiling. Clamping
  // alone is what let a 5%-capped line be paid 12.5% of the basis: the clamp
  // enlarged the remainder and the remainder pass gave it straight back.
  const cap = lineCapCents(basisTotal, line.capPercent);

  return cap === null ? amount : Math.min(amount, cap);
};

const clampNonNegative = (value: number) => (value < 0 ? 0 : value);

export const computeOrderSplits = (
  rawInput: ComputeOrderSplitsInput,
): ComputeOrderSplitsOutput => {
  const input = computeOrderSplitsInputSchema.parse(rawInput);
  const basis = Math.max(input.amountCents, 0);
  const sortedLines = sortLines(input.lines);
  const initialAllocations = sortedLines.map((line) =>
    applyLineRounding(basis, line),
  );

  const allocated = initialAllocations.reduce((sum, value) => sum + value, 0);
  const remainder = basis - allocated;
  const { amounts: finalAllocations, unallocatedCents } = distributeRemainder(
    [...initialAllocations],
    remainder,
    sortedLines.map((line) => lineCapCents(basis, line.capPercent)),
  );

  const splits = sortedLines.map((line, index) => ({
    payeeId: line.payeeId,
    amountCents: clampNonNegative(finalAllocations[index] ?? 0),
  }));

  const totalCents = splits.reduce((sum, split) => sum + split.amountCents, 0);

  return {
    splits,
    totalCents,
    unallocatedCents,
  };
};
