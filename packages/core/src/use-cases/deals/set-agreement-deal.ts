import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type {
  DealClauseRecord,
  DealClauseWrite,
  DealDeductionWrite,
  PayoutTermsDealRecord,
} from "@th/ports/repos/deals";
import { fail as failApp } from "@th/errors";

import { fail } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import {
  DEAL_BASIS_KINDS,
  DEAL_CLAUSE_AMOUNT_TYPES,
  DEAL_CLAUSE_RESOLUTIONS,
  DEAL_DEDUCTION_KINDS,
  MAX_DEAL_ITEMS,
  assertDealTermsShape,
  buildDoorSplitDeal,
  buildGuaranteeDeal,
  buildGuaranteePlusPercentDeal,
  buildRoomRentalDeal,
  buildStraightPercentDeal,
  buildVersusDeal,
  classifyClauseForStage1,
  computeDealSettlement,
  dealPercentSchema,
  type DealClause,
  type DealDeduction,
  type DealTerms,
} from "../../lib/settlement";
import {
  partyOnSide,
  requireAgreementParty,
} from "../booking-agreements/_shared/agreement-access";
import { deriveAgreementGuaranteeCents } from "../booking-agreements/_shared/agreement-deal-guarantee";
import { requireAgreementTermsEditor } from "../booking-agreements/_shared/agreement-editor-side";
import {
  isAgreementPartyPayee,
  requireDraftBookingAgreement,
  requirePayoutTermsId,
} from "../booking-agreements/_shared/agreement-lines";
import {
  SPLITS_TARGET_PCT,
  assessCapSatisfiability,
  isCompleteAllocation,
} from "../../lib/pricing/caps-satisfiable";
import {
  assertDealScopeUnchanged,
  assertDealWritable,
  bookingDealScope,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
} from "./_shared/deal-freeze";
import { isStoredPerOrderLine } from "./_shared/deal-from-storage";
import { dealFingerprint } from "./_shared/deal-fingerprint";
import {
  dealPayeeRefSchema,
  payeeRefKey,
  resolveDealPayeeRefs,
  type DealPayeeRef,
} from "./_shared/payee-refs";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stored money columns are int4. Every amount a deal write accepts fits, with
 * room: $21,474,836.47.
 */
export const MAX_STORED_DEAL_CENTS = 2_147_483_647;
const storedCentsSchema = z.number().int().nonnegative().max(MAX_STORED_DEAL_CENTS);
const positiveStoredCentsSchema = storedCentsSchema.min(1);

export const dealClauseInputSchema = z
  .object({
    /**
     * An existing clause of THIS deal to keep (its id survives). Ignored for
     * a per-order clause, whose identity is its payee (one per payee).
     */
    id: z.uuid().optional(),
    payee: dealPayeeRefSchema,
    amountType: z.enum(DEAL_CLAUSE_AMOUNT_TYPES),
    amountCents: positiveStoredCentsSchema.nullish(),
    percent: dealPercentSchema.nullish(),
    basis: z.enum(DEAL_BASIS_KINDS),
    resolution: z.enum(DEAL_CLAUSE_RESOLUTIONS).nullish(),
    displayLabel: plainTextOptional(200).nullish(),
  })
  .strict();

export const dealDeductionInputSchema = z
  .object({
    id: z.uuid().optional(),
    kind: z.enum(DEAL_DEDUCTION_KINDS),
    label: plainTextRequired(200),
    amountCents: storedCentsSchema.nullish(),
    percent: dealPercentSchema.nullish(),
    creditedPayee: dealPayeeRefSchema,
    estimated: z.boolean(),
  })
  .strict();

const actPreset = <S extends string, T extends z.ZodRawShape>(preset: S, shape: T) =>
  z.object({ preset: z.literal(preset), act: dealPayeeRefSchema, ...shape }).strict();

/** FR-003a: the presets, built server-side by `deal-presets.ts`. */
export const dealPresetInputSchema = z.discriminatedUnion("preset", [
  actPreset("GUARANTEE", { guaranteeCents: positiveStoredCentsSchema }),
  actPreset("DOOR_SPLIT", { percent: dealPercentSchema }),
  actPreset("GUARANTEE_PLUS_PERCENT", {
    guaranteeCents: positiveStoredCentsSchema,
    percent: dealPercentSchema.min(1),
    basis: z.enum(DEAL_BASIS_KINDS).optional(),
  }),
  actPreset("VERSUS", {
    guaranteeCents: positiveStoredCentsSchema,
    percent: dealPercentSchema.min(1),
    basis: z.enum(DEAL_BASIS_KINDS).optional(),
  }),
  actPreset("STRAIGHT_PERCENT", { percent: dealPercentSchema }),
  z
    .object({
      preset: z.literal("ROOM_RENTAL"),
      venue: dealPayeeRefSchema,
      /** The renter keeps the door: it is the remainder holder. */
      renter: dealPayeeRefSchema,
      rentalCents: positiveStoredCentsSchema,
      mode: z.enum(["FIXED_FEE", "RECOUPED_FROM_DOOR"]),
      rentalLabel: plainTextOptional(200).optional(),
    })
    .strict(),
]);

