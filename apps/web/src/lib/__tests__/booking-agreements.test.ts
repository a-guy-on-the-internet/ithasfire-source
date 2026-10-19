import { describe, expect, it } from "vitest";

import {
  agreementStatusTone,
  bpsToPercentText,
  bpsToWholePercent,
  canViewerActOnAgreement,
  canViewerConfirmLine,
  centsToDollarsInput,
  dollarsToCents,
  finalizeErrorKey,
  percentFromText,
  percentTextToBps,
  type AgreementLineSubject,
  type AgreementParties,
  agreementActionErrorKey,
} from "../booking-agreements";

describe("dollarsToCents", () => {
  it("parses whole dollars", () => {
    expect(dollarsToCents("25")).toBe(2500);
    expect(dollarsToCents("0")).toBe(0);
  });

  it("parses one and two decimal places without float drift", () => {
    expect(dollarsToCents("25.5")).toBe(2550);
    expect(dollarsToCents("0.29")).toBe(29);
    expect(dollarsToCents("  19.99 ")).toBe(1999);
  });

  it("rejects invalid input", () => {
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("-5")).toBeNull();
    expect(dollarsToCents("1.234")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("1,000")).toBeNull();
  });
});

describe("centsToDollarsInput", () => {
  it("round-trips whole and fractional cents", () => {
    expect(centsToDollarsInput(2500)).toBe("25");
    expect(centsToDollarsInput(2550)).toBe("25.50");
    expect(centsToDollarsInput(29)).toBe("0.29");
    expect(centsToDollarsInput(null)).toBe("");
  });
});

describe("percentFromText", () => {
  it("accepts whole numbers 0–100", () => {
    expect(percentFromText("0")).toBe(0);
    expect(percentFromText("45")).toBe(45);
    expect(percentFromText("100")).toBe(100);
  });

  it("rejects out-of-range and non-integer input", () => {
    expect(percentFromText("101")).toBeNull();
    expect(percentFromText("-1")).toBeNull();
    expect(percentFromText("12.5")).toBeNull();
    expect(percentFromText("")).toBeNull();
  });
});

describe("percentTextToBps", () => {
  it("parses whole and decimal percents into integer bps without drift", () => {
    expect(percentTextToBps("12")).toBe(1200);
    expect(percentTextToBps("12.5")).toBe(1250);
    expect(percentTextToBps("12.34")).toBe(1234);
    expect(percentTextToBps("0")).toBe(0);
    expect(percentTextToBps("100")).toBe(10000);
    expect(percentTextToBps(" 0.01 ")).toBe(1);
  });

  it("rejects out-of-range and malformed input", () => {
    expect(percentTextToBps("100.01")).toBeNull();
    expect(percentTextToBps("101")).toBeNull();
    expect(percentTextToBps("-1")).toBeNull();
    expect(percentTextToBps("12.345")).toBeNull();
    expect(percentTextToBps("")).toBeNull();
    expect(percentTextToBps("abc")).toBeNull();
  });
});

describe("bpsToPercentText", () => {
  it("renders bps as compact percent text", () => {
    expect(bpsToPercentText(1200)).toBe("12");
    expect(bpsToPercentText(1250)).toBe("12.5");
    expect(bpsToPercentText(1234)).toBe("12.34");
    expect(bpsToPercentText(1)).toBe("0.01");
    expect(bpsToPercentText(10000)).toBe("100");
  });

  it("round-trips with percentTextToBps", () => {
    for (const bps of [0, 1, 50, 1250, 1234, 9999, 10000]) {
      expect(percentTextToBps(bpsToPercentText(bps))).toBe(bps);
    }
  });
});

describe("bpsToWholePercent", () => {
  it("returns the whole percent only when exact", () => {
    expect(bpsToWholePercent(1200)).toBe(12);
    expect(bpsToWholePercent(0)).toBe(0);
    expect(bpsToWholePercent(10000)).toBe(100);
    expect(bpsToWholePercent(1250)).toBeNull();
    expect(bpsToWholePercent(1)).toBeNull();
  });
});

describe("agreementStatusTone", () => {
  it("maps lifecycle statuses to badge tones", () => {
    expect(agreementStatusTone("DRAFT")).toBe("info");
    expect(agreementStatusTone("PROPOSED")).toBe("warning");
    expect(agreementStatusTone("ACCEPTED")).toBe("success");
    expect(agreementStatusTone("DECLINED")).toBe("danger");
    // Terminal and adverse, same as DECLINED — the editor walked away.
    expect(agreementStatusTone("CANCELLED")).toBe("danger");
    expect(agreementStatusTone("EXPIRED")).toBe("neutral");
  });
});

describe("agreementActionErrorKey", () => {
  it("maps the terms-mutation codes to their own copy", () => {
    expect(agreementActionErrorKey("TERMS_EDITOR_ONLY")).toBe(
      "admin.baErrTermsEditorOnly",
    );
    expect(agreementActionErrorKey("ACT_RESPONSE_ONLY")).toBe(
      "admin.baErrActResponseOnly",
    );
    expect(agreementActionErrorKey("AGREEMENT_FINALIZED")).toBe(
      "admin.baErrAgreementFinalized",
    );
    expect(agreementActionErrorKey("AGREEMENT_NOT_CANCELLABLE")).toBe(
      "admin.baErrAgreementNotCancellable",
    );
  });

  it("falls back to the generic path for anything else", () => {
    expect(agreementActionErrorKey("SOMETHING_ELSE")).toBeNull();
    expect(agreementActionErrorKey(undefined)).toBeNull();
    expect(agreementActionErrorKey("")).toBeNull();
  });
});

