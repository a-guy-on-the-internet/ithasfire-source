import { describe, it, expect, vi } from "vitest";
import {
  runPayoutBatch,
  buildPayoutLedgerKey,
  buildTransferClaimKey,
  transferClaimKeyFromLedgerKey,
} from "../run-batch";

/**
 * The LEDGER-AUTHORITATIVE payout batch (spec 2026-08-10 §6).
 *
 * The harness mocks `payeeLedger`, not `settlements`: there is no settlement
 * row to make due, claim or mark. A payee is owed money iff the ledger's
 * payable query says so, and every scenario below is expressed in ledger
 * entries — credits with a maturity date, refund debits that are always
 * effective, and the PAYOUT entries the batch writes back.
 *
 * `ledgerEntries` is a tiny in-memory journal that reproduces the adapter's
 * arithmetic (`listPayableBalances`) rather than hard-coding an answer, so a
 * test asserting "transfer 6000" is asserting the real netting rule.
 */

const PAYEE_A = "payee-a-uuid";
const PAYEE_B = "payee-b-uuid";

const now = new Date("2026-03-05T06:00:00Z");
const YESTERDAY = new Date("2026-03-04T06:00:00Z");
const NEXT_WEEK = new Date("2026-03-12T06:00:00Z");

type LedgerEntry = {
  id: string;
  idempotencyKey: string;
  payeeId: string;
  type:
    | "SETTLEMENT_CREDIT"
    | "REFUND_DEBIT"
    | "TRANSFER_REVERSAL_CREDIT"
    | "CASH_SALE_DEBIT"
    | "CASH_SALE_DEBIT_REVERSAL"
    | "PAYOUT";
  amountCents: number;
  currency: string;
  orderId: string | null;
  /** Credits only. `null` on debits/payouts — they are always effective. */
  availableAt: Date | null;
  consumedByEntryId: string | null;
  metadata: unknown;
};

type SeedCredit = {
  id: string;
  payeeId?: string;
  currency?: string;
  amountCents: number;
  orderId: string;
  /** Maturity. Default: yesterday (matured). */
  availableAt?: Date;
  /** `{ [orderItemId]: contributionCents }` — the item-level attribution. */
  items?: Record<string, number>;
};

type SeedDebit = {
  id: string;
  payeeId?: string;
  currency?: string;
  amountCents: number;
  orderId: string;
};

function makePayee(
  id: string,
  stripeAccountId: string | null = "acct_test",
  payoutsEnabled = true,
) {
  return {
    id,
    subjectType: "ORGANIZATION" as const,
    subjectId: `org-${id}`,
    stripeAccountId,
    status: "ACTIVE" as const,
    payoutsEnabled,
    chargesEnabled: true,
    defaultCurrency: "usd",
  };
}

