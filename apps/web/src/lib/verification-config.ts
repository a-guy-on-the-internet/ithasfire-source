import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  ShieldX,
  Eye,
} from "lucide-react";
import type {
  PlaceStatus,
  PlaceVerificationStatus,
} from "@th/types/repos/places";

/**
 * Effective verification status surfaced in admin tables. Place.verification is
 * (UNVERIFIED | VERIFIED | PENDING | REJECTED); IN_REVIEW lives only on the
 * active PlaceVerificationRequest. Most UI surfaces want the "what's true right
 * now" view that joins both, hence this richer enum.
 */
export type EffectiveVerificationStatus = PlaceVerificationStatus | "IN_REVIEW";

export type VerificationIconEntry = {
  Icon: typeof ShieldCheck;
  themeKey: "success" | "info" | "warning" | "danger";
  color: string;
};

/**
 * Canonical status → icon / theme / CSS-color mapping for place verification.
 * Import this instead of duplicating the map in each page.
 */
export const VERIFICATION_ICON_MAP: Record<
  EffectiveVerificationStatus,
  VerificationIconEntry
> = {
  VERIFIED: {
    Icon: ShieldCheck,
    themeKey: "success",
    color: "var(--success, #166534)",
  },
  PENDING: {
    Icon: ShieldQuestion,
    themeKey: "info",
    color: "var(--info, #211C16)",
  },
  IN_REVIEW: { Icon: Eye, themeKey: "info", color: "var(--info, #211C16)" },
  UNVERIFIED: {
    Icon: ShieldAlert,
    themeKey: "warning",
    color: "var(--warning, #92400E)",
  },
  REJECTED: {
    Icon: ShieldX,
    themeKey: "danger",
    color: "var(--danger, #B91C1C)",
  },
};

/**
 * Re-exported from `@th/types` so a consumer needs ONE import for the whole
 * place-badge vocabulary — and so nobody hand-rolls the unions again. Both
 * had grown three or four private copies across the places surfaces even
 * though the canonical declarations already existed in the types package.
 */
export type { PlaceStatus, PlaceVerificationStatus };

/**
 * Canonical status → i18n label KEY for the verification badge.
 *
 * Narrower than {@link VERIFICATION_ICON_MAP} on purpose: it is keyed by the
 * PERSISTED four-state enum, not `EffectiveVerificationStatus`. The two
 * surfaces that render a translated label (the place editor's aside and
 * `../verify`'s VerificationSection) both read `place.verificationStatus`
 * directly, and the admin tables that do compute an effective status render
 * the raw enum string rather than a translated label — so there is no
 * IN_REVIEW badge label in either catalog to point at. Add one before
 * widening this.
 */
export const VERIFICATION_LABEL_KEY: Record<PlaceVerificationStatus, string> = {
  VERIFIED: "admin.placeVerifVerified",
  PENDING: "admin.placeVerifPending",
  UNVERIFIED: "admin.placeVerifUnverified",
  REJECTED: "admin.placeVerifRejected",
};

/**
 * Canonical status → Badge tone.
 *
 * Moved here from `places/_components/PlaceMobileCard.tsx` (which re-exports
 * it, so every existing import path still resolves) once a third and fourth
 * copy appeared — a ternary chain in VerificationSection and a lookup table
 * in the editor's aside. Behaviour is unchanged from the original.
 */
export function badgeToneForVerification(
  status: EffectiveVerificationStatus,
): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "VERIFIED":
      return "success";
    case "IN_REVIEW":
    case "PENDING":
      return "info";
    case "REJECTED":
      return "danger";
    case "UNVERIFIED":
      return "warning";
  }
}

/**
 * Place-row status → Badge tone. Also moved from PlaceMobileCard (and
 * re-exported from there) so a venue's status badge reads the same in the
 * Places table, the mobile card and the editor's aside — a user who opens a
 * venue from the table must not see its status change colour on the way in.
 */
export function getStatusBadgeTone(
  status: PlaceStatus,
): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "SUSPENDED":
      return "warning";
    case "ARCHIVED":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Which statuses may submit a verification request.
 *
 * PENDING is already in the queue and VERIFIED is done, so only UNVERIFIED
 * and REJECTED have a request to make. Centralised because the predicate had
 * been written out longhand at every entry point (the editor's aside,
 * VerificationSection, the places-table row action), and flipping it in one
 * place while missing another is a silent disagreement about whether a
 * button exists.
 */
export function canRequestPlaceVerification(
  status: PlaceVerificationStatus,
): boolean {
  return status === "UNVERIFIED" || status === "REJECTED";
}

/**
 * Compute the effective verification badge from the persisted Place.verification
 * status plus the live request status (when one exists). The active request
 * supersedes the denormalized Place flag — PENDING and IN_REVIEW are inflight
 * states; the place flag still shows REJECTED until the next decision.
 */
export function effectiveVerificationStatus(
  verification: PlaceVerificationStatus,
  activeRequestStatus: "PENDING" | "IN_REVIEW" | null | undefined,
): EffectiveVerificationStatus {
  if (activeRequestStatus === "IN_REVIEW") return "IN_REVIEW";
  if (activeRequestStatus === "PENDING") return "PENDING";
  return verification;
}

/**
 * Sort priority used by the admin table: requests needing attention float
 * to the top. IN_REVIEW first (admin already engaged), then PENDING, then
 * REJECTED, UNVERIFIED, finally VERIFIED.
 */
export function verificationSortRank(
  status: EffectiveVerificationStatus,
): number {
  switch (status) {
    case "IN_REVIEW":
      return 0;
    case "PENDING":
      return 1;
    case "REJECTED":
      return 2;
    case "UNVERIFIED":
      return 3;
    case "VERIFIED":
      return 4;
  }
}
