/**
 * The remainder pass shared by the two split calculators — the settlement one
 * (`compute-order-splits.ts`) and the checkout-preview one
 * (`compute-ticket-price-for-agreement.ts`).
 *
 * It used to be a byte-identical copy in each file, with a comment in one of
 * them asking the other to please stay in agreement. It did not: both carried
 * the same cap bug (below) and both would have had to be fixed twice. It lives
 * here now so preview and settlement cannot drift GIVEN THE SAME BASIS.
 *
 * That qualifier is the whole claim — see the note on
 * `computeTicketPriceForAgreement`. Preview distributes `buyerTotalCents`;
 * settlement distributes `computeAgreementBasis` (the order's ticket money;
 * minus the platform fee only on an order sold before the 2026-10-11 ruling).
 * Sharing this module makes the two agree cent-for-cent on identical input; it
 * does NOT make the inputs identical.
 *
 * ── Why the caps have to be threaded through here ─────────────────────────
 * Percentage allocation is floored per line, so the allocated total lands
 * under the basis and the shortfall is handed back round-robin. A `capPercent`
 * clamp is just a bigger shortfall — and before 2026-09 this pass had no idea
 * which lines had been clamped, so it handed the capped line its cap back one
 * cent at a time. Measured on live math: "venue takes 20%, capped at 5%" on a
 * $100 net order paid the venue $12.50 against a $5.00 cap; a 1% cap on a
 * 50/50 split paid $25.50 against $1.00. `Σ splits === basis` held throughout,
 * so no drift sweep, reconciliation or ledger invariant ever fired.
 */

/**
 * The cent ceiling a line's `capPercent` imposes on `basisTotal`, or `null`
 * for an uncapped line.
 *
 * Single-sourced deliberately: the ceiling used to CLAMP a line and the
 * ceiling used to withhold remainder from it must be the same number to the
 * cent, or the remainder pass hands back the rounding difference.
 *
 * FLOORED, not rounded. A ceiling that rounds UP is a ceiling that can be
 * exceeded: `round(335 × 10% ) = 34` lets a "10% cap" line be paid 10.15% of
 * the basis. That was unreachable while the cap only ever clamped a line
 * computed from its own (also floored) percentage, but the remainder pass now
 * actively fills a capped line UP TO this number, so the rounding direction is
 * live money. A cap must err downwards.
 */
export const lineCapCents = (
  basisTotal: number,
  capPercent: number | null | undefined,
): number | null =>
  capPercent === undefined || capPercent === null
    ? null
    : Math.floor((basisTotal * capPercent) / 100);

export type DistributeRemainderResult = {
  /** The normalized allocations (the same array instance passed in). */
  amounts: number[];
  /**
   * The part of the remainder this pass could NOT place, signed the same way
   * as the input remainder: positive = basis left unallocated (every line sat
   * at its cap), negative = over-allocation it could not claw back (needs a
   * negative basis, so unreachable today).
   *
   * Returned rather than swallowed because the alternative is silence: split
   * rows short of the basis flow into `tx.splits.upsertForOrder`, then into
   * payee credits, and `verifyLedgerInvariants` compares credits to those same
   * short rows — so every downstream check agrees with itself and stays green
   * while the payees are under-paid. Callers must surface a non-zero value.
   */
  unallocatedCents: number;
};

/**
 * Normalize `amounts` so they sum to the basis, mutating the array in place.
 *
 * `caps[i]` is line `i`'s ceiling in cents (`null` = uncapped) and is honoured
 * on the ADD arm only. The subtract arm needs no cap awareness: taking a cent
 * off a line only moves it further under its ceiling.
 */
export const distributeRemainder = (
  amounts: number[],
  remainder: number,
  caps: ReadonlyArray<number | null>,
): DistributeRemainderResult => {
  if (remainder === 0) return { amounts, unallocatedCents: 0 };

  if (remainder > 0) {
    // Round-robin from index 0 on every pass. Callers hand us lines already
    // sorted by priority desc then payeeId, so the odd penny keeps landing on
    // the highest-priority line exactly as it did before caps existed — for an
    // all-uncapped set this emits the identical sequence of increments to the
    // single continuous `i = (i + 1) % len` loop it replaced.
    //
    // `progressed` is load-bearing, not defensive: once every line has reached
    // its cap there is nowhere left to put a cent, and a loop that only exits
    // on `remainder === 0` would spin forever inside a checkout request.
    let progressed = true;
    while (remainder > 0 && progressed) {
      progressed = false;
      for (let i = 0; i < amounts.length && remainder > 0; i += 1) {
        const cap = caps[i] ?? null;
        if (cap !== null && (amounts[i] ?? 0) >= cap) continue;
        amounts[i] = (amounts[i] ?? 0) + 1;
        remainder -= 1;
        progressed = true;
      }
    }

    // Residue (`remainder` still > 0 here): EVERY line is at its cap and the
    // basis cannot be fully allocated. Those cents are simply NOT allocated —
    // no split row, so no payee credit and no payout; they stay in the
    // platform's balance for that order. That is the only safe landing spot:
    // pushing them onto any line would break the cap this pass exists to
    // honour, and throwing would fail a payment that has already been taken.
    //
    // It takes every line being capped: a single uncapped line is never
    // skipped above, so the loop drains to zero and `Σ amounts === basis`
    // exactly. The all-capped shape is what `SPLITS_CAPS_UNSATISFIABLE`
    // refuses at publish (and at every terms-editing use case) — but terms
    // predating those gates can still be in force, so the behaviour is
    // defined rather than assumed away, and `unallocatedCents` is returned so
    // the callers can SAY it happened instead of quietly under-paying.
  } else {
    const allZero = () => amounts.every((value) => (value ?? 0) === 0);
    for (
      let i = amounts.length - 1;
      remainder < 0;
      i = (i - 1 + amounts.length) % amounts.length
    ) {
      const current = amounts[i] ?? 0;
      if (current === 0) {
        if (allZero()) break;
        continue;
      }
      amounts[i] = current - 1;
      remainder += 1;
    }
  }

  return { amounts, unallocatedCents: remainder };
};
