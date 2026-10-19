import { describe, expect, it } from "vitest";

import {
  changedFields,
  combinedChars,
  decodeDeskError,
  draftFromFields,
  dueTreatment,
  isDraftDirty,
  ownerDisplay,
  sourcesForDisplay,
} from "../_components/dispute-desk.helpers";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

describe("dueTreatment", () => {
  it("returns a dash with no intent when there is no deadline", () => {
    expect(dueTreatment(null, NOW)).toEqual({
      label: "—",
      intent: "none",
      overdue: false,
    });
  });

  it("flags past deadlines and Stripe's past_due as overdue/danger", () => {
    expect(dueTreatment(hours(-1), NOW)).toMatchObject({
      label: "Overdue",
      intent: "danger",
      overdue: true,
    });
    expect(dueTreatment(hours(48), NOW, true)).toMatchObject({
      label: "Overdue",
      intent: "danger",
      overdue: true,
    });
  });

  it("uses hours under a day, warning within three days, none beyond", () => {
    expect(dueTreatment(hours(5), NOW)).toMatchObject({
      label: "in 5h",
      intent: "warning",
    });
    expect(dueTreatment(hours(24 * 2 + 3), NOW)).toMatchObject({
      label: "in 2d",
      intent: "warning",
    });
    expect(dueTreatment(hours(24 * 3), NOW)).toMatchObject({
      label: "in 3d",
      intent: "warning",
    });
    expect(dueTreatment(hours(24 * 10), NOW)).toMatchObject({
      label: "in 10d",
      intent: "none",
    });
  });

  it("accepts ISO strings (superjson may hand back either shape)", () => {
    expect(dueTreatment(hours(24 * 10).toISOString(), NOW).label).toBe(
      "in 10d",
    );
  });
});

describe("draft diffing", () => {
  it("sends only changed keys, and an empty string for a cleared field", () => {
    const initial = draftFromFields({
      productDescription: "Old",
      customerName: "Jane",
      uncategorizedText: "Keep me",
    });
    const current = { ...initial, productDescription: "New", customerName: "" };
    expect(changedFields(initial, current)).toEqual({
      productDescription: "New",
      customerName: "",
    });
    expect(isDraftDirty(initial, current)).toBe(true);
    expect(isDraftDirty(initial, { ...initial })).toBe(false);
  });

  it("treats an absent server field and an empty draft as equal (no spurious clear)", () => {
    const initial = draftFromFields({ productDescription: "x" });
    expect(initial.customerName).toBe("");
    expect(changedFields(initial, { ...initial })).toEqual({});
  });

  it("treats whitespace-only as cleared and not as an edit of an empty field", () => {
    const initial = draftFromFields({ productDescription: "x" });
    expect(changedFields(initial, { ...initial, productDescription: "   " })).toEqual({
      productDescription: "",
    });
    expect(changedFields(initial, { ...initial, customerName: "  " })).toEqual({});
    expect(isDraftDirty(initial, { ...initial, customerName: "\t" })).toBe(false);
  });

  it("counts combined UTF-16 units across the 14 text fields", () => {
    const draft = draftFromFields({ productDescription: "abc", customerName: "de" });
    expect(combinedChars(draft)).toBe(5);
  });
});