function makeDeps(
  overrides: {
    credits?: SeedCredit[];
    refundDebits?: SeedDebit[];
    payees?: Map<string, ReturnType<typeof makePayee>>;
    globalPolicy?: {
      payoutMinimumCents?: number;
      connectAccountFeeCents?: number;
    } | null;
    /** `orderId -> Order.kind`. Default: every order is TICKETING. */
    orderKinds?: Record<string, "TICKETING" | "MEMBERSHIP">;
    transferResult?: { id: string };
    transferThrow?: Error;
    /** Throw only for these payee ids (per-item failure isolation). */
    transferThrowForPayees?: Set<string>;
    /**
     * Throw only for these currencies. Combined with the payee filter by AND.
     * The seam for "the platform's USD balance is dry but CAD is fine".
     */
    transferThrowForCurrencies?: Set<string>;
    /** Payees with an already-transferred payout item this calendar month. */
    payeesActiveThisMonth?: Set<string>;
    /** MembershipStanding rows returned by `membershipStandings.listAll`. */
    standings?: Array<{
      ownerOrgId: string | null;
      ownerHumanId: string | null;
      reserveBps: number;
      reserveReleaseDays: number;
      overriddenBy: string | null;
      suspended?: boolean;
    }>;
    /** Rows returned by `disputes.latestLostMembershipDisputeAtByOwner`. */
    latestLostByOwner?: Array<{
      ownerOrgId: string | null;
      ownerHumanId: string | null;
      latestLostAt: Date;
    }>;
    firstMembershipPayoutAtByPayee?: Record<string, Date>;
    firstTicketingPayoutAtByPayee?: Record<string, Date>;
    /**
     * Items from a "previous run", pre-seeded into the stateful item store —
     * the crash-recovery scenarios need an original item that already exists
     * when the run under test starts. Defaults: status "pending", no
     * transfer id.
     */
    preexistingPayoutItems?: Array<{
      id: string;
      payoutId: string;
      payeeId: string;
      currency: string;
      amountCents: number;
      plannedCreditEntryIds: string[];
      plannedOrderItemIds: string[];
      plannedNetCents: number;
      payoutLedgerKey: string | null;
      status?: "pending" | "transferred" | "failed";
      stripeTransferId?: string | null;
      /** Default `now` — set older than ~15 min to enter the 0a sweep. */
      createdAt?: Date;
    }>;
    /**
     * Rows returned by `payoutItems.listTransferredNeedingLedgerHeal`. When
     * OMITTED the mock mirrors the adapter: transferred items with a plan
     * whose PAYOUT entry is missing from the journal (the anti-join).
     */
    itemsNeedingLedgerHeal?: Array<{
      id: string;
      payoutId: string;
      payeeId: string;
      currency: string;
      amountCents: number;
      plannedCreditEntryIds: string[];
      plannedOrderItemIds: string[];
      plannedNetCents: number;
      payoutLedgerKey: string;
      stripeTransferId: string | null;
    }>;
    /** Outstanding RESERVE_HOLD entries (stateful: released once, ever). */
    unreleasedReserveHolds?: Array<{
      id: string;
      payeeId: string;
      amountCents: number;
      currency: string;
      createdAt: Date;
    }>;
    /**
     * Hook fired just before `createTransfer` for a given payout item — the
     * seam for "a refund lands between planning and the transfer".
     */
    beforeTransfer?: (ctx: {
      ledgerEntries: LedgerEntry[];
      addEntry: (entry: Partial<LedgerEntry> & { amountCents: number }) => void;
    }) => void;
  } = {},
) {
  let entrySeq = 0;
  // Mutable so a test can change the transfer outcome between runs of the
  // SAME harness (see `setTransferThrow`).
  let transferThrow: Error | null = overrides.transferThrow ?? null;
  const ledgerEntries: LedgerEntry[] = [];

  const addEntry = (
    entry: Partial<LedgerEntry> & { amountCents: number },
  ): LedgerEntry => {
    entrySeq++;
    const row: LedgerEntry = {
      id: entry.id ?? `entry-${entrySeq}`,
      idempotencyKey: entry.idempotencyKey ?? `key-${entrySeq}`,
      payeeId: entry.payeeId ?? PAYEE_A,
      type: entry.type ?? "SETTLEMENT_CREDIT",
      amountCents: entry.amountCents,
      currency: entry.currency ?? "usd",
      orderId: entry.orderId ?? null,
      availableAt: entry.availableAt ?? null,
      consumedByEntryId: entry.consumedByEntryId ?? null,
      metadata: entry.metadata ?? null,
    };
    ledgerEntries.push(row);
    return row;
  };

  for (const credit of overrides.credits ?? []) {
    addEntry({
      id: credit.id,
      idempotencyKey: `settlement-credit:${credit.orderId}:${credit.payeeId ?? PAYEE_A}`,
      payeeId: credit.payeeId ?? PAYEE_A,
      type: "SETTLEMENT_CREDIT",
      amountCents: credit.amountCents,
      currency: credit.currency ?? "usd",
      orderId: credit.orderId,
      availableAt: credit.availableAt ?? YESTERDAY,
      metadata: {
        items: credit.items ?? { [`item-${credit.id}`]: credit.amountCents },
      },
    });
  }
  for (const debit of overrides.refundDebits ?? []) {
    addEntry({
      id: debit.id,
      idempotencyKey: `refund-debit:${debit.orderId}:${debit.payeeId ?? PAYEE_A}:${debit.id}`,
      payeeId: debit.payeeId ?? PAYEE_A,
      type: "REFUND_DEBIT",
      amountCents: debit.amountCents,
      currency: debit.currency ?? "usd",
      orderId: debit.orderId,
    });
  }

  // The adapter's arithmetic, in miniature: credits count only when MATURED,
  // every other effective type counts unconditionally. Signs match
  // listPayableBalances exactly (PAYOUT subtracts, reversal credits add).
  const payableFor = (asOf: Date) => {
    const totals = new Map<string, number>();
    for (const e of ledgerEntries) {
      // Folded like the adapter's btrim(lower(currency)).
      const key = `${e.payeeId}::${e.currency.trim().toLowerCase()}`;
      let delta = 0;
      if (e.type === "SETTLEMENT_CREDIT") {
        delta = e.availableAt && e.availableAt <= asOf ? e.amountCents : 0;
      } else if (
        e.type === "TRANSFER_REVERSAL_CREDIT" ||
        e.type === "CASH_SALE_DEBIT_REVERSAL"
      ) {
        delta = e.amountCents;
      } else if (e.type === "REFUND_DEBIT" || e.type === "CASH_SALE_DEBIT") {
        delta = -e.amountCents;
      } else if (e.type === "PAYOUT") {
        delta = -e.amountCents;
      }
      totals.set(key, (totals.get(key) ?? 0) + delta);
    }
    // Oldest MATURED credit per cell — what the batch orders its feed by.
    const oldest = new Map<string, Date>();
    for (const e of ledgerEntries) {
      if (e.type !== "SETTLEMENT_CREDIT") continue;
      if (!e.availableAt || e.availableAt > asOf) continue;
      const key = `${e.payeeId}::${e.currency.trim().toLowerCase()}`;
      const prev = oldest.get(key);
      if (!prev || e.availableAt < prev) oldest.set(key, e.availableAt);
    }
    return [...totals.entries()]
      .map(([key, payableCents]) => {
        const [payeeId, currency] = key.split("::") as [string, string];
        return {
          payeeId,
          currency,
          payableCents,
          oldestMaturedAt: oldest.get(key) ?? null,
        };
      })
      .sort(
        (a, b) =>
          (a.oldestMaturedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
            (b.oldestMaturedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
          a.payeeId.localeCompare(b.payeeId) ||
          a.currency.localeCompare(b.currency),
      );
  };

  const payees =
    overrides.payees ?? new Map([[PAYEE_A, makePayee(PAYEE_A)]]);
  const transferResult = overrides.transferResult ?? { id: "tr_batch_123" };

  const createdPayoutItems: Array<Record<string, unknown>> = [];
  let payoutItemCounter = 0;

  // Order items already stamped `paidOutAt` (write-once, like the adapter).
  const paidOutStampedItemIds = new Set<string>();

  // Stateful item store mirroring the DB row lifecycle: created pending,
  // stamped by markTransferred / markFailed, read back by getById and the
  // heal-sweep feed. Pre-seeded from `preexistingPayoutItems`.
  const payoutItemsStore = new Map<string, any>();
  for (const pre of overrides.preexistingPayoutItems ?? []) {
    payoutItemsStore.set(pre.id, {
      connectAccountFeeCents: 0,
      recoveredDebtCents: 0,
      reserveHeldCents: 0,
      reserveReleasedCents: 0,
      stripeTransferId: null,
      status: "pending" as const,
      failedAt: null,
      failureReason: null,
      transferredAt: null,
      createdAt: now,
      updatedAt: now,
      ...pre,
    });
  }

  // Stateful reserve ledger, mirroring the adapter: a hold releases at most
  // once EVER, whatever key it arrives under.
  const reserveHoldsStore = (overrides.unreleasedReserveHolds ?? []).map(
    (h) => ({ ...h }),
  );
  const releasedHoldIds = new Set<string>();
  const appliedReserveHoldKeys = new Set<string>();
  const reserveReleasedSumsByItem = new Map<string, number>();

  const mockLedgerEntry = (partial: Record<string, unknown>) => ({
    id: `ledger-${String(partial.idempotencyKey)}`,
    payeeId: "",
    amountCents: 0,
    currency: "usd",
    sourceKind: "payout_item",
    sourceId: "",
    orderId: null,
    settlementId: null,
    disputeId: null,
    relatedEntryId: null,
    availableAt: null,
    consumedByEntryId: null,
    description: "",
    metadata: null,
    createdAt: now,
    ...partial,
  });

  const idempotencyStore = new Map<string, unknown>();
  const idempotencyClaims = new Set<string>();

  const mocks = {
    repos: {
      orders: {
        getKindsByIds: vi.fn(async (orderIds: string[]) => {
          const map = new Map<string, "TICKETING" | "MEMBERSHIP">();
          for (const id of orderIds) {
            map.set(id, overrides.orderKinds?.[id] ?? "TICKETING");
          }
          return map;
        }),
      },
      orderItems: {
        // Stateful, mirroring the adapter's write-once `paidOutAt: null`
        // guard: a Set stamps each item at most once, and the heal feed's
        // stamp probe reads it.
        markItemsPaidOut: vi.fn(async (itemIds: string[]) => {
          for (const id of itemIds) paidOutStampedItemIds.add(id);
        }),
      },
      membershipStandings: {
        listAll: vi.fn(async () =>
          (overrides.standings ?? []).map((s, i) => ({
            id: `standing-${i}`,
            ownerOrgId: s.ownerOrgId,
            ownerHumanId: s.ownerHumanId,
            suspended: s.suspended ?? false,
            suspendedAt: s.suspended ? now : null,
            suspendedReason: s.suspended ? "test suspension" : null,
            reserveBps: s.reserveBps,
            reserveReleaseDays: s.reserveReleaseDays,
            overriddenBy: s.overriddenBy,
            overrideReason: null,
            createdAt: now,
            updatedAt: now,
          })),
        ),
      },
      disputes: {
        latestLostMembershipDisputeAtByOwner: vi.fn(
          async () => overrides.latestLostByOwner ?? [],
        ),
      },
      feePolicies: {
        resolveEffective: vi.fn(async () =>
          overrides.globalPolicy === null
            ? null
            : {
                payoutMinimumCents:
                  overrides.globalPolicy?.payoutMinimumCents ?? 1000,
                // Default 0 = recovery OFF, matching the shipped DB default.
                connectAccountFeeCents:
                  overrides.globalPolicy?.connectAccountFeeCents ?? 0,
              },
        ),
      },
      payouts: {
        create: vi.fn(async () => ({
          id: "payout-1",
          scheduledFor: now,
          status: "scheduled",
          canceledAt: null,
          startedAt: null,
          completedAt: null,
          processorBatchId: null,
          createdAt: now,
          updatedAt: now,
        })),
        markRunning: vi.fn(async () => {}),
        markCompleted: vi.fn(async () => {}),
        markFailed: vi.fn(async () => {}),
      },
      payoutItems: {
        createMany: vi.fn(async (inputs: any[]) =>
          inputs.map((input: any) => {
            payoutItemCounter++;
            const item = {
              id: `pi-${payoutItemCounter}`,
              payoutId: input.payoutId,
              payeeId: input.payeeId,
              currency: input.currency,
              amountCents: input.amountCents,
              connectAccountFeeCents: input.connectAccountFeeCents ?? 0,
              recoveredDebtCents: 0,
              reserveHeldCents: input.reserveHeldCents ?? 0,
              reserveReleasedCents: input.reserveReleasedCents ?? 0,
              plannedCreditEntryIds: input.plannedCreditEntryIds ?? [],
              plannedOrderItemIds: input.plannedOrderItemIds ?? [],
              plannedNetCents: input.plannedNetCents ?? 0,
              payoutLedgerKey: input.payoutLedgerKey ?? null,
              stripeTransferId: null,
              status: "pending" as const,
              failedAt: null,
              failureReason: null,
              transferredAt: null,
              createdAt: now,
              updatedAt: now,
            };
            createdPayoutItems.push({ ...item, input });
            payoutItemsStore.set(item.id, item);
            return item;
          }),
        ),
        markTransferred: vi.fn(
          async (
            payoutItemId: string,
            stripeTransferId: string | null,
            transferredAt: Date,
          ) => {
            const item = payoutItemsStore.get(payoutItemId);
            if (item) {
              item.status = "transferred";
              item.stripeTransferId = stripeTransferId;
              item.transferredAt = transferredAt;
            }
          },
        ),
        markFailed: vi.fn(
          async (payoutItemId: string, failedAt: Date, reason: string) => {
            const item = payoutItemsStore.get(payoutItemId);
            if (item) {
              item.status = "failed";
              item.failedAt = failedAt;
              item.failureReason = reason;
            }
          },
        ),
        getById: vi.fn(
          async (payoutItemId: string) =>
            payoutItemsStore.get(payoutItemId) ?? null,
        ),
        listPendingWithPlanOlderThan: vi.fn(async (cutoff: Date) =>
          [...payoutItemsStore.values()]
            .filter(
              (item) =>
                item.status === "pending" &&
                item.payoutLedgerKey != null &&
                item.createdAt < cutoff,
            )
            .map((item) => ({
              id: item.id,
              payeeId: item.payeeId,
              currency: item.currency,
              payoutLedgerKey: item.payoutLedgerKey,
            })),
        ),
        payeeIdsWithTransferredPayoutInPeriod: vi.fn(
          async ({ payeeIds }: { payeeIds: string[] }) =>
            new Set(
              payeeIds.filter(
                (id) => overrides.payeesActiveThisMonth?.has(id) ?? false,
              ),
            ),
        ),
        listTransferredWithReserveActivity: vi.fn(async () => []),
        listTransferredNeedingLedgerHeal: vi.fn(async () => {
          if (overrides.itemsNeedingLedgerHeal) {
            return overrides.itemsNeedingLedgerHeal;
          }
          // Mirrors the adapter's feed INCLUDING both probes: transferred
          // rows with a plan whose PAYOUT entry (idempotencyKey ===
          // payoutLedgerKey) is missing from the journal, OR whose entry
          // exists but a planned order item was never stamped paidOutAt.
          return [...payoutItemsStore.values()]
            .filter(
              (item) =>
                item.status === "transferred" &&
                item.payoutLedgerKey != null &&
                (!ledgerEntries.some(
                  (e) => e.idempotencyKey === item.payoutLedgerKey,
                ) ||
                  (item.plannedOrderItemIds ?? []).some(
                    (id: string) => !paidOutStampedItemIds.has(id),
                  )),
            )
            .map((item) => ({
              id: item.id,
              payoutId: item.payoutId,
              payeeId: item.payeeId,
              currency: item.currency,
              amountCents: item.amountCents,
              plannedCreditEntryIds: item.plannedCreditEntryIds ?? [],
              plannedOrderItemIds: item.plannedOrderItemIds ?? [],
              plannedNetCents: item.plannedNetCents ?? 0,
              payoutLedgerKey: item.payoutLedgerKey,
              stripeTransferId: item.stripeTransferId,
            }));
        }),
        earliestTransferredPayoutAtByPayee: vi.fn(
          async ({
            payeeIds,
            orderKind,
          }: {
            payeeIds: string[];
            orderKind: string;
          }) => {
            const source =
              orderKind === "MEMBERSHIP"
                ? overrides.firstMembershipPayoutAtByPayee
                : overrides.firstTicketingPayoutAtByPayee;
            const result = new Map<string, Date>();
            for (const id of payeeIds) {
              const at = source?.[id];
              if (at) result.set(id, at);
            }
            return result;
          },
        ),
      },
      payees: {
        getById: vi.fn(async (id: string) => payees.get(id) ?? null),
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => payees.get(id)).filter(Boolean),
        ),
      },
      payeeLedger: {
        listPayableBalances: vi.fn(async (asOf: Date, payeeIds?: string[]) => {
          const rows = payableFor(asOf);
          return payeeIds === undefined
            ? rows
            : rows.filter((r) => payeeIds.includes(r.payeeId));
        }),
        listConsumableCredits: vi.fn(
          async (payeeId: string, currency: string, asOf: Date) =>
            ledgerEntries
              .filter(
                (e) =>
                  e.type === "SETTLEMENT_CREDIT" &&
                  e.payeeId === payeeId &&
                  e.currency === currency &&
                  e.availableAt != null &&
                  e.availableAt <= asOf &&
                  e.consumedByEntryId === null,
              )
              .sort(
                (a, b) =>
                  (a.availableAt?.getTime() ?? 0) -
                  (b.availableAt?.getTime() ?? 0),
              )
              .map((e) => ({
                id: e.id,
                orderId: e.orderId,
                amountCents: e.amountCents,
                metadata: e.metadata,
              })),
        ),
        listOrderEntriesForOrders: vi.fn(async (orderIds: string[]) => {
          const grouped = new Map<string, unknown[]>();
          for (const orderId of orderIds) {
            const rows = ledgerEntries
              .filter(
                (e) =>
                  e.orderId === orderId &&
                  (e.type === "SETTLEMENT_CREDIT" ||
                    e.type === "REFUND_DEBIT" ||
                    e.type === "TRANSFER_REVERSAL_CREDIT"),
              )
              .map((e) => mockLedgerEntry({ ...e }));
            if (rows.length > 0) grouped.set(orderId, rows);
          }
          return grouped;
        }),
        listOrderEntries: vi.fn(async (orderId: string) =>
          ledgerEntries
            .filter(
              (e) =>
                e.orderId === orderId &&
                (e.type === "SETTLEMENT_CREDIT" ||
                  e.type === "REFUND_DEBIT" ||
                  e.type === "TRANSFER_REVERSAL_CREDIT"),
            )
            .map((e) => mockLedgerEntry({ ...e })),
        ),
        payoutDebit: vi.fn(async (input: any) => {
          const existing = ledgerEntries.find(
            (e) => e.idempotencyKey === input.idempotencyKey,
          );
          if (existing) return mockLedgerEntry({ ...existing });
          const row = addEntry({
            idempotencyKey: input.idempotencyKey,
            payeeId: input.payeeId,
            type: "PAYOUT",
            amountCents: input.amountCents,
            currency: input.currency,
            metadata: input.metadata,
          });
          return mockLedgerEntry({ ...row, sourceId: input.sourceId });
        }),
        markCreditsConsumed: vi.fn(
          async (creditEntryIds: string[], payoutEntryId: string) => {
            let count = 0;
            for (const id of creditEntryIds) {
              const row = ledgerEntries.find(
                (e) => e.id === id && e.type === "SETTLEMENT_CREDIT",
              );
              if (!row || row.consumedByEntryId !== null) continue;
              row.consumedByEntryId = payoutEntryId;
              count++;
            }
            return count;
          },
        ),
        reserveHold: vi.fn(async (input: any) => {
          appliedReserveHoldKeys.add(input.idempotencyKey);
          return mockLedgerEntry({
            idempotencyKey: input.idempotencyKey,
            payeeId: input.payeeId,
            type: "RESERVE_HOLD",
            amountCents: input.amountCents,
            currency: input.currency,
            sourceId: input.payoutItemId,
          });
        }),
        reserveRelease: vi.fn(async (input: any) => {
          const hold = reserveHoldsStore.find(
            (h) => h.id === input.holdEntryId,
          );
          if (!hold) {
            throw new Error("payee_ledger_reserve_release_hold_not_found");
          }
          if (!releasedHoldIds.has(hold.id)) {
            releasedHoldIds.add(hold.id);
            reserveReleasedSumsByItem.set(
              input.payoutItemId,
              (reserveReleasedSumsByItem.get(input.payoutItemId) ?? 0) +
                hold.amountCents,
            );
          }
          return mockLedgerEntry({
            idempotencyKey: input.idempotencyKey,
            payeeId: hold.payeeId,
            type: "RESERVE_RELEASE",
            amountCents: hold.amountCents,
            currency: hold.currency,
            sourceId: input.payoutItemId,
            relatedEntryId: hold.id,
          });
        }),
        listUnreleasedReserveHolds: vi.fn(async (payeeIds: string[]) =>
          reserveHoldsStore
            .filter(
              (h) => payeeIds.includes(h.payeeId) && !releasedHoldIds.has(h.id),
            )
            .map((h) =>
              mockLedgerEntry({
                idempotencyKey: `reserve-hold:${h.id}`,
                id: h.id,
                payeeId: h.payeeId,
                type: "RESERVE_HOLD",
                amountCents: h.amountCents,
                currency: h.currency,
                createdAt: h.createdAt,
              }),
            ),
        ),
        sumReserveReleasedByPayoutItem: vi.fn(async (itemIds: string[]) => {
          const result = new Map<string, number>();
          for (const id of itemIds) {
            const sum = reserveReleasedSumsByItem.get(id);
            if (sum != null) result.set(id, sum);
          }
          return result;
        }),
      },
      audit: { log: vi.fn(async () => {}) },
    },
    payments: {
      createTransfer: vi.fn(async (args: any) => {
        overrides.beforeTransfer?.({ ledgerEntries, addEntry });
        const payeeId = args.metadata?.payeeId as string | undefined;
        const currency = args.currency as string | undefined;
        if (
          transferThrow &&
          (!overrides.transferThrowForPayees ||
            (payeeId && overrides.transferThrowForPayees.has(payeeId))) &&
          (!overrides.transferThrowForCurrencies ||
            (currency && overrides.transferThrowForCurrencies.has(currency)))
        ) {
          throw transferThrow;
        }
        return transferResult;
      }),
    },
    idempotency: {
      get: vi.fn(async (key: string) => idempotencyStore.get(key) ?? null),
      begin: vi.fn(async (key: string) => {
        if (idempotencyClaims.has(key) || idempotencyStore.has(key)) {
          return false;
        }
        idempotencyClaims.add(key);
        return true;
      }),
      commit: vi.fn(async (key: string, value: unknown) => {
        idempotencyStore.set(key, value);
      }),
      fail: vi.fn(async (key: string) => {
        idempotencyClaims.delete(key);
      }),
    },
    clock: { now: () => now },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    } as any,
    reportError: vi.fn(),
    notifyPayee: vi.fn(async () => {}),
  };

  const run = (input: Record<string, unknown> = {}) =>
    runPayoutBatch(
      {
        repos: mocks.repos as any,
        payments: mocks.payments as any,
        idempotency: mocks.idempotency as any,
        clock: mocks.clock,
        logger: mocks.logger,
        reportError: mocks.reportError,
        notifyPayee: mocks.notifyPayee,
      },
      input,
    );

  return {
    mocks,
    run,
    ledgerEntries,
    createdPayoutItems,
    payableFor,
    addEntry,
    releasedHoldIds,
    idempotencyStore,
    payoutItemsStore,
    /**
     * Flip the transfer outcome BETWEEN runs of the same harness — the seam
     * for "the platform balance was dry last night and is topped up tonight".
     */
    setTransferThrow: (err: Error | null) => {
      transferThrow = err;
    },
  };
}


