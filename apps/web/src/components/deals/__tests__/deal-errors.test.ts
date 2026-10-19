import { describe, expect, it } from "vitest";

import {
  classifyDealReadError,
  classifyDealWriteError,
  isGuaranteeSetByDealError,
} from "../deal-errors";

/** A TRPCClientError as the deals router sends it (data.appCode + data.meta). */
const appError = (
  appCode: string,
  meta?: Record<string, unknown>,
  message = appCode,
) => ({
  message,
  data: { appCode, ...(meta ? { meta } : {}) },
});
/**
 * A lowercase use-case refusal as the transport sends it: `fail("conflict" |
 * "invalid_input", "<code>")` keeps the code as the MESSAGE, and the generic
 * code becomes the appCode (packages/transport/trpc/src/utils.ts toTrpcError).
 */
const useCaseError = (message: string) => ({
  message,
  data: { code: "CONFLICT", httpStatus: 409, appCode: "CONFLICT" },
});
const invalidInput = (message: string) => ({
  message,
  data: { code: "BAD_REQUEST", httpStatus: 400, appCode: "INVALID_INPUT" },
});

describe("classifyDealReadError", () => {
  it("reads 'no terms yet' as the empty state, for an event and an org default", () => {
    expect(
      classifyDealReadError(
        appError("PAYOUT_TERMS_NOT_FOUND", {
          reason: "event_has_no_terms_yet",
        }),
      ),
    ).toEqual({
      kind: "NO_DEAL",
    });
    expect(
      classifyDealReadError(
        appError("PAYOUT_TERMS_NOT_FOUND", {
          reason: "org_has_no_default_terms_yet",
        }),
      ),
    ).toEqual({ kind: "NO_DEAL" });
  });

  it("does not read an unexplained PAYOUT_TERMS_NOT_FOUND as 'no deal yet'", () => {
    expect(classifyDealReadError(appError("PAYOUT_TERMS_NOT_FOUND")).kind).toBe(
      "ERROR",
    );
  });

  it("points an event whose deal is its booking's at the agreement", () => {
    expect(
      classifyDealReadError(
        appError("AGREEMENT_FINALIZED", {
          reason: "event_terms_owned_by_booking",
          agreementId: "a-1",
        }),
      ),
    ).toEqual({ kind: "OWNED_BY_BOOKING", agreementId: "a-1" });
  });

  it("separates 'not allowed' from a failed read", () => {
    expect(classifyDealReadError(appError("INSUFFICIENT_ROLE")).kind).toBe(
      "NOT_ALLOWED",
    );
    expect(classifyDealReadError(new Error("boom")).kind).toBe("ERROR");
    expect(classifyDealReadError(null).kind).toBe("ERROR");
  });
});

describe("classifyDealWriteError", () => {
  it.each(["deal_terms_changed", "deal_event_owner_changed"])(
    "treats %s as 'this deal changed since you opened it'",
    (message) => {
      expect(classifyDealWriteError(useCaseError(message))).toEqual({
        kind: "CONFLICT",
        key: "deals.errors.changed",
      });
    },
  );

  it("maps the cap refusal", () => {
    expect(
      classifyDealWriteError(
        appError("SPLITS_CAPS_UNSATISFIABLE", { totalCapPct: 80 }),
      ),
    ).toEqual({
      kind: "KNOWN",
      key: "deals.errors.capsUnsatisfiable",
    });
  });

  it("explains a deal refused because the group is not active", () => {
    expect(classifyDealWriteError(appError("ORGANIZATION_INACTIVE"))).toEqual({
      kind: "KNOWN",
      key: "deals.notEditable.orgInactive",
    });
  });

  it("maps a scoped per-order line to its own copy", () => {
    expect(
      classifyDealWriteError({
        message: "deal_payee_has_scoped_per_order_line",
      }),
    ).toEqual({
      kind: "KNOWN",
      key: "deals.errors.scopedPerOrderLine",
    });
  });

  it("explains AGREEMENT_NOT_EDITABLE by its reason, with a fallback", () => {
    expect(
      classifyDealWriteError(
        appError("AGREEMENT_NOT_EDITABLE", { reason: "event_terms_shared" }),
      ),
    ).toEqual({
      kind: "KNOWN",
      key: "deals.notEditable.eventTermsShared",
    });
    expect(classifyDealWriteError(appError("AGREEMENT_NOT_EDITABLE"))).toEqual({
      kind: "KNOWN",
      key: "deals.errors.notEditable",
    });
  });

  it.each([
    ["deal_percent_over_100", "deals.errors.percentOver100"],
    ["deal_per_order_percent_over_100", "deals.errors.perOrderPercentOver100"],
    ["deal_clause_zero_percent", "deals.errors.clauseZeroPercent"],
    ["deal_duplicate_per_order_payee", "deals.errors.duplicatePerOrderPayee"],
    ["deal_remainder_not_a_party", "deals.errors.remainderNotAParty"],
    ["deal_remainder_not_the_org", "deals.errors.remainderNotTheOrg"],
    [
      "deal_room_rental_remainder_is_the_renter",
      "deals.errors.rentalRestIsRenter",
    ],
    ["deal_guarantee_too_large", "deals.errors.guaranteeTooLarge"],
  ])("gives the %s refusal its own copy", (code, key) => {
    expect(classifyDealWriteError(invalidInput(code))).toEqual({
      kind: "KNOWN",
      key,
    });
  });

  it("does not read the payout schedule's default_terms_changed as a deal conflict", () => {
    // That one is `fail("CONFLICT", { meta: { reason } })` from
    // update-payout-schedule; setTermsDeal never throws it.
    expect(
      classifyDealWriteError(useCaseError("default_terms_changed")).kind,
    ).toBe("OTHER");
  });

  it("leaves anything else to formatErrorMessage", () => {
    expect(classifyDealWriteError(new Error("Network down")).kind).toBe(
      "OTHER",
    );
  });
});

describe("classifyDealReadError (A3)", () => {
  it("reads an agreement with no payout terms as NO_TERMS, not a failure to retry", () => {
    expect(
      classifyDealReadError(appError("AGREEMENT_MISSING_PAYOUT_TERMS")),
    ).toEqual({ kind: "NO_TERMS" });
  });

  it("reads a non-party on a booking's deal as not allowed", () => {
    expect(classifyDealReadError(appError("NOT_AGREEMENT_PARTY"))).toEqual({
      kind: "NOT_ALLOWED",
    });
  });
});

describe("isGuaranteeSetByDealError", () => {
  it("spots the header refusing a guarantee The deal now sets", () => {
    expect(
      isGuaranteeSetByDealError(
        appError("AGREEMENT_NOT_EDITABLE", { reason: "guarantee_set_by_deal" }),
      ),
    ).toBe(true);
  });

  it("leaves every other not-editable refusal to the page", () => {
    expect(
      isGuaranteeSetByDealError(
        appError("AGREEMENT_NOT_EDITABLE", { reason: "not_draft" }),
      ),
    ).toBe(false);
    expect(isGuaranteeSetByDealError(appError("AGREEMENT_NOT_EDITABLE"))).toBe(
      false,
    );
    expect(isGuaranteeSetByDealError(new Error("Network down"))).toBe(false);
  });
});
