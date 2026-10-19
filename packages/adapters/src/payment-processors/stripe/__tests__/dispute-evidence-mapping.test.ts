import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  DISPUTE_EVIDENCE_FIELD_KEYS,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";

import {
  DISPUTE_EVIDENCE_KEY_TABLE,
  fromStripeDisputeEvidence,
  toStripeDisputeEvidence,
} from "../dispute-evidence-mapping";

/** A fully-populated port payload with a distinct value per key. */
function fullPortEvidence(): Required<DisputeEvidenceFields> {
  const out = {} as Required<DisputeEvidenceFields>;
  for (const key of DISPUTE_EVIDENCE_FIELD_KEYS) {
    out[key] = `value:${key}`;
  }
  return out;
}

describe("DISPUTE_EVIDENCE_KEY_TABLE", () => {
  it("maps every port key to a distinct Stripe key", () => {
    const stripeKeys = Object.values(DISPUTE_EVIDENCE_KEY_TABLE);
    expect(new Set(stripeKeys).size).toBe(stripeKeys.length);
    expect(Object.keys(DISPUTE_EVIDENCE_KEY_TABLE).sort()).toEqual(
      [...DISPUTE_EVIDENCE_FIELD_KEYS].sort(),
    );
  });

  it("uses only snake_case Stripe keys", () => {
    for (const stripeKey of Object.values(DISPUTE_EVIDENCE_KEY_TABLE)) {
      expect(stripeKey).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe("toStripeDisputeEvidence", () => {
  it("translates every key and round-trips through fromStripeDisputeEvidence", () => {
    const port = fullPortEvidence();
    const stripe = toStripeDisputeEvidence(port);

    expect(Object.keys(stripe)).toHaveLength(
      DISPUTE_EVIDENCE_FIELD_KEYS.length,
    );
    expect(stripe.product_description).toBe("value:productDescription");
    expect(stripe.customer_email_address).toBe("value:customerEmailAddress");
    expect(stripe.duplicate_charge_documentation).toBe(
      "value:duplicateChargeDocumentation",
    );

    // Stripe echoes a string-or-File per key; strings round-trip 1:1.
    const echoed = stripe as unknown as Stripe.Dispute.Evidence;
    expect(fromStripeDisputeEvidence(echoed)).toEqual(port);
  });

  it("never emits an undefined key (which would unset the field at Stripe)", () => {
    const stripe = toStripeDisputeEvidence({
      productDescription: "Two GA tickets",
      customerName: undefined,
      receipt: undefined,
    });
    expect(stripe).toEqual({ product_description: "Two GA tickets" });
    expect("customer_name" in stripe).toBe(false);
    expect("receipt" in stripe).toBe(false);
  });

  it("preserves an explicit empty string (a deliberate clear)", () => {
    expect(toStripeDisputeEvidence({ customerName: "" })).toEqual({
      customer_name: "",
    });
  });

  it("ignores keys outside the table rather than forwarding them", () => {
    const stripe = toStripeDisputeEvidence({
      productDescription: "x",
      ...({
        shipping_address: "should not pass",
        enhanced_evidence: {},
      } as object),
    });
    expect(stripe).toEqual({ product_description: "x" });
  });
});

describe("fromStripeDisputeEvidence", () => {
  it("drops null fields so absent means never-set", () => {
    const result = fromStripeDisputeEvidence({
      product_description: "Two GA tickets",
      customer_name: null,
      receipt: null,
    } as unknown as Stripe.Dispute.Evidence);
    expect(result).toEqual({ productDescription: "Two GA tickets" });
    expect("customerName" in result).toBe(false);
  });

  it("collapses an expanded File object to its id", () => {
    const result = fromStripeDisputeEvidence({
      receipt: { id: "file_123", object: "file" },
      service_documentation: "file_456",
    } as unknown as Stripe.Dispute.Evidence);
    expect(result).toEqual({
      receipt: "file_123",
      serviceDocumentation: "file_456",
    });
  });

  it("returns an empty object for a missing evidence hash", () => {
    expect(fromStripeDisputeEvidence(null)).toEqual({});
    expect(fromStripeDisputeEvidence(undefined)).toEqual({});
  });

  it("does not surface Stripe-only fields the port does not model", () => {
    const result = fromStripeDisputeEvidence({
      shipping_address: "1 Main St",
      shipping_carrier: "UPS",
      enhanced_evidence: {},
    } as unknown as Stripe.Dispute.Evidence);
    expect(result).toEqual({});
  });
});
