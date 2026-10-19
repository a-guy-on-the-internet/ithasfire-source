/**
 * M5, on every read: every party sees the whole breakdown; a payee who is not
 * a party sees only their own line; nobody else sees anything. Checked per
 * viewer type on the agreement deal, the projection, the event settlement
 * sheet and its CSV — and checked on the WIRE shape (the output schemas), not
 * on what a UI would choose to show.
 */
import { describe, expect, it } from "vitest";

import { DEAL_SETTLEMENT_ENGINE_VERSION } from "../../../lib/settlement";
import { exportEventSettlementCsv } from "../export-event-settlement-csv";
import { getAgreementDeal } from "../get-agreement-deal";
import { getEventSettlement } from "../get-event-settlement";
import { markEventSettled } from "../mark-event-settled";
import { projectAgreementDeal } from "../project-agreement-deal";
import { setAgreementDeal } from "../set-agreement-deal";
import {
  ACT_HUMAN,
  AGREEMENT_ID,
  EVENT_ID,
  OUTSIDER,
  SOUND_ADMIN,
  SOUND_ORG,
  SUPPORT_HUMAN,
  VENUE_ADMIN,
  VENUE_FINANCE,
  VENUE_ORG,
  VENUE_EDITOR,
  VENUE_SCANNER,
  VENUE_VIEWER,
  TERMS_ID,
  addFinalizedEvent,
  caught,
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

const act = { kind: "human" as const, id: ACT_HUMAN };
const venue = { kind: "org" as const, id: VENUE_ORG };

async function bookedVersus() {
  const s = standardStore();
  await setAgreementDeal(
    { repos: makeRepos(s), clock },
    {
      actorHumanId: VENUE_ADMIN,
      agreementId: AGREEMENT_ID,
      deal: {
        source: "PRESET",
        preset: { preset: "VERSUS", act, guaranteeCents: 80_000, percent: 70 },
        remainder: venue,
        extraClauses: [
          { payee: { kind: "human", id: SUPPORT_HUMAN }, amountType: "PERCENT", percent: 10, basis: "GROSS" },
        ],
        deductions: [
          { kind: "EXPENSE", label: "Sound", amountCents: 30_000, creditedPayee: { kind: "org", id: SOUND_ORG }, estimated: true },
        ],
      },
    },
  );
  return s;
}

function withEndedEvent(s: Awaited<ReturnType<typeof bookedVersus>>) {
  addFinalizedEvent(s);
  // $2,000 of tickets; the platform paid the support act 10% and the venue the rest.
  s.ledger.set(EVENT_ID, {
    orders: [{ orderId: "o1", status: "SUCCEEDED", amountGrossCents: 210_000, feesPlatformCents: 10_000, credited: true }],
    refundCount: 0,
    perPayee: [
      { payeeId: s.supportPayee, creditCents: 20_000, refundDebitCents: 0 },
      { payeeId: s.venuePayee, creditCents: 180_000, refundDebitCents: 0 },
    ],
    currencies: ["usd"],
  });
  return s;
}

/**
 * The support act's OWN_LINE view, by value (M14: it carries the $2,000 its
 * 10% is of — and nothing that is not its own).
 */
function ownLine(
  s: Awaited<ReturnType<typeof bookedVersus>>,
  mode: {
    revenueMode: "PROJECTED" | "ACTUAL";
    how: { paidPerOrderCents: number | null };
    position: Record<string, number | null>;
  },
) {
  const clauseId = s.terms.get(TERMS_ID)!.deal.clauses.find((c) => c.payeeId === s.supportPayee)!.id;
  return {
    visibility: "OWN_LINE",
    engineVersion: DEAL_SETTLEMENT_ENGINE_VERSION,
    revenueMode: mode.revenueMode,
    payeeIds: [s.supportPayee],
    clauses: [
      {
        clauseId,
        payeeId: s.supportPayee,
        amountType: "PERCENT",
        displayLabel: null,
        entitlementCents: 20_000,
        how: {
          kind: "PERCENT",
          percent: 10,
          percentOf: { basis: "GROSS", basisCents: 200_000, afterDeductionIds: [] },
          percentCents: 20_000,
          ...mode.how,
        },
        stage1: "PAID_PER_ORDER",
        coveredByPoolCents: 20_000,
        uncoveredCents: 0,
      },
    ],
    positions: [
      {
        payeeId: s.supportPayee,
        clauseIds: [clauseId],
        clauseCents: 20_000,
        creditedDeductionsCents: 0,
        notRecoveredCents: 0,
        entitlementCents: 20_000,
        offPlatformShareCents: 0,
        heldOffPlatformCents: 0,
        directReceivedCents: 0,
        directPaidCents: 0,
        shortfallDueCents: 0,
        ...mode.position,
      },
    ],
    costsCredited: [],
    offPlatform: [],
    shortfallDue: [],
  };
}

describe("M5 on the agreement deal and its projection", () => {
  it("M13: a party — an edit or finance role on a party org, or the human party — sees the whole deal", async () => {
    const s = await bookedVersus();
    for (const actor of [VENUE_ADMIN, VENUE_EDITOR, VENUE_FINANCE, ACT_HUMAN]) {
      const deal = await getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: actor, agreementId: AGREEMENT_ID });
      expect(deal.visibility, actor).toBe("FULL");
      expect(deal.clauses.length, actor).toBe(3);
      expect(deal.deductions.length, actor).toBe(1);
      expect(deal.remainder?.payeeId, actor).toBe(s.venuePayee);
    }
    // The act may see, never edit.
    const asAct = await getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: ACT_HUMAN, agreementId: AGREEMENT_ID });
    expect(asAct.mayEdit).toBe(false);
  });

  it("M13: a VIEWER or SCANNER on a party org sees neither the deal nor its projection", async () => {
    const s = await bookedVersus();
    for (const actor of [VENUE_VIEWER, VENUE_SCANNER]) {
      expect(await caught(getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: actor, agreementId: AGREEMENT_ID })), actor).toMatchObject({
        code: "NOT_AGREEMENT_PARTY",
      });
      expect(
        await caught(
          projectAgreementDeal({ repos: makeRepos(s), clock }, { actorHumanId: actor, agreementId: AGREEMENT_ID, tiers: [{ tickets: 1, unitBasisCents: 1 }] }),
        ),
        actor,
      ).toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    }
  });

  it("a payee who is not a party sees only their own line", async () => {
    const s = await bookedVersus();
    const deal = await getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: SUPPORT_HUMAN, agreementId: AGREEMENT_ID });
    expect(deal.visibility).toBe("OWN_LINE");
    expect(deal.clauses.map((c) => c.payeeId)).toEqual([s.supportPayee]);
    expect(deal.deductions).toEqual([]);
    expect(deal.remainder).toBeNull();
    expect(deal.perOrderPercentTotal).toBeNull();
    expect(deal.payees.map((p) => p.payeeId)).toEqual([s.supportPayee]);
    // An org payee's OWNER/ADMIN sees that org's line (the cost it fronted).
    const asSound = await getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: SOUND_ADMIN, agreementId: AGREEMENT_ID });
    expect(asSound.visibility).toBe("OWN_LINE");
    expect(asSound.clauses).toEqual([]);
    expect(asSound.deductions.map((d) => d.creditedPayeeId)).toEqual([s.soundPayee]);
  });

  it("M14: the projection for a non-party payee is EXACTLY its own line — with the number its percentage is of", async () => {
    const s = await bookedVersus();
    const out = await projectAgreementDeal(
      { repos: makeRepos(s), clock },
      { actorHumanId: SUPPORT_HUMAN, agreementId: AGREEMENT_ID, tiers: [{ tickets: 100, unitBasisCents: 2_000 }] },
    );
    // The whole wire shape, by value: an allow-list, so any field added to
    // the calculator's output that leaked here would fail this.
    expect(out.projection).toEqual(
      ownLine(s, {
        revenueMode: "PROJECTED",
        how: { paidPerOrderCents: null },
        position: {
          paidThroughPlatformCents: null,
          settleDirectlyCents: null,
          projectedPaidPerOrderCents: 20_000,
          projectedSettleDirectlyCents: 0,
        },
      }),
    );
    expect(out.remainder).toBeNull();
    expect(out.payees.map((p) => p.payeeId)).toEqual([s.supportPayee]);
  });

  it("nobody else sees anything", async () => {
    const s = await bookedVersus();
    expect(await caught(getAgreementDeal({ repos: makeRepos(s) }, { actorHumanId: OUTSIDER, agreementId: AGREEMENT_ID }))).toMatchObject({
      code: "NOT_AGREEMENT_PARTY",
    });
    expect(
      await caught(
        projectAgreementDeal({ repos: makeRepos(s), clock }, { actorHumanId: OUTSIDER, agreementId: AGREEMENT_ID, tiers: [{ tickets: 1, unitBasisCents: 1 }] }),
      ),
    ).toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });
});

