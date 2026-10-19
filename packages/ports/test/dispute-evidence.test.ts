import { describe, expect, it } from "vitest";

import {
  checkDisputeEvidenceLimits,
  DISPUTE_EVIDENCE_COMBINED_MAX_CHARS,
  DISPUTE_EVIDENCE_FIELD_KEYS,
  DISPUTE_EVIDENCE_FIELD_KINDS,
  DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
  type DisputeEvidenceFields,
} from "../src/dispute-evidence";

const text = (n: number) => "x".repeat(n);

describe("checkDisputeEvidenceLimits", () => {
  it("accepts an empty payload", () => {
    expect(checkDisputeEvidenceLimits({})).toEqual({
      ok: true,
      combinedChars: 0,
    });
  });

  it("passes a text field exactly at the per-field cap", () => {
    const result = checkDisputeEvidenceLimits({
      productDescription: text(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS),
    });
    expect(result).toEqual({
      ok: true,
      combinedChars: DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
    });
  });

  it("rejects a text field one char over the per-field cap", () => {
    const result = checkDisputeEvidenceLimits({
      productDescription: text(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS + 1),
    });
    expect(result).toEqual({
      ok: false,
      combinedChars: DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS + 1,
      violations: [
        {
          kind: "field",
          field: "productDescription",
          chars: 20_001,
          max: 20_000,
        },
      ],
    });
  });

  it("passes a combined payload exactly at the combined cap", () => {
    // 7 text fields × 20,000 + 10,000 = 150,000, no single field over.
    const evidence: DisputeEvidenceFields = {
      productDescription: text(20_000),
      customerName: text(20_000),
      customerEmailAddress: text(20_000),
      billingAddress: text(20_000),
      serviceDate: text(20_000),
      uncategorizedText: text(20_000),
      accessActivityLog: text(20_000),
      cancellationRebuttal: text(10_000),
    };
    const result = checkDisputeEvidenceLimits(evidence);
    expect(result).toEqual({
      ok: true,
      combinedChars: DISPUTE_EVIDENCE_COMBINED_MAX_CHARS,
    });
  });

  it("rejects a combined payload one char over the combined cap, with no per-field violation", () => {
    const evidence: DisputeEvidenceFields = {
      productDescription: text(20_000),
      customerName: text(20_000),
      customerEmailAddress: text(20_000),
      billingAddress: text(20_000),
      serviceDate: text(20_000),
      uncategorizedText: text(20_000),
      accessActivityLog: text(20_000),
      cancellationRebuttal: text(10_001),
    };
    const result = checkDisputeEvidenceLimits(evidence);
    expect(result).toEqual({
      ok: false,
      combinedChars: DISPUTE_EVIDENCE_COMBINED_MAX_CHARS + 1,
      violations: [{ kind: "combined", chars: 150_001, max: 150_000 }],
    });
  });

  it("reports both a per-field and the combined violation together", () => {
    const evidence: DisputeEvidenceFields = {
      productDescription: text(140_000),
      customerName: text(20_000),
    };
    const result = checkDisputeEvidenceLimits(evidence);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      {
        kind: "field",
        field: "productDescription",
        chars: 140_000,
        max: 20_000,
      },
      { kind: "combined", chars: 160_000, max: 150_000 },
    ]);
  });

  it("exempts file-reference fields from the per-field cap but counts them toward the total", () => {
    const result = checkDisputeEvidenceLimits({
      receipt: text(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS + 1),
    });
    expect(result).toEqual({
      ok: true,
      combinedChars: DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS + 1,
    });
  });

  it("skips undefined values and ignores keys outside the field table", () => {
    const result = checkDisputeEvidenceLimits({
      productDescription: undefined,
      // Not a port key; must be ignored, not counted.
      ...({ shippingAddress: text(500) } as object),
    });
    expect(result).toEqual({ ok: true, combinedChars: 0 });
  });
});

