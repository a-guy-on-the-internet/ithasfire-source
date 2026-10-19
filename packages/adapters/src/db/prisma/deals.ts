import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  DealChange,
  PayoutTermsDeduction,
  PayoutTermsLine,
  SettlementSheet,
  SettlementSheetDeductionActual,
  SettlementSheetDirectPayment,
  SettlementSheetOffPlatformAmount,
} from "@prisma/client";
import type {
  DealChangeRecord,
  DealClauseRecord,
  DealDeductionRecord,
  DealsRepo,
  EventTicketLedgerRecord,
  PayoutTermsReference,
  SettlementSheetDeductionActualRecord,
  SettlementSheetDirectPaymentRecord,
  SettlementSheetOffPlatformRecord,
  SettlementSheetRecord,
} from "@th/ports/repos/deals";

import type { PrismaClientOrTx } from "./types";

/**
 * Deal terms storage and the settlement sheet (deal-terms-and-settlement
 * stage 1, P4b). DTOs only; every rule (shape, participants, who may write,
 * the arithmetic of the ledger figures) lives in core.
 *
 * The per-order payout fence is in `payout-terms.ts`
 * (`PER_ORDER_PAYOUT_LINE_WHERE`); this repo is the one place that reads and
 * writes EVERY line of a terms row.
 */

/** Postgres caps bind parameters at 65,535; stay far below it per IN list. */
const IN_CHUNK = 5_000;

/**
 * Temporary offset for deduction reordering. `(payoutTermsId, sortOrder)` is
 * unique and checked per statement, so rows that swap places are first moved
 * clear of every final position. Far above any real waterfall (core caps a
 * deal at 100 items) and far below int4.
 */
