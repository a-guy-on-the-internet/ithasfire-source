import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { PayoutTerms, PayoutTermsLine } from "@prisma/client";
import type {
  PayoutTermsRepo,
  PayoutTermsRecord,
  PayoutTermsLineRecord,
  PayoutTermsLineInput,
  PayoutLineConfirmationStatus,
  CreatePayoutTermsDraftInput,
  UpdatePayoutTermsDraftInput,
  PayoutSchedule,
  PayoutTermsStatus,
  ProvisionDefaultPrimaryInput,
} from "@th/ports/repos/payout-terms";

import type { PrismaClientOrTx } from "./types";

/**
 * Shared helper used by both the PayoutTermsRepo.clone method and the events
 * adapter (which snapshots PayoutTerms at event creation). Returns the raw
 * Prisma row so callers can either map to a record or use the id directly.
 */
export async function clonePayoutTermsRow(
  p: PrismaClientOrTx,
  input: {
    sourcePayoutTermsId: string;
    payoutScheduleOverride?: PayoutSchedule;
    isDefault: boolean;
    resetConfirmations?: boolean;
    bumpVersion?: boolean;
    statusOverride?: PayoutTermsStatus;
    /** See `PayoutTermsRepo.clone`. Required so every caller decides. */
    resetFeeMode: boolean;
  },
): Promise<PayoutTerms | null> {
  const source = await p.payoutTerms.findUnique({
    where: { id: input.sourcePayoutTermsId },
    include: {
      lines: true,
      feePolicy: { select: { feeMode: true } },
      // ── P4b (deal terms) ──
      deductions: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!source) return null;

  return p.payoutTerms.create({
    data: {
      kind: source.kind,
      status: input.statusOverride ?? source.status,
      isDefault: input.isDefault,
      version: input.bumpVersion ? source.version + 1 : 1,
      settlementCurrency: source.settlementCurrency,
      // A snapshot of a default never inherits a mode
      // (docs/decisions/fee-mode-switch-dropped.md).
      feeMode: input.resetFeeMode ? null : source.feeMode,
      // Nor a pin to an ABSORB policy. Inert since ABSORB was removed
      // (docs/decisions/absorb-removed.md): the migration converted every such
      // policy, and pricing never reads a policy's mode (SALE_FEE_MODE).
      feePolicyId:
        input.resetFeeMode && source.feePolicy?.feeMode === "ABSORB"
          ? null
          : source.feePolicyId,
      payoutSchedule: input.payoutScheduleOverride ?? source.payoutSchedule,
      resaleProcessingFeeConfigRef: source.resaleProcessingFeeConfigRef,
      resalePayoutReleaseDays: source.resalePayoutReleaseDays,
      // The resale share clause (organiser-resale-share FR-001) travels with
      // the clone, so an event snapshot of the org default keeps its clause.
      resaleShareType: source.resaleShareType,
      resaleShareBps: source.resaleShareBps,
      resaleShareCents: source.resaleShareCents,
      resaleSharePayer: source.resaleSharePayer,
      effectiveFrom: source.effectiveFrom,
      effectiveTo: source.effectiveTo,
      // ── P4b (deal terms) ── the whole deal travels with the clone: the
      // remainder holder, every clause (settled-directly ones included) and
      // the costs off the top, in order. A clone that dropped them would
      // quietly turn a guarantee into nothing at booking accept.
      remainderPayeeId: source.remainderPayeeId,
      deductions: {
        create: source.deductions.map((deduction) => ({
          kind: deduction.kind,
          label: deduction.label,
          amountCents: deduction.amountCents,
          percent: deduction.percent,
          creditedPayeeId: deduction.creditedPayeeId,
          estimated: deduction.estimated,
          sortOrder: deduction.sortOrder,
        })),
      },
      lines: {
        create: source.lines.map((line) => {
          // A clause SETTLED DIRECTLY (anything but a per-order PERCENT/GROSS
          // line) never carries its payee's answer into a copy: the answer
          // was given to the source row — on a default, a template no one
          // can confirm — and a new event or agreement built from it is a
          // deal that payee has not seen. Per-order lines keep the existing
          // rule (`resetConfirmations`).
          const settledDirectly =
            line.amountType !== PER_ORDER_PAYOUT_LINE_WHERE.amountType ||
            line.basis !== PER_ORDER_PAYOUT_LINE_WHERE.basis;
          const needsReset =
            line.requiresConfirmation &&
            (input.resetConfirmations || settledDirectly);
          return {
            payeeId: line.payeeId,
            ticketTypeId: line.ticketTypeId,
            percent: line.percent,
            floorCents: line.floorCents,
            capPercent: line.capPercent,
            priority: line.priority,
            rounding: line.rounding,
            requiresConfirmation: line.requiresConfirmation,
            confirmationStatus: needsReset
              ? "PENDING"
              : line.confirmationStatus,
            confirmedAt: needsReset ? null : line.confirmedAt,
            counterPercentBps: needsReset ? null : line.counterPercentBps,
            counterNote: needsReset ? null : line.counterNote,
            // ── P4b (deal terms) ──
            amountType: line.amountType,
            amountCents: line.amountCents,
            basis: line.basis,
            resolution: line.resolution,
            displayLabel: line.displayLabel,
          };
        }),
      },
    },
  });
}

// ── P4b (deal terms) ──
/**
 * THE FR-005 FENCE. A payout line — the only kind the per-order engine may
 * pay — is a PERCENT clause on the GROSS basis. Every line read and write
 * this repo exposes (`listLines`, `listLinesByTermsIds`, `getLineById`,
 * `updateLineConfirmation`, `replaceLines`) is scoped by it, so a FIXED,
 * NET_POOL or FIXED_AND_PERCENT clause is structurally unable to reach
 * `computeOrderSplits`, a checkout preview, a publish gate or a legacy line
 * editor (whose `replaceLines` therefore never deletes one). Every pre-P4b
 * row matches it by the column defaults, so what is paid today is unchanged.
 * The whole deal is read and written through `DealsRepo` instead.
 */
export const PER_ORDER_PAYOUT_LINE_WHERE = {
  amountType: "PERCENT",
  basis: "GROSS",
} as const satisfies Prisma.PayoutTermsLineWhereInput;

export function makePayoutTermsRepo(p: PrismaClientOrTx): PayoutTermsRepo {
  return {
    async getById(payoutTermsId) {
      const row = await p.payoutTerms.findUnique({
        where: { id: payoutTermsId },
      });
      return row ? toPayoutTermsRecord(row) : null;
    },
    async listByEvent(eventId) {
      const event = await p.event.findUnique({
        where: { id: eventId },
        select: { payoutTermsId: true, resalePayoutTermsId: true },
      });
      if (!event) return [];

      const ids = [event.payoutTermsId, event.resalePayoutTermsId].filter(
        (id): id is string => id != null,
      );
      if (ids.length === 0) return [];

      const rows = await p.payoutTerms.findMany({ where: { id: { in: ids } } });
      return rows.map(toPayoutTermsRecord);
    },
    async listByEventIds(eventIds) {
      const unique = [...new Set(eventIds)];
      const result = new Map<string, PayoutTermsRecord[]>();
      if (unique.length === 0) return result;

      // TWO queries for any number of events: the events' two terms pointers,
      // then every pointed-at terms row.
      const events = await p.event.findMany({
        where: { id: { in: unique } },
        select: { id: true, payoutTermsId: true, resalePayoutTermsId: true },
      });
      const termsIds = new Set<string>();
      for (const event of events) {
        if (event.payoutTermsId) termsIds.add(event.payoutTermsId);
        if (event.resalePayoutTermsId) termsIds.add(event.resalePayoutTermsId);
      }
      const rows =
        termsIds.size === 0
          ? []
          : await p.payoutTerms.findMany({
              where: { id: { in: [...termsIds] } },
            });
      const byId = new Map(rows.map((row) => [row.id, row] as const));

      for (const id of unique) result.set(id, []);
      for (const event of events) {
        const terms: PayoutTermsRecord[] = [];
        for (const termsId of [event.payoutTermsId, event.resalePayoutTermsId]) {
          const row = termsId ? byId.get(termsId) : undefined;
          if (row) terms.push(toPayoutTermsRecord(row));
        }
        result.set(event.id, terms);
      }
      return result;
    },
    async createDraft(input) {
      const created = await p.payoutTerms.create({
        data: toCreateDraftData(input),
      });
      return toPayoutTermsRecord(created);
    },
    async provisionDefaultPrimary(input: ProvisionDefaultPrimaryInput) {
      const created = await p.payoutTerms.create({
        data: {
          kind: "PRIMARY",
          status: "ACTIVE",
          isDefault: input.isDefault,
          version: 1,
          settlementCurrency: input.settlementCurrency,
          // Only set when provided so the schema default applies otherwise.
          ...(input.payoutSchedule !== undefined
            ? { payoutSchedule: input.payoutSchedule }
            : {}),
          lines: {
            create: [
              {
                payeeId: input.payeeId,
                percent: 100,
                floorCents: 0,
                capPercent: null,
                priority: 0,
                rounding: "FLOOR",
              },
            ],
          },
        },
      });
      return toPayoutTermsRecord(created);
    },
    async updateDraft(input) {
      const updated = await p.payoutTerms.update({
        where: { id: input.payoutTermsId },
        data: toUpdateDraftData(input),
      });
      return toPayoutTermsRecord(updated);
    },
    async activate(input) {
      // Guarded compare-and-swap mirroring `updateLineConfirmation`: the WHERE
      // pins the stored status to `expectedFrom`, so a concurrent transition
      // (another publish/finalize activating first, or an archive) results in
      // a 0-match instead of silently overwriting committed state. Unlike the
      // line CAS, a miss returns `null` rather than throwing — callers re-read
      // and decide whether the miss is benign (row already ACTIVE) or fatal.
      const result = await p.payoutTerms.updateMany({
        where: {
          id: input.payoutTermsId,
          status: { in: [...input.expectedFrom] },
        },
        data: { status: "ACTIVE", updatedAt: new Date() },
      });
      if (result.count === 0) {
        return null;
      }

      const updated = await p.payoutTerms.findUnique({
        where: { id: input.payoutTermsId },
      });
      return updated ? toPayoutTermsRecord(updated) : null;
    },
    async archive(input) {
      // The mirror of `activate`: the WHERE pins the stored status, so a
      // concurrent transition (or a second archive) is a 0-match → null.
      const result = await p.payoutTerms.updateMany({
        where: {
          id: input.payoutTermsId,
          status: { in: [...input.expectedFrom] },
        },
        data: { status: "ARCHIVED", updatedAt: new Date() },
      });
      if (result.count === 0) {
        return null;
      }

      const updated = await p.payoutTerms.findUnique({
        where: { id: input.payoutTermsId },
      });
      return updated ? toPayoutTermsRecord(updated) : null;
    },
    async replaceLines(payoutTermsId, lines) {
      // FR-005 fence: rewrites the payout lines only — a deal's clauses
      // settled directly are not this editor's to delete.
      await p.payoutTermsLine.deleteMany({
        where: { payoutTermsId, ...PER_ORDER_PAYOUT_LINE_WHERE },
      });

      if (lines.length === 0) {
        return;
      }

      const data = lines.map(toLineCreateInput.bind(null, payoutTermsId));
      await p.payoutTermsLine.createMany({ data });
    },
    async seedLinesIfEmpty(payoutTermsId, lines) {
      if (lines.length === 0) {
        return false;
      }

      // Single-statement conditional insert: the NOT EXISTS guard and the
      // insert are evaluated together, so a splits save (`replaceLines`
      // delete-all + createMany) that COMMITS between the caller's read and
      // this write makes the seed a no-op instead of clobbering fresh lines.
      // A parent-row lock wouldn't achieve this — `replaceLines` never
      // touches the PayoutTerms row, so it would never contend on the lock.
      // All values are bind parameters (tagged $executeRaw), never
      // interpolated; nullable params carry explicit casts so Postgres
      // doesn't type VALUES columns as text.
      const rows = lines.map((line) => {
        const id = line.id ?? randomUUID();
        return Prisma.sql`(
          ${id},
          ${payoutTermsId},
          ${line.payeeId},
          ${line.ticketTypeId ?? null}::text,
          ${line.percent}::int4,
          ${line.floorCents}::int4,
          ${line.capPercent ?? null}::int4,
          ${line.priority}::int4,
          ${line.rounding}::"PayoutTermsLineRounding",
          ${line.requiresConfirmation ?? false}::boolean,
          ${line.confirmationStatus ?? null}::"PayoutLineConfirmationStatus",
          ${line.confirmedAt ?? null}::timestamp,
          ${line.counterPercentBps ?? null}::int4,
          ${line.counterNote ?? null}::text
        )`;
      });

      const inserted = await p.$executeRaw`
        INSERT INTO "PayoutTermsLine" (
          "id", "payoutTermsId", "payeeId", "ticketTypeId", "percent",
          "floorCents", "capPercent", "priority", "rounding",
          "requiresConfirmation", "confirmationStatus", "confirmedAt",
          "counterPercentBps", "counterNote"
        )
        SELECT v.* FROM (VALUES ${Prisma.join(rows)}) AS v
        WHERE NOT EXISTS (
          SELECT 1 FROM "PayoutTermsLine"
          WHERE "payoutTermsId" = ${payoutTermsId}
        )
      `;

      return inserted > 0;
    },
    async listLines(payoutTermsId) {
      const lines = await p.payoutTermsLine.findMany({
        where: { payoutTermsId, ...PER_ORDER_PAYOUT_LINE_WHERE },
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });
      return lines.map(toPayoutTermsLineRecord);
    },
    async listLinesByTermsIds(payoutTermsIds) {
      const unique = [...new Set(payoutTermsIds)];
      const result = new Map<string, PayoutTermsLineRecord[]>();
      if (unique.length === 0) return result;
      for (const id of unique) result.set(id, []);
      // Same ordering as `listLines`, so each bucket matches it exactly.
      const lines = await p.payoutTermsLine.findMany({
        where: { payoutTermsId: { in: unique }, ...PER_ORDER_PAYOUT_LINE_WHERE },
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });
      for (const line of lines) {
        result.get(line.payoutTermsId)?.push(toPayoutTermsLineRecord(line));
      }
      return result;
    },
    async getLineById(lineId: string) {
      const row = await p.payoutTermsLine.findFirst({
        where: { id: lineId, ...PER_ORDER_PAYOUT_LINE_WHERE },
      });
      return row ? toPayoutTermsLineRecord(row) : null;
    },
    async updateLineConfirmation(input) {
      // Guarded compare-and-swap mirroring `agreements.updateStatus`: the
      // WHERE pins the stored status to `expectedFrom` so a decision based on
      // a stale read (e.g. a COUNTER racing a concurrent CONFIRM + finalize)
      // loses with a conflict instead of silently overwriting committed state.
      const expectedNonNull = input.expectedFrom.filter(
        (s): s is PayoutLineConfirmationStatus => s !== null,
      );
      const allowsNull = expectedNonNull.length !== input.expectedFrom.length;
      // Prisma's `in` never matches NULL, so legacy rows (null status, treated
      // as PENDING by the use case) need an explicit OR arm when allowed.
      const statusGuard: Prisma.PayoutTermsLineWhereInput = allowsNull
        ? {
            OR: [
              { confirmationStatus: { in: expectedNonNull } },
              { confirmationStatus: null },
            ],
          }
        : { confirmationStatus: { in: expectedNonNull } };

      const result = await p.payoutTermsLine.updateMany({
        where: {
          id: input.lineId,
          ...PER_ORDER_PAYOUT_LINE_WHERE,
          ...statusGuard,
        },
        data: {
          confirmationStatus: input.confirmationStatus,
          confirmedAt: input.confirmedAt,
          ...(input.counterPercentBps !== undefined
            ? { counterPercentBps: input.counterPercentBps }
            : {}),
          ...(input.counterNote !== undefined
            ? { counterNote: input.counterNote }
            : {}),
        },
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "payout_line_confirmation_changed",
        } as const;
      }

      const updated = await p.payoutTermsLine.findFirst({
        where: { id: input.lineId, ...PER_ORDER_PAYOUT_LINE_WHERE },
      });
      if (!updated) {
        // Row deleted between the guarded write and the re-fetch — surface
        // the same conflict the CAS loser would see.
        throw {
          code: "conflict",
          message: "payout_line_confirmation_changed",
        } as const;
      }
      return toPayoutTermsLineRecord(updated);
    },
    async pinFeePolicy({
      payoutTermsId,
      feePolicyId,
    }: {
      payoutTermsId: string;
      feePolicyId: string;
    }) {
      const updated = await p.payoutTerms.update({
        where: { id: payoutTermsId },
        data: { feePolicyId, updatedAt: new Date() },
      });
      return toPayoutTermsRecord(updated);
    },
    async clone(input) {
      const created = await clonePayoutTermsRow(p, input);
      return created ? toPayoutTermsRecord(created) : null;
    },
    async markNotDefault(payoutTermsId) {
      await p.payoutTerms.update({
        where: { id: payoutTermsId },
        data: { isDefault: false, updatedAt: new Date() },
      });
    },
  };
}

function toPayoutTermsRecord(row: PayoutTerms): PayoutTermsRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    feeMode: row.feeMode,
    feePolicyId: row.feePolicyId ?? null,
    isDefault: row.isDefault,
    settlementCurrency: row.settlementCurrency,
    payoutSchedule: row.payoutSchedule,
    resaleProcessingFeeConfigRef: row.resaleProcessingFeeConfigRef ?? null,
    resalePayoutReleaseDays: row.resalePayoutReleaseDays,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // ── P4b (deal terms) ──
    remainderPayeeId: row.remainderPayeeId ?? null,
    // ── Resale share clause (FR-001) ──
    resaleShareType: row.resaleShareType ?? null,
    resaleShareBps: row.resaleShareBps ?? null,
    resaleShareCents: row.resaleShareCents ?? null,
    resaleSharePayer: row.resaleSharePayer,
  };
}

