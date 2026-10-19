import { Prisma } from "@prisma/client";

import { fail } from "@th/errors";
import type {
  PayoutItemsRepo,
  PayoutItemRecord,
  PayoutItemStatus,
  CreatePayoutItemInput,
} from "@th/ports/repos/payout-items";
import type {
  ConnectAccountFeeTotal,
  EarliestTransferredPayoutQuery,
  ListPayoutHistoryQuery,
  ListPayoutHistoryResult,
  PayoutHistoryItem,
  PayoutHistoryStatusFilter,
  PayoutItemsInPeriodQuery,
  PayoutLedgerHealItem,
  PayoutLedgerHealQuery,
  StalePendingPayoutItem,
  TransferredPayoutItemForOrderItems,
  TransferredReserveActivityItem,
  TransferredReserveActivityQuery,
} from "@th/types/repos/payout-items";

import type { PrismaClientOrTx } from "./types";

export function makePayoutItemsRepo(p: PrismaClientOrTx): PayoutItemsRepo {
  return {
    // NO settlement linkage: `PayoutItemSettlement` is frozen history
    // (spec 2026-08-10 §7). "Which orders did this payout cover" is answered
    // by the PAYOUT ledger entry's `metadata.consumedCreditEntryIds` and the
    // credits' `consumedByEntryId` stamp — one system, not two.
    // `recoveredDebtCents` is likewise never set: debt is a negative payable,
    // not a withholding, so the column keeps its DB default of 0.
    create: async (input: CreatePayoutItemInput): Promise<PayoutItemRecord> => {
      const item = await p.payoutItem.create({
        data: {
          payoutId: input.payoutId,
          payeeId: input.payeeId,
          currency: input.currency,
          amountCents: input.amountCents,
          connectAccountFeeCents: input.connectAccountFeeCents ?? 0,
          reserveHeldCents: input.reserveHeldCents ?? 0,
          reserveReleasedCents: input.reserveReleasedCents ?? 0,
          plannedCreditEntryIds: input.plannedCreditEntryIds ?? [],
          plannedOrderItemIds: input.plannedOrderItemIds ?? [],
          plannedNetCents: input.plannedNetCents ?? 0,
          payoutLedgerKey: input.payoutLedgerKey ?? null,
        },
      });

      return mapPayoutItem(item);
    },

    createMany: async (
      inputs: CreatePayoutItemInput[],
    ): Promise<PayoutItemRecord[]> => {
      if (inputs.length === 0) return [];

      // Create all payout items — must be sequential because createMany
      // doesn't return records with generated IDs in Prisma.
      const records: PayoutItemRecord[] = [];
      for (const input of inputs) {
        const item = await p.payoutItem.create({
          data: {
            payoutId: input.payoutId,
            payeeId: input.payeeId,
            currency: input.currency,
            amountCents: input.amountCents,
            connectAccountFeeCents: input.connectAccountFeeCents ?? 0,
            reserveHeldCents: input.reserveHeldCents ?? 0,
            reserveReleasedCents: input.reserveReleasedCents ?? 0,
            plannedCreditEntryIds: input.plannedCreditEntryIds ?? [],
            plannedOrderItemIds: input.plannedOrderItemIds ?? [],
            plannedNetCents: input.plannedNetCents ?? 0,
            payoutLedgerKey: input.payoutLedgerKey ?? null,
          },
        });

        records.push(mapPayoutItem(item));
      }

      return records;
    },

    getById: async (payoutItemId: string): Promise<PayoutItemRecord | null> => {
      const item = await p.payoutItem.findUnique({
        where: { id: payoutItemId },
      });
      return item ? mapPayoutItem(item) : null;
    },

    markTransferred: async (
      payoutItemId: string,
      stripeTransferId: string | null,
      transferredAt: Date,
    ) => {
      // `stripeTransferId` is null only on the zero-net path (the rolling
      // reserve and/or the Connect fee consumed the whole payable, so no
      // Stripe call was made). `transferredAt` records when the
      // transfer LANDED — the month-attribution timestamp for Stripe's
      // active-account fee.
      await p.payoutItem.update({
        where: { id: payoutItemId },
        data: { stripeTransferId, status: "transferred", transferredAt },
      });
    },

    markFailed: async (
      payoutItemId: string,
      failedAt: Date,
      reason: string,
    ) => {
      await p.payoutItem.update({
        where: { id: payoutItemId },
        data: { status: "failed", failedAt, failureReason: reason },
      });
    },

    listByPayoutId: async (payoutId: string) => {
      const items = await p.payoutItem.findMany({
        where: { payoutId },
        include: {
          settlements: { select: { settlementId: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      return items.map((item) => ({
        ...mapPayoutItem(item),
        settlementIds: item.settlements.map((s) => s.settlementId),
      }));
    },

    payeeIdsWithTransferredPayoutInPeriod: async (
      query: PayoutItemsInPeriodQuery,
    ): Promise<Set<string>> => {
      if (query.payeeIds.length === 0) return new Set<string>();

      // `status: "transferred"` is load-bearing: pending/failed items moved no
      // money, so Stripe never billed the active-account fee for them and they
      // must not suppress a later deduction.
      //
      // `stripeTransferId: { not: null }` excludes fully-withheld
      // debt-recovery items for the same reason: they complete as
      // "transferred" WITHOUT a Stripe transfer, so the connected account
      // never received a payout and never went active for the month.
      //
      // Month attribution keys on `transferredAt` (when the transfer LANDED —
      // that is what Stripe bills against), falling back to `createdAt` only
      // for legacy rows written before the column existed. For those,
      // creation and transfer happened in the same batch run, so createdAt is
      // a faithful proxy.
      const rows = await p.payoutItem.findMany({
        where: {
          payeeId: { in: query.payeeIds },
          status: "transferred",
          stripeTransferId: { not: null },
          OR: [
            { transferredAt: { gte: query.from, lte: query.to } },
            { transferredAt: null, createdAt: { gte: query.from, lte: query.to } },
          ],
        },
        select: { payeeId: true },
        distinct: ["payeeId"],
      });

      return new Set(rows.map((row) => row.payeeId));
    },

    listTransferredNeedingLedgerHeal: async (
      query: PayoutLedgerHealQuery,
    ): Promise<PayoutLedgerHealItem[]> => {
      if (query.payeeIds.length === 0) return [];

      // Feed for the payout LEDGER heal. `payoutLedgerKey: { not: null }`
      // selects post-cutover rows only (pre-cutover items have no plan and
      // nothing to replay), and `status: "transferred"` is the whole point:
      // the money left, so the ledger MUST record it. Bounded by payeeIds
      // alone with no time window — an orphan that ages out is a payable
      // that pays the same money twice.
      const rows = await p.payoutItem.findMany({
        where: {
          payeeId: { in: query.payeeIds },
          status: "transferred",
          payoutLedgerKey: { not: null },
        },
        select: {
          id: true,
          payoutId: true,
          payeeId: true,
          currency: true,
          amountCents: true,
          plannedCreditEntryIds: true,
          plannedOrderItemIds: true,
          plannedNetCents: true,
          payoutLedgerKey: true,
          stripeTransferId: true,
        },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) return [];

      // TWO PROBES decide who still needs a heal — batched model-API reads
      // rather than raw-SQL NOT EXISTS (house precedent above: no raw SQL
      // where the model API does). Without them every historical transferred
      // item replays every night: the consumption-mismatch branch fires a
      // Sentry report per item per night and `itemsLedgerHealed` saturates —
      // whose contract is "non-zero means a real crash".
      //
      // Probe 1 — the ARITHMETIC heal: the PAYOUT debit is missing. The
      // debit's `PayeeLedgerEntry.idempotencyKey` IS the item's
      // `payoutLedgerKey` (unique column), so absence of that entry means
      // the payable still overstates what is owed.
      const healedKeys = new Set(
        (
          await p.payeeLedgerEntry.findMany({
            where: {
              idempotencyKey: {
                in: rows.map((row) => row.payoutLedgerKey as string),
              },
            },
            select: { idempotencyKey: true },
          })
        ).map((entry) => entry.idempotencyKey),
      );

      // Probe 2 — the STAMP heal: the debit landed but a crash inside the
      // same window lost the `paidOutAt` stamps. NOT merely attribution: an
      // unstamped item classifies as not-paid-out at refund time
      // (refund-full-order's paidOutAt gate), SKIPS the Stripe transfer
      // reversal, and the platform fronts the refund as maybe-never-recouped
      // debt. The replay is idempotent by the write-once guard in
      // `markItemsPaidOut` (`paidOutAt: null`), so once stamped the item
      // drops out of this feed. (The credit-consumption stamp remains
      // deliberately unprobed — it is pure attribution with no money
      // consequence, and its replay is tolerated whenever either probe
      // fires.)
      const debitPresent = rows.filter((row) =>
        healedKeys.has(row.payoutLedgerKey as string),
      );
      const plannedOrderItemIds = [
        ...new Set(debitPresent.flatMap((row) => row.plannedOrderItemIds ?? [])),
      ];
      const unstampedOrderItemIds =
        plannedOrderItemIds.length > 0
          ? new Set(
              (
                await p.orderItem.findMany({
                  where: {
                    id: { in: plannedOrderItemIds },
                    paidOutAt: null,
                  },
                  select: { id: true },
                })
              ).map((item) => item.id),
            )
          : new Set<string>();
      const needsStampHeal = new Set(
        debitPresent
          .filter((row) =>
            (row.plannedOrderItemIds ?? []).some((id) =>
              unstampedOrderItemIds.has(id),
            ),
          )
          .map((row) => row.id),
      );

      // One pass over the original (createdAt-ordered) rows keeps the feed
      // ordered and deduped by construction.
      return rows
        .filter(
          (row) =>
            !healedKeys.has(row.payoutLedgerKey as string) ||
            needsStampHeal.has(row.id),
        )
        .map((row) => ({
          ...row,
          payoutLedgerKey: row.payoutLedgerKey as string,
        }));
    },

    listPendingWithPlanOlderThan: async (
      cutoff: Date,
    ): Promise<StalePendingPayoutItem[]> => {
      // Stale-pending recovery feed: a run that died between committing its
      // transfer claim and `markTransferred` leaves a REAL Stripe transfer
      // on an item still "pending" — invisible to the transferred-only heal
      // feed above. The batch probes each item's stored claim key; the age
      // cutoff (caller-chosen, MINUTES — see STALE_PENDING_MIN_AGE_MS in
      // run-batch; not load-bearing for safety) keeps a live run's own
      // just-created rows out of the feed. Unbounded by payee on purpose:
      // the crashed item's payee may
      // have no live payable cell, and "pending" is a transient state so the
      // scan stays small.
      const rows = await p.payoutItem.findMany({
        where: {
          status: "pending",
          payoutLedgerKey: { not: null },
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          payeeId: true,
          currency: true,
          payoutLedgerKey: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => ({
        ...row,
        payoutLedgerKey: row.payoutLedgerKey as string,
      }));
    },

    listTransferredWithReserveActivity: async (
      query: TransferredReserveActivityQuery,
    ): Promise<TransferredReserveActivityItem[]> => {
      if (query.payeeIds.length === 0) return [];

      // Crash-sweep feed for runPayoutBatch's rolling reserve: every
      // transferred item whose RESERVE_HOLD / RESERVE_RELEASE ledger writes
      // could have been lost between markTransferred and the ledger step.
      // Bounded by payeeIds only, deliberately with NO time window: replays
      // against an already-squared ledger are idempotent no-ops, so
      // re-listing old rows is cheap, while a window would let an orphan age
      // out (for a missing hold that means a payee's deferred money never
      // matures).
      const rows = await p.payoutItem.findMany({
        where: {
          payeeId: { in: query.payeeIds },
          status: "transferred",
          OR: [
            { reserveHeldCents: { gt: 0 } },
            { reserveReleasedCents: { gt: 0 } },
          ],
        },
        select: {
          id: true,
          payoutId: true,
          payeeId: true,
          currency: true,
          reserveHeldCents: true,
          reserveReleasedCents: true,
        },
        orderBy: { createdAt: "asc" },
      });

      return rows;
    },

    listHistory: (query: ListPayoutHistoryQuery) => listPayoutHistory(p, query),

    sumConnectAccountFeesByCurrency: async (): Promise<
      ConnectAccountFeeTotal[]
    > => {
      // Grouped on `lower("currency")`, the same normalisation
      // `orders.sumCollectedTaxByCurrency` and the ledger aggregates use, so
      // the rows join everything else without the caller guessing at casing.
      //
      // `status = 'transferred'` is the whole filter: a pending or failed
      // item executed no transfer, so no cents were withheld and it must not
      // inflate a recovered-cost line. Fully-withheld items (no
      // `stripeTransferId`, still `transferred`) DO count — the fee was
      // withheld even though Stripe was never called.
      //
      // Schema-qualified (public.*) so the statement survives a Neon pooled
      // connection waking with an empty search_path.
      const rows = await p.$queryRaw<
        Array<{
          currency: string;
          connectAccountFeeCents: bigint;
          itemCount: bigint;
        }>
      >(Prisma.sql`
        SELECT
          lower(pi."currency")                                   AS "currency",
          COALESCE(SUM(pi."connectAccountFeeCents"), 0)::bigint  AS "connectAccountFeeCents",
          COUNT(*)::bigint                                       AS "itemCount"
        FROM public."PayoutItem" pi
        WHERE pi."status" = 'transferred'
        GROUP BY lower(pi."currency")
        ORDER BY lower(pi."currency") ASC
      `);

      return rows.map((row) => ({
        currency: row.currency,
        // Diagnostic figures, never a transfer input: bigint → number, so a
        // pathological total is reported rather than raising 22003.
        connectAccountFeeCents: Number(row.connectAccountFeeCents),
        itemCount: Number(row.itemCount),
      }));
    },

    listTransferredByPlannedOrderItemIds: async (
      orderItemIds: string[],
    ): Promise<TransferredPayoutItemForOrderItems[]> => {
      if (orderItemIds.length === 0) return [];

      // Ledger-era refund resolution: which transfers paid these order items?
      // `plannedOrderItemIds` is a Postgres scalar list (String[]), so
      // `hasSome` is the overlap operator. `status: "transferred"` +
      // `stripeTransferId: { not: null }` mirror the period lookup above and
      // for the same reason: a pending/failed item moved no money, and a
      // fully-withheld item completed with NO Stripe transfer — in both cases
      // there is nothing on Stripe to reverse.
      const rows = await p.payoutItem.findMany({
        where: {
          status: "transferred",
          stripeTransferId: { not: null },
          plannedOrderItemIds: { hasSome: orderItemIds },
        },
        select: {
          id: true,
          stripeTransferId: true,
          payeeId: true,
          currency: true,
          plannedOrderItemIds: true,
          amountCents: true,
          plannedNetCents: true,
        },
        orderBy: { createdAt: "asc" },
      });

      return rows.map((row) => ({
        payoutItemId: row.id,
        // Non-null by the where-clause; the cast documents that.
        stripeTransferId: row.stripeTransferId as string,
        payeeId: row.payeeId,
        currency: row.currency,
        plannedOrderItemIds: row.plannedOrderItemIds ?? [],
        amountCents: row.amountCents,
        netAmountCents: row.plannedNetCents ?? 0,
      }));
    },

    subjectHasTransferredPayout: async (subject) => {
      const row = await p.payoutItem.findFirst({
        where: {
          status: "transferred",
          payee: {
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
          },
        },
        select: { id: true },
      });
      return row !== null;
    },

    earliestTransferredPayoutAtByPayee: async (
      query: EarliestTransferredPayoutQuery,
    ): Promise<Map<string, Date>> => {
      if (query.payeeIds.length === 0) return new Map<string, Date>();

      // "When did this payee's FIRST payout of this order-kind land?" — the
      // seasoning curve's track-record input.
      //
      // TWO ERAS, and both must be read. Pre-cutover items reach orders through
      // the `PayoutItemSettlement` junction; post-cutover items link no
      // settlements at all and reach orders through their durable plan
      // (`plannedCreditEntryIds` → SETTLEMENT_CREDIT.orderId → Order.kind).
      // Reading only the junction — which nothing writes any more — would make
      // every post-cutover payee read as "no history" FOREVER, pinning them at
      // the curve's maximum-risk bracket (1000 bps withheld from every
      // membership payout, never graduating). The union is load-bearing.
      //
      // `status: "transferred"` only, in both eras: a pending/failed item moved
      // no money and proves nothing about track record. Fully-withheld items
      // (stripeTransferId null) DO count — the payout genuinely completed
      // through the pipeline, which is what is being measured (contrast
      // payeeIdsWithTransferredPayoutInPeriod, where the question is whether
      // Stripe billed the account).
      //
      // Timestamp: transferredAt with createdAt as the legacy fallback (rows
      // predating the column). createdAt <= transferredAt within any one row,
      // so the combined min can only be minutes early — exact against the
      // 90/180-day brackets it feeds.
      const at = (row: { transferredAt: Date | null; createdAt: Date }) =>
        row.transferredAt ?? row.createdAt;
      const result = new Map<string, Date>();
      const record = (payeeId: string, when: Date) => {
        const existing = result.get(payeeId);
        if (!existing || when.getTime() < existing.getTime()) {
          result.set(payeeId, when);
        }
      };

      // ERA 1 — pre-cutover: the settlement-line join, unchanged.
      const legacy = await p.payoutItem.findMany({
        where: {
          payeeId: { in: query.payeeIds },
          status: "transferred",
          settlements: {
            some: {
              settlement: {
                lines: { some: { order: { kind: query.orderKind } } },
              },
            },
          },
        },
        select: { payeeId: true, transferredAt: true, createdAt: true },
      });
      for (const row of legacy) record(row.payeeId, at(row));

      // ERA 2 — post-cutover: the durable plan. Three batched reads rather
      // than one raw-SQL array join, so the path stays unit-testable against a
      // mocked client (house precedent: no raw SQL where the model API does).
      const planned = await p.payoutItem.findMany({
        where: {
          payeeId: { in: query.payeeIds },
          status: "transferred",
          payoutLedgerKey: { not: null },
        },
        select: {
          payeeId: true,
          transferredAt: true,
          createdAt: true,
          plannedCreditEntryIds: true,
        },
      });
      const allCreditIds = [
        ...new Set(planned.flatMap((row) => row.plannedCreditEntryIds ?? [])),
      ];
      if (allCreditIds.length > 0) {
        const credits = await p.payeeLedgerEntry.findMany({
          where: { id: { in: allCreditIds }, type: "SETTLEMENT_CREDIT" },
          select: { id: true, orderId: true },
        });
        const orderIdByCredit = new Map(
          credits
            .filter((c) => c.orderId != null)
            .map((c) => [c.id, c.orderId as string]),
        );
        const orderIds = [...new Set([...orderIdByCredit.values()])];
        const matchingOrders =
          orderIds.length > 0
            ? await p.order.findMany({
                where: { id: { in: orderIds }, kind: query.orderKind },
                select: { id: true },
              })
            : [];
        const matching = new Set(matchingOrders.map((o) => o.id));
        for (const row of planned) {
          const hit = (row.plannedCreditEntryIds ?? []).some((creditId) => {
            const orderId = orderIdByCredit.get(creditId);
            return orderId != null && matching.has(orderId);
          });
          if (hit) record(row.payeeId, at(row));
        }
      }

      return result;
    },
  };
}

function mapPayoutItem(item: {
  id: string;
  payoutId: string;
  payeeId: string;
  currency: string;
  amountCents: number;
  connectAccountFeeCents: number;
  recoveredDebtCents: number;
  reserveHeldCents: number;
  reserveReleasedCents: number;
  plannedCreditEntryIds?: string[];
  plannedOrderItemIds?: string[];
  plannedNetCents?: number;
  payoutLedgerKey?: string | null;
  stripeTransferId: string | null;
  status: string;
  failedAt: Date | null;
  failureReason: string | null;
  transferredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PayoutItemRecord {
  return {
    id: item.id,
    payoutId: item.payoutId,
    payeeId: item.payeeId,
    currency: item.currency,
    amountCents: item.amountCents,
    connectAccountFeeCents: item.connectAccountFeeCents,
    recoveredDebtCents: item.recoveredDebtCents,
    reserveHeldCents: item.reserveHeldCents,
    reserveReleasedCents: item.reserveReleasedCents,
    plannedCreditEntryIds: item.plannedCreditEntryIds ?? [],
    plannedOrderItemIds: item.plannedOrderItemIds ?? [],
    plannedNetCents: item.plannedNetCents ?? 0,
    payoutLedgerKey: item.payoutLedgerKey ?? null,
    stripeTransferId: item.stripeTransferId,
    status: item.status as PayoutItemStatus,
    failedAt: item.failedAt,
    failureReason: item.failureReason,
    transferredAt: item.transferredAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ── Payout history (staff "Payouts sent" read) ──────────────────────────────
//
// Raw SQL, deliberately: the ordering key is
// `COALESCE("transferredAt", "scheduledFor")` — a value that lives half on
// the item and half on its parent batch — and Prisma's `orderBy` cannot
// express it. Writing it by hand also lets the Payee subject join, the
// keyset predicate and the `COUNT(*) OVER ()` total ride one statement
// instead of three round trips.
//
// Every value is bound (`Prisma.sql` interpolation is parameterised); the
// only literal ever built by concatenation is the already-clamped integer
// statement timeout, exactly as `listDebtPositions` documents.

const HISTORY_CURSOR_FIELD = "occurredAt,id";
const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 200;
/** Applied when the caller passes no `statementTimeoutMs`. */
export const PAYOUT_HISTORY_DEFAULT_STATEMENT_TIMEOUT_MS = 8_000;
/** Hard ceiling on a caller-supplied statement timeout (5 minutes). */
const PAYOUT_HISTORY_MAX_STATEMENT_TIMEOUT_MS = 300_000;
/** Interactive-tx `timeout` = statement budget + this, so Postgres fires first. */
const PAYOUT_HISTORY_TX_TIMEOUT_HEADROOM_MS = 2_000;
/** Interactive-tx `maxWait` (time to acquire a connection from the pool). */
const PAYOUT_HISTORY_TX_MAX_WAIT_MS = 5_000;

interface HistoryCursor {
  /** ISO-8601 instant of the previous page's last `occurredAt`. */
  occurredAt: string;
  id: string;
}

function encodeHistoryCursor(c: HistoryCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * A cursor that fails to decode restarts from the top rather than throwing —
 * the same posture as `listDebtPositions`. A hand-edited or stale cursor
 * costs a reader a page position, never an error page.
 */
function decodeHistoryCursor(raw: string | null | undefined): HistoryCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as HistoryCursor).occurredAt === "string" &&
      typeof (parsed as HistoryCursor).id === "string"
    ) {
      const at = new Date((parsed as HistoryCursor).occurredAt);
      if (Number.isNaN(at.getTime())) return null;
      return {
        occurredAt: (parsed as HistoryCursor).occurredAt,
        id: (parsed as HistoryCursor).id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface PayoutHistoryRawRow {
  id: string;
  payoutId: string;
  payeeId: string;
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  currency: string;
  amountCents: number;
  connectAccountFeeCents: number;
  recoveredDebtCents: number;
  reserveHeldCents: number;
  reserveReleasedCents: number;
  netCents: number;
  netRecorded: boolean;
  status: string;
  transferredAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  stripeTransferId: string | null;
  occurredAt: Date;
  scheduledFor: Date;
  payoutStatus: string;
  processorBatchId: string | null;
  createdAt: Date;
  totalCount: bigint;
}

/**
 * The history statement as a parameterised `Prisma.Sql`, exported so the
 * integration suite can run the EXACT bytes the adapter runs. `limit` must
 * already be clamped; `cursor` already decoded.
 */
export function buildPayoutHistorySql(params: {
  status: PayoutHistoryStatusFilter;
  limit: number;
  cursor: HistoryCursor | null;
  payeeIds?: string[];
}): Prisma.Sql {
  const { status, limit, cursor, payeeIds } = params;

  // Base predicates, ANDed into ONE `WHERE` on the base CTE. Built as a list
  // rather than two hand-written fragments so adding a third filter cannot
  // reintroduce the "second WHERE" bug: `status` used to own the keyword
  // outright, and a payee filter bolted on as its own `WHERE` is a syntax
  // error at best and a silently-dropped predicate at worst.
  //
  // Both filters live in `base`, not in `page`, so the keyset cursor pages
  // the FILTERED set and `COUNT(*) OVER ()` counts the FILTERED set. The
  // corollary, documented on ListPayoutHistoryQuery.payeeIds: a cursor is
  // only meaningful within the filter set that produced it.
  const basePredicates: Prisma.Sql[] = [];
  if (status !== "all") {
    basePredicates.push(Prisma.sql`pi."status" = ${status}`);
  }
  if (payeeIds !== undefined) {
    // Bound as a text[], never interpolated. An EXPLICIT empty array becomes
    // `= ANY('{}')` — false for every row, i.e. no payees so no rows, which
    // is the documented contract (and the same shape the payee-ledger reads
    // use for their `payeeIds`). `undefined` skips the predicate entirely.
    basePredicates.push(Prisma.sql`pi."payeeId" = ANY(${payeeIds}::text[])`);
  }
  const baseFilter =
    basePredicates.length === 0
      ? Prisma.empty
      : Prisma.sql`WHERE ${Prisma.join(basePredicates, " AND ")}`;

  // Keyset on the SAME (occurredAt, id) tuple the ORDER BY uses, descending.
  // Row-value comparison rather than a hand-expanded OR chain: Postgres can
  // use it directly and it cannot drift out of sync with the sort.
  //
  // THE ISO STRING IS BOUND, NEVER A JS `Date`. `occurredAt` is
  // `COALESCE(transferredAt, scheduledFor)` — both TIMESTAMP(3) WITHOUT time
  // zone — and the driver binds a JS Date as `timestamptz`, so `::timestamp`
  // would convert through the session `TimeZone` GUC. Under a negative-offset
  // session that moves the page boundary EARLIER and page 2 silently skips
  // every row in between; the UI's dedupe then hides the symmetric duplicate
  // case, so "Load more" appears to work while adding nothing. CI runs UTC,
  // where the bug is invisible. `::timestamptz AT TIME ZONE 'UTC'` states the
  // intent outright: the cursor is a UTC instant, compared as the naked
  // timestamp the column stores.
  const cursorFilter = cursor
    ? Prisma.sql`WHERE (b."occurredAt", b."id") < (${cursor.occurredAt}::timestamptz AT TIME ZONE 'UTC', ${cursor.id})`
    : Prisma.empty;

  return Prisma.sql`
    WITH base AS (
      SELECT
        pi."id"                      AS "id",
        pi."payoutId"                AS "payoutId",
        pi."payeeId"                 AS "payeeId",
        py."subjectType"::text       AS "subjectType",
        py."subjectId"               AS "subjectId",
        pi."currency"                AS "currency",
        pi."amountCents"             AS "amountCents",
        pi."connectAccountFeeCents"  AS "connectAccountFeeCents",
        pi."recoveredDebtCents"      AS "recoveredDebtCents",
        pi."reserveHeldCents"        AS "reserveHeldCents",
        pi."reserveReleasedCents"    AS "reserveReleasedCents",
        pi."plannedNetCents"         AS "netCents",
        -- Is the stored net a REAL net, or a migration backfill?
        -- (see PayoutHistoryItem.netCents). NOTE: no backticks in this
        -- comment -- it lives inside a JS template literal.
        --
        -- TWO ways to be sure it is real, and the second one matters:
        --   * payoutLedgerKey IS NOT NULL -- a post-cutover row, whose
        --     writer always sets both columns together;
        --   * plannedNetCents <> 0 -- a non-zero value cannot be the
        --     backfill, whatever generation wrote it.
        -- Keying on the ledger key ALONE was tried and was too blunt: it
        -- flags any row without one, and the dev seed's display fixtures
        -- deliberately carry no ledger key (so the batch's heal sweep leaves
        -- them alone), so every seeded row rendered "Not reported" for a net
        -- it had plainly recorded.
        --
        -- The one case still reported as unknown is a pre-cutover row whose
        -- true net WAS zero. Unknown is the safe direction there: we cannot
        -- tell it apart from the backfill, and saying so beats asserting a
        -- zero we did not read.
        (pi."payoutLedgerKey" IS NOT NULL OR pi."plannedNetCents" <> 0)
          AS "netRecorded",
        pi."status"                  AS "status",
        pi."transferredAt"           AS "transferredAt",
        pi."failedAt"                AS "failedAt",
        pi."failureReason"           AS "failureReason",
        pi."stripeTransferId"        AS "stripeTransferId",
        po."scheduledFor"            AS "scheduledFor",
        po."status"                  AS "payoutStatus",
        po."processorBatchId"        AS "processorBatchId",
        pi."createdAt"               AS "createdAt",
        -- The display date AND the sort key, one expression so they can
        -- never disagree: when the money moved, else when the batch that
        -- owns this item was scheduled to run.
        COALESCE(pi."transferredAt", po."scheduledFor") AS "occurredAt"
      FROM public."PayoutItem" pi
      JOIN public."Payout" po ON po."id" = pi."payoutId"
      JOIN public."Payee"  py ON py."id" = pi."payeeId"
      ${baseFilter}
    ),
    page AS (
      SELECT b.*, COUNT(*) OVER () AS "totalCount"
      FROM base b
      ${cursorFilter}
      ORDER BY b."occurredAt" DESC, b."id" DESC
      LIMIT ${limit + 1}
    )
    SELECT * FROM page
    ORDER BY page."occurredAt" DESC, page."id" DESC
  `;
}

/**
 * Test-only seam, mirroring `__testOnlyDebtPositionsHooks`: an async hook run
 * INSIDE the read's transaction, after the SET LOCAL and before the
 * statement. The integration suite uses it to make the read slow FOR REAL
 * (`SELECT pg_sleep(...)`) and prove the degrade path.
 *
 * It exists because the obvious alternative — a 1ms budget on a small table
 * — is a gate that passes for the wrong reason: measured, this query
 * sometimes completes inside 1ms and the assertion flakes. Never set in
 * production code paths.
 */
export const __testOnlyPayoutHistoryHooks: {
  beforeQuery: ((tx: PrismaClientOrTx) => Promise<void>) | null;
} = { beforeQuery: null };

async function listPayoutHistory(
  p: PrismaClientOrTx,
  query: ListPayoutHistoryQuery,
): Promise<ListPayoutHistoryResult> {
  const limit = Math.min(
    Math.max(query.limit ?? HISTORY_DEFAULT_LIMIT, 1),
    HISTORY_MAX_LIMIT,
  );
  const status = query.status ?? "all";
  const cursor = decodeHistoryCursor(query.cursor);
  // `payeeIds` passes through UNNORMALISED — `undefined` stays `undefined`
  // (every payee) and `[]` stays `[]` (no payees). Coalescing the two here
  // would turn "this org has no payee yet" into "show them the whole
  // platform's payouts", which is the one mistake this filter must never make.
  const sql = buildPayoutHistorySql({
    status,
    limit,
    cursor,
    payeeIds: query.payeeIds,
  });

  const timeoutMs = Math.min(
    Math.max(
      Math.floor(
        query.statementTimeoutMs != null &&
          Number.isFinite(query.statementTimeoutMs)
          ? query.statementTimeoutMs
          : PAYOUT_HISTORY_DEFAULT_STATEMENT_TIMEOUT_MS,
      ),
      1,
    ),
    PAYOUT_HISTORY_MAX_STATEMENT_TIMEOUT_MS,
  );
  const txTimeoutMs = timeoutMs + PAYOUT_HISTORY_TX_TIMEOUT_HEADROOM_MS;

  // Own transaction only: `SET LOCAL` on a caller's tx would leak the
  // statement timeout onto everything else in it.
  if (!hasTransaction(p)) {
    throw fail("INTERNAL", {
      message: "payout_items_history_requires_top_level_client",
      meta: { hint: "listHistory must run outside repos.tx" },
    });
  }

  let rows: PayoutHistoryRawRow[];
  try {
    rows = await (p as PrismaWithTransaction).$transaction(
      async (tx) => {
        // `timeoutMs` is an integer this function clamped, never caller
        // text, so the interpolation is a number literal by construction.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        if (__testOnlyPayoutHistoryHooks.beforeQuery) {
          await __testOnlyPayoutHistoryHooks.beforeQuery(tx);
        }
        return tx.$queryRaw<PayoutHistoryRawRow[]>(sql);
      },
      { maxWait: PAYOUT_HISTORY_TX_MAX_WAIT_MS, timeout: txTimeoutMs },
    );
  } catch (err) {
    const expired = classifyPayoutHistoryTimeout(err);
    if (expired) {
      throw fail("SERVICE_UNAVAILABLE", {
        message: "payout_items_history_timeout",
        meta: {
          expired,
          statementTimeoutMs: timeoutMs,
          transactionTimeoutMs: txTimeoutMs,
        },
        cause: err,
      });
    }
    throw err;
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const items: PayoutHistoryItem[] = pageRows.map((r) => ({
    id: r.id,
    payoutId: r.payoutId,
    payeeId: r.payeeId,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    currency: r.currency,
    amountCents: r.amountCents,
    connectAccountFeeCents: r.connectAccountFeeCents,
    recoveredDebtCents: r.recoveredDebtCents,
    reserveHeldCents: r.reserveHeldCents,
    reserveReleasedCents: r.reserveReleasedCents,
    // A backfilled zero on a pre-cutover row is NOT a net of zero.
    netCents: r.netRecorded ? r.netCents : null,
    status: r.status as PayoutItemStatus,
    transferredAt: r.transferredAt,
    failedAt: r.failedAt,
    failureReason: r.failureReason,
    stripeTransferId: r.stripeTransferId,
    occurredAt: r.occurredAt,
    scheduledFor: r.scheduledFor,
    payoutStatus: r.payoutStatus,
    processorBatchId: r.processorBatchId,
    createdAt: r.createdAt,
  }));

  const lastRow = pageRows[pageRows.length - 1];
  return {
    items,
    pageInfo: {
      cursorField: HISTORY_CURSOR_FIELD,
      nextCursor:
        hasNextPage && lastRow
          ? encodeHistoryCursor({
              occurredAt: lastRow.occurredAt.toISOString(),
              id: lastRow.id,
            })
          : null,
      limit,
      hasNextPage,
    },
    total: rows.length > 0 ? Number(rows[0]!.totalCount) : 0,
  };
}

type PrismaWithTransaction = PrismaClientOrTx & {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
};

function hasTransaction(p: PrismaClientOrTx): p is PrismaWithTransaction {
  return typeof (p as { $transaction?: unknown }).$transaction === "function";
}

/**
 * Which budget killed the read, if any — same classification (and same
 * reasons) as the payee-ledger debt read's. `statement`: Postgres cancelled
 * it (`57014`). `transaction`: Prisma's interactive-tx `timeout` expired
 * first (`P2028`). The message matches are the last-resort net for
 * re-wrapped errors.
 */
function classifyPayoutHistoryTimeout(
  err: unknown,
): "statement" | "transaction" | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as {
      code?: unknown;
      meta?: { code?: unknown };
      message?: unknown;
      cause?: unknown;
    };
    if (o.code === "57014" || o.meta?.code === "57014") return "statement";
    if (o.code === "P2028") return "transaction";
    if (typeof o.message === "string") {
      if (/statement timeout|57014/i.test(o.message)) return "statement";
      if (/transaction already closed|expired transaction|P2028/i.test(o.message)) {
        return "transaction";
      }
    }
    cur = o.cause;
  }
  return null;
}
