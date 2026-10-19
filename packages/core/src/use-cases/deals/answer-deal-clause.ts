import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { DealClauseRecord } from "@th/ports/repos/deals";
import { fail as failApp } from "@th/errors";

import { fail } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { dealTargetSchema, refuseBookingOwnedTerms } from "./_shared/deal-target";
import { isStoredPerOrderLine } from "./_shared/deal-from-storage";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const answerDealClauseInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** Where the clause lives. Only EVENT terms take answers (see below). */
    target: dealTargetSchema,
    clauseId: z.uuid(),
    /**
     * The clause's economics as the client displayed them. The answer is a
     * yes (or no) to THESE terms: under the terms lock they must still be
     * the stored ones, or the answer is refused (`answered_terms_changed`).
     * Same shape and units as the deal read's clause.
     */
    answered: z
      .object({
        amountType: z.enum(["FIXED", "PERCENT", "FIXED_AND_PERCENT"]),
        amountCents: z.number().int().min(0).nullable(),
        /** Whole percent. */
        percent: z.number().int().min(0).max(100).nullable(),
        basis: z.enum(["GROSS", "NET_POOL"]),
        resolution: z.enum(["SUM", "GREATER_OF"]).nullable(),
      })
      .strict(),
  })
  .strict();

export const answerDealClauseOutputSchema = z
  .object({
    clauseId: z.uuid(),
    payoutTermsId: z.uuid(),
    confirmationStatus: z.enum(["CONFIRMED", "DECLINED"]),
    confirmedAt: z.date().nullable(),
  })
  .strict();

export type AnswerDealClauseInput = z.infer<typeof answerDealClauseInputSchema>;
export type AnswerDealClauseOutput = z.infer<typeof answerDealClauseOutputSchema>;

export type AnswerDealClauseDeps = {
  repos: Pick<Repos, "tx" | "events" | "deals" | "payoutTerms" | "payees" | "agreements" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

type Answer = "CONFIRMED" | "DECLINED";

// ─────────────────────────────────────────────────────────────────────────────
// Use cases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The payee named on a clause SETTLED DIRECTLY (a guarantee, a NET_POOL
 * share, a versus) accepts it. The consent half of `setTermsDeal`'s
 * `confirmSettledDirectly`: such a clause is stored PENDING until its payee
 * answers. Per-order PERCENT/GROSS lines answer through `confirmPayoutLine`.
 */
export function confirmDealClause(deps: AnswerDealClauseDeps, rawInput: unknown) {
  return answerDealClause(deps, rawInput, "CONFIRMED");
}

/** The payee declines the clause. Final for this version of the clause. */
export function declineDealClause(deps: AnswerDealClauseDeps, rawInput: unknown) {
  return answerDealClause(deps, rawInput, "DECLINED");
}

/**
 * Rules:
 *   - EVENT terms only. A default (ORG_DEFAULT target, or any `isDefault`
 *     row) is a template: an answer on it would ride into every event copied
 *     from it, which the payee never saw — so it is refused, and every copy
 *     resets these answers (`clonePayoutTermsRow`). A booking agreement's
 *     terms are refused too: the booking's own accept flow is the consent.
 *   - Only the clause's payee answers, by `confirmPayoutLine`'s rule: the
 *     human themself for a HUMAN payee, an OWNER/ADMIN of the org for an
 *     ORGANIZATION payee. Nobody else — not the event's editors.
 *   - Under the terms lock: the event still points at the terms, the clause
 *     still names the same payee, its stored economics are exactly the ones
 *     the client displayed (`input.answered`; else CONFLICT
 *     `answered_terms_changed` — a re-save that kept the clause id at a new
 *     amount must not collect a yes given to the old one), and it is still
 *     PENDING. Only PENDING moves; a second answer is
 *     a conflict (`deal_clause_already_answered`). The write itself is a
 *     guarded UPDATE, and its audit row is in the same transaction.
 */
