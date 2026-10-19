import type { Repos } from "@th/ports/repos";
import type {
  PayeeLedgerEntryRecord,
  PayeeLedgerEntryType,
} from "@th/types/repos/payee-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// The DISPUTE_RELEASE sign lookup, shared by every reader that turns ledger
// rows into a running balance: the organiser statement
// (`get-payee-statement.ts`) and the ledger CSV export
// (`export-payee-ledger.ts`). ONE implementation on purpose — two copies
// could disagree about whether a release added to the balance, and then the
// page and the file would print different balances for the same row.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many `listDebitsForDispute` reads may be in flight at once. A statement
 * page plus its newer rows is up to 1,200 entries, and an export is the whole
 * ledger; an unbounded fan-out over every distinct dispute among them would
 * be a connection-pool stampede on the rare payee that has many.
 */
export const DISPUTE_DEBIT_LOOKUP_CONCURRENCY = 10;

/**
 * The type of the row each DISPUTE_RELEASE's `relatedEntryId` points at,
 * which is what decides its balance effect: a release that compensates a
 * DISPUTE_DEBIT (won-after-lost) ADDS; a release of a DISPUTE_HOLD moves the
 * hold bucket and never the balance. The entry record carries only the id,
 * and the port has no read-by-id, so this asks `listDebitsForDispute` for
 * each distinct dispute among the releases and checks membership — the
 * same discrimination the adapter's rollup query makes with its EXISTS.
 *
 * INVARIANT THIS LEANS ON, stated because the adapter does not need it: the
 * adapter's EXISTS pivots on `relatedEntryId` ALONE, whereas this pivots on
 * the release's `disputeId` to find candidate debits. The two agree only
 * because BOTH writers set the release's `disputeId` to the dispute its
 * related row belongs to — `releaseHoldRow` copies it from the hold, and
 * `disputes/shared.ts` `reverseDisputeDebits` passes `dispute.id` alongside
 * `debitEntryId` from that same dispute's debit list. A release with
 * `relatedEntryId` set but `disputeId` null, or whose related debit belongs
 * to a DIFFERENT dispute, is therefore something no writer produces; if one
 * ever appears this resolves it to "not a debit" → delta 0, DELIBERATELY —
 * a silent 0 on a malformed row beats a guessed +, and the nightly
 * `listRollupDrift` sweep is the place that would catch the row itself.
 *
 * Reads are issued `DISPUTE_DEBIT_LOOKUP_CONCURRENCY` at a time, chunk after
 * chunk. A failed read REJECTS; each caller decides what that means (the
 * statement degrades its running balance, the export fails whole).
 * Follow-up: a port-level `listDebitsForDisputes(ids)` collapses this to one
 * query.
 */
export async function resolveDisputeReleaseRelations(
  ledger: Pick<Repos["payeeLedger"], "listDebitsForDispute">,
  rows: readonly PayeeLedgerEntryRecord[],
): Promise<Map<string, PayeeLedgerEntryType>> {
  const disputeIds = new Set<string>();
  for (const row of rows) {
    if (row.type === "DISPUTE_RELEASE" && row.relatedEntryId && row.disputeId) {
      disputeIds.add(row.disputeId);
    }
  }
  const relatedTypeById = new Map<string, PayeeLedgerEntryType>();
  const ids = [...disputeIds];
  for (let i = 0; i < ids.length; i += DISPUTE_DEBIT_LOOKUP_CONCURRENCY) {
    const chunk = ids.slice(i, i + DISPUTE_DEBIT_LOOKUP_CONCURRENCY);
    const debitLists = await Promise.all(
      chunk.map((disputeId) => ledger.listDebitsForDispute(disputeId)),
    );
    for (const debits of debitLists) {
      for (const debit of debits) relatedTypeById.set(debit.id, debit.type);
    }
  }
  return relatedTypeById;
}
