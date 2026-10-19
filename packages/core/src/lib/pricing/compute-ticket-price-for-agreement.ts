import { z } from "zod";

import { distributeRemainder, lineCapCents } from "./distribute-remainder";

/**
 * Both values stay in the type: `ABSORB` still describes PAST orders (their
 * `feePolicySnapshot.feeMode` and item `meta.effectiveFeeMode`), which the
 * buyer charge breakdown, refunds, net-kept and dispute evidence read. No new
 * sale is priced in it — see {@link SALE_FEE_MODE}.
 */
export const feeModeSchema = z.enum(["ABSORB", "PASS_THROUGH"]);
export type FeeMode = z.infer<typeof feeModeSchema>;
export const FeeMode = feeModeSchema.enum;

/**
 * The fee mode EVERY new sale is priced under: fees on top of the ticket
 * price. ABSORB was removed (owner ruling 2026-10-01,
 * docs/decisions/absorb-removed.md).
 *
 * THE guarantee lives here. The stored modes (`PayoutTerms.feeMode`,
 * `FeePolicy.feeMode`) were converted by migration `20261001230001`/`…02`,
 * but pricing does not trust that: every pricing-time reader — this kernel,
 * `computeOrderAmounts` and the fee-policy snapshot it records
 * (checkout-helpers), `estimateBuyerTicketPricingForEvent` (event page, card
 * badges, search index, checkout fee rates, tax estimate), `getEventFeePreview`
 * and `createResaleCheckout` — takes its mode from this constant, never from
 * a terms or policy row. A stray ABSORB row therefore prices PASS_THROUGH.
 *
 * Do not reintroduce `terms.feeMode ?? policy.feeMode` on a pricing path.
 * Reading a PAST order's mode is different: use the order's own snapshot
 * (`computeBuyerChargeBreakdown`).
 */
export const SALE_FEE_MODE = FeeMode.PASS_THROUGH;

/**
 * What EVERY new sale credits the organiser: the full ticket price the buyer
 * paid (`amountGrossCents`). The platform fee is taken once, from the buyer on
 * top (owner ruling 2026-10-11,
 * docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml).
 *
 * `buildFeePolicySnapshot` stamps it on the order as
 * `feePolicySnapshot.organiserCredit`; `computeAgreementBasis` reads it back.
 * An order WITHOUT the marker was sold before the ruling and was credited the
 * price minus the platform fee: it keeps that amount. Never re-derive a past
 * order's basis from this constant; read the order's own snapshot.
 */
export const SALE_ORGANISER_CREDIT = "FULL_PRICE" as const;
export type OrganiserCredit = typeof SALE_ORGANISER_CREDIT;

export const payoutTermsLineRoundingSchema = z.enum(["FLOOR", "NEAREST"]);
export type PayoutTermsLineRounding = z.infer<
  typeof payoutTermsLineRoundingSchema
>;

export const payoutTermsLineSchema = z.object({
  id: z.string(),
  payeeId: z.string(),
  percent: z.number().min(0),
  floorCents: z.number().int().nonnegative().optional(),
  capPercent: z.number().min(0).max(100).nullable().optional(),
  priority: z.number().int().optional(),
  rounding: payoutTermsLineRoundingSchema.optional(),
  // ── P4b (deal terms) ── FR-005, the second fence: per order the platform
  // pays only a PERCENT clause on the GROSS basis. The adapter's `listLines`
  // already returns nothing else; if a FIXED / NET_POOL / FIXED_AND_PERCENT
  // clause ever reached a split calculator anyway, parsing FAILS here rather
  // than paying a guarantee's percent (or 0) on every order. Absent = a
  // pre-P4b caller or fake, which can only mean a PERCENT/GROSS line.
  amountType: z.literal("PERCENT").optional(),
  basis: z.literal("GROSS").optional(),
});

export const payoutTermsPolicySchema = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  /** The row's stored mode. Accepted, never read for pricing (SALE_FEE_MODE). */
  feeMode: feeModeSchema,
  processsorFeePct: z.number().min(0),
  processorFixedCents: z.number().int().nonnegative(),
  payoutPct: z.number().min(0),
  payoutFixedCents: z.number().int().nonnegative(),
  monthlyPayoutCents: z.number().int().nonnegative(),
  buyerFeePct: z.number().min(0),
  maxFeeCents: z.number().int().nonnegative().nullable(),
  minFeeCents: z.number().int().nonnegative().default(0),
  platformFixedCents: z.number().int().nonnegative().default(0),
});

