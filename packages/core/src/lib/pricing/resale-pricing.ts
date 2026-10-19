import { z } from "zod";

import { fail } from "@th/errors";
import type { EventRecord } from "@th/ports/repos/events";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";
import type { ResaleSharePayer } from "@th/types/repos/payout-terms";
import { RESALE_CLAIM_WINDOW_DAYS } from "../resale-claim-window";

/**
 * When a listing stops selling and when its seller's money releases. The
 * sale cutoff is the given one, else the event's start. The release is the
 * event's end plus the release days (the event's override, else the RESALE
 * terms'), floored at the claim window, not 0: a release before the window
 * closes pays the seller before the buyer can file a claim. Stored policies
 * below the window are left as written and clamped here (and again at credit
 * time, for listings snapshotted before this floor existed).
 */
export function computeResaleSchedule(input: {
  event: Pick<
    EventRecord,
    "startsAt" | "endsAt" | "resalePayoutReleaseDaysOverride"
  >;
  payoutTerms: Pick<PayoutTermsRecord, "resalePayoutReleaseDays">;
  saleCutoffAt?: Date | null;
}): { saleCutoffAt: Date; payoutReleaseAt: Date } {
  const saleCutoffAt = new Date(
    (input.saleCutoffAt ?? input.event.startsAt).getTime(),
  );
  const payoutReleaseDays = Math.max(
    input.event.resalePayoutReleaseDaysOverride ??
      input.payoutTerms.resalePayoutReleaseDays,
    RESALE_CLAIM_WINDOW_DAYS,
  );
  const payoutReleaseAt = addDays(
    input.event.endsAt ?? input.event.startsAt,
    payoutReleaseDays,
  );
  return { saleCutoffAt, payoutReleaseAt };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// ── The organiser's resale share (organiser-resale-share spec, FR-002/FR-005) ──
//
// Every resale pays a share to the people who put on the night, set by the
// resale clause the ticket recorded at its first sale (FR-003). It replaced
// the split of the markup above face (FR-014 removed it, with its columns).

/** The most any one resale may pay the event side: 10% of the ask (FR-002). */
export const RESALE_SHARE_MAX_BPS = 1000;

/**
 * The highest asking price a seller may list at, in cents ($500,000). The
 * buyer's charge is the basis (ask + share ≤ 1.1 × ask) plus processing and
 * tax, and it must fit one Stripe charge (at most $999,999.99): 1.1 × this
 * ask, plus processing at a few percent, plus tax well past any US rate,
 * stays under that. Far inside the `Int` columns the amounts are stored in.
 */
export const RESALE_LISTING_MAX_ASK_CENTS = 50_000_000;

/**
 * The largest amount this module prices, in cents: the `Int` column bound
 * (2^31 − 1). It bounds the ask AND the basis (ask + share with a BUYER
 * clause), so every amount `computeResaleShare` returns fits an `Int` column;
 * a BUYER ask whose basis would pass it is refused (`resale_total_too_large`).
 * The largest product computed is ask × bps with bps ≤ 1000, at most
 * ≈ 2.1e12, far inside `Number.MAX_SAFE_INTEGER` (≈ 9.0e15), so integer
 * arithmetic on JS numbers is exact for every ask accepted here.
 */
export const RESALE_SHARE_MAX_ASK_CENTS = 2_147_483_647;

const resaleSharePayerSchema = z.enum(["SELLER", "BUYER"]);

/**
 * The resale clause, as a writer accepts it and as pricing reads it from the
 * ticket's OrderItem record. Matches the DB CHECKs
 * (`PayoutTerms_resale_share_shape_check`, `OrderItem_resale_clause_shape_check`):
 * PERCENT carries bps 0..1000 and no cents; FLAT carries cents > 0 and no bps.
 * Writers parse with this so a bad clause is a typed INVALID_INPUT, never a
 * CHECK violation surfacing as a 500.
 */
export const resaleShareClauseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("PERCENT"),
      bps: z.number().int().min(0).max(RESALE_SHARE_MAX_BPS),
      cents: z.null().optional(),
      payer: resaleSharePayerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("FLAT"),
      cents: z.number().int().positive().max(RESALE_SHARE_MAX_ASK_CENTS),
      bps: z.null().optional(),
      payer: resaleSharePayerSchema,
    })
    .strict(),
]);

