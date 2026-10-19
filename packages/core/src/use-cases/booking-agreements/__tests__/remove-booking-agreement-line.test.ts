import { describe, expect, it, vi } from "vitest";

import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { removeBookingAgreementLine } from "../remove-booking-agreement-line";
import type { BookingAgreementLineDeps } from "../upsert-booking-agreement-line";
import type { AgreementRecord } from "@th/ports/repos/agreements";

import {
  AGREEMENT_ID,
  EVENT_ID,
  LINE_ID,
  PERFORMER_ID,
  TERMS_ID,
  THIRD_PARTY_PAYEE_ID,
  VENUE_PAYEE_ID,
  buildAgreementRecord,
  buildLineRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
  makeClock,
  withTx,
} from "./helpers";

function buildDeps(
  existingLines: PayoutTermsLineRecord[],
  agreement: AgreementRecord = buildAgreementRecord(),
) {
  const agreements = makeAgreementsRepoFake(agreement);
  const audit = makeAuditFake();

  let lines = existingLines;
  const payoutTerms = {
    listLines: vi.fn(async () => lines),
    replaceLines: vi.fn(async (_termsId: string, inputs: unknown[]) => {
      lines = inputs as PayoutTermsLineRecord[];
    }),
  };

  const deps = {
    repos: withTx({
      agreements: agreements.repo,
      payoutTerms,
      authz: makeAuthzFake(),
      audit,
    }) as unknown as BookingAgreementLineDeps["repos"],
    clock: makeClock(),
  } satisfies BookingAgreementLineDeps;

  return { deps, payoutTerms, audit, lines: () => lines };
}

describe("removeBookingAgreementLine", () => {
  it("removes the line and preserves the rest verbatim", async () => {
    const confirmedAt = new Date("2026-06-05T00:00:00.000Z");
    const keeper = buildLineRecord({
      id: "11111111-2222-4333-8444-555555555555",
      payeeId: VENUE_PAYEE_ID,
      percent: 30,
      confirmationStatus: "CONFIRMED",
      confirmedAt,
    });
    const { deps, payoutTerms, audit, lines } = buildDeps([
      buildLineRecord({ id: LINE_ID, payeeId: THIRD_PARTY_PAYEE_ID }),
      keeper,
    ]);

    const result = await removeBookingAgreementLine(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
      lineId: LINE_ID,
    });

    expect(result).toMatchObject({
      agreementId: AGREEMENT_ID,
      payoutTermsId: TERMS_ID,
      lineId: LINE_ID,
      removed: true,
    });
    expect(payoutTerms.replaceLines).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      id: keeper.id,
      confirmationStatus: "CONFIRMED",
      confirmedAt,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.line_removed" }),
    );
  });

  it("rejects removal on a FINALIZED agreement (eventId stamped) even if status reads DRAFT", async () => {
    const { deps, payoutTerms } = buildDeps(
      [buildLineRecord({ id: LINE_ID, payeeId: THIRD_PARTY_PAYEE_ID })],
      buildAgreementRecord({ status: "DRAFT", eventId: EVENT_ID }),
    );

    await expect(
      removeBookingAgreementLine(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        lineId: LINE_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });
    expect(payoutTerms.replaceLines).not.toHaveBeenCalled();
  });

  it("rejects an unknown lineId", async () => {
    const { deps } = buildDeps([]);

    await expect(
      removeBookingAgreementLine(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        lineId: LINE_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_LINE_NOT_FOUND" });
  });
});
