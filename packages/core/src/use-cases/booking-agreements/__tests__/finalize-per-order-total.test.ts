/**
 * P4b review B1, the defence behind the deal write's terms lock: terms put in
 * force must divide each order the way they should. Deal-written terms (a
 * stored remainder holder) total exactly 100%; legacy terms never over 100%.
 */
import { describe, expect, it, vi } from "vitest";

import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import {
  assertPerOrderLinesForActivation,
  assertPerOrderLinesNotOver100,
  assertPerOrderLinesTotal100,
} from "../../../lib/pricing/per-order-lines-total";
import { finalizeBookingAgreement } from "../finalize-booking-agreement";
import type { FinalizeBookingAgreementDeps } from "../finalize-booking-agreement";
import {
  AGREEMENT_ID,
  EVENT_ID,
  PERFORMER_ID,
  TERMS_ID,
  VENUE_ORG_ID,
  VENUE_PAYEE_ID,
  THIRD_PARTY_PAYEE_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildPayeeRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
  makeClock,
  makeFakeIdempotency,
  withTx,
} from "./helpers";

const line = (id: string, payeeId: string, percent: number): PayoutTermsLineRecord =>
  buildLineRecord({ id, payeeId, percent, requiresConfirmation: false, confirmationStatus: null });

function deps(lines: PayoutTermsLineRecord[], remainderPayeeId: string | null) {
  const agreements = makeAgreementsRepoFake(buildAgreementRecord({ status: "ACCEPTED" }));
  const payoutTerms = {
    listLines: vi.fn(async () => lines),
    activate: vi.fn(async () => ({ id: TERMS_ID, status: "ACTIVE" })),
    getById: vi.fn(async (id: string) =>
      id === TERMS_ID ? { id: TERMS_ID, status: "PENDING", remainderPayeeId } : null,
    ),
  };
  const events = {
    getById: vi.fn(async () => ({ id: EVENT_ID, orgId: null, humanId: PERFORMER_ID, status: "DRAFT" })),
    linkPayoutTerms: vi.fn(async () => undefined),
    lockRows: vi.fn(async () => undefined),
  };
  return {
    events,
    deps: {
      repos: withTx({
        agreements: agreements.repo,
        payoutTerms,
        payees: {
          getByIds: vi.fn(async () => [
            buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID }),
            buildPayeeRecord({ id: VENUE_PAYEE_ID, subjectType: "ORGANIZATION", subjectId: VENUE_ORG_ID }),
          ]),
        },
        events,
        authz: makeAuthzFake(),
        audit: makeAuditFake(),
      }) as unknown as FinalizeBookingAgreementDeps["repos"],
      idempotency: makeFakeIdempotency(),
      clock: makeClock(),
    } satisfies FinalizeBookingAgreementDeps,
  };
}

const input = { actorHumanId: PERFORMER_ID, agreementId: AGREEMENT_ID, eventId: EVENT_ID };
const L1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const L2 = "11111111-aaaa-4aaa-8aaa-000000000002";
const L3 = "11111111-aaaa-4aaa-8aaa-000000000003";

describe("finalize refuses per-order lines that don't divide the order (B1 defence)", () => {
  it("deal-written terms: the doubled set a lost race would leave (110%) is refused, and nothing is linked", async () => {
    const { deps: d, events } = deps(
      [line(L1, VENUE_PAYEE_ID, 90), line(L2, THIRD_PARTY_PAYEE_ID, 10), line(L3, THIRD_PARTY_PAYEE_ID, 10)],
      VENUE_PAYEE_ID,
    );
    await expect(finalizeBookingAgreement(d, input)).rejects.toMatchObject({
      code: "PAYOUT_LINES_TOTAL_INVALID",
    });
    expect(events.linkPayoutTerms).not.toHaveBeenCalled();
  });

  it("deal-written terms: under 100% is refused too", async () => {
    const { deps: d } = deps([line(L1, VENUE_PAYEE_ID, 80), line(L2, THIRD_PARTY_PAYEE_ID, 10)], VENUE_PAYEE_ID);
    await expect(finalizeBookingAgreement(d, input)).rejects.toMatchObject({ code: "PAYOUT_LINES_TOTAL_INVALID" });
  });

  it("deal-written terms at exactly 100% finalize", async () => {
    const { deps: d, events } = deps([line(L1, VENUE_PAYEE_ID, 90), line(L2, THIRD_PARTY_PAYEE_ID, 10)], VENUE_PAYEE_ID);
    await expect(finalizeBookingAgreement(d, input)).resolves.toMatchObject({ eventId: EVENT_ID });
    expect(events.linkPayoutTerms).toHaveBeenCalledTimes(1);
  });

  it("legacy terms: over 100% is refused; under 100% finalizes as it always has", async () => {
    const over = deps([line(L1, VENUE_PAYEE_ID, 90), line(L2, THIRD_PARTY_PAYEE_ID, 20)], null);
    await expect(finalizeBookingAgreement(over.deps, input)).rejects.toMatchObject({ code: "PAYOUT_LINES_TOTAL_INVALID" });
    const under = deps([line(L1, VENUE_PAYEE_ID, 80), line(L2, THIRD_PARTY_PAYEE_ID, 10)], null);
    await expect(finalizeBookingAgreement(under.deps, input)).resolves.toMatchObject({ eventId: EVENT_ID });
  });

  it("the guards themselves", () => {
    const at = (...percents: number[]) => percents.map((percent) => ({ percent }));
    expect(() => assertPerOrderLinesTotal100(at(60, 40))).not.toThrow();
    expect(() => assertPerOrderLinesTotal100(at(60, 41))).toThrow();
    expect(() => assertPerOrderLinesTotal100(at(60, 39))).toThrow();
    expect(() => assertPerOrderLinesNotOver100(at(60, 39))).not.toThrow();
    expect(() => assertPerOrderLinesNotOver100(at(60, 41))).toThrow();
    expect(() => assertPerOrderLinesForActivation(at(60, 39), { remainderPayeeId: "r" })).toThrow();
    expect(() => assertPerOrderLinesForActivation(at(60, 39), { remainderPayeeId: null })).not.toThrow();
    expect(() => assertPerOrderLinesForActivation(at(60, 39), null)).not.toThrow();
  });
});

describe("the per-order total refusal is a deterministic finalize failure", () => {
  it("is retained for 1s only, so a retry after the lines are fixed gets the real answer", async () => {
    const { deps: d } = deps([line(L1, VENUE_PAYEE_ID, 80), line(L2, THIRD_PARTY_PAYEE_ID, 10)], VENUE_PAYEE_ID);
    const fail = vi.spyOn(d.idempotency, "fail");
    await expect(finalizeBookingAgreement(d, input)).rejects.toMatchObject({ code: "PAYOUT_LINES_TOTAL_INVALID" });
    expect(fail).toHaveBeenCalledWith(expect.any(String), expect.anything(), 1);
  });
});
