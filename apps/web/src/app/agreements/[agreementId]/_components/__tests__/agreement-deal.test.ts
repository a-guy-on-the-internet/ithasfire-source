import { describe, expect, it } from "vitest";

import {
  agreementDealParties,
  isAnswerLine,
  type AgreementDealPartiesInput,
} from "../agreement-deal";

const ACT = "22222222-2222-4222-8222-222222222222";
const PLACE = "11111111-1111-4111-8111-111111111111";
const PAYEE = "33333333-3333-4333-8333-333333333333";

// Lowlight (the act) pitched Marrow Hall: the act proposed, the place edits.
const agreement: AgreementDealPartiesInput["agreement"] = {
  proposerType: "organization",
  proposerId: ACT,
  proposerDisplayName: "Lowlight Collective",
  counterpartyType: "organization",
  counterpartyId: PLACE,
  counterpartyDisplayName: "Marrow Hall",
};

const names = (input: AgreementDealPartiesInput) =>
  agreementDealParties(input, "Unnamed").map((p) => p.name);

describe("agreementDealParties", () => {
  it("puts the place's side (the terms editor) first, whichever side views", () => {
    // The place views: it is the counterparty and the editor.
    expect(
      names({ agreement, actorSide: "counterparty", viewerSide: "editor" }),
    ).toEqual(["Marrow Hall", "Lowlight Collective"]);
    // The act views: it is the proposer and the act.
    expect(
      names({ agreement, actorSide: "proposer", viewerSide: "act" }),
    ).toEqual(["Marrow Hall", "Lowlight Collective"]);
  });

  it("follows the editor when the place proposed", () => {
    expect(
      names({ agreement, actorSide: "proposer", viewerSide: "editor" }),
    ).toEqual(["Lowlight Collective", "Marrow Hall"]);
  });

  it("puts the proposer first with no originating request", () => {
    expect(
      names({ agreement, actorSide: "counterparty", viewerSide: null }),
    ).toEqual(["Lowlight Collective", "Marrow Hall"]);
  });

  it("names parties by their kind and id, with a fallback name", () => {
    const [first] = agreementDealParties(
      {
        agreement: {
          ...agreement,
          counterpartyType: "human",
          counterpartyDisplayName: null,
        },
        actorSide: "counterparty",
        viewerSide: "editor",
      },
      "Unnamed",
    );
    expect(first).toEqual({
      ref: { kind: "human", id: PLACE },
      name: "Unnamed",
      source: "party",
    });
  });
});

describe("isAnswerLine", () => {
  const viewer = { humanId: PAYEE, adminOrgIds: [] };
  const line = {
    subjectType: "human" as const,
    subjectId: PAYEE,
    requiresConfirmation: true,
    confirmationStatus: "PENDING" as const,
    counterPercentBps: null,
  };

  it("keeps a line the viewer answers for themselves", () => {
    expect(isAnswerLine(line, viewer)).toBe(true);
  });

  it("keeps an open counter-ask for every viewer", () => {
    const party = { humanId: null, adminOrgIds: [PLACE] };
    expect(
      isAnswerLine(
        { ...line, confirmationStatus: "COUNTERED", counterPercentBps: 1500 },
        party,
      ),
    ).toBe(true);
  });

  it("drops everything else: party lines, answered lines, someone else's line", () => {
    const party = { humanId: null, adminOrgIds: [PLACE] };
    expect(isAnswerLine(line, party)).toBe(false);
    expect(
      isAnswerLine(
        { ...line, requiresConfirmation: false, confirmationStatus: null },
        viewer,
      ),
    ).toBe(false);
    expect(
      isAnswerLine({ ...line, confirmationStatus: "CONFIRMED" }, viewer),
    ).toBe(false);
  });
});