function toPayoutTermsLineRecord(line: PayoutTermsLine): PayoutTermsLineRecord {
  // ── P4b (deal terms) ── every caller reads through the FR-005 fence, and the
  // shape CHECK makes a PERCENT row's percent NOT NULL. Reaching here with
  // anything else is a bug in this file: throw rather than hand the money
  // path a line it must not pay (or a null percent it would read as 0).
  if (
    line.amountType !== "PERCENT" ||
    line.basis !== "GROSS" ||
    line.percent === null
  ) {
    throw new Error(
      `payout_line_fence_breached: line ${line.id} is ${line.amountType}/${line.basis}`,
    );
  }
  return {
    id: line.id,
    payoutTermsId: line.payoutTermsId,
    payeeId: line.payeeId,
    ticketTypeId: line.ticketTypeId ?? null,
    percent: line.percent,
    amountType: line.amountType,
    basis: line.basis,
    floorCents: line.floorCents,
    capPercent: line.capPercent ?? null,
    priority: line.priority,
    rounding: line.rounding,
    requiresConfirmation: line.requiresConfirmation ?? false,
    confirmationStatus: line.confirmationStatus ?? null,
    confirmedAt: line.confirmedAt ?? null,
    counterPercentBps: line.counterPercentBps ?? null,
    counterNote: line.counterNote ?? null,
  };
}