export const payoutTermsSchema = z.object({
  id: z.string(),
  /** The terms' stored mode. Accepted, never read for pricing (SALE_FEE_MODE). */
  feeMode: feeModeSchema.nullish(),
  lines: z.array(payoutTermsLineSchema).min(1),
  policy: payoutTermsPolicySchema,
});

export const computeTicketPriceInputSchema = z.object({
  qty: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  agreement: payoutTermsSchema,
});
export type ComputeTicketPriceInput = z.infer<
  typeof computeTicketPriceInputSchema
>;

const splitSchema = z.object({
  payeeId: z.string(),
  amountCents: z.number().int(),
});

export const computeTicketPriceOutputSchema = z.object({
  qty: z.number().int().nonnegative(),
  unitPriceCents: z.number().int().nonnegative(),
  platformFeePerTicketCents: z.number().int().nonnegative(),
  buyerUnitTotalCents: z.number().int().nonnegative(),
  buyerTotalCents: z.number().int().nonnegative(),
  splits: z.array(splitSchema),
  splitsTotalCents: z.number().int().nonnegative(),
  /**
   * `buyerTotalCents - splitsTotalCents` when caps prevented full allocation.
   * Surfaced rather than swallowed so a quote that cannot distribute what it
   * charges is visible to its caller — see `distributeRemainder`.
   */
  unallocatedCents: z.number().int(),
  effectiveFeeMode: feeModeSchema,
});
export type ComputeTicketPriceOutput = z.infer<
  typeof computeTicketPriceOutputSchema
>;

const sortAgreementLines = (
  lines: ComputeTicketPriceInput["agreement"]["lines"],
) =>
  [...lines].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.payeeId.localeCompare(b.payeeId),
  );

const applyLineRounding = (
  basisTotal: number,
  line: z.infer<typeof payoutTermsLineSchema>,
) => {
  const base = (basisTotal * line.percent) / 100;
  const roundingMode = line.rounding ?? "FLOOR";
  const amount =
    roundingMode === "NEAREST" ? Math.round(base) : Math.floor(base);

  // `floorCents` is deliberately NOT applied — this preview must agree with
  // the split math in `compute-order-splits.ts`. Floors were removed there
  // (2026-08: the platform records deals, it does not execute them; a
  // per-order floor cannot survive a sum-to-basis distribution). Keeping a
  // floor here would make this function's `splits` output promise a number
  // settlement never pays.
  //
  // The cap, by contrast, IS honoured end to end: clamped here and withheld
  // from the remainder pass, off the same `lineCapCents` ceiling settlement
  // uses. The remainder pass itself is now shared code rather than a copy —
  // when it was a copy, this preview quoted a 5%-capped line at 12.5% of the
  // basis and settlement then paid exactly that, so the two "agreed" on the
  // wrong number.
  const cap = lineCapCents(basisTotal, line.capPercent);

  return cap === null ? amount : Math.min(amount, cap);
};

const clampNonNegative = (value: number) => (value < 0 ? 0 : value);

/**
 * The per-ticket platform fee, and the ONLY implementation of it.
 *
 *   fee = 0                                                  when face is $0
 *   fee = max( min(round(face × buyerFeePct), maxFeeCents) + platformFixedCents,
 *              minFeeCents )                                 otherwise
 *
 * A $0 TICKET CARRIES NO FEE. Owner ruling, 2026-10-10: "If $0 is the cost of
 * the tickets there shouldn't be any fee." Without the first line a $0 face
 * evaluates to `max(platformFixedCents, minFeeCents)`: the fixed part and the
 * floor were charged on a free ticket type, on a seat whose price override is
 * $0 and on a pay-what-you-want line set to $0 whenever the rest of the cart
 * was paid (an all-free order was already zeroed downstream), while every
 * estimate quoted that ticket as free. The rule lives HERE, in the one
 * implementation, so the charge (`computeOrderAmounts`: online, the embed, the
 * door), the estimates and the previews cannot disagree about it. With no
 * platform fee the ticket adds nothing to the processing-fee base or to a
 * buyer-total tax base either. Paid tickets are untouched: a 1¢ ticket still
 * pays the fixed part and the floor.
 *
 * `maxFeeCents: null` means NO per-ticket cap (not "cap of zero") — the
 * `?? POSITIVE_INFINITY` below is the definition of that, and the reason
 * `packages/adapters/src/db/prisma/fee-policies.ts` must persist `null` as
 * `null` rather than coercing it to 0.
 *
 * Exported so nothing re-derives it. E2E specs previously hand-copied the
 * formula AND the rates into five separate files; two of them had silently gone
 * stale against the seeded policy and still passed. If you need the expected
 * fee anywhere outside this module, call this — do not retype the arithmetic.
 */