async function answerDealClause(
  deps: AnswerDealClauseDeps,
  rawInput: unknown,
  answer: Answer,
): Promise<AnswerDealClauseOutput> {
  const input = parseInput(answerDealClauseInputSchema, rawInput);
  const { target } = input;
  if (target.kind === "ORG_DEFAULT") {
    throw failApp("AGREEMENT_NOT_EDITABLE", { meta: { reason: "default_terms_are_a_template" } });
  }
  if (target.kind === "BOOKING_AGREEMENT") {
    throw failApp("AGREEMENT_NOT_EDITABLE", { meta: { reason: "booking_terms_answered_by_accept" } });
  }

  const event = await deps.repos.events.getById(target.eventId);
  if (!event) throw failApp("EVENT_NOT_FOUND");
  const payoutTermsId = event.payoutTermsId ?? null;
  if (!payoutTermsId) throw failApp("PAYOUT_LINE_NOT_FOUND");
  const deal = await deps.repos.deals.getTermsDeal(payoutTermsId);
  const clause = deal?.clauses.find((c) => c.id === input.clauseId);
  if (!clause) throw failApp("PAYOUT_LINE_NOT_FOUND");

  await requirePayeeActor(deps.repos, clause.payeeId, input.actorHumanId);

  if (isStoredPerOrderLine(clause)) {
    // Paid per order: its answer goes through `confirmPayoutLine`.
    fail("invalid_input", "deal_clause_is_paid_per_order");
  }
  if (!clause.requiresConfirmation) throw failApp("LINE_DOES_NOT_REQUIRE_CONFIRMATION");

  const now = deps.clock.now();
  const confirmedAt = answer === "CONFIRMED" ? now : null;

  await deps.repos.tx(async (tx) => {
    if (!(await tx.deals.lockTerms(payoutTermsId))) throw failApp("PAYOUT_LINE_NOT_FOUND");

    const lockedEvent = await tx.events.getById(target.eventId);
    if ((lockedEvent?.payoutTermsId ?? null) !== payoutTermsId) {
      fail("conflict", "deal_terms_changed");
    }
    const terms = await tx.payoutTerms.getById(payoutTermsId);
    if (!terms) throw failApp("PAYOUT_LINE_NOT_FOUND");
    if (terms.isDefault) {
      throw failApp("AGREEMENT_NOT_EDITABLE", { meta: { reason: "default_terms_are_a_template" } });
    }
    await refuseBookingOwnedTerms(tx.agreements, payoutTermsId);

    // The clause the payee answered must be the clause that is stored now.
    const current = (await tx.deals.getTermsDeal(payoutTermsId))?.clauses.find(
      (c) => c.id === input.clauseId,
    );
    if (!current || current.payeeId !== clause.payeeId || !current.requiresConfirmation) {
      fail("conflict", "deal_clause_changed");
    }
    if (!answeredMatches(input.answered, current)) {
      throw failApp("CONFLICT", { meta: { reason: "answered_terms_changed" } });
    }
    if ((current.confirmationStatus ?? "PENDING") !== "PENDING") {
      fail("conflict", "deal_clause_already_answered");
    }

    const landed = await tx.deals.answerDealClause({
      payoutTermsId,
      clauseId: input.clauseId,
      expectedFrom: ["PENDING", null],
      confirmationStatus: answer,
      confirmedAt,
    });
    if (!landed) fail("conflict", "deal_clause_already_answered");

    await tx.audit.log({
      entity: "payout_terms_line",
      entityId: input.clauseId,
      action: answer === "CONFIRMED" ? "deal_clause_confirmed" : "deal_clause_declined",
      data: {
        payoutTermsId,
        eventId: target.eventId,
        payeeId: current.payeeId,
        actorHumanId: input.actorHumanId,
        previousStatus: current.confirmationStatus ?? "PENDING",
        clause: {
          amountType: current.amountType,
          amountCents: current.amountCents,
          percent: current.percent,
          basis: current.basis,
          resolution: current.resolution,
        },
      },
      at: now,
    });
  });

  deps.logger?.info("deals.clause_answered", {
    clauseId: input.clauseId,
    payoutTermsId,
    answer,
    actorHumanId: input.actorHumanId,
  });

  return answerDealClauseOutputSchema.parse({
    clauseId: input.clauseId,
    payoutTermsId,
    confirmationStatus: answer,
    confirmedAt,
  });
}

/** `confirmPayoutLine`'s rule for who answers for a payee. */
async function requirePayeeActor(
  repos: Pick<Repos, "payees" | "authz">,
  payeeId: string,
  actorHumanId: string,
): Promise<void> {
  const payee = await repos.payees.getById(payeeId);
  if (!payee) throw failApp("PAYEE_NOT_FOUND");
  if (payee.subjectType === "HUMAN") {
    if (payee.subjectId !== actorHumanId) {
      throw failApp("NOT_RESOURCE_OWNER", { meta: { entity: "payee" } });
    }
    return;
  }
  const memberships = await repos.authz.getOrgMemberships({
    orgIds: [payee.subjectId],
    humanId: actorHumanId,
  });
  if (!memberships.some((m) => m.role === "OWNER" || m.role === "ADMIN")) {
    throw failApp("INSUFFICIENT_ROLE");
  }
}

/** The economics the payee was shown are the economics stored now. */
function answeredMatches(
  answered: AnswerDealClauseInput["answered"],
  stored: DealClauseRecord,
): boolean {
  return (
    answered.amountType === stored.amountType &&
    answered.amountCents === (stored.amountCents ?? null) &&
    answered.percent === (stored.percent ?? null) &&
    answered.basis === stored.basis &&
    answered.resolution === (stored.resolution ?? null)
  );
}