function toLineCreateInput(
  payoutTermsId: string,
  line: PayoutTermsLineInput,
): Prisma.PayoutTermsLineCreateManyInput {
  const base = {
    payoutTermsId,
    payeeId: line.payeeId,
    ticketTypeId: line.ticketTypeId ?? null,
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent ?? null,
    priority: line.priority,
    rounding: line.rounding,
    requiresConfirmation: line.requiresConfirmation ?? false,
    confirmationStatus: line.confirmationStatus ?? null,
    confirmedAt: line.confirmedAt ?? null,
    counterPercentBps: line.counterPercentBps ?? null,
    counterNote: line.counterNote ?? null,
    // ── P4b (deal terms) ── explicit, not left to the column defaults: a
    // payout line written here is a PERCENT clause on the GROSS basis.
    ...PER_ORDER_PAYOUT_LINE_WHERE,
  };

  return line.id ? { ...base, id: line.id } : base;
}

function toCreateDraftData(
  input: CreatePayoutTermsDraftInput,
): Prisma.PayoutTermsUncheckedCreateInput {
  return {
    kind: input.kind,
    settlementCurrency: input.settlementCurrency,
    // Fee mode is never written on a draft: null inherits the policy default.
    feeMode: null,
    feePolicyId: input.feePolicyId ?? null,
    // Only set when provided so the schema default applies otherwise.
    ...(input.payoutSchedule !== undefined
      ? { payoutSchedule: input.payoutSchedule }
      : {}),
    resaleProcessingFeeConfigRef: input.resaleProcessingFeeConfigRef ?? null,
    resalePayoutReleaseDays: input.resalePayoutReleaseDays ?? 7,
    // Resale share clause (FR-001): null type = not set; the payer falls to
    // the schema default (SELLER) when omitted.
    resaleShareType: input.resaleShareType ?? null,
    resaleShareBps: input.resaleShareBps ?? null,
    resaleShareCents: input.resaleShareCents ?? null,
    ...(input.resaleSharePayer !== undefined
      ? { resaleSharePayer: input.resaleSharePayer }
      : {}),
  };
}

