import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { disputeStatusSchema } from "../schemas";
import {
  disputeEvidenceRecordSchema,
  earlyFraudWarningSummarySchema,
} from "./schemas";
import { requireDisputeDeskStaff, type DisputeDeskAuthzDeps } from "./staff";

// ─────────────────────────────────────────────────────────────────────────────
// getDisputeForDesk — one dispute with everything the desk detail page
// needs: the dispute row, order/buyer/event/owner display fields, the
// evidence package (with sources), and the ledger position (active holds +
// realised debits) for this dispute. Staff-only, enforced here.
//
// Display lookups are best-effort: a missing org name must not 404 the
// dispute. Each swallow reports.
// ─────────────────────────────────────────────────────────────────────────────

export const getDisputeForDeskInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    disputeId: z.string().min(1),
  })
  .strict();

const ledgerLineSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    payeeId: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    createdAt: z.date(),
    description: z.string().nullable(),
  })
  .strict();

export const getDisputeForDeskOutputSchema = z
  .object({
    dispute: z
      .object({
        id: z.string(),
        stripeDisputeId: z.string(),
        stripeChargeId: z.string().nullable(),
        paymentIntentId: z.string().nullable(),
        status: disputeStatusSchema,
        reason: z.string(),
        amountCents: z.number().int(),
        feeCents: z.number().int(),
        feeBorneBy: z.enum(["PLATFORM", "PAYEE"]).nullable(),
        currency: z.string(),
        triageReason: z.string().nullable(),
        linkedAt: z.date().nullable(),
        evidenceDueBy: z.date().nullable(),
        evidenceHasEvidence: z.boolean().nullable(),
        evidencePastDue: z.boolean().nullable(),
        evidenceSubmissionCount: z.number().int().nullable(),
        evidenceSubmittedAt: z.date().nullable(),
        fundsWithdrawnAt: z.date().nullable(),
        closedAt: z.date().nullable(),
        outcome: z.string().nullable(),
        createdAt: z.date(),
        updatedAt: z.date(),
      })
      .strict(),
    order: z
      .object({
        id: z.string(),
        kind: z.enum(["TICKETING", "MEMBERSHIP"]),
        status: z.string(),
        amountGrossCents: z.number().int(),
        taxAmountCents: z.number().int(),
        currency: z.string(),
        occurredAt: z.date(),
        paymentChannel: z.string(),
        paymentMethodType: z.string().nullable(),
        billingDescriptor: z.string().nullable(),
        checkoutIp: z.string().nullable(),
        disputeStatus: disputeStatusSchema.nullable(),
      })
      .strict()
      .nullable(),
    buyer: z
      .object({
        humanId: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
      })
      .strict()
      .nullable(),
    event: z
      .object({
        id: z.string(),
        title: z.string(),
        startsAt: z.date(),
        timezone: z.string(),
      })
      .strict()
      .nullable(),
    owner: z
      .object({
        subjectType: z.enum(["ORGANIZATION", "HUMAN"]),
        subjectId: z.string(),
        name: z.string().nullable(),
      })
      .strict()
      .nullable(),
    evidence: disputeEvidenceRecordSchema.nullable(),
    /**
     * Newest Radar early fraud warning on the linked order, any resolution:
     * the issuer flagged the charge BEFORE this chargeback. Null = never
     * warned, no linked order, or the lookup failed (reported).
     */
    earlyFraudWarning: earlyFraudWarningSummarySchema.nullable(),
    ledger: z
      .object({
        activeHolds: z.array(ledgerLineSchema),
        debits: z.array(ledgerLineSchema),
        heldCents: z.number().int(),
        debitedCents: z.number().int(),
      })
      .strict(),
  })
  .strict();

export type GetDisputeForDeskInput = z.infer<typeof getDisputeForDeskInputSchema>;
export type GetDisputeForDeskOutput = z.infer<
  typeof getDisputeForDeskOutputSchema
>;

export type GetDisputeForDeskDeps = DisputeDeskAuthzDeps & {
  repos: Pick<
    Repos,
    | "disputes"
    | "disputeEvidence"
    | "orders"
    | "humans"
    | "events"
    | "organizations"
    | "payeeLedger"
    | "earlyFraudWarnings"
  >;
  logger?: LoggerPort;
  /** Reports the swallowed best-effort display lookups. */
  reportError?: ReporterPort | null;
};