describe("M5 on the event settlement sheet and its CSV", () => {
  it("the organiser (edit or finance role) and the act see the whole sheet", async () => {
    const s = withEndedEvent(await bookedVersus());
    for (const actor of [VENUE_ADMIN, VENUE_FINANCE, ACT_HUMAN]) {
      const out = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: actor, eventId: EVENT_ID });
      expect(out.sheet.visibility, actor).toBe("FULL");
      expect(out.ledger, actor).not.toBeNull();
    }
    const asAdmin = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID });
    expect(asAdmin.viewer).toEqual({ visibility: "FULL", canEdit: true, canMarkSettled: true });
    const asFinance = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_FINANCE, eventId: EVENT_ID });
    expect(asFinance.viewer).toEqual({ visibility: "FULL", canEdit: true, canMarkSettled: false });
    const asAct = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: ACT_HUMAN, eventId: EVENT_ID });
    expect(asAct.viewer).toEqual({ visibility: "FULL", canEdit: false, canMarkSettled: false });
    // A venue VIEWER is no finance reader and holds no payee: refused.
    expect(await caught(getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_VIEWER, eventId: EVENT_ID }))).toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("a payee who is not a party sees their own line — server-side, on the wire", async () => {
    const s = withEndedEvent(await bookedVersus());
    const out = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: SUPPORT_HUMAN, eventId: EVENT_ID });
    expect(out.sheet.visibility).toBe("OWN_LINE");
    expect(out.ledger).toBeNull();
    expect(out.remainder).toBeNull();
    if (out.sheet.visibility !== "OWN_LINE") return;
    expect(out.sheet).toEqual(
      ownLine(s, {
        revenueMode: "ACTUAL",
        how: { paidPerOrderCents: 20_000 },
        position: {
          paidThroughPlatformCents: 20_000,
          settleDirectlyCents: 0,
          projectedPaidPerOrderCents: null,
          projectedSettleDirectlyCents: null,
        },
      }),
    );
    expect(out.completeness).toBeNull();
    expect(out.entries).toEqual({ offPlatform: [], deductionActuals: [], directPayments: [] });
    expect(out.payees.map((p) => p.payeeId)).toEqual([s.supportPayee]);
  });

  it("M13: a VIEWER or SCANNER on the organiser's org does not see the sheet", async () => {
    const s = withEndedEvent(await bookedVersus());
    for (const actor of [VENUE_VIEWER, VENUE_SCANNER]) {
      expect(await caught(getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: actor, eventId: EVENT_ID })), actor).toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
    }
  });

  it("review B2 (round 2): a sheet settled while incomplete — a non-party payee gets its line and 'settled', nothing about who, when, or what was missing", async () => {
    const s = withEndedEvent(await bookedVersus());
    // Sound is an estimate: incomplete, settled on purpose.
    await markEventSettled({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    const asParty = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID });
    expect(asParty.settled?.acknowledgedIncomplete?.byHumanId).toBe(VENUE_ADMIN);

    const out = await getEventSettlement({ repos: makeRepos(s), clock }, { actorHumanId: SUPPORT_HUMAN, eventId: EVENT_ID });
    // The WHOLE envelope, by value.
    expect(out).toEqual({
      eventId: EVENT_ID,
      status: "SETTLED",
      frozen: true,
      settled: null,
      reopened: null,
      eventEnded: true,
      viewer: { visibility: "OWN_LINE", canEdit: false, canMarkSettled: false },
      remainder: null,
      sheet: ownLine(s, {
        revenueMode: "ACTUAL",
        how: { paidPerOrderCents: 20_000 },
        position: {
          paidThroughPlatformCents: 20_000,
          settleDirectlyCents: 0,
          projectedPaidPerOrderCents: null,
          projectedSettleDirectlyCents: null,
        },
      }),
      entries: { offPlatform: [], deductionActuals: [], directPayments: [] },
      ledger: null,
      completeness: null,
      staleEntryIds: [],
      payees: [{ payeeId: s.supportPayee, subjectType: "human", subjectId: SUPPORT_HUMAN, displayName: expect.any(String) }],
    });

    // The CSV, line by line: its own clause with the number its 10% is of
    // (M14), its position, and "Settled" — no date, no name, no incompleteness.
    const { csv } = await exportEventSettlementCsv({ repos: makeRepos(s), clock }, { actorHumanId: SUPPORT_HUMAN, eventId: EVENT_ID });
    const name = out.payees[0]!.displayName;
    expect(csv.trimEnd().split("\r\n")).toEqual([
      "Section,Item,Party,Amount,Details",
      "Status,Settled,,,",
      `Clause,10% of ticket money,${name},$200.00,"10% of $2,000.00 = $200.00; Paid through Ithas Fire per order"`,
      `Position,Entitled,${name},$200.00,`,
      `Position,Paid through Ithas Fire,${name},$200.00,`,
      `Position,Settle directly,${name},$0.00,Settles at $0.00`,
    ]);
  });

  it("the party's CSV names who settled it and who confirmed it incomplete — never a raw id", async () => {
    const s = withEndedEvent(await bookedVersus());
    await markEventSettled({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, acknowledgeIncomplete: true });
    const { csv } = await exportEventSettlementCsv({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID });
    expect(csv).not.toContain(VENUE_ADMIN);
    expect(csv).toContain("by Human 2323");
    expect(csv).toContain("Confirmed by Human 2323");
  });

  it("the CSV follows the same rules: the whole sheet for a party, one line for a payee, nothing for anyone else", async () => {
    const s = withEndedEvent(await bookedVersus());
    const full = await exportEventSettlementCsv({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID });
    expect(full.csv).toContain("Gross: ticket money net of refunds");
    expect(full.csv).toContain("Sound");
    const own = await exportEventSettlementCsv({ repos: makeRepos(s), clock }, { actorHumanId: SUPPORT_HUMAN, eventId: EVENT_ID });
    expect(own.csv).not.toContain("Gross");
    expect(own.csv).not.toContain("Sound");
    expect(own.csv).not.toContain("$800.00");
    expect(own.csv).toContain("$200.00");
    expect(await caught(exportEventSettlementCsv({ repos: makeRepos(s), clock }, { actorHumanId: OUTSIDER, eventId: EVENT_ID }))).toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });
});