describe("canViewerConfirmLine", () => {
  const pendingHumanLine: AgreementLineSubject = {
    subjectType: "human",
    subjectId: "11111111-1111-4111-8111-111111111111",
    requiresConfirmation: true,
    confirmationStatus: "PENDING",
  };

  it("allows the human payee themselves", () => {
    expect(
      canViewerConfirmLine(pendingHumanLine, {
        humanId: pendingHumanLine.subjectId,
        adminOrgIds: [],
      }),
    ).toBe(true);
    expect(
      canViewerConfirmLine(pendingHumanLine, {
        humanId: "22222222-2222-4222-8222-222222222222",
        adminOrgIds: [],
      }),
    ).toBe(false);
  });

  it("allows org admins for org payees", () => {
    const orgLine: AgreementLineSubject = {
      ...pendingHumanLine,
      subjectType: "organization",
      subjectId: "33333333-3333-4333-8333-333333333333",
    };
    expect(
      canViewerConfirmLine(orgLine, {
        humanId: "x".repeat(36),
        adminOrgIds: [orgLine.subjectId as string],
      }),
    ).toBe(true);
    expect(
      canViewerConfirmLine(orgLine, { humanId: null, adminOrgIds: [] }),
    ).toBe(false);
  });

  it("stays actionable on the payee's own COUNTERED line (re-counter / accept / decline)", () => {
    expect(
      canViewerConfirmLine(
        { ...pendingHumanLine, confirmationStatus: "COUNTERED" },
        { humanId: pendingHumanLine.subjectId, adminOrgIds: [] },
      ),
    ).toBe(true);
  });

  it("never offers confirm on implied, already-resolved, or orphaned lines", () => {
    expect(
      canViewerConfirmLine(
        { ...pendingHumanLine, requiresConfirmation: false },
        { humanId: pendingHumanLine.subjectId, adminOrgIds: [] },
      ),
    ).toBe(false);
    expect(
      canViewerConfirmLine(
        { ...pendingHumanLine, confirmationStatus: "CONFIRMED" },
        { humanId: pendingHumanLine.subjectId, adminOrgIds: [] },
      ),
    ).toBe(false);
    expect(
      canViewerConfirmLine(
        { ...pendingHumanLine, confirmationStatus: "DECLINED" },
        { humanId: pendingHumanLine.subjectId, adminOrgIds: [] },
      ),
    ).toBe(false);
    expect(
      canViewerConfirmLine(
        { ...pendingHumanLine, subjectType: null, subjectId: null },
        { humanId: pendingHumanLine.subjectId, adminOrgIds: [] },
      ),
    ).toBe(false);
  });
});

describe("canViewerActOnAgreement", () => {
  const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
  const ORG_ID = "33333333-3333-4333-8333-333333333333";
  const OTHER_ID = "22222222-2222-4222-8222-222222222222";

  const humanVsOrg: AgreementParties = {
    proposerType: "human",
    proposerId: HUMAN_ID,
    counterpartyType: "organization",
    counterpartyId: ORG_ID,
  };

  it("allows the human party themselves", () => {
    expect(
      canViewerActOnAgreement(humanVsOrg, {
        humanId: HUMAN_ID,
        editOrgIds: [],
      }),
    ).toBe(true);
    expect(
      canViewerActOnAgreement(humanVsOrg, {
        humanId: OTHER_ID,
        editOrgIds: [],
      }),
    ).toBe(false);
  });

  it("allows edit-role members of an org party on either side", () => {
    expect(
      canViewerActOnAgreement(humanVsOrg, {
        humanId: OTHER_ID,
        editOrgIds: [ORG_ID],
      }),
    ).toBe(true);
    // Org as proposer instead of counterparty.
    expect(
      canViewerActOnAgreement(
        {
          proposerType: "organization",
          proposerId: ORG_ID,
          counterpartyType: "human",
          counterpartyId: HUMAN_ID,
        },
        { humanId: OTHER_ID, editOrgIds: [ORG_ID] },
      ),
    ).toBe(true);
  });

  it("denies org members without an edit role (FINANCE/VIEWER/SCANNER)", () => {
    // Their org id simply isn't in editOrgIds.
    expect(
      canViewerActOnAgreement(humanVsOrg, {
        humanId: OTHER_ID,
        editOrgIds: [OTHER_ID],
      }),
    ).toBe(false);
  });

  it("never matches a null humanId against a human party", () => {
    expect(
      canViewerActOnAgreement(humanVsOrg, { humanId: null, editOrgIds: [] }),
    ).toBe(false);
  });
});

describe("finalizeErrorKey", () => {
  it("maps known finalize errors and falls back to null", () => {
    expect(finalizeErrorKey("lines_unconfirmed")).toBe(
      "admin.baErrLinesUnconfirmed",
    );
    expect(finalizeErrorKey("payee_not_ready")).toBe(
      "admin.baErrPayeeNotReady",
    );
    expect(finalizeErrorKey("event_already_has_agreement")).toBe(
      "admin.baErrEventHasAgreement",
    );
    expect(finalizeErrorKey("agreement_finalized")).toBe(
      "admin.baErrAgreementFinalized",
    );
    expect(finalizeErrorKey("something_else")).toBeNull();
    expect(finalizeErrorKey(undefined)).toBeNull();
  });
});
