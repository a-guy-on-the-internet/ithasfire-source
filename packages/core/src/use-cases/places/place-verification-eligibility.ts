/**
 * Pure helper: determines whether a place has enough data to be submitted
 * for verification. Keep free of runtime deps.
 *
 * ── This is a UI HINT, not a server gate ─────────────────────────────────────
 * Read the call sites before trusting it. Today it is used ONLY client-side —
 * the place editor, VerificationSection, the places-table row action and the
 * request modal all call it to label/explain, and the modal deliberately lets
 * an ineligible place open the dialog so the blockers can be listed.
 *
 * `submitPlaceVerification` does NOT call it: its own gates are ownership,
 * no-active-request, at-least-one-document, and a place verification of
 * UNVERIFIED or REJECTED (checked under the claim lock). The one server-side
 * caller that ever existed was `updatePlaceVerificationStatus`'s PENDING branch,
 * which the FR-013 convergence orphaned (the web app no longer reaches it).
 *
 * So: do not assume a submission with a placeholder name or a "TBD" address is
 * impossible. If that guarantee is wanted, add the check to
 * `submitPlaceVerification` explicitly — and update this note.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal shape we need to evaluate eligibility — works with PlaceRecord
 *  and with the tRPC response shapes the UI already has. */
export const placeVerificationEligibilityInputSchema = z.object({
  name: z.string(),
  addressLine1: z.string().nullish(),
  city: z.string().nullish(),
  countryCode: z.string().nullish(),
  orgIdsWithAccess: z.array(z.string()).default([]),
  humanIdsWithAccess: z.array(z.string()).default([]),
});

export type PlaceVerificationEligibilityInput = z.infer<
  typeof placeVerificationEligibilityInputSchema
>;

export interface PlaceVerificationEligibility {
  eligible: boolean;
  /** Human-readable reasons the place is NOT eligible (empty when eligible). */
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Logic
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_NAMES = new Set(["new place", "untitled", ""]);
const PLACEHOLDER_ADDRESSES = new Set(["tbd", ""]);

/**
 * Evaluate whether a place meets the minimum requirements for verification.
 *
 * Rules:
 *  1. Name must be a real name (not "New Place" / empty).
 *  2. Address line 1 must be filled in (not "TBD" / empty).
 *  3. City must be present.
 *  4. Country code must be present.
 *  5. At least one owner (org or human) must exist.
 */
export function getPlaceVerificationEligibility(
  input: PlaceVerificationEligibilityInput,
): PlaceVerificationEligibility {
  const reasons: string[] = [];

  // 1. Name
  const normalizedName = (input.name ?? "").trim().toLowerCase();
  if (!normalizedName || PLACEHOLDER_NAMES.has(normalizedName)) {
    reasons.push("Place must have a real name (not a placeholder).");
  }

  // 2. Address line 1
  const normalizedAddr = (input.addressLine1 ?? "").trim().toLowerCase();
  if (!normalizedAddr || PLACEHOLDER_ADDRESSES.has(normalizedAddr)) {
    reasons.push("Street address is required.");
  }

  // 3. City
  if (!input.city?.trim()) {
    reasons.push("City is required.");
  }

  // 4. Country code
  if (!input.countryCode?.trim()) {
    reasons.push("Country code is required.");
  }

  // 5. At least one owner
  const totalOwners =
    (input.orgIdsWithAccess?.length ?? 0) +
    (input.humanIdsWithAccess?.length ?? 0);
  if (totalOwners === 0) {
    reasons.push("Place must have at least one owner.");
  }

  return { eligible: reasons.length === 0, reasons };
}
