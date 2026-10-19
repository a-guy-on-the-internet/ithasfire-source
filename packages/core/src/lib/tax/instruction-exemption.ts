/**
 * Per-event instructional-admission sales-tax exemption.
 *
 * WHY: Tennessee exempts admission charges for INSTRUCTION only (classes /
 * lessons / courses / teaching) from sales/amusement tax, while recreational
 * admission stays taxable. We model this as an organizer-attested per-event
 * boolean (`Event.instructionalAdmission`). When that flag is set AND the
 * event's frozen tax situs is Tennessee (US / region "TN"), the admission tax
 * rate must resolve to 0 with source "exempt:tn-instruction". Outside TN the
 * flag has NO effect — the normal rate still applies.
 *
 * This is deliberately TN-only for now, but the exempt-jurisdiction table
 * ({@link INSTRUCTION_EXEMPT_REGIONS}) is the single place to append more
 * states as they adopt comparable exemptions.
 */

/** Rate source stamped when the TN instruction-only exemption applies. */
export const TN_INSTRUCTION_EXEMPT_SOURCE = "exempt:tn-instruction";

/** The minimal situs shape the exemption predicate needs. */
type ExemptionSitus =
  | { countryCode: string | null; region: string | null }
  | null
  | undefined;

/**
 * Jurisdictions where organizer-attested instructional admission is
 * sales-tax exempt: `countryCode` → set of exempt region codes. TN-only
 * today. Region codes are the uppercased two-letter values stored on the
 * situs (see {@link TaxSitus} normalization). Append states here to extend
 * the exemption — the predicate + apply logic stay unchanged.
 */
const INSTRUCTION_EXEMPT_REGIONS: Record<string, ReadonlySet<string>> = {
  US: new Set(["TN"]),
};

/**
 * Predicate: does this situs sit in a jurisdiction where instructional
 * admission is tax-exempt? The single source of truth for the TN rule so
 * both read paths (checkout) and the stamp write paths (save/publish) agree.
 */
export function isInstructionExemptSitus(situs: ExemptionSitus): boolean {
  if (!situs?.countryCode || !situs.region) return false;
  return (
    INSTRUCTION_EXEMPT_REGIONS[situs.countryCode]?.has(situs.region) ?? false
  );
}

/**
 * Apply the instructional-admission exemption to a resolved/stamped rate.
 *
 * Returns `{ rateBps: 0, source: "exempt:tn-instruction" }` when the event is
 * flagged instructional AND its situs qualifies (TN today); otherwise returns
 * the input `rateBps`/`source` unchanged. Pure — no I/O, no clock — so it can
 * be applied uniformly at every rate-resolution site.
 */
export function applyInstructionExemption(input: {
  instructionalAdmission: boolean | null | undefined;
  situs: ExemptionSitus;
  rateBps: number;
  source: string;
}): { rateBps: number; source: string } {
  if (
    input.instructionalAdmission === true &&
    isInstructionExemptSitus(input.situs)
  ) {
    return { rateBps: 0, source: TN_INSTRUCTION_EXEMPT_SOURCE };
  }
  return { rateBps: input.rateBps, source: input.source };
}