describe("checkDisputeEvidenceLimits with existing evidence (merged overlay)", () => {
  it("counts an explicit empty string as 0 chars and passes", () => {
    expect(checkDisputeEvidenceLimits({ productDescription: "" })).toEqual({
      ok: true,
      combinedChars: 0,
    });
  });

  it("fails when a small delta pushes the MERGED hash over the combined cap", () => {
    // Already staged at the processor: 140,000 chars across seven text
    // fields, none over the per-field cap. Delta alone is a harmless 15,000.
    const existing: DisputeEvidenceFields = {
      productDescription: text(20_000),
      customerName: text(20_000),
      customerEmailAddress: text(20_000),
      billingAddress: text(20_000),
      serviceDate: text(20_000),
      uncategorizedText: text(20_000),
      accessActivityLog: text(20_000),
    };
    const delta: DisputeEvidenceFields = { cancellationRebuttal: text(15_000) };

    // Delta on its own is fine — this is all the adapter can see.
    expect(checkDisputeEvidenceLimits(delta)).toEqual({
      ok: true,
      combinedChars: 15_000,
    });
    // Merged, it is 155,000 and must fail.
    expect(checkDisputeEvidenceLimits(delta, existing)).toEqual({
      ok: false,
      combinedChars: 155_000,
      violations: [{ kind: "combined", chars: 155_000, max: 150_000 }],
    });
  });

  it("passes when the delta clears a large existing field with an empty string", () => {
    const existing: DisputeEvidenceFields = {
      productDescription: text(20_000),
      customerName: text(20_000),
      customerEmailAddress: text(20_000),
      billingAddress: text(20_000),
      serviceDate: text(20_000),
      uncategorizedText: text(20_000),
      accessActivityLog: text(20_000),
    };
    // Clear one 20k field, add 25k elsewhere: merged = 140k - 20k + 25k.
    const delta: DisputeEvidenceFields = {
      accessActivityLog: "",
      cancellationRebuttal: text(20_000),
      refundRefusalExplanation: text(5_000),
    };
    expect(checkDisputeEvidenceLimits(delta, existing)).toEqual({
      ok: true,
      combinedChars: 145_000,
    });
  });

  it("leaves an existing value in place when the delta key is undefined", () => {
    const existing: DisputeEvidenceFields = { productDescription: text(100) };
    expect(
      checkDisputeEvidenceLimits({ productDescription: undefined }, existing),
    ).toEqual({ ok: true, combinedChars: 100 });
  });

  it("replaces (not appends to) an existing value with the delta's value", () => {
    const existing: DisputeEvidenceFields = {
      productDescription: text(20_000),
    };
    // If the helper appended instead of replacing, this would read as 20,001.
    expect(
      checkDisputeEvidenceLimits({ productDescription: "x" }, existing),
    ).toEqual({ ok: true, combinedChars: 1 });
  });

  it("applies the per-field cap to an existing over-limit value the delta does not touch", () => {
    const existing: DisputeEvidenceFields = {
      productDescription: text(20_001),
    };
    const result = checkDisputeEvidenceLimits({}, existing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      {
        kind: "field",
        field: "productDescription",
        chars: 20_001,
        max: 20_000,
      },
    ]);
  });
});

describe("DISPUTE_EVIDENCE_FIELD_KINDS", () => {
  it("enumerates every key with a kind, in a stable order", () => {
    expect(DISPUTE_EVIDENCE_FIELD_KEYS).toHaveLength(22);
    for (const key of DISPUTE_EVIDENCE_FIELD_KEYS) {
      expect(["text", "file"]).toContain(DISPUTE_EVIDENCE_FIELD_KINDS[key]);
    }
  });

  it("classifies the documented file slots as files", () => {
    const files = DISPUTE_EVIDENCE_FIELD_KEYS.filter(
      (k) => DISPUTE_EVIDENCE_FIELD_KINDS[k] === "file",
    );
    expect(files.sort()).toEqual(
      [
        "cancellationPolicy",
        "customerCommunication",
        "customerSignature",
        "duplicateChargeDocumentation",
        "receipt",
        "refundPolicy",
        "serviceDocumentation",
        "uncategorizedFile",
      ].sort(),
    );
  });
});