export const computePlatformFeePerTicketCents = (
  unitPriceCents: number,
  policy: Pick<
    z.infer<typeof payoutTermsPolicySchema>,
    "buyerFeePct" | "maxFeeCents" | "minFeeCents" | "platformFixedCents"
  >,
): number => {
  // A $0 ticket carries no fee (owner ruling 2026-10-10, see above). Before
  // the fixed part and the floor, which are what a $0 face used to pay.
  if (unitPriceCents <= 0) {
    return 0;
  }
  const pctFee = Math.round(unitPriceCents * policy.buyerFeePct);
  const cappedPctFee = Math.min(
    policy.maxFeeCents ?? Number.POSITIVE_INFINITY,
    pctFee,
  );
  return Math.max(cappedPctFee + policy.platformFixedCents, policy.minFeeCents);
};

/**
 * The checkout-side quote: buyer totals, the platform fee, and a PREVIEW of
 * the split.
 *
 * ── How far the "preview agrees with settlement" claim goes ───────────────
 * It shares `applyLineRounding` and `distributeRemainder` with
 * `computeOrderSplits`, so the two cannot drift GIVEN THE SAME BASIS. They are
 * not given the same basis. This function distributes `buyerTotalCents`,
 * which includes the buyer-paid platform fee; settlement distributes
 * `computeAgreementBasis(order)`: the order's ticket money
 * (`amountGrossCents`, which never held tax or buyer fees) on a sale marked
 * `organiserCredit: "FULL_PRICE"`, and that minus the platform fee on an
 * order sold before the 2026-10-11 ruling. On a $100 ticket with a $5 fee a
 * 5%-capped line is quoted `floor(0.05 × 10 500) = 525c` here and paid
 * `floor(0.05 × 10 000) = 500c` at settlement (475c on a pre-ruling order).
 *
 * That divergence is PRE-EXISTING and hits uncapped percentages identically —
 * it is the difference between the two bases, not a cap bug — so it is
 * deliberately not "fixed" here; changing either basis moves real settlement
 * money. Do not read the parity test in this module's suite as evidence
 * against it either: it feeds `preview.buyerTotalCents` back in as
 * settlement's basis, so it is tautological on exactly this axis and only
 * proves the shared math agrees.
 */
export const computeTicketPriceForAgreement = (
  rawInput: ComputeTicketPriceInput,
): ComputeTicketPriceOutput => {
  const input = computeTicketPriceInputSchema.parse(rawInput);
  const { qty, unitPriceCents, agreement } = input;
  const { policy } = agreement;

  // Never the agreement's or the policy's stored mode: see SALE_FEE_MODE.
  const effectiveFeeMode: FeeMode = SALE_FEE_MODE;

  // Single-sourced above: cap the percentage, add the fixed component, then
  // enforce the minimum-fee floor.
  const platformFeePerTicketCents = computePlatformFeePerTicketCents(
    unitPriceCents,
    policy,
  );

  // NOTE: Processor fees (percentage + flat) are computed at the ORDER level
  // in `computeOrderAmounts` using an algebraic solve so that the fee shown
  // to the buyer exactly matches what Stripe will deduct.  Per-ticket prices
  // include only the face value + platform fee.

  const buyerUnitTotalCents =
    effectiveFeeMode === FeeMode.PASS_THROUGH
      ? unitPriceCents + platformFeePerTicketCents
      : unitPriceCents;

  const buyerTotalCents = buyerUnitTotalCents * qty;

  const distributionTotalCents = clampNonNegative(buyerTotalCents);

  const sortedLines = sortAgreementLines(agreement.lines);
  const initialAmounts = sortedLines.map((line) =>
    applyLineRounding(distributionTotalCents, line),
  );

  const allocated = initialAmounts.reduce((sum, value) => sum + value, 0);
  const remainder = distributionTotalCents - allocated;
  const { amounts: finalAmounts, unallocatedCents } = distributeRemainder(
    [...initialAmounts],
    remainder,
    sortedLines.map((line) =>
      lineCapCents(distributionTotalCents, line.capPercent),
    ),
  );

  const splits = sortedLines.map((line, index) => ({
    payeeId: line.payeeId,
    amountCents: clampNonNegative(finalAmounts[index] ?? 0),
  }));

  const splitsTotalCents = splits.reduce(
    (sum, split) => sum + split.amountCents,
    0,
  );

  return computeTicketPriceOutputSchema.parse({
    qty,
    unitPriceCents,
    platformFeePerTicketCents,
    buyerUnitTotalCents,
    buyerTotalCents,
    splits,
    splitsTotalCents,
    unallocatedCents,
    effectiveFeeMode,
  });
};
