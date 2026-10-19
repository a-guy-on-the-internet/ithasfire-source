export const CURRENT_REFUND_POLICY_VERSION = "platform-refund-2026-06";

/**
 * Verbatim refund-policy text snapshotted onto Orders and AcceptanceRecord
 * ledger rows. Git history of this constant is the audit trail — bump
 * CURRENT_REFUND_POLICY_VERSION whenever this text changes.
 */
export const CURRENT_REFUND_POLICY_TEXT = [
  "Ticket price, tax, and platform fees are refundable through Ithas Fire according to the organizer's stated refund policy and applicable law.",
  "The payment processing fee is non-refundable because the payment processor retains it even on refunds.",
  "Donation and pay-what-you-want tickets are non-refundable unless required by law or the event is cancelled.",
].join(" ");

export type RefundPolicySnapshot = {
  version: typeof CURRENT_REFUND_POLICY_VERSION;
  text: string;
};

export function getCurrentRefundPolicySnapshot(): RefundPolicySnapshot {
  return {
    version: CURRENT_REFUND_POLICY_VERSION,
    text: CURRENT_REFUND_POLICY_TEXT,
  };
}