describe("decodeDeskError", () => {
  it("extracts field and combined violations from DISPUTE_EVIDENCE_LIMIT_EXCEEDED", () => {
    const decoded = decodeDeskError({
      message: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
      data: {
        appCode: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
        meta: {
          combinedChars: 151_000,
          violations: [
            { kind: "field", field: "productDescription", chars: 20_500, max: 20_000 },
            { kind: "combined", chars: 151_000, max: 150_000 },
            // A file key must never be treated as an editable text field.
            { kind: "field", field: "receipt", chars: 30, max: 20_000 },
          ],
        },
      },
    });
    expect(decoded.code).toBe("DISPUTE_EVIDENCE_LIMIT_EXCEEDED");
    expect(decoded.fieldViolations).toEqual([
      { field: "productDescription", chars: 20_500, max: 20_000 },
    ]);
    expect(decoded.combinedViolation).toEqual({ chars: 151_000, max: 150_000 });
  });

  it("maps DISPUTE_NOT_ACCEPTING_EVIDENCE to a plain headline with the server sentence", () => {
    const decoded = decodeDeskError({
      message: "the evidence deadline has passed",
      data: { appCode: "DISPUTE_NOT_ACCEPTING_EVIDENCE" },
    });
    expect(decoded.title).toBe(
      "Stripe is not accepting evidence for this dispute",
    );
    expect(decoded.detail).toBe("the evidence deadline has passed");
  });

  it("prefers the processor error over the message for DISPUTE_NOT_ACCEPTING_EVIDENCE", () => {
    const decoded = decodeDeskError({
      message: "the processor rejected the evidence submission",
      data: {
        appCode: "DISPUTE_NOT_ACCEPTING_EVIDENCE",
        meta: { processorError: "Stripe: dispute is closed" },
      },
    });
    expect(decoded.detail).toBe("Stripe: dispute is closed");
  });

  it("names the in-flight case of DISPUTE_EVIDENCE_STATE_INVALID", () => {
    expect(
      decodeDeskError({
        message: "DISPUTE_EVIDENCE_STATE_INVALID",
        data: { appCode: "DISPUTE_EVIDENCE_STATE_INVALID", meta: { inFlight: true } },
      }).title,
    ).toBe("Another operator is working on this package");
    expect(
      decodeDeskError({
        message: "submitted dispute evidence cannot be edited",
        data: { appCode: "DISPUTE_EVIDENCE_STATE_INVALID", meta: { status: "SUBMITTED" } },
      }).title,
    ).toBe("The evidence package changed under you");
  });

  it("surfaces the sanitised processor error on DISPUTE_EVIDENCE_SUBMIT_FAILED", () => {
    const decoded = decodeDeskError({
      message: "DISPUTE_EVIDENCE_SUBMIT_FAILED",
      data: {
        appCode: "DISPUTE_EVIDENCE_SUBMIT_FAILED",
        meta: { processorError: "Stripe: rate limited" },
      },
    });
    expect(decoded.title).toBe("Stripe rejected the submission");
    expect(decoded.detail).toBe("Stripe: rate limited");
  });

  it("never echoes a bare code as the detail", () => {
    const decoded = decodeDeskError({ message: "SOMETHING_ODD" });
    expect(decoded.detail).toBeNull();
    expect(decoded.title).toBe("Something went wrong");
  });
});

describe("display helpers", () => {
  it("prefers the org owner, then the human, then a dash", () => {
    expect(
      ownerDisplay({
        ownerOrgId: "o1",
        ownerOrgName: "Velvet Room",
        ownerHumanId: null,
        ownerHumanName: null,
      }),
    ).toEqual({ name: "Velvet Room", kind: "org" });
    expect(
      ownerDisplay({
        ownerOrgId: null,
        ownerOrgName: null,
        ownerHumanId: "h1",
        ownerHumanName: null,
      }),
    ).toEqual({ name: "Unnamed human", kind: "human" });
    expect(
      ownerDisplay({
        ownerOrgId: null,
        ownerOrgName: null,
        ownerHumanId: null,
        ownerHumanName: null,
      }),
    ).toEqual({ name: "—", kind: null });
  });

  it("lists every provenance source exactly once", () => {
    const list = sourcesForDisplay({
      order: "found",
      buyer: "found",
      buyerEmail: "missing",
      checkoutIp: "missing",
      billingAddress: "missing",
      event: "found",
      venue: "found",
      organizer: "found",
      refundPolicy: "missing",
      termsAcceptance: "found",
      tickets: "found",
      scanLog: "not_applicable",
      refundHistory: "found",
      cardChecks: "missing",
      ticketEmail: "found",
      statementDescriptor: "found",
      truncated: false,
    });
    expect(list).toHaveLength(16);
    expect(list.find((s) => s.key === "scanLog")?.state).toBe("not_applicable");
  });
});
