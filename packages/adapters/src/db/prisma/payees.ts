import type { Payee } from "@prisma/client";
import type { PayeesRepo, PayeeRecord } from "@th/ports/repos/payees";

import type { PrismaClientOrTx } from "./types";

export function makePayeesRepo(p: PrismaClientOrTx): PayeesRepo {
  return {
    async getById(id) {
      const payee = await p.payee.findUnique({ where: { id } });
      return payee ? toPayeeRecord(payee) : null;
    },
    async getByIds(ids) {
      if (ids.length === 0) return [];
      const payees = await p.payee.findMany({ where: { id: { in: ids } } });
      return payees.map(toPayeeRecord);
    },
    getBySubject: (subject) =>
      p.payee.findFirst({
        where: { subjectType: subject.type as any, subjectId: subject.id },
        select: { id: true },
      }),
    async getByStripeAccountId(stripeAccountId) {
      const payee = await p.payee.findUnique({ where: { stripeAccountId } });
      return payee ? toPayeeRecord(payee) : null;
    },
    syncCapabilities: async (input) => {
      if (!input.stripeAccountId) return "skipped_no_account";

      // RESTRICTED is owned exclusively by the deauthorize handler
      // (`markDeauthorized`). A stale / retried / out-of-order
      // `account.updated` webhook carrying active capabilities must never
      // flip a deauthorized (RESTRICTED) payee back to ACTIVE/PENDING —
      // that would silently re-enable publish + payouts for an account
      // whose Connect authorization was revoked. We enforce this invariant
      // here (not in the handler) so it holds for every caller and is
      // concurrency-safe under the unique `stripeAccountId` constraint:
      // the conditional `updateMany` won't touch a RESTRICTED row.
      //
      // The second predicate is the ORDERING guard. Stripe does not guarantee
      // webhook delivery order and retries can arrive minutes late, so an older
      // `account.updated` ("still pending") could otherwise overwrite a newer
      // one ("now active") and permanently block publish. We only apply a write
      // whose `observedAt` is at least as new as the last applied one.
      //
      // KNOWN LIMIT — `lte`, not `lt`, so a redelivery of the SAME event still
      // applies (re-applying an identical snapshot is a no-op). The cost is that
      // two DIFFERENT events sharing a timestamp have no ordering protection,
      // and Stripe's `event.created` is second-granular while `account.updated`
      // is emitted in bursts as capabilities and requirements settle. So this
      // guard protects against minutes-late retries — the failure mode that
      // caused the outage — but not against a same-second reorder. That residual
      // is bounded by the live-read write-back, which re-derives from Stripe on
      // the next Payments/events-list load.
      const { count } = await p.payee.updateMany({
        where: {
          stripeAccountId: input.stripeAccountId,
          status: { not: "RESTRICTED" },
          OR: [
            { capabilitiesSyncedAt: null },
            { capabilitiesSyncedAt: { lte: input.observedAt } },
          ],
        },
        data: {
          status: input.status,
          payoutsEnabled: input.payoutsEnabled,
          chargesEnabled: input.chargesEnabled,
          defaultCurrency: input.defaultCurrency,
          requirements: input.requirements ?? {},
          capabilitiesSyncedAt: input.observedAt,
        },
      });
      if (count > 0) return "applied";

      // 0 rows updated: the row exists but a guard refused (RESTRICTED, or
      // this observation is older than the one already applied), or we hold no
      // row for this account at all. All three must leave the table untouched.
      const existing = await p.payee.findUnique({
        where: { stripeAccountId: input.stripeAccountId },
        select: { id: true, status: true, capabilitiesSyncedAt: true },
      });
      if (existing) {
        // Report WHICH guard fired. `skipped_restricted` is not routine: it
        // means a live connected account can never be promoted, which is a
        // permanent publish/payout block, so the caller escalates it.
        return existing.status === "RESTRICTED"
          ? "skipped_restricted"
          : "skipped_stale";
      }

      // No row: not ours. Onboarding mints the real row (with its subject and
      // this account id) via `upsertForSubject` before Stripe can emit events
      // for it, so an unknown account here is foreign. DO NOT create a
      // placeholder — see `skipped_unknown_account` in @th/types for the three
      // ways the old create branch (subjectType HUMAN, subjectId "") went
      // wrong, including turning the SECOND unknown account into a P2002 that
      // permanently occupied the DLQ.
      return "skipped_unknown_account";
    },
    listForCapabilityReconcile: async ({ limit }) => {
      const base = {
        stripeAccountId: { not: null },
        status: { not: "RESTRICTED" as const },
      };

      // TWO queries, not one `ORDER BY capabilitiesSyncedAt ASC NULLS FIRST`.
      //
      // A default Postgres btree on a nullable column is ASC NULLS LAST. A
      // forward scan gives ASC NULLS LAST and a backward scan gives DESC NULLS
      // FIRST — neither is ASC NULLS FIRST, so that ordering cannot use the
      // index and plans a Seq Scan + Sort of the whole table every night.
      // Prisma's `@@index` can't express `NULLS FIRST`, so the query is split.
      //
      // What the split buys, honestly (EXPLAIN ANALYZE on a 50k-row clone):
      //  - the ordered arm below is a forward Index Scan that stops early with
      //    NO Sort node — that arm is what the index exists for;
      //  - this IS NULL arm is only index-served once NULLs are rare (Bitmap
      //    Index Scan in steady state). Prisma appends `ORDER BY id` to every
      //    `take` query, so while the never-synced backlog is large the
      //    planner walks the pkey instead, and in steady state it adds a small
      //    Sort over the few matched rows. Both plans were <41ms at 50k; do
      //    not expect a plain Index Scan on this arm, and do not "fix" the
      //    Sort — it is Prisma's implicit ordering, not a missing index.
      //
      // Never-synced first: no `account.updated` was ever applied to those
      // rows, which is exactly the state the outage left them in.
      //
      // CAPPED at half the batch, not the whole of it. A row whose Stripe read
      // fails is never stamped, so a never-synced row with a deleted Stripe
      // account stays in this set forever. Let this query take the full limit
      // and, once enough of those accumulate, it fills every batch — the second
      // query is never issued, no synced row is ever re-read, and the backstop
      // silently provides zero coverage while still reporting a full scan. The
      // cap guarantees the stale set is always sampled.
      const neverSyncedBudget = Math.max(1, Math.ceil(limit / 2));
      const neverSynced = await p.payee.findMany({
        where: { ...base, capabilitiesSyncedAt: null },
        take: neverSyncedBudget,
      });

      // Then the stalest of the rest. No NULLs in this set, so the default
      // NULLS LAST ordering is served by a forward index scan that stops early.
      const stalest = await p.payee.findMany({
        where: { ...base, capabilitiesSyncedAt: { not: null } },
        orderBy: { capabilitiesSyncedAt: "asc" },
        take: limit - neverSynced.length,
      });

      // Hand unused budget back to the never-synced arm. The cap reserves half
      // the batch for stale rows, but when that set is SMALLER than its
      // reservation the difference must not evaporate: on the first run after
      // the migration every row is never-synced, and without this refill a
      // limit-200 sweep scanned 100 rows and reported itself full (measured:
      // limit 10 against 6 never-synced rows returned 5). Only the never-
      // synced arm can have leftovers — the stale arm was already offered
      // everything the first arm didn't take.
      const spare = limit - neverSynced.length - stalest.length;
      const refill =
        spare > 0 && neverSynced.length === neverSyncedBudget
          ? await p.payee.findMany({
              where: {
                ...base,
                capabilitiesSyncedAt: null,
                id: { notIn: neverSynced.map((row) => row.id) },
              },
              take: spare,
            })
          : [];

      // The queries aren't in one transaction, so a webhook stamping a row
      // between them can land it in two sets. Same row twice would double-count
      // one payee's drift and inflate the alert.
      const seen = new Set<string>();
      return [...neverSynced, ...stalest, ...refill]
        .filter((row) => !seen.has(row.id) && seen.add(row.id))
        .map(toPayeeRecord);
    },
    countRestrictedWithStripeAccount: () =>
      p.payee.count({
        where: { status: "RESTRICTED", stripeAccountId: { not: null } },
      }),
    markDeauthorized: async (stripeAccountId) => {
      const existing = await p.payee.findUnique({ where: { stripeAccountId } });
      if (!existing) return null;
      const updated = await p.payee.update({
        where: { stripeAccountId },
        data: {
          status: "RESTRICTED",
          payoutsEnabled: false,
          chargesEnabled: false,
        },
      });
      return toPayeeRecord(updated);
    },
    updateResaleFinanceState: async (input) => {
      const updated = await p.payee.update({
        where: { id: input.payeeId },
        data: {
          resaleNegativeBalanceCents:
            input.resaleNegativeBalanceCents !== undefined
              ? input.resaleNegativeBalanceCents
              : undefined,
          resaleNegativeBalanceOpenedAt:
            input.resaleNegativeBalanceOpenedAt !== undefined
              ? input.resaleNegativeBalanceOpenedAt
              : undefined,
          resaleNegativeBalanceAgingStartsAt:
            input.resaleNegativeBalanceAgingStartsAt !== undefined
              ? input.resaleNegativeBalanceAgingStartsAt
              : undefined,
          resalePayoutBlockReason:
            input.resalePayoutBlockReason !== undefined
              ? input.resalePayoutBlockReason
              : undefined,
          resalePayoutBlockedAt:
            input.resalePayoutBlockedAt !== undefined
              ? input.resalePayoutBlockedAt
              : undefined,
        },
      });
      return toPayeeRecord(updated);
    },
    upsertForSubject: async (input) => {
      // stripeAccountId is null/empty when creating a placeholder payee
      // before Connect onboarding. Don't overwrite a previously-set Connect
      // account on update with a null/empty value.
      const stripeAccountId =
        input.stripeAccountId && input.stripeAccountId.length > 0
          ? input.stripeAccountId
          : null;
      const payee = await p.payee.upsert({
        where: {
          subjectType_subjectId: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
          },
        },
        create: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          stripeAccountId,
          status: "PENDING",
          payoutsEnabled: false,
          chargesEnabled: false,
          defaultCurrency: "usd",
          requirements: {},
        },
        update: stripeAccountId !== null ? { stripeAccountId } : {},
      });
      return toPayeeRecord(payee);
    },
  };
}

function toPayeeRecord(payee: Payee): PayeeRecord {
  return {
    id: payee.id,
    subjectType: payee.subjectType as PayeeRecord["subjectType"],
    subjectId: payee.subjectId,
    stripeAccountId: payee.stripeAccountId,
    status: payee.status,
    payoutsEnabled: payee.payoutsEnabled,
    chargesEnabled: payee.chargesEnabled,
    defaultCurrency: payee.defaultCurrency,
    resaleNegativeBalanceCents: payee.resaleNegativeBalanceCents,
    resaleNegativeBalanceOpenedAt: payee.resaleNegativeBalanceOpenedAt ?? null,
    resaleNegativeBalanceAgingStartsAt:
      payee.resaleNegativeBalanceAgingStartsAt ?? null,
    resalePayoutBlockReason: payee.resalePayoutBlockReason ?? null,
    resalePayoutBlockedAt: payee.resalePayoutBlockedAt ?? null,
  };
}