export async function getDisputeForDesk(
  deps: GetDisputeForDeskDeps,
  rawInput: unknown,
): Promise<GetDisputeForDeskOutput> {
  const input = parseInput(getDisputeForDeskInputSchema, rawInput);
  await requireDisputeDeskStaff(deps, input.actorHumanId, "read");

  const dispute = await deps.repos.disputes.getById(input.disputeId);
  if (!dispute) {
    throw fail("DISPUTE_NOT_FOUND", { meta: { disputeId: input.disputeId } });
  }

  const optional = async <T>(
    source: string,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      deps.logger?.error("dispute.desk.lookup_failed", {
        disputeId: dispute.id,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        deps.reportError?.(err, {
          tags: { useCase: "getDisputeForDesk", source },
          extra: { disputeId: dispute.id },
        });
      } catch {
        // Reporter failures never change behaviour.
      }
      return null;
    }
  };

  const order = dispute.orderId
    ? await optional("order", () => deps.repos.orders.getById(dispute.orderId!))
    : null;
  const buyer = order
    ? await optional("buyer", () =>
        deps.repos.humans.getByIdWithIdentity(order.buyerHumanId),
      )
    : null;
  const buyerFallback =
    order && !buyer
      ? await optional("buyer", () => deps.repos.humans.getById(order.buyerHumanId))
      : null;
  const event = order?.eventId
    ? await optional("event", () => deps.repos.events.getById(order.eventId!))
    : null;

  let owner: GetDisputeForDeskOutput["owner"] = null;
  if (dispute.ownerSubjectType === "ORGANIZATION" && dispute.ownerSubjectId) {
    const org = await optional("owner", () =>
      deps.repos.organizations.getById(dispute.ownerSubjectId!),
    );
    owner = {
      subjectType: "ORGANIZATION",
      subjectId: dispute.ownerSubjectId,
      name: org?.name ?? null,
    };
  } else if (dispute.ownerSubjectType === "HUMAN" && dispute.ownerSubjectId) {
    const human = await optional("owner", () =>
      deps.repos.humans.getById(dispute.ownerSubjectId!),
    );
    owner = {
      subjectType: "HUMAN",
      subjectId: dispute.ownerSubjectId,
      name: human?.name ?? null,
    };
  }

  const earlyFraudWarning = dispute.orderId
    ? await optional("earlyFraudWarning", () =>
        deps.repos.earlyFraudWarnings.findLatestForOrder(dispute.orderId!),
      )
    : null;

  const evidence = await deps.repos.disputeEvidence.getByDisputeId(dispute.id);
  const [activeHolds, debits] = await Promise.all([
    deps.repos.payeeLedger.listActiveHoldsByDispute(dispute.id),
    deps.repos.payeeLedger.listDebitsForDispute(dispute.id),
  ]);
  const toLine = (entry: (typeof activeHolds)[number]) => ({
    id: entry.id,
    type: entry.type,
    payeeId: entry.payeeId,
    amountCents: entry.amountCents,
    currency: entry.currency,
    createdAt: entry.createdAt,
    description: entry.description ?? null,
  });

  return getDisputeForDeskOutputSchema.parse({
    dispute: {
      id: dispute.id,
      stripeDisputeId: dispute.stripeDisputeId,
      stripeChargeId: dispute.stripeChargeId,
      paymentIntentId: dispute.paymentIntentId,
      status: dispute.status,
      reason: dispute.reason,
      amountCents: dispute.amountCents,
      feeCents: dispute.feeCents,
      feeBorneBy: dispute.feeBorneBy,
      currency: dispute.currency,
      triageReason: dispute.triageReason,
      linkedAt: dispute.linkedAt,
      evidenceDueBy: dispute.evidenceDueBy,
      evidenceHasEvidence: dispute.evidenceHasEvidence,
      evidencePastDue: dispute.evidencePastDue,
      evidenceSubmissionCount: dispute.evidenceSubmissionCount,
      evidenceSubmittedAt: dispute.evidenceSubmittedAt,
      fundsWithdrawnAt: dispute.fundsWithdrawnAt,
      closedAt: dispute.closedAt,
      outcome: dispute.outcome,
      createdAt: dispute.createdAt,
      updatedAt: dispute.updatedAt,
    },
    order: order
      ? {
          id: order.id,
          kind: order.kind,
          status: order.status,
          amountGrossCents: order.amountGrossCents,
          taxAmountCents: order.taxAmountCents,
          currency: order.currency,
          occurredAt: order.occurredAt,
          paymentChannel: order.paymentChannel,
          paymentMethodType: order.paymentMethodType,
          billingDescriptor: order.billingDescriptor ?? null,
          // Same effective value the evidence packet sends to Stripe.
          checkoutIp: order.checkoutIp ?? order.refundPolicyAckIp ?? null,
          disputeStatus: order.disputeStatus ?? null,
        }
      : null,
    buyer: order
      ? {
          humanId: order.buyerHumanId,
          name: buyer?.human.name ?? buyerFallback?.name ?? null,
          email: buyer?.identity.email ?? null,
        }
      : null,
    event: event
      ? {
          id: event.id,
          title: event.title,
          startsAt: event.startsAt,
          timezone: event.timezone,
        }
      : null,
    owner,
    evidence,
    earlyFraudWarning: earlyFraudWarning
      ? {
          fraudType: earlyFraudWarning.fraudType,
          stripeCreatedAt: earlyFraudWarning.stripeCreatedAt,
        }
      : null,
    ledger: {
      activeHolds: activeHolds.map(toLine),
      debits: debits.map(toLine),
      heldCents: activeHolds.reduce((sum, e) => sum + e.amountCents, 0),
      debitedCents: debits.reduce((sum, e) => sum + Math.abs(e.amountCents), 0),
    },
  });
}