const SORT_ORDER_PARKING = 1_000_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function makeDealsRepo(p: PrismaClientOrTx): DealsRepo {
  return {
    async lockTerms(payoutTermsId) {
      // A row-level write lock held until the transaction ends: a concurrent
      // lockTerms on the same row blocks here until this one commits.
      const result = await p.payoutTerms.updateMany({
        where: { id: payoutTermsId },
        data: { updatedAt: new Date() },
      });
      return result.count === 1;
    },

    async listTermsReferences(payoutTermsId) {
      // Two per kind is enough to answer "is this the only reference?".
      const take = 2;
      const id = payoutTermsId;
      const select = { id: true } as const;
      const [
        agreements,
        eventsPrimary,
        eventsResale,
        eventsMerch,
        orgsPrimary,
        orgsResale,
        humansPrimary,
        humansResale,
        placesPrimary,
        placesResale,
        settlements,
      ] = await Promise.all([
        p.agreement.findMany({ where: { payoutTermsId: id }, select, take }),
        p.event.findMany({ where: { payoutTermsId: id }, select, take }),
        p.event.findMany({ where: { resalePayoutTermsId: id }, select, take }),
        p.event.findMany({ where: { merchPayoutTermsId: id }, select, take }),
        p.organization.findMany({ where: { defaultPrimaryPayoutTermsId: id }, select, take }),
        p.organization.findMany({ where: { defaultResalePayoutTermsId: id }, select, take }),
        p.human.findMany({ where: { defaultPrimaryPayoutTermsId: id }, select, take }),
        p.human.findMany({ where: { defaultResalePayoutTermsId: id }, select, take }),
        p.place.findMany({ where: { defaultPrimaryPayoutTermsId: id }, select, take }),
        p.place.findMany({ where: { defaultResalePayoutTermsId: id }, select, take }),
        p.settlement.findMany({ where: { payoutTermsId: id }, select, take }),
      ]);
      const out: PayoutTermsReference[] = [];
      const add = (kind: PayoutTermsReference["kind"], rows: Array<{ id: string }>) => {
        for (const row of rows) out.push({ kind, id: row.id });
      };
      add("AGREEMENT", agreements);
      add("EVENT_PRIMARY", eventsPrimary);
      add("EVENT_RESALE", eventsResale);
      add("EVENT_MERCH", eventsMerch);
      add("ORG_DEFAULT_PRIMARY", orgsPrimary);
      add("ORG_DEFAULT_RESALE", orgsResale);
      add("HUMAN_DEFAULT_PRIMARY", humansPrimary);
      add("HUMAN_DEFAULT_RESALE", humansResale);
      add("PLACE_DEFAULT_PRIMARY", placesPrimary);
      add("PLACE_DEFAULT_RESALE", placesResale);
      add("SETTLEMENT", settlements);
      return out;
    },

    async answerDealClause(input) {
      const nonNull = input.expectedFrom.filter((s): s is "PENDING" => s !== null);
      const allowsNull = nonNull.length !== input.expectedFrom.length;
      const result = await p.payoutTermsLine.updateMany({
        where: {
          id: input.clauseId,
          payoutTermsId: input.payoutTermsId,
          requiresConfirmation: true,
          // Settled directly only: per-order lines answer through the
          // payout-terms repo, behind its PER_ORDER_PAYOUT_LINE_WHERE fence.
          NOT: { amountType: "PERCENT", basis: "GROSS" },
          OR: [
            ...(nonNull.length > 0 ? [{ confirmationStatus: { in: nonNull } }] : []),
            ...(allowsNull ? [{ confirmationStatus: null }] : []),
          ],
        },
        data: {
          confirmationStatus: input.confirmationStatus,
          confirmedAt: input.confirmedAt,
          counterPercentBps: null,
          counterNote: null,
        },
      });
      return result.count === 1;
    },

    async linkEventPrimaryTermsIfUnset({ eventId, payoutTermsId }) {
      const result = await p.event.updateMany({
        where: { id: eventId, payoutTermsId: null },
        data: { payoutTermsId },
      });
      return result.count === 1;
    },

    async linkOrgDefaultResaleTermsIfUnset({ orgId, payoutTermsId }) {
      const result = await p.organization.updateMany({
        where: { id: orgId, defaultResalePayoutTermsId: null },
        data: { defaultResalePayoutTermsId: payoutTermsId },
      });
      return result.count === 1;
    },

    async getTermsDeal(payoutTermsId) {
      const terms = await p.payoutTerms.findUnique({
        where: { id: payoutTermsId },
        select: {
          id: true,
          remainderPayeeId: true,
          lines: { orderBy: [{ priority: "asc" }, { id: "asc" }] },
          deductions: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
        },
      });
      if (!terms) return null;
      return {
        payoutTermsId: terms.id,
        remainderPayeeId: terms.remainderPayeeId ?? null,
        clauses: terms.lines.map(toClauseRecord),
        deductions: terms.deductions.map(toDeductionRecord),
      };
    },

    async replaceTermsDeal(input) {
      const { payoutTermsId } = input;
      const clauseIds = input.clauses.map((c) => c.id);
      const deductionIds = input.deductions.map((d) => d.id);

      // Lines: drop the ones the deal no longer has, update the kept ones in
      // place (their ids — and so any confirmation referencing them — stay),
      // insert the new ones.
      await p.payoutTermsLine.deleteMany({
        where: { payoutTermsId, id: { notIn: clauseIds } },
      });
      for (const clause of input.clauses) {
        const data = {
          payeeId: clause.payeeId,
          ticketTypeId: clause.ticketTypeId,
          amountType: clause.amountType,
          amountCents: clause.amountCents,
          percent: clause.percent,
          basis: clause.basis,
          resolution: clause.resolution,
          displayLabel: clause.displayLabel,
          floorCents: clause.floorCents,
          capPercent: clause.capPercent,
          priority: clause.priority,
          rounding: clause.rounding,
          requiresConfirmation: clause.requiresConfirmation,
          confirmationStatus: clause.confirmationStatus,
          confirmedAt: clause.confirmedAt,
          counterPercentBps: clause.counterPercentBps,
          counterNote: clause.counterNote,
        };
        // Scoped to THIS terms row: an id that belongs to another terms row
        // is never moved here — the create below then fails on the primary
        // key instead.
        const updated = await p.payoutTermsLine.updateMany({
          where: { id: clause.id, payoutTermsId },
          data,
        });
        if (updated.count === 0) {
          await p.payoutTermsLine.create({
            data: { id: clause.id, payoutTermsId, ...data },
          });
        }
      }

      // Deductions: same, keeping ids so typed-in actuals stay attached.
      await p.payoutTermsDeduction.deleteMany({
        where: { payoutTermsId, id: { notIn: deductionIds } },
      });
      await p.payoutTermsDeduction.updateMany({
        where: { payoutTermsId },
        data: { sortOrder: { increment: SORT_ORDER_PARKING } },
      });
      for (const [sortOrder, deduction] of input.deductions.entries()) {
        const data = {
          kind: deduction.kind,
          label: deduction.label,
          amountCents: deduction.amountCents,
          percent: deduction.percent,
          creditedPayeeId: deduction.creditedPayeeId,
          estimated: deduction.estimated,
          sortOrder,
        };
        const updated = await p.payoutTermsDeduction.updateMany({
          where: { id: deduction.id, payoutTermsId },
          data,
        });
        if (updated.count === 0) {
          await p.payoutTermsDeduction.create({
            data: { id: deduction.id, payoutTermsId, ...data },
          });
        }
      }

      await p.payoutTerms.update({
        where: { id: payoutTermsId },
        data: { remainderPayeeId: input.remainderPayeeId },
      });
    },

    async getSheetByEventId(eventId) {
      const sheet = await p.settlementSheet.findUnique({
        where: { eventId },
        include: {
          offPlatform: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          deductionActuals: { orderBy: [{ enteredAt: "asc" }, { id: "asc" }] },
          directPayments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        },
      });
      return sheet ? toSheetRecord(sheet) : null;
    },

    async ensureSheet(eventId) {
      // INSERT … ON CONFLICT DO NOTHING: a concurrent first write never
      // raises (a caught P2002 would abort the caller's transaction); the
      // loser adopts the winner's row below.
      await p.settlementSheet.createMany({
        data: [{ id: randomUUID(), eventId }],
        skipDuplicates: true,
      });
      const row = await p.settlementSheet.findUniqueOrThrow({
        where: { eventId },
        select: { id: true },
      });
      return { id: row.id };
    },

    async lockDraftSheet(sheetId) {
      const result = await p.settlementSheet.updateMany({
        where: { id: sheetId, status: "DRAFT" },
        data: { revision: { increment: 1 } },
      });
      return result.count === 1;
    },

    async lockSettledSheet(sheetId) {
      const result = await p.settlementSheet.updateMany({
        where: { id: sheetId, status: "SETTLED" },
        data: { revision: { increment: 1 } },
      });
      return result.count === 1;
    },

    async upsertOffPlatform(input) {
      const data = {
        kind: input.kind,
        label: input.label,
        amountCents: input.amountCents,
        heldByPayeeId: input.heldByPayeeId,
        ownerPayeeId: input.ownerPayeeId,
        enteredByHumanId: input.enteredByHumanId,
        enteredAt: input.enteredAt,
      };
      if (input.id) {
        const updated = await p.settlementSheetOffPlatformAmount.updateMany({
          where: { id: input.id, sheetId: input.sheetId },
          data,
        });
        if (updated.count === 0) return null;
        const row = await p.settlementSheetOffPlatformAmount.findUniqueOrThrow({
          where: { id: input.id },
        });
        return toOffPlatformRecord(row);
      }
      const row = await p.settlementSheetOffPlatformAmount.create({
        data: { sheetId: input.sheetId, ...data },
      });
      return toOffPlatformRecord(row);
    },

    async deleteOffPlatform(sheetId, rowId) {
      const result = await p.settlementSheetOffPlatformAmount.deleteMany({
        where: { id: rowId, sheetId },
      });
      return result.count > 0;
    },

    async upsertDeductionActual(input) {
      const row = await p.settlementSheetDeductionActual.upsert({
        where: {
          sheetId_deductionId: {
            sheetId: input.sheetId,
            deductionId: input.deductionId,
          },
        },
        create: {
          sheetId: input.sheetId,
          deductionId: input.deductionId,
          amountCents: input.amountCents,
          enteredByHumanId: input.enteredByHumanId,
          enteredAt: input.enteredAt,
        },
        update: {
          amountCents: input.amountCents,
          enteredByHumanId: input.enteredByHumanId,
          enteredAt: input.enteredAt,
        },
      });
      return toDeductionActualRecord(row);
    },

    async deleteDeductionActual(sheetId, deductionId) {
      const result = await p.settlementSheetDeductionActual.deleteMany({
        where: { sheetId, deductionId },
      });
      return result.count > 0;
    },

    async createDirectPayment(input) {
      const row = await p.settlementSheetDirectPayment.create({
        data: {
          sheetId: input.sheetId,
          fromPayeeId: input.fromPayeeId,
          toPayeeId: input.toPayeeId,
          amountCents: input.amountCents,
          label: input.label,
          note: input.note,
          enteredByHumanId: input.enteredByHumanId,
          enteredAt: input.enteredAt,
        },
      });
      return toDirectPaymentRecord(row);
    },

    async deleteDirectPayment(sheetId, paymentId) {
      const result = await p.settlementSheetDirectPayment.deleteMany({
        where: { id: paymentId, sheetId },
      });
      return result.count > 0;
    },

    async markSheetSettled(input) {
      const result = await p.settlementSheet.updateMany({
        where: { id: input.sheetId, status: "DRAFT" },
        data: {
          status: "SETTLED",
          settledByHumanId: input.settledByHumanId,
          settledAt: input.settledAt,
          engineVersion: input.engineVersion,
          snapshot: input.snapshot as Prisma.InputJsonValue,
          revision: { increment: 1 },
        },
      });
      return result.count === 1;
    },

    async reopenSheet(input) {
      const result = await p.settlementSheet.updateMany({
        where: { id: input.sheetId, status: "SETTLED" },
        data: {
          status: "DRAFT",
          settledByHumanId: null,
          settledAt: null,
          engineVersion: null,
          snapshot: Prisma.DbNull,
          reopenedAt: input.reopenedAt,
          reopenedByHumanId: input.reopenedByHumanId,
          revision: { increment: 1 },
        },
      });
      return result.count === 1;
    },

    async readEventTicketLedger(eventId): Promise<EventTicketLedgerRecord> {
      const orders = await p.order.findMany({
        where: { eventId, kind: "TICKETING", source: "PRIMARY" },
        select: {
          id: true,
          status: true,
          paymentChannel: true,
          amountGrossCents: true,
          feesPlatformCents: true,
          feePolicySnapshot: true,
        },
        orderBy: { id: "asc" },
      });

      // Refunded items of CASH orders, so a part-refunded cash sale counts
      // net of what was handed back (the cash till report's own netting).
      const cashRefunded = new Map<string, number>();
      for (const ids of chunks(
        orders.filter((o) => o.paymentChannel === "CASH").map((o) => o.id),
        IN_CHUNK,
      )) {
        const rows = await p.orderItem.groupBy({
          by: ["orderId"],
          where: { orderId: { in: ids }, status: "refunded" },
          _sum: { amountCents: true },
        });
        for (const r of rows) cashRefunded.set(r.orderId, r._sum.amountCents ?? 0);
      }

      const disputes: EventTicketLedgerRecord["disputes"] = [];
      for (const ids of chunks(
        orders.map((o) => o.id),
        IN_CHUNK,
      )) {
        const rows = await p.dispute.findMany({
          where: { orderId: { in: ids } },
          select: { orderId: true, status: true, amountCents: true },
          orderBy: [{ orderId: "asc" }, { id: "asc" }],
        });
        for (const r of rows) {
          if (r.orderId) {
            disputes.push({ orderId: r.orderId, status: r.status, amountCents: r.amountCents });
          }
        }
      }

      const credited = new Set<string>();
      const perPayee = new Map<string, { creditCents: number; refundDebitCents: number }>();
      const currencies = new Set<string>();
      const sums: Array<{
        orderId: string | null;
        payeeId: string;
        type: string;
        currency: string;
        amount: number;
      }> = [];

      for (const ids of chunks(
        orders.map((o) => o.id),
        IN_CHUNK,
      )) {
        const grouped = await p.payeeLedgerEntry.groupBy({
          by: ["orderId", "payeeId", "type", "currency"],
          where: {
            orderId: { in: ids },
            type: { in: ["SETTLEMENT_CREDIT", "REFUND_DEBIT"] },
          },
          _sum: { amountCents: true },
        });
        for (const g of grouped) {
          sums.push({
            orderId: g.orderId,
            payeeId: g.payeeId,
            type: g.type,
            currency: g.currency,
            amount: g._sum.amountCents ?? 0,
          });
          if (g.type === "SETTLEMENT_CREDIT" && g.orderId) credited.add(g.orderId);
        }
      }

      for (const s of sums) {
        // Only the credited orders are the order set; a debit always sits on
        // a credited order (the refund writer debits a credit), so this
        // filter drops nothing real — it states the rule.
        if (!s.orderId || !credited.has(s.orderId)) continue;
        currencies.add(s.currency);
        const agg = perPayee.get(s.payeeId) ?? { creditCents: 0, refundDebitCents: 0 };
        if (s.type === "SETTLEMENT_CREDIT") agg.creditCents += s.amount;
        else agg.refundDebitCents += s.amount;
        perPayee.set(s.payeeId, agg);
      }

      let refundCount = 0;
      for (const ids of chunks([...credited].sort(), IN_CHUNK)) {
        const refunds = await p.payeeLedgerEntry.groupBy({
          by: ["orderId", "sourceId"],
          where: { orderId: { in: ids }, type: "REFUND_DEBIT" },
        });
        refundCount += refunds.length;
      }

      return {
        orders: orders.map((o) => ({
          orderId: o.id,
          status: o.status,
          paymentChannel: o.paymentChannel,
          refundedItemCents: cashRefunded.get(o.id) ?? 0,
          amountGrossCents: o.amountGrossCents,
          feesPlatformCents: o.feesPlatformCents,
          feePolicySnapshot: o.feePolicySnapshot,
          credited: credited.has(o.id),
        })),
        disputes,
        refundCount,
        perPayee: [...perPayee.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([payeeId, agg]) => ({ payeeId, ...agg })),
        currencies: [...currencies].sort(),
      };
    },

    // ── freeze-the-deal (FR-001, FR-005, FR-007) ──

    async freezeEventDealIfUnfrozen({ eventId, frozenAt, frozenByHumanId }) {
      // Guarded: an existing freeze is never overwritten (FR-002 re-publish,
      // FR-003 already frozen).
      const result = await p.event.updateMany({
        where: { id: eventId, dealFrozenAt: null },
        data: { dealFrozenAt: frozenAt, dealFrozenByHumanId: frozenByHumanId },
      });
      return result.count === 1;
    },

    async createDealChange(input) {
      const row = await p.dealChange.create({
        data: {
          eventId: input.eventId,
          actorHumanId: input.actorHumanId,
          createdAt: input.createdAt,
          before: input.before as Prisma.InputJsonValue,
          after: input.after as Prisma.InputJsonValue,
        },
      });
      return toDealChangeRecord(row);
    },

    async listDealChanges({ eventId, limit, cursor }) {
      const rows = await p.dealChange.findMany({
        where: { eventId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map(toDealChangeRecord),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },

    async listDealChangeSnapshots(eventId) {
      return p.dealChange.findMany({
        where: { eventId },
        select: { before: true, after: true },
      });
    },
  };
}

function toDealChangeRecord(row: DealChange): DealChangeRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    actorHumanId: row.actorHumanId,
    createdAt: row.createdAt,
    before: row.before,
    after: row.after,
  };
}

function toClauseRecord(line: PayoutTermsLine): DealClauseRecord {
  return {
    id: line.id,
    payoutTermsId: line.payoutTermsId,
    payeeId: line.payeeId,
    amountType: line.amountType,
    amountCents: line.amountCents ?? null,
    percent: line.percent ?? null,
    basis: line.basis,
    resolution: line.resolution ?? null,
    displayLabel: line.displayLabel ?? null,
    ticketTypeId: line.ticketTypeId ?? null,
    floorCents: line.floorCents,
    capPercent: line.capPercent ?? null,
    priority: line.priority,
    rounding: line.rounding,
    requiresConfirmation: line.requiresConfirmation,
    confirmationStatus: line.confirmationStatus ?? null,
    confirmedAt: line.confirmedAt ?? null,
    counterPercentBps: line.counterPercentBps ?? null,
    counterNote: line.counterNote ?? null,
  };
}

function toDeductionRecord(row: PayoutTermsDeduction): DealDeductionRecord {
  return {
    id: row.id,
    payoutTermsId: row.payoutTermsId,
    kind: row.kind,
    label: row.label,
    amountCents: row.amountCents ?? null,
    percent: row.percent ?? null,
    creditedPayeeId: row.creditedPayeeId,
    estimated: row.estimated,
    sortOrder: row.sortOrder,
  };
}

function toOffPlatformRecord(
  row: SettlementSheetOffPlatformAmount,
): SettlementSheetOffPlatformRecord {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    amountCents: row.amountCents ?? null,
    heldByPayeeId: row.heldByPayeeId,
    ownerPayeeId: row.ownerPayeeId ?? null,
    enteredByHumanId: row.enteredByHumanId,
    enteredAt: row.enteredAt,
  };
}

