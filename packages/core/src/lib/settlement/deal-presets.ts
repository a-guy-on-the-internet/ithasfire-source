/**
 * Deal presets (deal-terms-and-settlement FR-003a): Guarantee · Door split ·
 * Guarantee + % · Versus · Straight % · Room rental. Pure builders: each
 * writes the clauses and deductions for one preset in one step, and the
 * result is validated exactly as the calculator validates terms, so a preset
 * can never produce a deal the calculator refuses.
 *
 * Each preset builds ONE act's clause (plus, for a room rental, the rental).
 * More acts (a support act's 10%) are added clause by clause in the editor —
 * pass them as `extraClauses`.
 */
import { parseInput } from "../io";
import {
  assertDealTermsShape,
  dealTermsSchema,
  type DealBasisKind,
  type DealClause,
  type DealDeduction,
  type DealTerms,
} from "./deal-terms";

export const DEAL_PRESETS = [
  "GUARANTEE",
  "DOOR_SPLIT",
  "GUARANTEE_PLUS_PERCENT",
  "VERSUS",
  "STRAIGHT_PERCENT",
  "ROOM_RENTAL",
] as const;
export type DealPreset = (typeof DEAL_PRESETS)[number];

type PresetCommon = {
  /** Who the leftover falls to (and who owes any shortfall). */
  remainderPayeeId: string;
  /** Costs off the top, in waterfall order. */
  deductions?: DealDeduction[];
  /** Other clauses (support acts) appended after the preset's own. */
  extraClauses?: DealClause[];
  /** Id for the preset's own clause. Default: `"<payeeId>:<preset>"`. */
  clauseId?: string;
  displayLabel?: string | null;
};

type ActPreset = PresetCommon & { payeeId: string };

const finish = (clause: DealClause, common: PresetCommon): DealTerms => {
  const terms = parseInput(dealTermsSchema, {
    clauses: [clause, ...(common.extraClauses ?? [])],
    deductions: common.deductions ?? [],
    remainderPayeeId: common.remainderPayeeId,
  });
  assertDealTermsShape(terms);
  return terms;
};

const clauseIdFor = (args: ActPreset, preset: DealPreset) =>
  args.clauseId ?? `${args.payeeId}:${preset.toLowerCase()}`;

/** A fixed amount, owed however many tickets sell. Settled directly. */
export function buildGuaranteeDeal(
  args: ActPreset & { guaranteeCents: number },
): DealTerms {
  return finish(
    {
      id: clauseIdFor(args, "GUARANTEE"),
      payeeId: args.payeeId,
      amountType: "FIXED",
      amountCents: args.guaranteeCents,
      percent: null,
      basis: "GROSS",
      resolution: null,
      displayLabel: args.displayLabel ?? null,
    },
    args,
  );
}

/** A percentage of the pool, after the costs off the top. Settled directly. */
export function buildDoorSplitDeal(
  args: ActPreset & { percent: number },
): DealTerms {
  return finish(
    {
      id: clauseIdFor(args, "DOOR_SPLIT"),
      payeeId: args.payeeId,
      amountType: "PERCENT",
      amountCents: null,
      percent: args.percent,
      basis: "NET_POOL",
      resolution: null,
      displayLabel: args.displayLabel ?? null,
    },
    args,
  );
}

/**
 * Guarantee PLUS a percentage, added together. Defaults to "dollar one" —
 * the percent of the gross, from the first dollar; pass `basis: "NET_POOL"`
 * for a percentage after costs.
 */
export function buildGuaranteePlusPercentDeal(
  args: ActPreset & {
    guaranteeCents: number;
    percent: number;
    basis?: DealBasisKind;
  },
): DealTerms {
  return finish(
    {
      id: clauseIdFor(args, "GUARANTEE_PLUS_PERCENT"),
      payeeId: args.payeeId,
      amountType: "FIXED_AND_PERCENT",
      amountCents: args.guaranteeCents,
      percent: args.percent,
      basis: args.basis ?? "GROSS",
      resolution: "SUM",
      displayLabel: args.displayLabel ?? null,
    },
    args,
  );
}

/**
 * Versus: the guarantee or the percentage, whichever is greater. Defaults to
 * a percentage of the pool (CONTEXT.md "Versus"; 08-07 worked example).
 */
export function buildVersusDeal(
  args: ActPreset & {
    guaranteeCents: number;
    percent: number;
    basis?: DealBasisKind;
  },
): DealTerms {
  return finish(
    {
      id: clauseIdFor(args, "VERSUS"),
      payeeId: args.payeeId,
      amountType: "FIXED_AND_PERCENT",
      amountCents: args.guaranteeCents,
      percent: args.percent,
      basis: args.basis ?? "NET_POOL",
      resolution: "GREATER_OF",
      displayLabel: args.displayLabel ?? null,
    },
    args,
  );
}

/**
 * A straight percentage of the gross — today's shape, the only one the
 * platform pays per order in stage 1.
 */
export function buildStraightPercentDeal(
  args: ActPreset & { percent: number },
): DealTerms {
  return finish(
    {
      id: clauseIdFor(args, "STRAIGHT_PERCENT"),
      payeeId: args.payeeId,
      amountType: "PERCENT",
      amountCents: null,
      percent: args.percent,
      basis: "GROSS",
      resolution: null,
      displayLabel: args.displayLabel ?? null,
    },
    args,
  );
}

/**
 * Room rental: the venue is paid the rental, the renter keeps the door (the
 * renter is the remainder payee).
 *  - FIXED_FEE (four-wall): a FIXED clause to the venue. Owed whatever the
 *    door does — if the door can't cover it, the renter owes the shortfall.
 *  - RECOUPED_FROM_DOOR: a RENTAL deduction credited to the venue, recouped
 *    only from money that exists; what the door can't cover is the venue's
 *    loss ("Not recovered").
 * The two differ exactly on a thin night, which is why neither is a default.
 */
export function buildRoomRentalDeal(args: {
  venuePayeeId: string;
  renterPayeeId: string;
  rentalCents: number;
  mode: "FIXED_FEE" | "RECOUPED_FROM_DOOR";
  /** Id for the rental clause or deduction. Default: `"<venuePayeeId>:room_rental"`. */
  rentalId?: string;
  rentalLabel?: string;
  deductions?: DealDeduction[];
  extraClauses?: DealClause[];
}): DealTerms {
  const id = args.rentalId ?? `${args.venuePayeeId}:room_rental`;
  const common: PresetCommon = {
    remainderPayeeId: args.renterPayeeId,
    deductions: args.deductions,
    extraClauses: args.extraClauses,
  };
  if (args.mode === "FIXED_FEE") {
    return finish(
      {
        id,
        payeeId: args.venuePayeeId,
        amountType: "FIXED",
        amountCents: args.rentalCents,
        percent: null,
        basis: "GROSS",
        resolution: null,
        displayLabel: args.rentalLabel ?? null,
      },
      common,
    );
  }
  const terms = parseInput(dealTermsSchema, {
    clauses: args.extraClauses ?? [],
    deductions: [
      {
        id,
        kind: "RENTAL",
        label: args.rentalLabel ?? "Room rental",
        amountCents: args.rentalCents,
        percent: null,
        creditedPayeeId: args.venuePayeeId,
        estimated: false,
      },
      ...(args.deductions ?? []),
    ],
    remainderPayeeId: args.renterPayeeId,
  });
  assertDealTermsShape(terms);
  return terms;
}