export type ResaleShareClause = z.infer<typeof resaleShareClauseSchema>;

/**
 * The clause a ticket's OrderItem recorded (FR-003), as pricing reads it.
 * Null when the item records no clause (`resaleClauseType` null). Throws
 * INTERNAL when the columns do not parse: the
 * `OrderItem_resale_clause_shape_check` CHECK makes that unreachable, and
 * pricing a sale off a guess would move real money.
 */
export function resaleClauseFromRecord(record: {
  id?: string;
  resaleClauseType?: "PERCENT" | "FLAT" | null;
  resaleClauseBps?: number | null;
  resaleClauseCents?: number | null;
  resaleClausePayer?: ResaleSharePayer | null;
}): ResaleShareClause | null {
  if (record.resaleClauseType == null) return null;
  const parsed = resaleShareClauseSchema.safeParse(
    record.resaleClauseType === "PERCENT"
      ? {
          type: "PERCENT",
          bps: record.resaleClauseBps,
          payer: record.resaleClausePayer,
        }
      : {
          type: "FLAT",
          cents: record.resaleClauseCents,
          payer: record.resaleClausePayer,
        },
  );
  if (!parsed.success) {
    throw fail("INTERNAL", {
      message: `resale_clause_record_invalid: order item ${record.id ?? "?"}`,
      meta: { orderItemId: record.id ?? null },
    });
  }
  return parsed.data;
}

export type ResaleShare = {
  /** The seller's asking price, as given. */
  askCents: number;
  /** What the event's RESALE payout lines split. */
  shareCents: number;
  /**
   * True when a FLAT amount was reduced to the 10% limit on this sale. The
   * seller form shows `shareCents` as the held amount and `heldFromCents` as
   * the clause's own amount. Always false for PERCENT (a percentage above
   * 10% is refused at write, never held).
   */
  shareHeld: boolean;
  /** The clause's FLAT amount before the limit when `shareHeld`, else null. */
  heldFromCents: number | null;
  /** SELLER: ask − share. BUYER: ask. */
  sellerReceivesCents: number;
  /**
   * What the buyer pays before processing and tax, and the agreement basis
   * finalize splits: SELLER: ask. BUYER: ask + share.
   * Invariant: sellerReceivesCents + shareCents === basisCents.
   */
  basisCents: number;
  payer: ResaleSharePayer;
};

function isValidAsk(askCents: unknown): askCents is number {
  return (
    typeof askCents === "number" &&
    Number.isInteger(askCents) &&
    askCents >= 0 &&
    askCents <= RESALE_SHARE_MAX_ASK_CENTS
  );
}

/** The 10% limit on one sale: floor(ask × 1000 / 10000). */
function shareLimitCents(askCents: number): number {
  return Math.floor((askCents * RESALE_SHARE_MAX_BPS) / 10_000);
}

/**
 * The share one resale pays the people who put on the night (FR-005):
 *   PERCENT: floor(ask × bps / 10000)            (bps ≤ 1000, so ≤ the limit)
 *   FLAT:    min(cents, floor(ask × 1000 / 10000)) (held to 10% of the ask)
 * SELLER payer: the buyer pays ask, the seller receives ask − share.
 * BUYER payer:  the buyer pays ask + share, the seller receives ask.
 *
 * Refuses: a missing clause (RESALE_TERMS_MISSING); a clause outside
 * `resaleShareClauseSchema`, an ask that is not an integer in
 * 0..RESALE_SHARE_MAX_ASK_CENTS, or a basis above RESALE_SHARE_MAX_ASK_CENTS
 * (INVALID_INPUT, `meta.reason` = `resale_total_too_large`, with
 * `highestFittingAskCents`). Throws INTERNAL if seller + share ever differs
 * from the basis: the to-the-cent invariant finalize also checks on the stored
 * snapshot (`resolveResaleSellerSplit`, which refuses a broken one with
 * RESALE_PURCHASE_PRICE_UNKNOWN). INTERNAL, not a user-facing code: a broken
 * invariant is our bug, so it must reach Sentry as a 5xx, never read to the
 * seller as their own mistake.
 */
