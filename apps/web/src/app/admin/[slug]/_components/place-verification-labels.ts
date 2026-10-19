/**
 * Place verification status → i18n label key. Plain TS on purpose (no
 * Tamagui / @th/ui imports): shared by `PlaceRailContextHeader` (the chip),
 * `place-nav-sections` (the Verification item's dress) and the place rail
 * context (the ledger shell's context-strip fact). Same keys the old place
 * tab-bar header used (places/[placeId]/layout.tsx before FR-203) — the chip
 * moved, it did not change. `Record<PlaceVerificationStatus, string>` so a
 * new enum member is a compile error, not a missing label.
 */
export type PlaceVerificationStatus =
  | "UNVERIFIED"
  | "VERIFIED"
  | "PENDING"
  | "REJECTED";

export const VERIFICATION_LABEL_KEYS: Record<PlaceVerificationStatus, string> =
  {
    VERIFIED: "admin.placeVerifVerified",
    PENDING: "admin.placeVerifPending",
    UNVERIFIED: "admin.placeVerifUnverified",
    REJECTED: "admin.placeVerifRejected",
  };

export const isKnownStatus = (s: string): s is PlaceVerificationStatus =>
  s in VERIFICATION_LABEL_KEYS;
