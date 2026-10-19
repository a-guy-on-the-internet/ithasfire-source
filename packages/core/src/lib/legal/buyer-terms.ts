/**
 * Server-authoritative buyer Terms of Service version + text snapshot.
 *
 * The version stamped on Orders (`Order.termsVersion`) and on BUYER_TERMS
 * AcceptanceRecord ledger rows comes from here — never from client input.
 * Git history of these constants is the audit trail (same convention as
 * chargeback terms and the refund policy): bump CURRENT_BUYER_TERMS_VERSION
 * whenever the legal document or this snapshot text changes.
 *
 * "2026-05" matches the ToS version published at
 * `apps/web/src/app/terms/page.tsx` and the version web clients previously
 * sent as `termsVersion` (`apps/web/src/lib/legal-constants.ts`), so new
 * ledger rows line up with existing production Order.termsVersion values.
 */
export const CURRENT_BUYER_TERMS_VERSION = "2026-05";

/**
 * The checkbox-adjacent language the buyer actually sees at checkout, plus a
 * pointer to the canonical full document. The full ToS lives at
 * `apps/web/src/app/terms/page.tsx` (served at /terms).
 */
export const CURRENT_BUYER_TERMS_TEXT = [
  'Checkout consent: "I agree to the Terms of Service and have read and agree to the refund policy."',
  `Full Terms of Service: https://ithasfire.com/terms (version ${CURRENT_BUYER_TERMS_VERSION}).`,
].join(" ");

export type BuyerTermsSnapshot = {
  version: typeof CURRENT_BUYER_TERMS_VERSION;
  text: string;
};

export function getCurrentBuyerTermsSnapshot(): BuyerTermsSnapshot {
  return {
    version: CURRENT_BUYER_TERMS_VERSION,
    text: CURRENT_BUYER_TERMS_TEXT,
  };
}