export function computeResaleShare(input: {
  askCents: number;
  clause: ResaleShareClause | null | undefined;
}): ResaleShare {
  const { askCents, clause } = input;
  if (clause == null) {
    throw fail("RESALE_TERMS_MISSING", {
      meta: { reason: "resale_share_clause_missing" },
    });
  }
  if (!isValidAsk(askCents)) {
    throw fail("INVALID_INPUT", {
      meta: { reason: "resale_share_ask_invalid", askCents },
    });
  }
  const parsed = resaleShareClauseSchema.safeParse(clause);
  if (!parsed.success) {
    throw fail("INVALID_INPUT", {
      meta: {
        reason: "resale_share_clause_invalid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  const share = priceResaleShare(askCents, parsed.data);
  if (share.basisCents > RESALE_SHARE_MAX_ASK_CENTS) {
    throw fail("INVALID_INPUT", {
      meta: {
        reason: "resale_total_too_large",
        askCents,
        basisCents: share.basisCents,
        maxBasisCents: RESALE_SHARE_MAX_ASK_CENTS,
        highestFittingAskCents: searchHighestFittingAsk(
          parsed.data,
          RESALE_SHARE_MAX_ASK_CENTS,
        ),
      },
    });
  }
  return share;
}

/**
 * The two amounts a share fixes (spec FR-005), the ONE place they are derived:
 * SELLER pays: the buyer's basis is the ask and the seller nets ask - share;
 * BUYER pays: the basis is ask + share and the seller nets the ask. Used by
 * the pricing, the checkout and every read that shows these amounts, so a
 * page can never disagree with the charge (NFR-002).
 */
export function resaleAmountsFromShare(input: {
  askCents: number;
  shareCents: number;
  payer: "SELLER" | "BUYER";
}): { basisCents: number; sellerReceivesCents: number } {
  const { askCents, shareCents, payer } = input;
  return payer === "SELLER"
    ? { basisCents: askCents, sellerReceivesCents: askCents - shareCents }
    : { basisCents: askCents + shareCents, sellerReceivesCents: askCents };
}

/**
 * The share for a valid ask and a parsed clause, with the invariant guard but
 * WITHOUT the basis bound, so the search can probe asks whose basis passes it.
 */
function priceResaleShare(
  askCents: number,
  parsedClause: ResaleShareClause,
): ResaleShare {
  const limitCents = shareLimitCents(askCents);
  let shareCents: number;
  let shareHeld = false;
  let heldFromCents: number | null = null;
  if (parsedClause.type === "PERCENT") {
    shareCents = Math.floor((askCents * parsedClause.bps) / 10_000);
  } else if (parsedClause.cents > limitCents) {
    shareCents = limitCents;
    shareHeld = true;
    heldFromCents = parsedClause.cents;
  } else {
    shareCents = parsedClause.cents;
  }

  const payer = parsedClause.payer;
  const { sellerReceivesCents, basisCents } = resaleAmountsFromShare({
    askCents,
    shareCents,
    payer,
  });

  if (
    !Number.isSafeInteger(shareCents) ||
    !Number.isSafeInteger(sellerReceivesCents) ||
    !Number.isSafeInteger(basisCents) ||
    shareCents < 0 ||
    shareCents > limitCents ||
    sellerReceivesCents < 0 ||
    sellerReceivesCents + shareCents !== basisCents
  ) {
    throw fail("INTERNAL", {
      meta: {
        reason: "resale_share_invariant",
        askCents,
        shareCents,
        sellerReceivesCents,
        basisCents,
        payer,
      },
    });
  }

  return {
    askCents,
    shareCents,
    shareHeld,
    heldFromCents,
    sellerReceivesCents,
    basisCents,
    payer,
  };
}

export type ResaleAskCapCheck =
  | { ok: true; basisCents: number }
  | {
      ok: false;
      /** ask + share (BUYER) or ask (SELLER): the amount over the cap. */
      basisCents: number;
      capCents: number;
      /**
       * The largest whole-cent ask whose basis fits under the cap, or null
       * when none does (a negative cap).
       */
      highestFittingAskCents: number | null;
    };

/**
 * FR-002: what the buyer pays before processing and tax must not exceed the
 * ticket's resale cap (`effectiveResaleCapCents`). With a BUYER clause that is
 * ask + share; with SELLER it is the ask alone (today's check). `capCents`
 * null = no cap, always ok.
 *
 * On a refusal, `highestFittingAskCents` is found by binary search, not a
 * closed form: basis(ask) = ask + share(ask) rises by at least 1 for every
 * cent of ask (share never falls as ask rises, under either rule), so the
 * fitting asks are exactly 0..k and the search returns k with floor rounding
 * and the FLAT limit accounted for by the same pricing `computeResaleShare`
 * uses. A basis above the `Int` bound is refused by `computeResaleShare`
 * (INVALID_INPUT `resale_total_too_large`, carrying the highest fitting ask)
 * before the cap is compared.
 */
export function checkResaleAskWithinCap(input: {
  askCents: number;
  clause: ResaleShareClause | null | undefined;
  capCents: number | null;
}): ResaleAskCapCheck {
  const { basisCents } = computeResaleShare(input);
  const { capCents } = input;
  if (capCents == null || basisCents <= capCents) {
    return { ok: true, basisCents };
  }
  return {
    ok: false,
    basisCents,
    capCents,
    highestFittingAskCents: highestAskWithinCapCents({
      clause: input.clause,
      capCents,
    }),
  };
}

/**
 * The largest integer ask whose basis (ask + share for BUYER, ask for SELLER)
 * is ≤ the cap AND ≤ RESALE_SHARE_MAX_ASK_CENTS, so the ask it offers is
 * always one `computeResaleShare` accepts. `capCents` null = no cap: only the
 * `Int` bound applies. Null when capCents < 0 or is not an integer. Refuses a
 * missing or invalid clause like `computeResaleShare`.
 * Exact: binary search over the monotone basis (see `checkResaleAskWithinCap`).
 */
export function highestAskWithinCapCents(input: {
  clause: ResaleShareClause | null | undefined;
  capCents: number | null;
}): number | null {
  const { clause, capCents } = input;
  // Validates the clause (missing → RESALE_TERMS_MISSING, bad → INVALID_INPUT).
  computeResaleShare({ askCents: 0, clause });
  if (capCents != null && (!Number.isInteger(capCents) || capCents < 0)) {
    return null;
  }
  const limitCents =
    capCents == null
      ? RESALE_SHARE_MAX_ASK_CENTS
      : Math.min(capCents, RESALE_SHARE_MAX_ASK_CENTS);
  return searchHighestFittingAsk(
    resaleShareClauseSchema.parse(clause),
    limitCents,
  );
}

/**
 * Binary search for the largest ask in 0..limitCents with basis ≤ limitCents.
 * basis(ask) ≥ ask, so no ask above the limit can fit, and basis(0) = 0, so
 * 0 always does. `limitCents` is already ≤ RESALE_SHARE_MAX_ASK_CENTS, so the
 * answer's basis fits the `Int` bound too. Probes through `priceResaleShare`
 * (no basis bound) so a probe above the bound compares instead of throwing.
 */
function searchHighestFittingAsk(
  parsedClause: ResaleShareClause,
  limitCents: number,
): number {
  let lo = 0;
  let hi = limitCents;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (priceResaleShare(mid, parsedClause).basisCents <= limitCents) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
