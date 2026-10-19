import type {
  ListAllSettlementsInput,
  ListAllSettlementsResult,
  ListSettlementsForOrgInput,
  ListSettlementsForOrgResult,
  SettlementRecord,
} from "@th/types/repos/settlements";

/**
 * READ-ONLY view of the FROZEN settlement tables.
 *
 * `Settlement` / `SettlementLine` / `OrderItemSettlementLine` are financial
 * HISTORY as of the ledger-authoritative cutover (spec 2026-08-10 §7): the
 * `PayeeLedgerEntry` journal is the only source of truth for what a payee is
 * owed, and nothing writes these tables any more. Every write method is
 * deleted — not deprecated — so the "two systems that must agree" bug class
 * (the P0 leak: refund the buyer, still pay the organizer) is unrepresentable
 * rather than patched:
 *
 *   * `addDraft` / `create` / `updateAmount` / `incrementAmount` —
 *     revenue is a SETTLEMENT_CREDIT written at order finalize.
 *   * `cancelForPayee` / `cancelForEvent` / `cancelForOrder` — refunds write
 *     REFUND_DEBITs (orders/_shared/write-refund-debits.ts); event
 *     cancellation is just its orders' refunds.
 *   * `listDueForPayout` / `bulkClaimForTransfer` / `bulkReleaseClaim` /
 *     `recoverStuckTransferring` / `bulkMarkTransferred` / `bulkMarkFailed` /
 *     `markTransferred` / `resetFailed` — the payout batch pays
 *     `max(0, payable)` off the ledger; there is no row to claim, no claim to
 *     release, and no failed row to reset (a failed item simply leaves its
 *     credits unconsumed for the next cycle).
 *   * `getByPayeeAndScheduledDate` — the per-payee/date row that membership
 *     invoices folded into no longer exists as a concept.
 *
 * What remains is exactly what the admin/report surfaces need to display the
 * historical rows.
 */
export interface SettlementsRepo {
  /** Fetch a settlement by its id. */
  getById(settlementId: string): Promise<SettlementRecord | null>;

  /** Batch-fetch multiple settlements by ID. Missing IDs are silently omitted. */
  getByIds(ids: string[]): Promise<SettlementRecord[]>;

  /** Paginated list scoped to a single payee (org-admin view). */
  listForOrg(
    input: ListSettlementsForOrgInput,
  ): Promise<ListSettlementsForOrgResult>;

  /** Paginated cross-org list (platform staff view). */
  listAll(input: ListAllSettlementsInput): Promise<ListAllSettlementsResult>;
}
