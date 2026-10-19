/**
 * Processor-agnostic dispute (chargeback) evidence vocabulary.
 *
 * Lives in ports so core can assemble evidence and pre-check limits without
 * depending on the Stripe adapter. Keys are camelCase and map 1:1 onto
 * Stripe's dispute `evidence` hash; the snake_case translation is the
 * adapter's job (`packages/adapters/src/payment-processors/stripe/
 * dispute-evidence-mapping.ts`).
 *
 * Every field is optional, and the VALUE carries a three-way meaning:
 *   - absent / `undefined` — leave the processor's current value alone;
 *   - `""` — explicit clear (unset the field at the processor);
 *   - non-empty string — set the field to this value.
 * Adapters MUST NOT forward `undefined` keys, since the processor treats any
 * key it receives as an instruction. Never coalesce a missing source value to
 * `""` — use `?? undefined` — or a "we have nothing for this" silently
 * becomes "delete what is already there".
 */
export type DisputeEvidenceFields = {
  // ── Free text ─────────────────────────────────────────────────────────
  /** What was sold: event name, ticket type, quantity, date, venue. */
  productDescription?: string;
  customerName?: string;
  customerEmailAddress?: string;
  /** IP address the buyer checked out from. */
  customerPurchaseIp?: string;
  /** Billing address as a single string. */
  billingAddress?: string;
  /**
   * Date the service was provided (the event date), as text. Stripe treats
   * this as a free-text field, so a human-readable date is fine.
   */
  serviceDate?: string;
  /** Where/how the refund policy was shown to the buyer at purchase time. */
  refundPolicyDisclosure?: string;
  /** Why a refund was refused, if the buyer asked for one. */
  refundRefusalExplanation?: string;
  /** Anything that does not fit another field. */
  uncategorizedText?: string;
  /** Sign-in / scan / usage log showing the buyer used what they bought. */
  accessActivityLog?: string;
  /** For `duplicate` disputes: the OTHER charge id the buyer is confusing this with. */
  duplicateChargeId?: string;
  /** For `duplicate` disputes: why the two charges are distinct purchases. */
  duplicateChargeExplanation?: string;
  /** Where/how the cancellation policy was shown at purchase time. */
  cancellationPolicyDisclosure?: string;
  /** Why the buyer's cancellation claim is wrong. */
  cancellationRebuttal?: string;

  // ── File references (processor file ids from `uploadDisputeEvidenceFile`) ─
  /** Proof the service was delivered (e.g. scan log export, attendance). */
  serviceDocumentation?: string;
  /** Receipt / order confirmation sent to the buyer. */
  receipt?: string;
  /** The refund policy document. */
  refundPolicy?: string;
  /** Emails / messages exchanged with the buyer. */
  customerCommunication?: string;
  /** Signed agreement or signature capture, if any. */
  customerSignature?: string;
  /** Any supporting file that fits no other slot. */
  uncategorizedFile?: string;
  /** For `duplicate` disputes: receipt for the OTHER charge. */
  duplicateChargeDocumentation?: string;
  /** The cancellation policy document. */
  cancellationPolicy?: string;
};

export type DisputeEvidenceFieldKey = keyof DisputeEvidenceFields;

/**
 * Whether a field carries free text or a processor file id. Drives which
 * limit applies: the per-field cap is for text; file ids only count toward
 * the combined total (they are ~30 chars, so this is bookkeeping, not a
 * real constraint).
 */
export type DisputeEvidenceFieldKind = "text" | "file";

/**
 * Exhaustive field table. `satisfies Record<DisputeEvidenceFieldKey, …>`
 * fails to compile if a key is added to the type without a kind here, and
 * `Record<…>` (not `Partial`) means an extra key here that is not on the
 * type fails too. Iterate this — never `Object.keys` a caller's object —
 * so unknown keys are ignored rather than forwarded.
 */
