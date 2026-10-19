/**
 * The four sections of `/admin/<slug>/payouts`, in page order. Each id is the
 * DOM id of its section heading, the fragment of its rail child
 * (`payouts#ledger`) and of its phone jump chip. The rail order never changes,
 * whatever state the account is in.
 */
export const PAYOUTS_ROUTE_ID = "payouts";

export const PAYOUTS_SECTION_IDS = [
  "balance",
  "ledger",
  "schedule",
  "stripe",
] as const;

export type PayoutsSectionId = (typeof PAYOUTS_SECTION_IDS)[number];
