// Pure: whether the resale form shows the "Set up payouts" card, or the
// "payouts are on now" line, from the seller's Connect status read and the
// last SELLER_PAYOUT_NOT_SETUP refusal. Kept out of ResellForm so the rules
// are testable without rendering (web component tests need jest-dom).

export type PayoutGateInput = {
  /**
   * At least one of the order's resellable items has a VALID ticket, the only
   * status that can be listed. False while the tickets read is in flight and
   * for an order whose tickets are all used, invalid, refunded, already listed
   * or missing. The form skips the Stripe status read when this is false.
   */
  hasResellable: boolean;
  /** `stripeConnect.getStatus` data; `undefined` while loading or after a first-load failure. */
  status: { payoutsEnabled: boolean } | undefined;
  /**
   * The query's `dataUpdatedAt` (0 = never). React Query keeps the last
   * data and this timestamp when a refetch FAILS, so a failed refetch can
   * never count as "newer than the refusal".
   */
  statusUpdatedAt: number;
  /** When `createListing` last refused with SELLER_PAYOUT_NOT_SETUP; null = no refusal pending. */
  refusedAt: number | null;
};

export type PayoutGate = {
  showSetupCard: boolean;
  /** A refusal was answered by a newer read saying payouts are on: invite a retry. */
  showReadyNow: boolean;
};

export function derivePayoutGate({
  hasResellable,
  status,
  statusUpdatedAt,
  refusedAt,
}: PayoutGateInput): PayoutGate {
  const enabledSinceRefusal =
    refusedAt !== null &&
    status?.payoutsEnabled === true &&
    statusUpdatedAt > refusedAt;
  // The server refused; only a read made AFTER that refusal may overrule it.
  const refusalStillCurrent = refusedAt !== null && !enabledSinceRefusal;
  return {
    showSetupCard:
      refusalStillCurrent ||
      (hasResellable && status?.payoutsEnabled === false),
    showReadyNow: enabledSinceRefusal,
  };
}