function toDeductionActualRecord(
  row: SettlementSheetDeductionActual,
): SettlementSheetDeductionActualRecord {
  return {
    id: row.id,
    deductionId: row.deductionId,
    amountCents: row.amountCents,
    enteredByHumanId: row.enteredByHumanId,
    enteredAt: row.enteredAt,
  };
}

function toDirectPaymentRecord(
  row: SettlementSheetDirectPayment,
): SettlementSheetDirectPaymentRecord {
  return {
    id: row.id,
    fromPayeeId: row.fromPayeeId,
    toPayeeId: row.toPayeeId,
    amountCents: row.amountCents,
    label: row.label,
    note: row.note ?? null,
    enteredByHumanId: row.enteredByHumanId,
    enteredAt: row.enteredAt,
  };
}

function toSheetRecord(
  sheet: SettlementSheet & {
    offPlatform: SettlementSheetOffPlatformAmount[];
    deductionActuals: SettlementSheetDeductionActual[];
    directPayments: SettlementSheetDirectPayment[];
  },
): SettlementSheetRecord {
  return {
    id: sheet.id,
    eventId: sheet.eventId,
    status: sheet.status,
    settledByHumanId: sheet.settledByHumanId ?? null,
    settledAt: sheet.settledAt ?? null,
    engineVersion: sheet.engineVersion ?? null,
    snapshot: sheet.snapshot ?? null,
    revision: sheet.revision,
    reopenedAt: sheet.reopenedAt ?? null,
    reopenedByHumanId: sheet.reopenedByHumanId ?? null,
    offPlatform: sheet.offPlatform.map(toOffPlatformRecord),
    deductionActuals: sheet.deductionActuals.map(toDeductionActualRecord),
    directPayments: sheet.directPayments.map(toDirectPaymentRecord),
  };
}