export const DISPUTE_EVIDENCE_FIELD_KINDS = {
  productDescription: "text",
  customerName: "text",
  customerEmailAddress: "text",
  customerPurchaseIp: "text",
  billingAddress: "text",
  serviceDate: "text",
  refundPolicyDisclosure: "text",
  refundRefusalExplanation: "text",
  uncategorizedText: "text",
  accessActivityLog: "text",
  duplicateChargeId: "text",
  duplicateChargeExplanation: "text",
  cancellationPolicyDisclosure: "text",
  cancellationRebuttal: "text",
  serviceDocumentation: "file",
  receipt: "file",
  refundPolicy: "file",
  customerCommunication: "file",
  customerSignature: "file",
  uncategorizedFile: "file",
  duplicateChargeDocumentation: "file",
  cancellationPolicy: "file",
} as const satisfies Record<DisputeEvidenceFieldKey, DisputeEvidenceFieldKind>;

/** Every evidence key, in table order. */
export const DISPUTE_EVIDENCE_FIELD_KEYS = Object.keys(
  DISPUTE_EVIDENCE_FIELD_KINDS,
) as readonly DisputeEvidenceFieldKey[];

/** Stripe's cap on any single free-text evidence field. */
export const DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS = 20_000;

/** Stripe's cap on the character count summed across ALL evidence fields. */
export const DISPUTE_EVIDENCE_COMBINED_MAX_CHARS = 150_000;

export type DisputeEvidenceLimitViolation =
  | {
      kind: "field";
      field: DisputeEvidenceFieldKey;
      chars: number;
      max: number;
    }
  | { kind: "combined"; chars: number; max: number };

export type DisputeEvidenceLimitCheck =
  | { ok: true; combinedChars: number }
  | {
      ok: false;
      combinedChars: number;
      violations: DisputeEvidenceLimitViolation[];
    };

/**
 * Pure pre-flight for the processor's evidence size limits. Callers that
 * need a throw (the Stripe adapter, a use case) wrap this in their own typed
 * error so this module stays dependency-free.
 *
 * The processor's combined cap applies to the MERGED evidence hash — what it
 * already holds plus this update — not to the delta alone. Pass the
 * processor's current evidence (`retrieveDispute(...).evidence`) as
 * `existing` to check the merge; the overlay follows the three-way rule on
 * {@link DisputeEvidenceFields}: an `undefined` key in `evidence` keeps the
 * existing value, `""` clears it, anything else replaces it. Without
 * `existing` only the fields in `evidence` are counted, which is what the
 * Stripe adapter does on its own (it does not read before every write); a
 * submitting use case must supply `existing`.
 *
 * Counts UTF-16 code units (`String.prototype.length`). That over-counts
 * astral characters relative to a code-point count, which is the safe
 * direction: we may reject slightly early, never let an over-limit payload
 * through to a processor rejection after the operator hit "submit".
 *
 * Only keys present in {@link DISPUTE_EVIDENCE_FIELD_KINDS} are counted;
 * `undefined` values are skipped (they are not sent).
 */
export function checkDisputeEvidenceLimits(
  evidence: DisputeEvidenceFields,
  existing?: DisputeEvidenceFields,
): DisputeEvidenceLimitCheck {
  const violations: DisputeEvidenceLimitViolation[] = [];
  let combinedChars = 0;

  for (const field of DISPUTE_EVIDENCE_FIELD_KEYS) {
    const delta = evidence[field];
    const value = delta !== undefined ? delta : existing?.[field];
    if (value === undefined) continue;
    const chars = value.length;
    combinedChars += chars;
    if (
      DISPUTE_EVIDENCE_FIELD_KINDS[field] === "text" &&
      chars > DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS
    ) {
      violations.push({
        kind: "field",
        field,
        chars,
        max: DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
      });
    }
  }

  if (combinedChars > DISPUTE_EVIDENCE_COMBINED_MAX_CHARS) {
    violations.push({
      kind: "combined",
      chars: combinedChars,
      max: DISPUTE_EVIDENCE_COMBINED_MAX_CHARS,
    });
  }

  return violations.length === 0
    ? { ok: true, combinedChars }
    : { ok: false, combinedChars, violations };
}