const entriesOfType = (entries: LedgerEntry[], type: LedgerEntry["type"]) =>
  entries.filter((e) => e.type === type);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runPayoutBatch (ledger-authoritative)", () => {
  it("returns early when nothing is payable", async () => {
    const { mocks, run } = makeDeps({ credits: [] });
    const result = await run();

    expect(result.payoutId).toBeNull();
    expect(result.itemsCreated).toBe(0);
    expect(result.payeesConsidered).toBe(0);
    expect(mocks.repos.payouts.create).not.toHaveBeenCalled();
    expect(mocks.payments.createTransfer).not.toHaveBeenCalled();
  });

  it("happy path: matured credits pay out, are consumed, and stamp their items", async () => {
    const { mocks, run, ledgerEntries } = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 6000,
          items: { "oi-1": 4000, "oi-2": 2000 },
        },
        { id: "c2", orderId: "order-2", amountCents: 4000, items: { "oi-3": 4000 } },
      ],
    });

    const result = await run();

    expect(result.itemsCreated).toBe(1);
    expect(result.itemsTransferred).toBe(1);
    expect(result.itemsFailed).toBe(0);
    expect(result.totalTransferredCents).toBe(10_000);
    expect(result.totalPayableClaimedCents).toBe(10_000);

    expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000, currency: "usd" }),
    );

    // PAYOUT entry = the PAYABLE CLAIMED, keyed on the CELL HASH (payee +
    // currency + sorted credit ids) — never on the payout item id, which the
    // next batch re-mints for the same money.
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: buildPayoutLedgerKey(PAYEE_A, "usd", ["c1", "c2"]),
        payeeId: PAYEE_A,
        amountCents: 10_000,
        currency: "usd",
        sourceKind: "payout_item",
        sourceId: "pi-1",
        metadata: expect.objectContaining({
          consumedCreditEntryIds: ["c1", "c2"],
        }),
      }),
    );

    // Both credits consumed (attribution), items stamped paidOutAt.
    expect(mocks.repos.payeeLedger.markCreditsConsumed).toHaveBeenCalledWith(
      ["c1", "c2"],
      expect.any(String),
    );
    expect(
      ledgerEntries
        .filter((e) => e.type === "SETTLEMENT_CREDIT")
        .every((e) => e.consumedByEntryId !== null),
    ).toBe(true);
    const paidOutArgs = mocks.repos.orderItems.markItemsPaidOut.mock.calls[0]!;
    expect(paidOutArgs[0]).toEqual(
      expect.arrayContaining(["oi-1", "oi-2", "oi-3"]),
    );

    expect(mocks.notifyPayee).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: PAYEE_A,
        payoutItemId: "pi-1",
        amountCents: 10_000,
        currency: "usd",
        settlementCount: 2,
        // The consumed credits ride along so the email can name each order
        // — read from the plan cell, since by notify time they are stamped
        // consumed and no longer readable as consumable.
        credits: [
          { entryId: "c1", orderId: "order-1", amountCents: 6000 },
          { entryId: "c2", orderId: "order-2", amountCents: 4000 },
        ],
        recoveredDebtCents: 0,
        connectAccountFeeCents: 0,
        reserveHeldCents: 0,
        reserveReleasedCents: 0,
        payoutDateIso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  it("THE LEAK, INVERTED: a refund debit reduces the transfer to the cent", async () => {
    // Characterization inversion. Pre-cutover, a refund inside the pending
    // window left `Settlement.amountCents` untouched, so the organizer was
    // still paid the full amount — the P0 documented in
    // docs/specs/2026-08-10/completed/settlement-cancellation-granularity.spec.md. The
    // ledger makes it unrepresentable: the debit is ALWAYS effective, the
    // credit only counts once matured, and there is no second stored total
    // anyone has to remember to update.
    const { mocks, run } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
      refundDebits: [{ id: "d1", orderId: "order-1", amountCents: 4_000 }],
    });

    const result = await run();

    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 6_000 }),
    );
    expect(result.totalTransferredCents).toBe(6_000);
    expect(result.totalPayableClaimedCents).toBe(6_000);
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 6_000 }),
    );
  });

  it("debt carry: a negative payable pays nothing, and the next cycle recoups by arithmetic", async () => {
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 5_000 }],
      refundDebits: [{ id: "d1", orderId: "order-1", amountCents: 8_000 }],
    });

    expect(harness.payableFor(now)[0]!.payableCents).toBe(-3_000);

    const first = await harness.run();
    expect(first.payoutId).toBeNull();
    expect(first.itemsCreated).toBe(0);
    expect(harness.mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(harness.mocks.repos.payeeLedger.payoutDebit).not.toHaveBeenCalled();
    // No recovery entry, no squaring, no sweep — the debt is just the balance.
    expect(entriesOfType(harness.ledgerEntries, "PAYOUT")).toHaveLength(0);

    // Next cycle: 8000 of new matured revenue against the 3000 carried debt.
    harness.addEntry({
      id: "c2",
      idempotencyKey: "settlement-credit:order-2:payee-a-uuid",
      type: "SETTLEMENT_CREDIT",
      amountCents: 8_000,
      orderId: "order-2",
      availableAt: YESTERDAY,
      metadata: { items: { "oi-2": 8_000 } },
    });

    const second = await harness.run();
    expect(second.totalTransferredCents).toBe(5_000);
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5_000 }),
    );
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5_000 }),
    );
  });

  // Spec 2026-10-07 door-sales-same-price-and-tax, FR-004 / owner ruling R6:
  // a door cash sale's platform fee + tax is owed to the platform and comes
  // out of the organiser's next payout as a CASH_SALE_DEBIT. The debit is on
  // the cash ORDER, which has no settlement credit of its own.
  it("cash sale debit: card revenue minus the cash fee + tax is what transfers", async () => {
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-card", amountCents: 10_000 }],
    });
    harness.addEntry({
      id: "cash-1",
      idempotencyKey: "cash-sale-debit:order-cash",
      type: "CASH_SALE_DEBIT",
      amountCents: 700,
      orderId: "order-cash",
    });

    expect(harness.payableFor(now)[0]!.payableCents).toBe(9_300);

    const result = await harness.run();

    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9_300 }),
    );
    expect(result.totalTransferredCents).toBe(9_300);
    expect(result.totalPayableClaimedCents).toBe(9_300);
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9_300 }),
    );
  });

  it("cash-only organiser: the debit pays nothing, carries, and nets against the first card revenue", async () => {
    const harness = makeDeps({ credits: [] });
    harness.addEntry({
      id: "cash-1",
      idempotencyKey: "cash-sale-debit:order-cash",
      type: "CASH_SALE_DEBIT",
      amountCents: 1_536,
      orderId: "order-cash",
    });

    expect(harness.payableFor(now)[0]!.payableCents).toBe(-1_536);

    const first = await harness.run();
    expect(first.payoutId).toBeNull();
    expect(first.itemsCreated).toBe(0);
    expect(harness.mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(harness.mocks.repos.payeeLedger.payoutDebit).not.toHaveBeenCalled();

    harness.addEntry({
      id: "c2",
      idempotencyKey: "settlement-credit:order-2:payee-a-uuid",
      type: "SETTLEMENT_CREDIT",
      amountCents: 8_000,
      orderId: "order-2",
      availableAt: YESTERDAY,
      metadata: { items: { "oi-2": 8_000 } },
    });

    const second = await harness.run();
    expect(second.totalTransferredCents).toBe(6_464);
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 6_464 }),
    );
  });

  it("a refunded cash sale (debit + reversal) leaves the transfer whole", async () => {
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-card", amountCents: 10_000 }],
    });
    harness.addEntry({
      id: "cash-1",
      idempotencyKey: "cash-sale-debit:order-cash",
      type: "CASH_SALE_DEBIT",
      amountCents: 700,
      orderId: "order-cash",
    });
    harness.addEntry({
      id: "cash-1-rev",
      idempotencyKey: "cash-sale-debit-reversal:order-cash",
      type: "CASH_SALE_DEBIT_REVERSAL",
      amountCents: 700,
      orderId: "order-cash",
    });

    expect(harness.payableFor(now)[0]!.payableCents).toBe(10_000);
    const result = await harness.run();
    expect(result.totalTransferredCents).toBe(10_000);
  });

  it("immature credits never transfer; the maturity boundary is inclusive", async () => {
    // c-immature matures next week; c-boundary matures EXACTLY at `now`.
    const { mocks, run } = makeDeps({
      credits: [
        {
          id: "c-immature",
          orderId: "order-future",
          amountCents: 9_000,
          availableAt: NEXT_WEEK,
        },
        {
          id: "c-boundary",
          orderId: "order-today",
          amountCents: 2_500,
          availableAt: now,
        },
      ],
    });

    const result = await run();

    expect(result.totalTransferredCents).toBe(2_500);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2_500 }),
    );
    // Only the matured credit is attributed.
    expect(mocks.repos.payeeLedger.markCreditsConsumed).toHaveBeenCalledWith(
      ["c-boundary"],
      expect.any(String),
    );
  });

  it("minimum gate: a payable below the minimum pays nothing and consumes nothing", async () => {
    const { mocks, run } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 800 }],
      globalPolicy: { payoutMinimumCents: 1000 },
    });

    const result = await run();

    expect(result.itemsSkippedBelowMinimum).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(result.payoutId).toBeNull();
    expect(mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(
      mocks.repos.payeeLedger.markCreditsConsumed,
    ).not.toHaveBeenCalled();
  });

  it("ineligible payee (payouts disabled) is skipped with credits intact", async () => {
    const { mocks, run, ledgerEntries } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
      payees: new Map([[PAYEE_A, makePayee(PAYEE_A, "acct_test", false)]]),
    });

    const result = await run();

    expect(result.itemsSkippedIneligible).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsFailed).toBe(0);
    expect(mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId).toBe(
      null,
    );
    // Deliberate swallow — Sentry must see it.
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `payee_payouts_disabled: ${PAYEE_A}`,
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "payee_eligibility" }),
      }),
    );
  });

  it("reserve: withholds the membership portion, still claims the FULL payable", async () => {
    // 10_000 payable, all MEMBERSHIP, brand-new payee → 1000 bps = 1_000.
    const { mocks, run } = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-m",
          amountCents: 10_000,
          items: { "oi-1": 10_000 },
        },
      ],
      orderKinds: { "order-m": "MEMBERSHIP" },
    });

    const result = await run();

    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9_000 }),
    );
    expect(result.totalTransferredCents).toBe(9_000);
    expect(result.reserveHeldCents).toBe(1_000);
    expect(result.itemsWithReserveHeld).toBe(1);
    // The PAYOUT entry claims the payable, NOT the transfer — otherwise the
    // withheld 1_000 stays payable and pays again next cycle.
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000 }),
    );
    expect(mocks.repos.payeeLedger.reserveHold).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "reserve-hold:pi-1",
        amountCents: 1_000,
        payoutItemId: "pi-1",
      }),
    );
  });

  it("reserve: a matured hold RIDES the transfer but is excluded from the payable claim", async () => {
    const oldHold = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const { mocks, run, releasedHoldIds } = makeDeps({
      // Pure ticketing so no NEW reserve is withheld — isolates the release.
      credits: [{ id: "c1", orderId: "order-t", amountCents: 10_000 }],
      unreleasedReserveHolds: [
        {
          id: "hold-1",
          payeeId: PAYEE_A,
          amountCents: 1_500,
          currency: "usd",
          createdAt: oldHold,
        },
      ],
    });

    const result = await run();

    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 11_500 }),
    );
    expect(result.totalTransferredCents).toBe(11_500);
    expect(result.reserveReleasedCents).toBe(1_500);
    // The released cents were claimed by the cycle that WITHHELD them.
    expect(result.totalPayableClaimedCents).toBe(10_000);
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000 }),
    );
    expect(releasedHoldIds.has("hold-1")).toBe(true);
  });

  it("reserve: a hold stored in a NON-LOWERCASE currency still releases", async () => {
    // The batch built its hold lookup with the RAW `hold.currency` but read it
    // with `normalizeCurrency(cell.currency)`. A hold whose stored currency is
    // not already lowercase therefore hashed to a key nothing ever looked up:
    // `anyReserveWork` read false, `holds` read [], no RESERVE_RELEASE was
    // planned, and the payee's deferred cents were never returned. Silently —
    // the batch reports success and the money simply stays withheld.
    //
    // The write path lowercases, so this arrives only from legacy rows, a
    // backfill or direct SQL — the same provenance that makes the liability
    // duplicate reachable.
    const oldHold = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const { mocks, run, releasedHoldIds } = makeDeps({
      credits: [{ id: "c1", orderId: "order-t", amountCents: 10_000 }],
      unreleasedReserveHolds: [
        {
          id: "hold-1",
          payeeId: PAYEE_A,
          amountCents: 1_500,
          currency: "USD",
          createdAt: oldHold,
        },
      ],
    });

    const result = await run();

    expect(result.reserveReleasedCents).toBe(1_500);
    expect(releasedHoldIds.has("hold-1")).toBe(true);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 11_500 }),
    );
  });

  it("reserve: a legacy 'USD' refund still nets out of a 'usd' cell's reserve basis", async () => {
    // netContributionCents matched order entries to the cell on the RAW
    // currency. A refund stored as 'USD' against a 'usd' cell was skipped,
    // so the membership credit counted at its gross 10_000 and the reserve
    // was held on money already refunded. The ticketing credit keeps the
    // payable (16_000) above the basis so the min() cap cannot mask it.
    const { mocks, run } = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-m",
          amountCents: 10_000,
          items: { "oi-m": 10_000 },
        },
        {
          id: "c2",
          orderId: "order-t",
          amountCents: 10_000,
          items: { "oi-t": 10_000 },
        },
      ],
      refundDebits: [
        { id: "d1", orderId: "order-m", amountCents: 4_000, currency: "USD" },
      ],
      orderKinds: { "order-m": "MEMBERSHIP", "order-t": "TICKETING" },
      standings: [
        {
          ownerOrgId: `org-${PAYEE_A}`,
          ownerHumanId: null,
          reserveBps: 1_000,
          reserveReleaseDays: 90,
          overriddenBy: "admin-1",
        },
      ],
    });

    const result = await run();

    // Basis = 10_000 - 4_000 = 6_000; 1000 bps → 600 (not 1_000).
    expect(result.reserveHeldCents).toBe(600);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 15_400 }),
    );
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 16_000 }),
    );
  });

  it("crash sweep: a release stamped on a 'usd' item heals against a legacy 'USD' hold", async () => {
    // The sweep reconstructs a crashed run's RESERVE_RELEASE entries by
    // matching the transferred item's currency to the outstanding holds.
    // Compared raw, a 'USD' hold never matched, the 1_500 remainder read as
    // unmatchable, and the whole reserve step was skipped as an integrity
    // violation.
    const oldHold = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-t", amountCents: 10_000 }],
      unreleasedReserveHolds: [
        {
          id: "hold-1",
          payeeId: PAYEE_A,
          amountCents: 1_500,
          currency: "USD",
          createdAt: oldHold,
        },
      ],
    });
    harness.mocks.repos.payoutItems.listTransferredWithReserveActivity = vi.fn(
      async () => [
        {
          id: "pi-old",
          payoutId: "payout-old",
          payeeId: PAYEE_A,
          currency: "usd",
          reserveHeldCents: 0,
          reserveReleasedCents: 1_500,
        },
      ],
    ) as any;

    await harness.run();

    expect(harness.mocks.repos.payeeLedger.reserveRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        holdEntryId: "hold-1",
        payoutItemId: "pi-old",
        metadata: expect.objectContaining({ source: "crash_sweep" }),
      }),
    );
    expect(harness.releasedHoldIds.has("hold-1")).toBe(true);
    // Released by the sweep, so tonight's transfer does not carry it again.
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000 }),
    );
  });

  it("connect fee: withheld from the transfer, never from the payable claim", async () => {
    const { mocks, run } = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-m",
          amountCents: 10_000,
          items: { "oi-1": 10_000 },
        },
      ],
      // Membership-only revenue with no seasoning history would also hold a
      // reserve; pin the standing to 0 bps so the fee is the only deduction.
      orderKinds: { "order-m": "MEMBERSHIP" },
      standings: [
        {
          ownerOrgId: `org-${PAYEE_A}`,
          ownerHumanId: null,
          reserveBps: 0,
          reserveReleaseDays: 90,
          overriddenBy: "admin-1",
        },
      ],
      globalPolicy: { payoutMinimumCents: 1000, connectAccountFeeCents: 200 },
    });

    const result = await run();

    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9_800 }),
    );
    expect(result.connectFeeCents).toBe(200);
    expect(result.itemsWithConnectAccountFee).toBe(1);
    expect(result.totalTransferredCents).toBe(9_800);
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000 }),
    );
  });

  it("zero-net item: withholding consumes everything, so no Stripe call is made", async () => {
    // A manual standing pins 10_000 bps (100%) on a membership-only payout.
    const { mocks, run } = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-m",
          amountCents: 4_000,
          items: { "oi-1": 4_000 },
        },
      ],
      orderKinds: { "order-m": "MEMBERSHIP" },
      standings: [
        {
          ownerOrgId: `org-${PAYEE_A}`,
          ownerHumanId: null,
          reserveBps: 10_000,
          reserveReleaseDays: 90,
          overriddenBy: "admin-1",
        },
      ],
    });

    const result = await run();

    expect(mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(result.itemsTransferred).toBe(1);
    expect(result.itemsFullyWithheld).toBe(1);
    expect(result.totalTransferredCents).toBe(0);
    expect(result.reserveHeldCents).toBe(4_000);
    // The payable is still fully claimed — otherwise it pays again.
    expect(result.totalPayableClaimedCents).toBe(4_000);
    expect(mocks.repos.payoutItems.markTransferred).toHaveBeenCalledWith(
      "pi-1",
      null,
      expect.any(Date),
    );
    // Pinned to the same field set as the payout-path assertion so a field
    // dropped from ONE call site cannot go unnoticed.
    expect(mocks.notifyPayee).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: PAYEE_A,
        payoutItemId: "pi-1",
        kind: "reserved",
        // The RESERVED amount, not the $0.00 that landed.
        amountCents: 4_000,
        currency: "usd",
        settlementCount: 1,
        credits: [{ entryId: "c1", orderId: "order-m", amountCents: 4_000 }],
        recoveredDebtCents: 0,
        connectAccountFeeCents: 0,
        reserveHeldCents: 4_000,
        reserveReleasedCents: 0,
        payoutDateIso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  it("race guard: a refund landing after planning fails the item instead of overpaying", async () => {
    const { mocks, run, ledgerEntries } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
      beforeTransfer: ({ addEntry }) => {
        // Should never be reached — the recheck happens BEFORE createTransfer.
        addEntry({
          idempotencyKey: "refund-debit:late",
          type: "REFUND_DEBIT",
          amountCents: 4_000,
          orderId: "order-1",
        });
      },
    });

    // Drop the payable between planning and the per-item recheck: the first
    // listPayableBalances call is the plan, the second is the guard.
    let payableCalls = 0;
    const realList = mocks.repos.payeeLedger.listPayableBalances;
    mocks.repos.payeeLedger.listPayableBalances = vi.fn(
      async (asOf: Date, payeeIds?: string[]) => {
        payableCalls++;
        if (payableCalls > 1) {
          ledgerEntries.push({
            id: "d-late",
            idempotencyKey: "refund-debit:late",
            payeeId: PAYEE_A,
            type: "REFUND_DEBIT",
            amountCents: 4_000,
            currency: "usd",
            orderId: "order-1",
            availableAt: null,
            consumedByEntryId: null,
            metadata: null,
          });
        }
        return realList(asOf, payeeIds);
      },
    ) as any;

    const result = await run();

    expect(mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(result.itemsSkippedPayableDropped).toBe(1);
    expect(result.itemsFailed).toBe(1);
    expect(mocks.repos.payoutItems.markFailed).toHaveBeenCalledWith(
      "pi-1",
      expect.any(Date),
      "payable_dropped_before_transfer",
    );
    expect(mocks.repos.payeeLedger.payoutDebit).not.toHaveBeenCalled();
    expect(ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId).toBe(
      null,
    );
  });

  it("transfer throws: the item fails, its claim is released, and other payees still pay", async () => {
    const { mocks, run, ledgerEntries } = makeDeps({
      credits: [
        { id: "c1", payeeId: PAYEE_A, orderId: "order-a", amountCents: 10_000 },
        { id: "c2", payeeId: PAYEE_B, orderId: "order-b", amountCents: 7_000 },
      ],
      payees: new Map([
        [PAYEE_A, makePayee(PAYEE_A)],
        [PAYEE_B, makePayee(PAYEE_B)],
      ]),
      transferThrow: new Error("stripe_unavailable"),
      transferThrowForPayees: new Set([PAYEE_A]),
    });

    const result = await run();

    expect(result.itemsFailed).toBe(1);
    expect(result.itemsTransferred).toBe(1);
    expect(result.totalTransferredCents).toBe(7_000);
    expect(mocks.repos.payoutItems.markFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Date),
      "stripe_unavailable",
    );
    expect(mocks.idempotency.fail).toHaveBeenCalledWith(
      expect.stringMatching(/^payout-transfer:/),
      "stripe_unavailable",
    );
    // The failed payee's credit is untouched: next cycle re-plans it.
    expect(ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId).toBe(
      null,
    );
    expect(ledgerEntries.find((e) => e.id === "c2")!.consumedByEntryId).not.toBe(
      null,
    );
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stripe_unavailable" }),
      expect.objectContaining({
        tags: expect.objectContaining({ payeeId: PAYEE_A }),
      }),
    );
  });

  describe("platform float exhaustion (Stripe balance_insufficient)", () => {
    /**
     * What the Stripe adapter re-throws when the PLATFORM's own available
     * balance can't fund a transfer. Duck-typed exactly as core detects it —
     * core must not import @th/adapters, so the marker flag IS the contract.
     */
    const platformShortfall = () =>
      Object.assign(new Error("insufficient available funds"), {
        name: "StripeInsufficientPlatformBalanceError",
        isInsufficientPlatformBalanceError: true as const,
      });

    it("counts the shortfall distinctly, still counts it as failed, and leaves the money alone", async () => {
      const { mocks, run, ledgerEntries } = makeDeps({
        credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
        transferThrow: platformShortfall(),
      });

      const result = await run();

      expect(result.itemsFailedInsufficientPlatformBalance).toBe(1);
      // ALSO counted as a plain failure: the payee genuinely was not paid, and
      // step 11 must see a batch that paid nobody as a FAILED payout.
      expect(result.itemsFailed).toBe(1);
      expect(result.itemsTransferred).toBe(0);
      expect(result.totalTransferredCents).toBe(0);
      expect(mocks.repos.payouts.markFailed).toHaveBeenCalled();

      // The money is untouched: credit unconsumed, no PAYOUT entry.
      expect(ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId).toBe(
        null,
      );
      expect(entriesOfType(ledgerEntries, "PAYOUT")).toHaveLength(0);
      expect(mocks.repos.payeeLedger.payoutDebit).not.toHaveBeenCalled();

      // The transfer claim is RELEASED — nothing was sent, so tomorrow's run
      // must be able to claim the same cell hash again.
      expect(mocks.idempotency.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^payout-transfer:/),
        "insufficient available funds",
      );

      // Distinct, greppable log — never the generic transfer_failed.
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "runPayoutBatch.platform_balance_insufficient",
        expect.objectContaining({ payeeId: PAYEE_A, currency: "usd" }),
      );
      expect(mocks.logger.error).not.toHaveBeenCalledWith(
        "runPayoutBatch.transfer_failed",
        expect.anything(),
      );

      // A LONE shortfall is already fully described by its own event, so the
      // aggregate follow-up must stay quiet.
      expect(mocks.reportError).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({
            step: "platform_float_exhausted_summary",
          }),
        }),
      );

      // Sentry gets its own issue via the distinct step tag.
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "insufficient available funds" }),
        expect.objectContaining({
          tags: expect.objectContaining({
            job: "settlements.run-batch",
            step: "transfer_balance_insufficient",
            payeeId: PAYEE_A,
          }),
        }),
      );
    });

    it("re-plans and pays the same money on the next run once the float is back", async () => {
      const harness = makeDeps({
        credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
        transferThrow: platformShortfall(),
      });

      const dry = await harness.run();
      expect(dry.itemsFailedInsufficientPlatformBalance).toBe(1);
      expect(dry.totalTransferredCents).toBe(0);

      // Operator tops up. Our nightly re-plan IS the explicit re-attempt
      // Stripe requires — it never retries a balance_insufficient itself.
      harness.setTransferThrow(null);
      const wet = await harness.run();

      expect(wet.itemsFailedInsufficientPlatformBalance).toBe(0);
      expect(wet.itemsTransferred).toBe(1);
      expect(wet.totalTransferredCents).toBe(10_000);
      expect(
        harness.ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId,
      ).not.toBe(null);
      expect(entriesOfType(harness.ledgerEntries, "PAYOUT")).toHaveLength(1);
    });

    it("short-circuits the rest of that currency instead of firing N doomed calls", async () => {
      const harness = makeDeps({
        credits: [
          {
            id: "c1",
            payeeId: PAYEE_A,
            orderId: "order-a",
            amountCents: 10_000,
          },
          {
            id: "c2",
            payeeId: PAYEE_B,
            orderId: "order-b",
            amountCents: 7_000,
          },
        ],
        payees: new Map([
          [PAYEE_A, makePayee(PAYEE_A)],
          [PAYEE_B, makePayee(PAYEE_B)],
        ]),
        transferThrow: platformShortfall(),
      });
      const { mocks, run, ledgerEntries } = harness;

      const result = await run();

      // ONE Stripe round-trip, not two: the breaker armed on the first.
      expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
      expect(result.itemsFailedInsufficientPlatformBalance).toBe(2);
      expect(result.itemsFailed).toBe(2);
      expect(result.itemsTransferred).toBe(0);

      // ...and ONE Sentry event, not one per payee.
      const shortfallReports = mocks.reportError.mock.calls.filter(
        ([, ctx]: any[]) =>
          ctx?.tags?.step === "transfer_balance_insufficient",
      );
      expect(shortfallReports).toHaveLength(1);

      // The arming event fires from the first item and cannot know the blast
      // radius, so a closing aggregate carries the per-currency totals.
      expect(mocks.reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("platform_float_exhausted: 2"),
        }),
        expect.objectContaining({
          tags: expect.objectContaining({
            step: "platform_float_exhausted_summary",
          }),
          extra: expect.objectContaining({
            itemsFailedInsufficientPlatformBalance: 2,
            byCurrency: { usd: { items: 2, unfundedCents: 17_000 } },
          }),
        }),
      );

      // Both payees' money is untouched and both items are re-plannable.
      for (const id of ["c1", "c2"]) {
        expect(ledgerEntries.find((e) => e.id === id)!.consumedByEntryId).toBe(
          null,
        );
      }
      expect(entriesOfType(ledgerEntries, "PAYOUT")).toHaveLength(0);
      expect(mocks.repos.payoutItems.markFailed).toHaveBeenCalledTimes(2);
      expect(mocks.repos.payoutItems.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Date),
        "platform_balance_insufficient",
      );
      // The SKIPPED item never began a transfer claim, so `fail` must not be
      // called on one — that would write a spurious record for an unbegun key.
      expect(
        mocks.idempotency.fail.mock.calls.filter(([key]: any[]) =>
          String(key).startsWith("payout-transfer:"),
        ),
      ).toHaveLength(1);
      // Its planning-time cell claim IS released, so the next run re-plans it.
      expect(mocks.idempotency.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^payout:[^:]+:usd:/),
        "platform_balance_insufficient",
      );

      // ...and PROVE the re-plan, for the SKIPPED item specifically. The skip
      // path is separate code from the arming path (null claim key, constant
      // reason), so "the next batch pays them" cannot be inferred from the
      // arming item's recovery — it has to be exercised.
      harness.setTransferThrow(null);
      const recovered = await run();

      expect(recovered.itemsFailedInsufficientPlatformBalance).toBe(0);
      expect(recovered.itemsFailed).toBe(0);
      expect(recovered.itemsTransferred).toBe(2);
      expect(recovered.totalTransferredCents).toBe(17_000);
      for (const id of ["c1", "c2"]) {
        expect(
          ledgerEntries.find((e) => e.id === id)!.consumedByEntryId,
        ).not.toBe(null);
      }
      expect(entriesOfType(ledgerEntries, "PAYOUT")).toHaveLength(2);
    });

    it("a fully-withheld item still completes: it never needed the float", async () => {
      // PAYEE_A sorts first and is net-positive, so it arms the breaker.
      // PAYEE_B's membership payable is 100% reserve — net zero, terminal
      // WITHOUT any Stripe call — so a dry balance is irrelevant to it.
      const { mocks, run, ledgerEntries } = makeDeps({
        credits: [
          {
            id: "c-a",
            payeeId: PAYEE_A,
            orderId: "order-a",
            amountCents: 10_000,
          },
          {
            id: "c-b",
            payeeId: PAYEE_B,
            orderId: "order-b",
            amountCents: 4_000,
            items: { "oi-b": 4_000 },
          },
        ],
        payees: new Map([
          [PAYEE_A, makePayee(PAYEE_A)],
          [PAYEE_B, makePayee(PAYEE_B)],
        ]),
        orderKinds: { "order-b": "MEMBERSHIP" },
        standings: [
          {
            ownerOrgId: `org-${PAYEE_B}`,
            ownerHumanId: null,
            reserveBps: 10_000,
            reserveReleaseDays: 90,
            overriddenBy: "admin-1",
          },
        ],
        transferThrow: platformShortfall(),
      });

      const result = await run();

      // Only the net-positive item ever reached Stripe.
      expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
      expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 10_000 }),
      );

      // The shortfall counter describes ONE item, not two — overstating it
      // would send the operator hunting for a bigger hole than exists.
      expect(result.itemsFailedInsufficientPlatformBalance).toBe(1);
      expect(result.itemsFailed).toBe(1);

      // The zero-net item completed, so its reserve seasoning starts tonight
      // rather than being deferred for the length of the outage.
      expect(result.itemsTransferred).toBe(1);
      expect(result.itemsFullyWithheld).toBe(1);
      expect(result.reserveHeldCents).toBe(4_000);
      expect(result.totalPayableClaimedCents).toBe(4_000);
      expect(entriesOfType(ledgerEntries, "PAYOUT")).toHaveLength(1);
      expect(ledgerEntries.find((e) => e.id === "c-b")!.consumedByEntryId).not.toBe(
        null,
      );
      // ...while the item that DID need the float kept its money intact.
      expect(ledgerEntries.find((e) => e.id === "c-a")!.consumedByEntryId).toBe(
        null,
      );
    });

    it("the breaker is per-currency: a dry USD balance does not block CAD", async () => {
      const { mocks, run } = makeDeps({
        credits: [
          {
            id: "c-usd",
            orderId: "order-1",
            amountCents: 10_000,
            currency: "usd",
            // Older matured money sorts FIRST, so the USD shortfall happens
            // BEFORE the CAD item is reached. Without that, a global breaker
            // would pass this test by luck of the ordering.
            availableAt: new Date("2026-03-01T06:00:00Z"),
          },
          {
            id: "c-cad",
            orderId: "order-2",
            amountCents: 7_000,
            currency: "cad",
          },
        ],
        transferThrow: platformShortfall(),
        transferThrowForCurrencies: new Set(["usd"]),
      });

      const result = await run();

      expect(
        mocks.payments.createTransfer.mock.calls.map(
          ([args]: any[]) => args.currency,
        ),
      ).toEqual(["usd", "cad"]);
      expect(result.itemsFailedInsufficientPlatformBalance).toBe(1);
      expect(result.itemsTransferred).toBe(1);
      expect(result.totalTransferredCents).toBe(7_000);
    });

    it("an ordinary transfer failure still takes the old path and arms nothing", async () => {
      const { mocks, run } = makeDeps({
        credits: [
          {
            id: "c1",
            payeeId: PAYEE_A,
            orderId: "order-a",
            amountCents: 10_000,
          },
          {
            id: "c2",
            payeeId: PAYEE_B,
            orderId: "order-b",
            amountCents: 7_000,
          },
        ],
        payees: new Map([
          [PAYEE_A, makePayee(PAYEE_A)],
          [PAYEE_B, makePayee(PAYEE_B)],
        ]),
        transferThrow: new Error("stripe_unavailable"),
      });

      const result = await run();

      expect(result.itemsFailedInsufficientPlatformBalance).toBe(0);
      expect(result.itemsFailed).toBe(2);
      // No breaker: a per-payee fault must not stop the batch attempting the
      // next payee.
      expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(2);
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "runPayoutBatch.transfer_failed",
        expect.anything(),
      );
      expect(mocks.logger.error).not.toHaveBeenCalledWith(
        "runPayoutBatch.platform_balance_insufficient",
        expect.anything(),
      );
      expect(
        mocks.reportError.mock.calls.filter(
          ([, ctx]: any[]) =>
            ctx?.tags?.step === "transfer_balance_insufficient",
        ),
      ).toHaveLength(0);
    });
  });

  it("idempotent re-run: re-invoking the same cycle transfers nothing more", async () => {
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });

    const first = await harness.run();
    expect(first.totalTransferredCents).toBe(10_000);
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledTimes(1);

    const second = await harness.run();

    // The PAYOUT entry drove the payable to zero and the credit is consumed,
    // so the second run has nothing to plan: no transfer, no second debit.
    expect(second.payoutId).toBeNull();
    expect(second.itemsCreated).toBe(0);
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledTimes(1);
    expect(entriesOfType(harness.ledgerEntries, "PAYOUT")).toHaveLength(1);
  });

  it("multi-currency payee: two items, never summed", async () => {
    const { mocks, run, createdPayoutItems } = makeDeps({
      credits: [
        { id: "c-usd", orderId: "order-1", amountCents: 10_000, currency: "usd" },
        { id: "c-cad", orderId: "order-2", amountCents: 7_000, currency: "cad" },
      ],
    });

    const result = await run();

    expect(result.payeesConsidered).toBe(1);
    expect(result.itemsCreated).toBe(2);
    expect(result.itemsTransferred).toBe(2);
    expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(2);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7_000, currency: "cad" }),
    );
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000, currency: "usd" }),
    );
    expect(createdPayoutItems.map((i) => i.currency).sort()).toEqual([
      "cad",
      "usd",
    ]);
    // Two separate PAYOUT entries, one per currency bucket.
    expect(mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledTimes(2);
  });

  it("limit caps PAYEES, and both of a capped payee's currencies ride along", async () => {
    const { mocks, run } = makeDeps({
      credits: [
        { id: "c-a-usd", payeeId: PAYEE_A, orderId: "o1", amountCents: 10_000 },
        {
          id: "c-a-cad",
          payeeId: PAYEE_A,
          orderId: "o2",
          amountCents: 6_000,
          currency: "cad",
        },
        { id: "c-b-usd", payeeId: PAYEE_B, orderId: "o3", amountCents: 8_000 },
      ],
      payees: new Map([
        [PAYEE_A, makePayee(PAYEE_A)],
        [PAYEE_B, makePayee(PAYEE_B)],
      ]),
    });

    const result = await run({ limit: 1 });

    expect(result.payeesConsidered).toBe(1);
    expect(result.itemsCreated).toBe(2);
    expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(2);
    expect(
      mocks.payments.createTransfer.mock.calls.every(
        (call: any[]) => call[0].metadata.payeeId === PAYEE_A,
      ),
    ).toBe(true);
  });

  it("suspension circuit breaker: a suspended owner's MEMBERSHIP cell is held, ticketing pays", async () => {
    const { mocks, run, ledgerEntries } = makeDeps({
      credits: [
        {
          id: "c-mem",
          payeeId: PAYEE_A,
          orderId: "order-m",
          amountCents: 10_000,
        },
        {
          id: "c-tix",
          payeeId: PAYEE_B,
          orderId: "order-t",
          amountCents: 9_000,
        },
      ],
      payees: new Map([
        [PAYEE_A, makePayee(PAYEE_A)],
        [PAYEE_B, makePayee(PAYEE_B)],
      ]),
      orderKinds: { "order-m": "MEMBERSHIP", "order-t": "TICKETING" },
      standings: [
        {
          ownerOrgId: `org-${PAYEE_A}`,
          ownerHumanId: null,
          reserveBps: 0,
          reserveReleaseDays: 90,
          overriddenBy: null,
          suspended: true,
        },
      ],
    });

    const result = await run();

    expect(result.itemsHeldForSuspension).toBe(1);
    expect(result.itemsCreated).toBe(1);
    expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9_000 }),
    );
    // Held cell's credit is untouched — it pays after unsuspension.
    expect(
      ledgerEntries.find((e) => e.id === "c-mem")!.consumedByEntryId,
    ).toBe(null);
  });

  it("a credit-consumption mismatch is reported, never thrown", async () => {
    const { mocks, run } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });
    mocks.repos.payeeLedger.markCreditsConsumed = vi.fn(async () => 0) as any;

    const result = await run();

    expect(result.itemsTransferred).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("payout_credit_consumption_mismatch"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "mark_credits_consumed" }),
      }),
    );
  });

  it("a failed PAYOUT write is reported with the manual-adjustment remediation", async () => {
    const { mocks, run } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });
    mocks.repos.payeeLedger.payoutDebit = vi.fn(async () => {
      throw new Error("ledger_down");
    }) as any;

    const result = await run();

    // The money moved, so the item still completes — but Sentry must know.
    expect(result.itemsTransferred).toBe(1);
    expect(mocks.repos.payeeLedger.markCreditsConsumed).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ledger_down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "payout_debit" }),
        extra: expect.objectContaining({
          remediation: expect.stringContaining("MANUAL_ADJUSTMENT"),
        }),
      }),
    );
  });

  it("the Stripe idempotency key is derived from the CREDITS, not the payout item", async () => {
    // Load-bearing: a crash after the transfer but before the PAYOUT entry
    // leaves the credits unconsumed, so the next batch re-plans the SAME
    // credits into a NEW PayoutItem. Keying on the item id would let that
    // second run send the money again; keying on the credits makes Stripe
    // replay the original transfer.
    const first = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });
    await first.run();
    const firstKey =
      first.mocks.payments.createTransfer.mock.calls[0]![0].idempotencyKey;

    const second = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });
    // Same credits, but the payout item this run mints is `pi-1` again only
    // because the counter restarts; force a different one to prove the key
    // does not depend on it.
    second.mocks.repos.payoutItems.createMany = vi.fn(async (inputs: any[]) =>
      inputs.map((input: any) => ({
        id: "pi-999",
        payoutId: input.payoutId,
        payeeId: input.payeeId,
        currency: input.currency,
        amountCents: input.amountCents,
        connectAccountFeeCents: input.connectAccountFeeCents ?? 0,
        recoveredDebtCents: 0,
        reserveHeldCents: input.reserveHeldCents ?? 0,
        reserveReleasedCents: input.reserveReleasedCents ?? 0,
        stripeTransferId: null,
        status: "pending" as const,
        failedAt: null,
        failureReason: null,
        transferredAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    ) as any;
    await second.run();
    const secondKey =
      second.mocks.payments.createTransfer.mock.calls[0]![0].idempotencyKey;

    expect(secondKey).toBe(firstKey);
  });

  // ── BLOCKING-1 regression: two overlapping runs ─────────────────────────
  it("two interleaved runs produce ONE transfer, ONE payout entry, ONE consumption, ONE notify", async () => {
    // The cron and a manual `POST /jobs/settlements.run-batch` are not
    // mutually exclusive. Both runs read the same payable, plan the same
    // credits, and reach the ledger. Stripe dedupes the TRANSFER on the
    // credit-set key, so the damage a per-item key would let through is not a
    // double payment — it is the payee debited TWICE for one transfer.
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });

    // Interleave AT the transfer boundary: run B starts while run A is inside
    // createTransfer.
    let secondRun: Promise<unknown> | null = null;
    const realTransfer = harness.mocks.payments.createTransfer;
    harness.mocks.payments.createTransfer = vi.fn(async (args: any) => {
      if (!secondRun) secondRun = harness.run();
      return realTransfer(args);
    }) as any;

    const first = await harness.run();
    await secondRun;

    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledTimes(1);
    expect(entriesOfType(harness.ledgerEntries, "PAYOUT")).toHaveLength(1);
    expect(
      harness.ledgerEntries.filter((e) => e.type === "PAYOUT")[0]!.amountCents,
    ).toBe(10_000);
    expect(harness.mocks.notifyPayee).toHaveBeenCalledTimes(1);
    expect(first.totalPayableClaimedCents).toBe(10_000);
    // The loser recorded WHY it paid nothing.
    const second = (await secondRun) as Awaited<ReturnType<typeof harness.run>>;
    expect(second.itemsSkippedClaimLost).toBe(1);
    expect(second.totalTransferredCents).toBe(0);
  });

  it("the cross-run cell claim is released when the item fails, so the next run re-plans", async () => {
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
      transferThrow: new Error("stripe_unavailable"),
    });

    await harness.run();

    // Both the cell claim and the transfer claim are released — a failed item
    // must not lock its own payee out for the rest of the TTL.
    const failedKeys = harness.mocks.idempotency.fail.mock.calls.map(
      (c: any[]) => c[0] as string,
    );
    expect(failedKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^payout:payee-a-uuid:usd:\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^payout-transfer:/),
      ]),
    );
  });

  // ── BLOCKING-2 regression: amount stability across the crash window ─────
  it("heals a crashed payout from its stored plan — no second Stripe call, exact cents", async () => {
    // Night 1: the transfer lands (payable 10_000, reserve 1_000 held, a
    // 1_500 matured release riding → 10_500 sent) and the PAYOUT entry then
    // fails. Recomputing the plan on night 2 would produce a DIFFERENT amount
    // (the release is gone, the fee input has moved), so the Stripe key would
    // no longer match and a second real transfer would go out. The heal
    // replays the frozen plan as a pure ledger write instead.
    const oldHold = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const harness = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 10_000,
          items: { "oi-1": 10_000 },
        },
      ],
      unreleasedReserveHolds: [
        {
          id: "hold-1",
          payeeId: PAYEE_A,
          amountCents: 1_500,
          currency: "usd",
          createdAt: oldHold,
        },
      ],
    });
    harness.mocks.repos.payeeLedger.payoutDebit = vi.fn(async () => {
      throw new Error("ledger_down");
    }) as any;

    const night1 = await harness.run();
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 11_500 }),
    );
    expect(night1.itemsTransferred).toBe(1);
    // The claim did not land, so the reserve writes were NOT burned.
    expect(harness.mocks.repos.payeeLedger.reserveRelease).not.toHaveBeenCalled();
    expect(harness.mocks.repos.payeeLedger.reserveHold).not.toHaveBeenCalled();

    // The plan was frozen on the item, exactly as sent.
    const planned = harness.createdPayoutItems[0]!.input as any;
    expect(planned.plannedCreditEntryIds).toEqual(["c1"]);
    expect(planned.plannedOrderItemIds).toEqual(["oi-1"]);
    expect(planned.plannedNetCents).toBe(11_500);
    expect(planned.payoutLedgerKey).toBe(
      buildPayoutLedgerKey(PAYEE_A, "usd", ["c1"]),
    );

    // Night 2: the ledger is back. The sweep heals from the stored plan.
    const night2 = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 10_000,
          items: { "oi-1": 10_000 },
        },
      ],
      itemsNeedingLedgerHeal: [
        {
          id: "pi-1",
          payoutId: "payout-1",
          payeeId: PAYEE_A,
          currency: "usd",
          amountCents: 10_000,
          plannedCreditEntryIds: ["c1"],
          plannedOrderItemIds: ["oi-1"],
          plannedNetCents: 11_500,
          payoutLedgerKey: buildPayoutLedgerKey(PAYEE_A, "usd", ["c1"]),
          stripeTransferId: "tr_batch_123",
        },
      ],
    });

    const result = await night2.run();

    expect(result.itemsLedgerHealed).toBe(1);
    // A pure LEDGER heal: no Stripe call, and the PAYOUT entry records the
    // PAYABLE CLAIMED (10_000), not the amount sent (11_500).
    expect(night2.mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(night2.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10_000 }),
    );
    expect(
      night2.ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId,
    ).not.toBe(null);
    expect(night2.mocks.repos.orderItems.markItemsPaidOut).toHaveBeenCalledWith(
      ["oi-1"],
      expect.any(Date),
    );
    // The heal drove the payable to zero, so the batch plans nothing.
    expect(result.itemsCreated).toBe(0);
    expect(result.payoutId).toBeNull();
  });

  it("a cell with a positive payable but NO consumable credits is refused, not paid", async () => {
    // An empty credit set collapses the cell hash to a per-payee constant,
    // which would alias this transfer with any other empty-credit transfer
    // for the same payee. A payable with nothing to attribute it to is an
    // integrity question.
    const { mocks, run } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });
    mocks.repos.payeeLedger.listConsumableCredits = vi.fn(async () => []) as any;

    const result = await run();

    expect(mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(result.itemsSkippedClaimLost).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("payable_without_consumable_credits"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "empty_credit_set" }),
      }),
    );
  });

  it("the payee cap defers the payees who have waited LEAST, and counts them", async () => {
    // Oldest matured money first — otherwise the same low-id prefix wins
    // every night forever and the tail is starved silently.
    const older = new Date("2026-02-01T00:00:00Z");
    const newer = new Date("2026-03-01T00:00:00Z");
    const { mocks, run } = makeDeps({
      credits: [
        // PAYEE_A sorts first by id but its money is NEWER.
        {
          id: "c-a",
          payeeId: PAYEE_A,
          orderId: "o1",
          amountCents: 10_000,
          availableAt: newer,
        },
        {
          id: "c-b",
          payeeId: PAYEE_B,
          orderId: "o2",
          amountCents: 8_000,
          availableAt: older,
        },
      ],
      payees: new Map([
        [PAYEE_A, makePayee(PAYEE_A)],
        [PAYEE_B, makePayee(PAYEE_B)],
      ]),
    });

    const result = await run({ limit: 1 });

    expect(result.payeesConsidered).toBe(1);
    expect(result.payeesDeferredByLimit).toBe(1);
    expect(mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 8_000,
        metadata: expect.objectContaining({ payeeId: PAYEE_B }),
      }),
    );
  });

  // ── Crash-recovery regressions: the claim-commit → markTransferred window ─
  it("claim-lost recovery: a committed transfer whose markTransferred was lost re-stamps the ORIGINAL item, sends nothing, and the sweep heals to the cent", async () => {
    // Night 1 (simulated): a run committed its transfer claim (tr_night1,
    // 9_300¢ left Stripe) and DIED before markTransferred — the original item
    // "pi-orig" is still pending, so the step-0 sweep (keyed on status
    // "transferred") cannot see it and the payable still says 9_300 is owed.
    const ledgerKey = buildPayoutLedgerKey(PAYEE_A, "usd", ["c1"]);
    const claimKey = buildTransferClaimKey(PAYEE_A, "usd", ["c1"]);
    const harness = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 9_300,
          items: { "oi-1": 9_300 },
        },
      ],
      preexistingPayoutItems: [
        {
          id: "pi-orig",
          payoutId: "payout-0",
          payeeId: PAYEE_A,
          currency: "usd",
          amountCents: 9_300,
          plannedCreditEntryIds: ["c1"],
          plannedOrderItemIds: ["oi-1"],
          plannedNetCents: 9_300,
          payoutLedgerKey: ledgerKey,
        },
      ],
    });
    harness.idempotencyStore.set(claimKey, {
      stripeTransferId: "tr_night1",
      payoutItemId: "pi-orig",
    });

    // Night 2: the batch re-plans the same credits into a fresh item, loses
    // the claim, and RECOVERS from the committed payload.
    const run2 = await harness.run();

    // ZERO Stripe calls for this cell — the money already left.
    expect(harness.mocks.payments.createTransfer).not.toHaveBeenCalled();
    // The ORIGINAL item was re-stamped transferred with the ORIGINAL
    // transfer id — never this run's fresh item.
    expect(harness.mocks.repos.payoutItems.markTransferred).toHaveBeenCalledWith(
      "pi-orig",
      "tr_night1",
      expect.any(Date),
    );
    expect(harness.payoutItemsStore.get("pi-orig").status).toBe("transferred");
    // The fresh duplicate item fails exactly as today: on a NULL key, so the
    // committed "already sent" record survives.
    expect(harness.mocks.repos.payoutItems.markFailed).toHaveBeenCalledWith(
      "pi-1",
      expect.any(Date),
      "transfer_already_claimed_for_these_credits",
    );
    const failedKeys = harness.mocks.idempotency.fail.mock.calls.map(
      (c: any[]) => c[0] as string,
    );
    expect(failedKeys).not.toContain(claimKey);
    expect(run2.itemsSkippedClaimLost).toBe(1);
    expect(run2.itemsTransferred).toBe(0);
    expect(run2.totalTransferredCents).toBe(0);
    // The crash signature is reported, not just warned.
    expect(harness.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "transfer_claim_lost_unmarked_item_recovered",
        ),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "transfer_claim_lost_recovery",
          payoutItemId: "pi-orig",
        }),
      }),
    );

    // Night 3: the sweep now SEES pi-orig and heals the ledger from ITS OWN
    // frozen plan — to the cent.
    const run3 = await harness.run();
    expect(run3.itemsLedgerHealed).toBe(1);
    expect(harness.mocks.payments.createTransfer).not.toHaveBeenCalled();
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: ledgerKey,
        payeeId: PAYEE_A,
        amountCents: 9_300,
        sourceId: "pi-orig",
      }),
    );
    const payoutEntries = entriesOfType(harness.ledgerEntries, "PAYOUT");
    expect(payoutEntries).toHaveLength(1);
    expect(payoutEntries[0]!.amountCents).toBe(9_300);
    expect(
      harness.ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId,
    ).not.toBe(null);
    expect(
      harness.mocks.repos.orderItems.markItemsPaidOut,
    ).toHaveBeenCalledWith(["oi-1"], expect.any(Date));
    // Payable is squared: nothing left to plan.
    expect(run3.payoutId).toBeNull();
    expect(run3.itemsCreated).toBe(0);
  });

  it("markTransferred throws after the commit: the claim survives, the item self-heals to transferred, and the next run heals with no second Stripe call", async () => {
    const claimKey = buildTransferClaimKey(PAYEE_A, "usd", ["c1"]);
    const harness = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 9_300,
          items: { "oi-1": 9_300 },
        },
      ],
    });
    // A transient DB blip on the LIVE markTransferred; the catch-arm retry
    // then succeeds.
    harness.mocks.repos.payoutItems.markTransferred.mockRejectedValueOnce(
      new Error("db_blip"),
    );

    const run1 = await harness.run();

    // The transfer went out once, and the committed claim was NOT erased —
    // `idempotency.fail` on it would delete the "9_300 already sent" guard.
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(harness.mocks.idempotency.fail).not.toHaveBeenCalled();
    expect(harness.idempotencyStore.get(claimKey)).toEqual({
      stripeTransferId: "tr_batch_123",
      payoutItemId: "pi-1",
    });
    // Not marked failed as if no money moved: the self-heal arm re-stamped
    // it transferred.
    expect(harness.mocks.repos.payoutItems.markFailed).not.toHaveBeenCalled();
    expect(harness.payoutItemsStore.get("pi-1").status).toBe("transferred");
    expect(run1.itemsTransferred).toBe(1);
    expect(run1.itemsFailed).toBe(0);
    expect(run1.totalTransferredCents).toBe(9_300);
    // Ledger writes were deliberately deferred to the sweep.
    expect(harness.mocks.repos.payeeLedger.payoutDebit).not.toHaveBeenCalled();
    expect(harness.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db_blip" }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "post_transfer_completion" }),
      }),
    );

    // Next run: the step-0 sweep heals from the frozen plan; Stripe is never
    // called again.
    const run2 = await harness.run();
    expect(run2.itemsLedgerHealed).toBe(1);
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(harness.mocks.repos.payeeLedger.payoutDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 9_300, sourceId: "pi-1" }),
    );
    expect(run2.payoutId).toBeNull();
  });

  it("an old-format committed record (no payoutItemId) keeps today's behavior: fresh item failed on a null key, no crash", async () => {
    const claimKey = buildTransferClaimKey(PAYEE_A, "usd", ["c1"]);
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 9_300 }],
    });
    // A record committed BEFORE the payload gained `payoutItemId`.
    harness.idempotencyStore.set(claimKey, { stripeTransferId: "tr_old" });

    const result = await harness.run();

    expect(harness.mocks.payments.createTransfer).not.toHaveBeenCalled();
    // Nothing to recover from an old-format record: no item touched.
    expect(
      harness.mocks.repos.payoutItems.markTransferred,
    ).not.toHaveBeenCalled();
    expect(harness.mocks.repos.payoutItems.markFailed).toHaveBeenCalledWith(
      "pi-1",
      expect.any(Date),
      "transfer_already_claimed_for_these_credits",
    );
    // NULL key: the committed record survives.
    const failedKeys = harness.mocks.idempotency.fail.mock.calls.map(
      (c: any[]) => c[0] as string,
    );
    expect(failedKeys).not.toContain(claimKey);
    expect(harness.idempotencyStore.get(claimKey)).toEqual({
      stripeTransferId: "tr_old",
    });
    expect(result.itemsSkippedClaimLost).toBe(1);
    expect(result.itemsFailed).toBe(1);
  });

  it("credit-set drift: the stale-pending sweep recovers a crashed transfer when tonight's cell hash DIFFERS — one Stripe call total, each credit nets once", async () => {
    // The manual-rerun gap: hash(c1) committed (9_300¢ sent as tr_night1),
    // process died before markTransferred at ~00:05. A NEW credit c2 matured
    // since, so this run plans hash(c1,c2) ≠ hash(c1): `begin` SUCCEEDS on
    // the new key and the claim-lost probe never fires — without the 0a
    // sweep, the 9_300 would ride out again inside the fresh transfer. The
    // crashed item is only ONE HOUR old (an operator re-trigger, not the
    // nightly cron), which is exactly why the 0a cutoff is minutes, not a
    // cycle.
    const ledgerKeyC1 = buildPayoutLedgerKey(PAYEE_A, "usd", ["c1"]);
    const claimKeyC1 = buildTransferClaimKey(PAYEE_A, "usd", ["c1"]);
    const ONE_HOUR_AGO = new Date(now.getTime() - 60 * 60 * 1000);
    const harness = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 9_300,
          items: { "oi-1": 9_300 },
        },
        {
          id: "c2",
          orderId: "order-2",
          amountCents: 4_700,
          items: { "oi-2": 4_700 },
        },
      ],
      preexistingPayoutItems: [
        {
          id: "pi-orig",
          payoutId: "payout-0",
          payeeId: PAYEE_A,
          currency: "usd",
          amountCents: 9_300,
          plannedCreditEntryIds: ["c1"],
          plannedOrderItemIds: ["oi-1"],
          plannedNetCents: 9_300,
          payoutLedgerKey: ledgerKeyC1,
          createdAt: ONE_HOUR_AGO,
        },
      ],
    });
    harness.idempotencyStore.set(claimKeyC1, {
      stripeTransferId: "tr_night1",
      payoutItemId: "pi-orig",
    });

    const result = await harness.run();

    // The cutoff is minutes (clock-skew buffer only — NOT a cycle, which
    // would have skipped this hour-old item).
    expect(
      harness.mocks.repos.payoutItems.listPendingWithPlanOlderThan,
    ).toHaveBeenCalledWith(new Date(now.getTime() - 15 * 60 * 1000));
    // 0a recovered the original from its STORED plan — no hash collision
    // involved — and 0b healed its ledger in the same run.
    expect(
      harness.mocks.repos.payoutItems.markTransferred,
    ).toHaveBeenCalledWith("pi-orig", "tr_night1", expect.any(Date));
    expect(result.itemsLedgerHealed).toBe(1);
    expect(harness.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("stale_pending_transfer_recovered"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "stale_pending_recovery",
          payoutItemId: "pi-orig",
        }),
      }),
    );

    // Exactly ONE Stripe call across both nights, and it carries ONLY the
    // new credit's money — the healed 9_300 is out of the payable.
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledTimes(1);
    expect(harness.mocks.payments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4_700 }),
    );

    // Each credit nets exactly once: one PAYOUT entry per cell, payable 0.
    const payouts = entriesOfType(harness.ledgerEntries, "PAYOUT");
    expect(payouts.map((e) => e.amountCents).sort((a, b) => a - b)).toEqual([
      4_700, 9_300,
    ]);
    expect(
      harness
        .payableFor(now)
        .find((c) => c.payeeId === PAYEE_A && c.currency === "usd")!
        .payableCents,
    ).toBe(0);
    expect(
      harness.ledgerEntries.find((e) => e.id === "c1")!.consumedByEntryId,
    ).not.toBe(null);
    expect(
      harness.ledgerEntries.find((e) => e.id === "c2")!.consumedByEntryId,
    ).not.toBe(null);
  });

  it("the sweep re-stamps paidOutAt when the PAYOUT entry landed but the stamps were lost — and drops the item from the feed once stamped", async () => {
    const ledgerKey = buildPayoutLedgerKey(PAYEE_A, "usd", ["c1"]);
    const harness = makeDeps({
      credits: [
        {
          id: "c1",
          orderId: "order-1",
          amountCents: 9_300,
          items: { "oi-1": 9_300 },
        },
      ],
      preexistingPayoutItems: [
        {
          id: "pi-orig",
          payoutId: "payout-0",
          payeeId: PAYEE_A,
          currency: "usd",
          amountCents: 9_300,
          plannedCreditEntryIds: ["c1"],
          plannedOrderItemIds: ["oi-1"],
          plannedNetCents: 9_300,
          payoutLedgerKey: ledgerKey,
          status: "transferred",
          stripeTransferId: "tr_1",
        },
      ],
    });
    // The PAYOUT debit LANDED before the crash — but `paidOutAt` never did.
    // A lost stamp is a money bug, not bookkeeping: at refund time the item
    // classifies as not-paid-out and skips the Stripe transfer reversal.
    harness.addEntry({
      idempotencyKey: ledgerKey,
      payeeId: PAYEE_A,
      type: "PAYOUT",
      amountCents: 9_300,
    });

    const run1 = await harness.run();

    expect(run1.itemsLedgerHealed).toBe(1);
    expect(
      harness.mocks.repos.orderItems.markItemsPaidOut,
    ).toHaveBeenCalledWith(["oi-1"], expect.any(Date));
    // The debit replay was a no-op: still exactly one PAYOUT entry.
    expect(entriesOfType(harness.ledgerEntries, "PAYOUT")).toHaveLength(1);
    expect(harness.mocks.payments.createTransfer).not.toHaveBeenCalled();

    // Once stamped, the item is fully squared and leaves the feed.
    const run2 = await harness.run();
    expect(run2.itemsLedgerHealed).toBe(0);
  });

  it("transferClaimKeyFromLedgerKey inverts buildPayoutLedgerKey onto buildTransferClaimKey for the same inputs", () => {
    // The 0a sweep derives a crashed item's claim key from its STORED
    // payoutLedgerKey via this mapping. If either prefix is ever renamed
    // without the other, `get()` misses silently and the sweep goes blind —
    // this equality is the tripwire.
    const ledgerKey = buildPayoutLedgerKey(PAYEE_A, "usd", ["c1", "c2"]);
    expect(transferClaimKeyFromLedgerKey(ledgerKey)).toBe(
      buildTransferClaimKey(PAYEE_A, "usd", ["c1", "c2"]),
    );
  });

  it("a stale pending item whose claim record names ANOTHER item is reported and left alone", async () => {
    // The record was overwritten by a later same-hash run — the stale item's
    // own send-state is unknowable and a historical double-send is possible.
    // Nothing safe to write; the report is the point.
    const ledgerKey = buildPayoutLedgerKey(PAYEE_A, "usd", ["c1"]);
    const claimKey = buildTransferClaimKey(PAYEE_A, "usd", ["c1"]);
    const ONE_HOUR_AGO = new Date(now.getTime() - 60 * 60 * 1000);
    const harness = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 9_300 }],
      preexistingPayoutItems: [
        {
          id: "pi-stale",
          payoutId: "payout-0",
          payeeId: PAYEE_A,
          currency: "usd",
          amountCents: 9_300,
          plannedCreditEntryIds: ["c1"],
          plannedOrderItemIds: ["oi-1"],
          plannedNetCents: 9_300,
          payoutLedgerKey: ledgerKey,
          createdAt: ONE_HOUR_AGO,
        },
      ],
    });
    harness.idempotencyStore.set(claimKey, {
      stripeTransferId: "tr_other",
      payoutItemId: "pi-other",
    });

    await harness.run();

    // Not stamped: the committed transfer belongs to another item.
    expect(
      harness.mocks.repos.payoutItems.markTransferred,
    ).not.toHaveBeenCalledWith("pi-stale", expect.anything(), expect.anything());
    expect(harness.payoutItemsStore.get("pi-stale").status).toBe("pending");
    expect(harness.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "stale_pending_claim_names_other_item",
        ),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({
          step: "stale_pending_claim_mismatch",
          payoutItemId: "pi-stale",
        }),
        extra: expect.objectContaining({
          otherPayoutItemId: "pi-other",
          claimKey,
        }),
      }),
    );
  });

  it("commits the TRANSFER claim with the 3-cycle keep; cycle-scoped claims keep the general retention", async () => {
    const { mocks, run } = makeDeps({
      credits: [{ id: "c1", orderId: "order-1", amountCents: 10_000 }],
    });

    await run();

    const commitCalls = mocks.idempotency.commit.mock.calls as Array<
      [string, unknown, number?]
    >;
    const transferCommit = commitCalls.find(([key]) =>
      key.startsWith("payout-transfer:"),
    );
    // 72h — the committed claim must outlive the ~24h nightly cadence (and
    // Stripe's own ~24h key) so recovery is guaranteed, not scheduler luck.
    expect(transferCommit?.[2]).toBe(3 * 86_400);
    const cellCommit = commitCalls.find(([key]) =>
      key.startsWith(`payout:${PAYEE_A}:`),
    );
    expect(cellCommit?.[2]).toBe(86_400);
  });
});
