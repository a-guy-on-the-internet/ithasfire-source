import type Stripe from "stripe";
import {
  DISPUTE_EVIDENCE_FIELD_KEYS,
  type DisputeEvidenceFieldKey,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";

/**
 * Stripe evidence keys that carry a plain string in BOTH directions. The
 * `enhanced_evidence` sub-hash and the shipping_* fields are deliberately
 * excluded: neither applies to ticketed events, and the port does not model
 * them.
 */
type StripeEvidenceKey = Exclude<
  keyof Stripe.DisputeUpdateParams.Evidence,
  "enhanced_evidence"
>;

/**
 * The ONE place camelCase port keys meet snake_case Stripe keys. Explicit on
 * purpose — no runtime case conversion — so a typo fails to compile:
 * `Record<DisputeEvidenceFieldKey, …>` demands every port key be present,
 * and the value type demands every target be a real Stripe evidence key.
 */
export const DISPUTE_EVIDENCE_KEY_TABLE = {
  productDescription: "product_description",
  customerName: "customer_name",
  customerEmailAddress: "customer_email_address",
  customerPurchaseIp: "customer_purchase_ip",
  billingAddress: "billing_address",
  serviceDate: "service_date",
  refundPolicyDisclosure: "refund_policy_disclosure",
  refundRefusalExplanation: "refund_refusal_explanation",
  uncategorizedText: "uncategorized_text",
  accessActivityLog: "access_activity_log",
  duplicateChargeId: "duplicate_charge_id",
  duplicateChargeExplanation: "duplicate_charge_explanation",
  cancellationPolicyDisclosure: "cancellation_policy_disclosure",
  cancellationRebuttal: "cancellation_rebuttal",
  serviceDocumentation: "service_documentation",
  receipt: "receipt",
  refundPolicy: "refund_policy",
  customerCommunication: "customer_communication",
  customerSignature: "customer_signature",
  uncategorizedFile: "uncategorized_file",
  duplicateChargeDocumentation: "duplicate_charge_documentation",
  cancellationPolicy: "cancellation_policy",
} as const satisfies Record<DisputeEvidenceFieldKey, StripeEvidenceKey>;

/**
 * Port → Stripe update params. Skips `undefined` values entirely: Stripe
 * treats a key it receives as an instruction, so forwarding `undefined`
 * (which the SDK would serialise as an empty string) would UNSET the field.
 */
export function toStripeDisputeEvidence(
  evidence: DisputeEvidenceFields,
): Stripe.DisputeUpdateParams.Evidence {
  const out: Stripe.DisputeUpdateParams.Evidence = {};
  for (const key of DISPUTE_EVIDENCE_FIELD_KEYS) {
    const value = evidence[key];
    if (value === undefined) continue;
    out[DISPUTE_EVIDENCE_KEY_TABLE[key]] = value;
  }
  return out;
}

/**
 * Stripe dispute → port. File-typed fields come back as either an id string
 * or an expanded `Stripe.File`; both collapse to the id. `null` (Stripe's
 * "never set") is dropped so the port shape only carries present fields.
 */
export function fromStripeDisputeEvidence(
  evidence: Stripe.Dispute.Evidence | null | undefined,
): DisputeEvidenceFields {
  const out: DisputeEvidenceFields = {};
  if (!evidence) return out;
  for (const key of DISPUTE_EVIDENCE_FIELD_KEYS) {
    const raw = evidence[DISPUTE_EVIDENCE_KEY_TABLE[key]];
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === "string" ? raw : raw.id;
  }
  return out;
}