/** The whole deal a write replaces: typed clause by clause, or a preset. */
export const dealWriteInputSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("CLAUSES"),
      clauses: z.array(dealClauseInputSchema).max(MAX_DEAL_ITEMS),
      deductions: z.array(dealDeductionInputSchema).max(MAX_DEAL_ITEMS),
      remainder: dealPayeeRefSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("PRESET"),
      preset: dealPresetInputSchema,
      /** Required by every preset but ROOM_RENTAL (the renter is it). */
      remainder: dealPayeeRefSchema.optional(),
      /** More clauses after the preset's own (a support act's 10%). */
      extraClauses: z.array(dealClauseInputSchema).max(MAX_DEAL_ITEMS).default([]),
      deductions: z.array(dealDeductionInputSchema).max(MAX_DEAL_ITEMS).default([]),
      displayLabel: plainTextOptional(200).nullish(),
    })
    .strict(),
]);

export const setAgreementDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    deal: dealWriteInputSchema,
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes a frozen
     * deal (every payee is told). Without it a frozen deal is refused
     * (DEAL_FROZEN). Ignored when the deal is not frozen.
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const setAgreementDealOutputSchema = z
  .object({
    agreementId: z.uuid(),
    payoutTermsId: z.uuid(),
    remainderPayeeId: z.uuid(),
    clauseIds: z.array(z.string()),
    deductionIds: z.array(z.string()),
    /** The remainder holder's per-order share ("the rest"), 0 when none. */
    remainderPerOrderPercent: z.number().int(),
  })
  .strict();

export type SetAgreementDealInput = z.input<typeof setAgreementDealInputSchema>;
export type SetAgreementDealOutput = z.infer<typeof setAgreementDealOutputSchema>;

export type SetAgreementDealDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "agreements"
    | "payoutTerms"
    | "deals"
    | "payees"
    | "humans"
    | "organizations"
    | "authz"
    | "audit"
    | "bookingRequests"
    | "events"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