function toUpdateDraftData(
  input: UpdatePayoutTermsDraftInput,
): Prisma.PayoutTermsUncheckedUpdateInput {
  const data: Record<string, unknown> = {};
  if (input.settlementCurrency !== undefined)
    data.settlementCurrency = input.settlementCurrency;
  if (input.feePolicyId !== undefined) data.feePolicyId = input.feePolicyId;
  if (input.resaleProcessingFeeConfigRef !== undefined) {
    data.resaleProcessingFeeConfigRef = input.resaleProcessingFeeConfigRef;
  }
  if (input.resalePayoutReleaseDays !== undefined) {
    data.resalePayoutReleaseDays = input.resalePayoutReleaseDays;
  }
  // Resale share clause (FR-001). The SQL CHECK holds the shape, so a caller
  // changing the type sends the matching bps / cents (and nulls the other).
  if (input.resaleShareType !== undefined) {
    data.resaleShareType = input.resaleShareType;
  }
  if (input.resaleShareBps !== undefined) {
    data.resaleShareBps = input.resaleShareBps;
  }
  if (input.resaleShareCents !== undefined) {
    data.resaleShareCents = input.resaleShareCents;
  }
  if (input.resaleSharePayer !== undefined) {
    data.resaleSharePayer = input.resaleSharePayer;
  }
  // Same UPDATE as the clause columns, so no reader sees the new clause under
  // the old version (OrderItem keys the recorded clause by id + version).
  if (input.bumpVersion) {
    data.version = { increment: 1 };
  }
  return data as Prisma.PayoutTermsUncheckedUpdateInput;
}
