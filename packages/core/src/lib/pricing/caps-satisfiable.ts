/**
 * Can a set of payout-terms lines distribute a WHOLE basis?
 *
 * The one predicate behind `SPLITS_CAPS_UNSATISFIABLE`, shared by every use
 * case that stores or activates terms (`publishEvent`, `updateEventSplits`,
 * `upsertAgreementLine`) so they cannot disagree about which deals are legal.
 *
 * ── What actually makes a set unsatisfiable ───────────────────────────────
 * The remainder pass (`distributeRemainder`) skips a line only when it has a
 * cap AND is already sitting on it. A line with `capPercent === null` is
 * therefore NEVER skipped, so one uncapped line is enough to absorb every
 * withheld cent and `Σ splits === basis` holds exactly. Residue requires
 * EVERY line to be capped.
 *
 * The first cut of this gate (2026-09-10, be6e0814) got that wrong: it
 * summed `min(percent, capPercent ?? percent)` over all lines and refused
 * anything short of the target. That refuses the canonical "venue takes 20%,
 * capped at 5%, organiser takes the other 80%" deal — 5 + 80 = 85 — which the
 * same commit's own math distributes correctly to 500 / 9 500 on a 10 000c
 * basis. Publishing was broken for a shape that works.
 *
 * ── Why the comparison is Σ capPercent, not Σ min(percent, cap) ───────────
 * Once every line is capped the caps are the only ceilings that matter: a
 * line can be filled UP TO its cap by the remainder pass regardless of its
 * own percentage. `min(percent, cap)` would refuse an all-capped set that is
 * genuinely fine (20% cap 60 + 80% cap 60 reaches 100) and — with the ±1
 * tolerance the first cut inherited from Gate 1 — ADMIT one that is not:
 * 50% cap 50 + 50% cap 49 sums to 99, passed `100 - 99 > 1` as false, and
 * then silently dropped 100c out of every 10 000c order. No tolerance here.
 * Caps are compared exactly; the ±1 exists for integer `percent` storage and
 * has no business in a pure cap comparison.
 *
 * ── Known edge: an all-capped set landing EXACTLY on the target ───────────
 * `lineCapCents` floors each ceiling, so `Σ floor(basis × cap_i / 100)` can
 * come in under the basis by up to (lines − 1) cents when the caps sum to
 * exactly 100 and the basis does not divide evenly: 50%+50% on a 1 001c basis
 * gives ceilings of 500 + 500 and strands 1c. That is admitted deliberately —
 * the cent genuinely cannot be paid without breaching a cap, and refusing
 * "50/50, both capped at 50" outright would reject terms that are exact on
 * every even basis. It is not silent: `distributeRemainder` returns it and the
 * settlement callers report it. Terms that want no residue at all should leave
 * slack in the caps (or leave one line uncapped).
 */

/** The share of the seller's post-fee net that terms must divide. */
export const SPLITS_TARGET_PCT = 100;

export type CapSatisfiabilityLine = {
  id?: string | null;
  /** Whole percent (0–100), as stored on `PayoutTermsLine.percent`. */
  percent: number;
  /** Whole percent (0–100), `null`/`undefined` = uncapped. */
  capPercent?: number | null;
};

export type CapSatisfiabilityReport = {
  /** False ⇒ every order under these terms leaves cents unallocated. */
  satisfiable: boolean;
  /** The only shape that can be unsatisfiable. */
  everyLineCapped: boolean;
  /** Σ capPercent over the lines examined (0 when any line is uncapped). */
  totalCapPct: number;
  /** Σ percent over the lines examined — for the error payload. */
  totalPercent: number;
  /** Lines whose cap binds below their own share, for the error payload. */
  cappedLineIds: string[];
};

const isCapped = (line: CapSatisfiabilityLine): boolean =>
  line.capPercent !== null && line.capPercent !== undefined;

/**
 * Assess `lines` against `targetPct`. Pure; callers decide whether to throw.
 *
 * An empty set is satisfiable — "no lines" is a different failure with its
 * own gate, and reporting it here would give the organizer the wrong error.
 */
export const assessCapSatisfiability = (
  lines: readonly CapSatisfiabilityLine[],
  targetPct: number = SPLITS_TARGET_PCT,
): CapSatisfiabilityReport => {
  const everyLineCapped = lines.length > 0 && lines.every(isCapped);
  const totalCapPct = everyLineCapped
    ? lines.reduce((sum, line) => sum + (line.capPercent ?? 0), 0)
    : 0;
  const totalPercent = lines.reduce((sum, line) => sum + line.percent, 0);

  return {
    satisfiable: !everyLineCapped || totalCapPct >= targetPct,
    everyLineCapped,
    totalCapPct,
    totalPercent,
    cappedLineIds: lines
      .filter((line) => isCapped(line) && (line.capPercent ?? 0) < line.percent)
      .map((line) => line.id)
      .filter((id): id is string => typeof id === "string"),
  };
};

/**
 * Does this line set already divide the whole target, i.e. is it a COMPLETE
 * set rather than a half-composed draft?
 *
 * The terms EDITORS (`updateEventSplits`, `upsertAgreementLine`) accept
 * partial sets on purpose — you build a deal a line at a time, and `<100%` is
 * refused at publish, not at every keystroke. Running the cap gate on a
 * partial set would refuse the first line of every capped deal ever composed.
 * So the editors gate on `isCompleteAllocation(...) && !satisfiable`: the set
 * claims to divide the whole basis and demonstrably cannot.
 *
 * Same ±1 tolerance as `publishEvent`'s Gate 1, and for the same reason —
 * `percent` is stored as an integer, so a three-way split reconciles to 99 or
 * 101. The tolerance belongs HERE, on integer percentages; it does not belong
 * in the cap comparison.
 */
export const isCompleteAllocation = (
  lines: readonly CapSatisfiabilityLine[],
  targetPct: number = SPLITS_TARGET_PCT,
): boolean => {
  if (lines.length === 0) return false;
  const totalPercent = lines.reduce((sum, line) => sum + line.percent, 0);
  return Math.abs(totalPercent - targetPct) <= 1;
};