export type ParsedSetAgreementDealInput = z.infer<typeof setAgreementDealInputSchema>;
type ParsedInput = ParsedSetAgreementDealInput;
export type ParsedDealWrite = z.infer<typeof dealWriteInputSchema>;
type ClauseInput = z.infer<typeof dealClauseInputSchema>;
type DeductionInput = z.infer<typeof dealDeductionInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the whole deal on a DRAFT booking agreement (FR-001, FR-003 data):
 * clauses, costs off the top and the remainder holder — typed clause by
 * clause, or built from a preset by `deal-presets.ts`.
 *
 * Gates (the agreement's existing edit rules, reused): DRAFT and not
 * finalized (`requireDraftBookingAgreement`, re-checked in the transaction);
 * an edit-level party (`ORG_EDIT_ROLES`); the terms-editor side, never the
 * act (`requireAgreementTermsEditor`).
 *
 * FR-005 — what the platform pays per order stays a set of PERCENT/GROSS
 * lines that divide each order exactly once:
 *   - every non-remainder payee's PERCENT/GROSS clause is its per-order line
 *     (at most one per payee — `OrderSplit` is one row per order and payee);
 *   - the remainder holder gets "the rest" per order: a PERCENT/GROSS line of
 *     100 − Σ the others, written here and never typed (refused if typed);
 *   - everything else (FIXED, NET_POOL, FIXED_AND_PERCENT, costs) is stored
 *     but sits behind the adapter's per-order fence: settled directly.
 * So the per-order lines always total exactly 100% and the publish gate
 * (`splits_total_invalid`) passes whatever is settled directly.
 *
 * Per-order lines keep their id, economics (cap, priority, rounding) and
 * confirmation when their percent is unchanged; a changed percent resets a
 * third-party payee's confirmation to PENDING, as the line editor does.
 * Clauses settled directly carry no confirmation — the platform routes no
 * money on them; both parties see them on the agreement.
 *
 * The remainder holder must be one of the two agreement parties: it owes
 * every shortfall, and a third party never agreed to that.
 */
export async function setAgreementDeal(
  deps: SetAgreementDealDeps,
  rawInput: unknown,
): Promise<SetAgreementDealOutput> {
  const input = parseInput(setAgreementDealInputSchema, rawInput);
  const { dealFingerprint: _fingerprint, ...out } = await setBookingAgreementDeal(deps, input);
  return out;
}

/** {@link setAgreementDeal} on an already-parsed input (the booking target). */
export async function setBookingAgreementDeal(
  deps: SetAgreementDealDeps,
  input: ParsedInput,
  opts: { expectedDealFingerprint?: string | null } = {},
): Promise<SetAgreementDealOutput & { dealFingerprint: string }> {
  const agreement = await requireDraftBookingAgreement(
    deps.repos.agreements,
    input.agreementId,
  );
  requirePayoutTermsId(agreement);
  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  const remainderRef = remainderRefOf(input.deal);
  const partyRefs = [partyOnSide(agreement, "proposer"), partyOnSide(agreement, "counterparty")];
  if (
    !partyRefs.some(
      (p) =>
        p.id === remainderRef.id &&
        (p.type === "human") === (remainderRef.kind === "human"),
    )
  ) {
    fail("invalid_input", "deal_remainder_not_a_party");
  }

  const now = deps.clock.now();
  const lockedTermsId = requirePayoutTermsId(agreement);

  const lockedScope = bookingDealScope(agreement);

  const result = await deps.repos.tx(async (tx) => {
    // freeze-the-deal: the row of the booking's event first, before the
    // terms lock (the order in deal-freeze.ts).
    await lockDealEvent(tx, lockedScope);
    // Then the terms row lock (B1). Everything below — the deal this write
    // replaces included — is read under it, so concurrent writes serialize
    // and the later one replaces the earlier instead of adding a second set
    // of clauses beside it.
    if (!(await tx.deals.lockTerms(lockedTermsId))) {
      throw failApp("PAYOUT_TERMS_NOT_FOUND");
    }
    const fresh = await requireDraftBookingAgreement(tx.agreements, input.agreementId);
    assertDealScopeUnchanged(lockedScope, bookingDealScope(fresh));
    const payoutTermsId = requirePayoutTermsId(fresh);
    if (payoutTermsId !== lockedTermsId) {
      // The agreement was re-pointed at other terms since the read above.
      fail("conflict", "deal_terms_changed");
    }

    // A deal is written onto the agreement's OWN terms (the per-agreement
    // clone accept makes) — never onto an org / place / human default.
    const termsRow = await tx.payoutTerms.getById(payoutTermsId);
    if (!termsRow) throw failApp("PAYOUT_TERMS_NOT_FOUND");
    if (termsRow.isDefault) throw failApp("AGREEMENT_NOT_EDITABLE");

    // freeze-the-deal FR-004: under the event and terms locks. A DRAFT agreement whose
    // event is not frozen (or that has no event yet) writes as before (F4).
    const fence = await assertDealWritable(tx, {
      scope: bookingDealScope(fresh),
      frozenChange: input.frozenChange,
    });

    const written = await writeDealOnLockedTerms(tx, {
      payoutTermsId,
      deal: input.deal,
      remainderRef,
      // A per-order line paying anyone but the two parties needs that payee's
      // confirmation.
      isThirdPartyPayee: (payee) => !isAgreementPartyPayee(fresh, payee),
      audit: {
        action: "booking_agreement.deal_set",
        data: { actorHumanId: input.actorHumanId, agreementId: fresh.id },
      },
      now,
      ...(opts.expectedDealFingerprint !== undefined
        ? { fingerprintCheck: { expected: opts.expectedDealFingerprint, minted: false } }
        : {}),
    });

    // FR-001: the header guarantee is The deal's — the fixed part of the act
    // side's clauses — written in this transaction, under the terms lock, so
    // the header and the deal can never disagree. The header write takes the
    // same lock before refusing a typed change.
    await syncHeaderGuaranteeFromDeal(tx, fresh, payoutTermsId);

    const change = await recordDealChange(tx, fence, {
      actorHumanId: input.actorHumanId,
      at: now,
    });
    return { agreementId: fresh.id, ...written, change };
  });

  // FR-006: after the commit, never inside it (a rolled-back change is
  // never announced). Best effort: never throws.
  if (result.change) await notifyDealChange(deps, result.change);

  deps.logger?.info("deals.agreement_deal_set", {
    agreementId: result.agreementId,
    payoutTermsId: result.payoutTermsId,
    actorHumanId: input.actorHumanId,
  });

  const { dealFingerprint: fingerprint, change: _change, ...out } = result;
  return { ...setAgreementDealOutputSchema.parse(out), dealFingerprint: fingerprint };
}

/**
 * Set `Agreement.guaranteeCents` from the deal just written (FR-001). Call
 * inside the deal write's transaction, after the write, with the terms row
 * locked. No-op on an agreement not linked to its booking request (no act side
 * to read the guarantee from) and when the value is already right.
 */
async function syncHeaderGuaranteeFromDeal(
  tx: Pick<TxRepos, "deals" | "payees" | "agreements" | "bookingRequests">,
  agreement: AgreementRecord,
  payoutTermsId: string,
): Promise<void> {
  const request = await tx.bookingRequests.findByAgreementId(agreement.id);
  if (!request) return;
  const deal = await tx.deals.getTermsDeal(payoutTermsId);
  if (!deal) throw failApp("PAYOUT_TERMS_NOT_FOUND");
  const guaranteeCents = await deriveAgreementGuaranteeCents(tx, {
    agreement,
    request,
    clauses: deal.clauses,
  });
  if (guaranteeCents === agreement.guaranteeCents) return;
  // `fresh` was read DRAFT under the lock; the CAS still travels with the write.
  await tx.agreements.updateHeader({
    id: agreement.id,
    expectedFrom: ["DRAFT"],
    guaranteeCents,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The write itself, shared by every target (booking, event, org default)
// ─────────────────────────────────────────────────────────────────────────────

export type WrittenDeal = {
  payoutTermsId: string;
  remainderPayeeId: string;
  clauseIds: string[];
  deductionIds: string[];
  remainderPerOrderPercent: number;
  /** The fingerprint of the deal as written (`dealFingerprint`), read back under the lock. */
  dealFingerprint: string;
};

/**
 * What the editor loaded, checked under the lock before the write (the
 * lost-update guard). `expected` is the `dealFingerprint` the read returned,
 * or null when the read found no terms yet. `minted` = the caller created the
 * terms row in this transaction, so the only matching expectation is null.
 */
export type DealFingerprintCheck = { expected: string | null; minted: boolean };

/**
 * Replace the deal on a terms row the caller has ALREADY locked
 * (`tx.deals.lockTerms`) and authorised. Everything after the gates: payee
 * resolution, the typed terms, the stored rows (FR-005 per-order lines + the
 * derived remainder line), the calculator's invariants, confirmations, the
 * write and its audit row — all in the caller's transaction.
 *
 * `isThirdPartyPayee` decides which per-order lines need their payee's
 * confirmation: anyone who is not a party to the terms (the two agreement
 * parties; the event's owner; the org itself).
 */
export async function writeDealOnLockedTerms(
  tx: Pick<TxRepos, "deals" | "payees" | "humans" | "organizations" | "audit">,
  args: {
    payoutTermsId: string;
    deal: ParsedDealWrite;
    remainderRef: DealPayeeRef;
    isThirdPartyPayee: (payee: PayeeRecord) => boolean;
    /**
     * Consent for clauses settled directly too (EVENT and ORG_DEFAULT
     * targets): a guarantee, a NET_POOL share or a versus naming a third
     * party is stored PENDING until that payee confirms. False for a booking
     * agreement, whose two parties agree to the whole agreement.
     */
    confirmSettledDirectly?: boolean;
    audit: { action: string; data: Record<string, unknown> };
    now: Date;
    /** Absent only on the legacy `setAgreementDeal` path. */
    fingerprintCheck?: DealFingerprintCheck;
  },
): Promise<WrittenDeal> {
  const { payoutTermsId, deal, remainderRef } = args;
  const before = await tx.deals.getTermsDeal(payoutTermsId);
  if (!before) throw failApp("PAYOUT_TERMS_NOT_FOUND");
  if (args.fingerprintCheck) {
    const { expected, minted } = args.fingerprintCheck;
    const current = minted ? null : dealFingerprint(before);
    if (expected !== current) fail("conflict", "deal_terms_changed");
  }

  const payeeIds = await resolveDealPayeeRefs(tx, collectRefs(deal));
  const payeeOf = (ref: DealPayeeRef) => payeeIds.get(payeeRefKey(ref)) as string;
  const remainderPayeeId = payeeOf(remainderRef);

  const typed = buildTypedTerms(deal, payeeOf, remainderPayeeId);
  const write = toStoredDeal(typed, before, remainderPayeeId);

  // The whole stored deal must be one the calculator accepts — shape,
  // percent totals, and every invariant on a zero projection.
  const storedTerms: DealTerms = {
    clauses: write.clauses.map(toCalculatorClause),
    deductions: write.deductions.map(toCalculatorDeduction),
    remainderPayeeId,
  };
  assertDealTermsShape(storedTerms);
  computeDealSettlement(storedTerms, {
    ticketRevenue: { mode: "PROJECTED", tiers: [{ tickets: 0, unitBasisCents: 0 }] },
  });

  const payees = await tx.payees.getByIds([
    ...new Set(write.clauses.map((c) => c.payeeId)),
  ]);
  const payeesById = new Map(payees.map((p) => [p.id, p]));
  const requiresConfirmationFor = (payeeId: string) => {
    const payee = payeesById.get(payeeId);
    return payee ? args.isThirdPartyPayee(payee) : true;
  };
  const carried = new Set<string>();
  const clauses = write.clauses.map((clause) =>
    withConfirmation(clause, before, requiresConfirmationFor, {
      confirmSettledDirectly: args.confirmSettledDirectly ?? false,
      carried,
    }),
  );

  // Caps must be able to reach the whole order — the predicate every terms
  // writer runs (`updateEventSplits`, `upsertAgreementLine`, publish). A deal
  // keeps the economics of each per-order line it reuses, caps included, so
  // without this a rewrite of a live event's terms could strand cents on
  // every order. Declined lines pay nothing and are left out, as there.
  const activePerOrder = clauses
    .filter((c) => isStoredPerOrderLine(c) && c.confirmationStatus !== "DECLINED")
    .map((c) => ({ id: c.id, percent: c.percent ?? 0, capPercent: c.capPercent }));
  const capReport = assessCapSatisfiability(activePerOrder);
  if (isCompleteAllocation(activePerOrder) && !capReport.satisfiable) {
    throw failApp("SPLITS_CAPS_UNSATISFIABLE", {
      meta: {
        payoutTermsId,
        totalCapPct: capReport.totalCapPct,
        totalAllocatedPct: capReport.totalPercent,
        targetPct: SPLITS_TARGET_PCT,
      },
    });
  }

  await tx.deals.replaceTermsDeal({
    payoutTermsId,
    remainderPayeeId,
    clauses,
    deductions: write.deductions,
  });

  await tx.audit.log({
    entity: "payoutTerms",
    entityId: payoutTermsId,
    action: args.audit.action,
    data: {
      ...args.audit.data,
      source: deal.source,
      preset: deal.source === "PRESET" ? deal.preset.preset : null,
      before: snapshotDeal(before),
      after: {
        remainderPayeeId,
        clauses: clauses.map(snapshotClause),
        deductions: write.deductions,
      },
    },
    at: args.now,
  });

  const after = await tx.deals.getTermsDeal(payoutTermsId);
  if (!after) throw failApp("PAYOUT_TERMS_NOT_FOUND");

  return {
    payoutTermsId,
    remainderPayeeId,
    clauseIds: clauses.map((c) => c.id),
    deductionIds: write.deductions.map((d) => d.id),
    remainderPerOrderPercent: write.remainderPerOrderPercent,
    dealFingerprint: dealFingerprint(after),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the deal
// ─────────────────────────────────────────────────────────────────────────────

export function remainderRefOf(deal: ParsedInput["deal"]): DealPayeeRef {
  if (deal.source === "CLAUSES") return deal.remainder;
  if (deal.preset.preset === "ROOM_RENTAL") {
    const renter = deal.preset.renter;
    if (deal.remainder && payeeRefKey(deal.remainder) !== payeeRefKey(renter)) {
      fail("invalid_input", "deal_room_rental_remainder_is_the_renter");
    }
    return renter;
  }
  if (!deal.remainder) fail("invalid_input", "deal_remainder_required");
  return deal.remainder;
}

function collectRefs(deal: ParsedInput["deal"]): DealPayeeRef[] {
  const refs: DealPayeeRef[] = [remainderRefOf(deal)];
  const clauses = deal.source === "CLAUSES" ? deal.clauses : deal.extraClauses;
  refs.push(...clauses.map((c) => c.payee));
  refs.push(...deal.deductions.map((d) => d.creditedPayee));
  if (deal.source === "PRESET") {
    const p = deal.preset;
    if (p.preset === "ROOM_RENTAL") refs.push(p.venue, p.renter);
    else refs.push(p.act);
  }
  return refs;
}

/** Typed clause, before ids are settled against what is stored. */
type TypedClause = DealClause & { requestedId: string | null };
type TypedDeduction = DealDeduction & { requestedId: string | null };
type TypedTerms = { clauses: TypedClause[]; deductions: TypedDeduction[] };

function typedClause(c: ClauseInput, payeeId: string): TypedClause {
  return {
    id: randomUUID(),
    requestedId: c.id ?? null,
    payeeId,
    amountType: c.amountType,
    amountCents: c.amountCents ?? null,
    percent: c.percent ?? null,
    basis: c.basis,
    resolution: c.resolution ?? null,
    displayLabel: c.displayLabel ? c.displayLabel : null,
  };
}

function typedDeduction(d: DeductionInput, creditedPayeeId: string): TypedDeduction {
  return {
    id: randomUUID(),
    requestedId: d.id ?? null,
    kind: d.kind,
    label: d.label,
    amountCents: d.amountCents ?? null,
    percent: d.percent ?? null,
    creditedPayeeId,
    estimated: d.estimated,
  };
}

const withoutRequested = (c: TypedClause): DealClause => {
  const { requestedId: _ignored, ...clause } = c;
  return clause;
};

function buildTypedTerms(
  deal: ParsedInput["deal"],
  payeeOf: (ref: DealPayeeRef) => string,
  remainderPayeeId: string,
): TypedTerms {
  if (deal.source === "CLAUSES") {
    return {
      clauses: deal.clauses.map((c) => typedClause(c, payeeOf(c.payee))),
      deductions: deal.deductions.map((d) => typedDeduction(d, payeeOf(d.creditedPayee))),
    };
  }

  const extra = deal.extraClauses.map((c) => typedClause(c, payeeOf(c.payee)));
  const deductions = deal.deductions.map((d) => typedDeduction(d, payeeOf(d.creditedPayee)));
  const common = {
    remainderPayeeId,
    deductions: deductions.map(({ requestedId: _r, ...d }) => d),
    extraClauses: extra.map(withoutRequested),
    clauseId: randomUUID(),
    displayLabel: deal.displayLabel ?? null,
  };
  const p = deal.preset;
  let built: DealTerms;
  switch (p.preset) {
    case "GUARANTEE":
      built = buildGuaranteeDeal({ ...common, payeeId: payeeOf(p.act), guaranteeCents: p.guaranteeCents });
      break;
    case "DOOR_SPLIT":
      built = buildDoorSplitDeal({ ...common, payeeId: payeeOf(p.act), percent: p.percent });
      break;
    case "GUARANTEE_PLUS_PERCENT":
      built = buildGuaranteePlusPercentDeal({
        ...common,
        payeeId: payeeOf(p.act),
        guaranteeCents: p.guaranteeCents,
        percent: p.percent,
        basis: p.basis,
      });
      break;
    case "VERSUS":
      built = buildVersusDeal({
        ...common,
        payeeId: payeeOf(p.act),
        guaranteeCents: p.guaranteeCents,
        percent: p.percent,
        basis: p.basis,
      });
      break;
    case "STRAIGHT_PERCENT":
      built = buildStraightPercentDeal({ ...common, payeeId: payeeOf(p.act), percent: p.percent });
      break;
    case "ROOM_RENTAL":
      built = buildRoomRentalDeal({
        venuePayeeId: payeeOf(p.venue),
        renterPayeeId: payeeOf(p.renter),
        rentalCents: p.rentalCents,
        mode: p.mode,
        rentalId: randomUUID(),
        rentalLabel: p.rentalLabel || undefined,
        deductions: common.deductions,
        extraClauses: common.extraClauses,
      });
      break;
  }
  // The builders keep the ids they were given; the extras' requested ids
  // come back from the typed list (a preset's own clause has none).
  const requested = new Map(extra.map((c) => [c.id, c.requestedId]));
  const requestedDeduction = new Map(deductions.map((d) => [d.id, d.requestedId]));
  return {
    clauses: built.clauses.map((c) => ({ ...c, requestedId: requested.get(c.id) ?? null })),
    deductions: built.deductions.map((d) => ({
      ...d,
      requestedId: requestedDeduction.get(d.id) ?? null,
    })),
  };
}

type StoredDealWrite = {
  clauses: DealClauseWrite[];
  deductions: DealDeductionWrite[];
  remainderPerOrderPercent: number;
};

/**
 * Typed terms → the rows to store, against what is stored now:
 *   - a typed PERCENT/GROSS clause on the remainder holder is refused (its
 *     per-order line is derived: "the rest");
 *   - a typed 0% PERCENT/GROSS clause is refused (the per-order engine would
 *     still hand it rounding cents; the calculator calls it a no-op);
 *   - at most one per-order line per payee;
 *   - the remainder's per-order line = 100 − Σ the others (none when 0).
 * Ids: a per-order line reuses the stored per-order line of the same payee;
 * any other clause / deduction keeps the requested id when it is one of this
 * deal's own and not already taken; else a fresh uuid.
 */
function toStoredDeal(
  typed: TypedTerms,
  before: PayoutTermsDealRecord,
  remainderPayeeId: string,
): StoredDealWrite {
  // A payee with SEVERAL stored per-order lines (legacy ticket-type-scoped
  // lines) has no one line a deal write could keep: keeping the last and
  // dropping the rest would silently rewrite what it is paid. Refused; the
  // scoped lines are edited in the splits editor first.
  const storedPerOrderByPayee = new Map<string, DealClauseRecord>();
  for (const c of before.clauses.filter(isStoredPerOrderLine)) {
    if (storedPerOrderByPayee.has(c.payeeId)) {
      fail("invalid_input", "deal_payee_has_several_per_order_lines");
    }
    storedPerOrderByPayee.set(c.payeeId, c);
  }
  // A single line scoped to one ticket type pays only on that type. Reused
  // by a deal it would keep the scope, so "30% per order" would pay nothing
  // on every other type. Refused for the same reason as above.
  if ([...storedPerOrderByPayee.values()].some((c) => c.ticketTypeId !== null)) {
    fail("invalid_input", "deal_payee_has_scoped_per_order_line");
  }
  const storedOtherIds = new Set(
    before.clauses.filter((c) => !isStoredPerOrderLine(c)).map((c) => c.id),
  );
  const storedDeductionIds = new Set(before.deductions.map((d) => d.id));
  const used = new Set<string>();
  const claim = (requested: string | null, stored: ReadonlySet<string>): string => {
    if (requested && stored.has(requested) && !used.has(requested)) {
      used.add(requested);
      return requested;
    }
    const id = randomUUID();
    used.add(id);
    return id;
  };

  const perOrderPayees = new Set<string>();
  let othersPerOrderPercent = 0;
  const clauses: DealClauseWrite[] = [];
  for (const c of typed.clauses) {
    const perOrder = c.amountType === "PERCENT" && c.basis === "GROSS";
    if (perOrder) {
      if (c.payeeId === remainderPayeeId) {
        fail("invalid_input", "deal_remainder_per_order_clause_is_derived");
      }
      if ((c.percent ?? 0) <= 0) fail("invalid_input", "deal_clause_zero_percent");
      if (perOrderPayees.has(c.payeeId)) {
        fail("invalid_input", "deal_duplicate_per_order_payee");
      }
      perOrderPayees.add(c.payeeId);
      othersPerOrderPercent += c.percent ?? 0;
      const stored = storedPerOrderByPayee.get(c.payeeId);
      const id = stored ? stored.id : claim(null, new Set());
      used.add(id);
      clauses.push(clauseWrite(id, c, stored ?? null));
    } else {
      clauses.push(clauseWrite(claim(c.requestedId, storedOtherIds), c, null));
    }
  }

  if (othersPerOrderPercent > 100) {
    fail("invalid_input", "deal_per_order_percent_over_100");
  }
  const remainderPerOrderPercent = 100 - othersPerOrderPercent;
  if (remainderPerOrderPercent > 0) {
    const stored = storedPerOrderByPayee.get(remainderPayeeId) ?? null;
    clauses.push(
      clauseWrite(
        stored ? stored.id : claim(null, new Set()),
        {
          payeeId: remainderPayeeId,
          amountType: "PERCENT",
          amountCents: null,
          percent: remainderPerOrderPercent,
          basis: "GROSS",
          resolution: null,
          displayLabel: null,
        },
        stored,
        // "The rest" must be able to take the rest: a cap carried from the
        // stored line (written for a different share) would strand the
        // difference on every order.
        { uncapped: true },
      ),
    );
  }

  const deductions: DealDeductionWrite[] = typed.deductions.map((d) => ({
    id: claim(d.requestedId, storedDeductionIds),
    kind: d.kind,
    label: d.label,
    amountCents: d.amountCents ?? null,
    percent: d.percent ?? null,
    creditedPayeeId: d.creditedPayeeId,
    estimated: d.estimated,
  }));

  return { clauses, deductions, remainderPerOrderPercent };
}

/** A clause row; per-order economics carried from the stored line it keeps. */
function clauseWrite(
  id: string,
  c: Omit<DealClause, "id">,
  stored: DealClauseRecord | null,
  opts: { uncapped?: boolean } = {},
): DealClauseWrite {
  return {
    id,
    payeeId: c.payeeId,
    amountType: c.amountType,
    amountCents: c.amountCents ?? null,
    percent: c.percent ?? null,
    basis: c.basis,
    resolution: c.resolution ?? null,
    displayLabel: c.displayLabel ?? null,
    ticketTypeId: stored?.ticketTypeId ?? null,
    floorCents: stored?.floorCents ?? 0,
    capPercent: opts.uncapped ? null : (stored?.capPercent ?? null),
    priority: stored?.priority ?? 0,
    rounding: stored?.rounding ?? "FLOOR",
    // Set by `withConfirmation`.
    requiresConfirmation: false,
    confirmationStatus: null,
    confirmedAt: null,
    counterPercentBps: null,
    counterNote: null,
  };
}

/**
 * Confirmation, the line editor's rule: a per-order line paying a third
 * party needs that payee's confirmation; an unchanged percent on the same
 * line keeps what they decided, a changed one resets to PENDING.
 *
 * Clauses settled directly: none on a booking agreement (the two parties
 * agree to the whole agreement). With `confirmSettledDirectly` (EVENT,
 * ORG_DEFAULT) a third party's clause needs their confirmation too — the
 * owner's consent-based ruling. A stored clause for the same payee with the
 * same economics (type, amount, percent, basis, resolution) carries its
 * decision over, so re-saving an unchanged preset (whose clause ids are
 * fresh) keeps it; any change resets to PENDING. `carried` stops one stored
 * clause carrying over onto two.
 */
function withConfirmation(
  clause: DealClauseWrite,
  before: PayoutTermsDealRecord,
  requiresConfirmationFor: (payeeId: string) => boolean,
  opts: { confirmSettledDirectly: boolean; carried: Set<string> },
): DealClauseWrite {
  if (!isStoredPerOrderLine(clause)) {
    if (!opts.confirmSettledDirectly || !requiresConfirmationFor(clause.payeeId)) {
      return { ...clause, requiresConfirmation: false, confirmationStatus: null };
    }
    const same = before.clauses.find(
      (c) =>
        !isStoredPerOrderLine(c) &&
        !opts.carried.has(c.id) &&
        c.requiresConfirmation &&
        c.payeeId === clause.payeeId &&
        c.amountType === clause.amountType &&
        (c.amountCents ?? null) === (clause.amountCents ?? null) &&
        (c.percent ?? null) === (clause.percent ?? null) &&
        c.basis === clause.basis &&
        (c.resolution ?? null) === (clause.resolution ?? null),
    );
    if (same) {
      opts.carried.add(same.id);
      return {
        ...clause,
        requiresConfirmation: true,
        confirmationStatus: same.confirmationStatus ?? "PENDING",
        confirmedAt: same.confirmedAt,
        counterPercentBps: same.counterPercentBps,
        counterNote: same.counterNote,
      };
    }
    return {
      ...clause,
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
      confirmedAt: null,
      counterPercentBps: null,
      counterNote: null,
    };
  }
  const requires = requiresConfirmationFor(clause.payeeId);
  if (!requires) {
    return { ...clause, requiresConfirmation: false, confirmationStatus: null };
  }
  const previous = before.clauses.find(
    (c) => c.id === clause.id && isStoredPerOrderLine(c),
  );
  if (previous && previous.percent === clause.percent && previous.requiresConfirmation) {
    return {
      ...clause,
      requiresConfirmation: true,
      confirmationStatus: previous.confirmationStatus ?? "PENDING",
      confirmedAt: previous.confirmedAt,
      counterPercentBps: previous.counterPercentBps,
      counterNote: previous.counterNote,
    };
  }
  return {
    ...clause,
    requiresConfirmation: true,
    confirmationStatus: "PENDING",
    confirmedAt: null,
    counterPercentBps: null,
    counterNote: null,
  };
}

function toCalculatorClause(c: DealClauseWrite): DealClause {
  return {
    id: c.id,
    payeeId: c.payeeId,
    amountType: c.amountType,
    amountCents: c.amountCents,
    percent: c.percent,
    basis: c.basis,
    resolution: c.resolution,
    displayLabel: c.displayLabel,
  };
}

function toCalculatorDeduction(d: DealDeductionWrite): DealDeduction {
  return {
    id: d.id,
    kind: d.kind,
    label: d.label,
    amountCents: d.amountCents,
    percent: d.percent,
    creditedPayeeId: d.creditedPayeeId,
    estimated: d.estimated,
  };
}

function snapshotClause(c: DealClauseWrite | DealClauseRecord) {
  return {
    id: c.id,
    payeeId: c.payeeId,
    amountType: c.amountType,
    amountCents: c.amountCents,
    percent: c.percent,
    basis: c.basis,
    resolution: c.resolution,
    stage1: classifyClauseForStage1(c),
  };
}

function snapshotDeal(deal: PayoutTermsDealRecord) {
  return {
    remainderPayeeId: deal.remainderPayeeId,
    clauses: deal.clauses.map(snapshotClause),
    deductions: deal.deductions.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      amountCents: d.amountCents,
      percent: d.percent,
      creditedPayeeId: d.creditedPayeeId,
      estimated: d.estimated,
    })),
  };
}
