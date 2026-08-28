/**
 * Pure POS-entry gate logic for the scanner terms acknowledgement
 * (spec docs/specs/2026-05-14/completed/pos-attestation.spec.md).
 *
 * The server is the enforcer — `pos.startSale` / `pos.recordCashSale`
 * reject operators without a current-version ack. This helper only
 * decides whether the sell tab should render the blocking terms modal
 * instead of the POS UI, and it fails CLOSED: missing/unknown operator
 * state shows the modal.
 *
 * Re-acknowledge-on-version-bump works by construction: the comparison
 * is against the live `SCANNER_TERMS_VERSION` constant, so bumping the
 * constant re-prompts every operator whose stored pointer is stale.
 */
import { SCANNER_TERMS_VERSION } from "@th/types";

export type ScannerTermsAckState = {
  scannerTermsAckAt?: Date | string | null;
  scannerTermsAckVersion?: string | null;
};

export const needsScannerTermsAck = (
  operator: ScannerTermsAckState | null | undefined,
  currentVersion: string = SCANNER_TERMS_VERSION,
): boolean => {
  if (!operator) return true;
  if (!operator.scannerTermsAckAt) return true;
  return operator.scannerTermsAckVersion !== currentVersion;
};
