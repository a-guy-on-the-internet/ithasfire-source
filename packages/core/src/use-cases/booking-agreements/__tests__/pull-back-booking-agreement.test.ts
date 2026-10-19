import { describe, expect, it } from "vitest";

import { pullBackBookingAgreement } from "../pull-back-booking-agreement";
import {
  AGREEMENT_ID,
  NOW,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  buildAgreementRecord,
  buildTransitionDeps,
} from "./helpers";

const baseInput = {
  actorHumanId: PERFORMER_ID,
  agreementId: AGREEMENT_ID,
};

describe("pullBackBookingAgreement", () => {
  it("moves PROPOSED → DRAFT so editing can resume (proposedAt kept as history)", async () => {
    const { deps, agreements, audit } = buildTransitionDeps(
      buildAgreementRecord({ status: "PROPOSED", proposedAt: NOW }),
    );

    const result = await pullBackBookingAgreement(deps, baseInput);

    expect(result).toMatchObject({
      agreementId: AGREEMENT_ID,
      status: "DRAFT",
    });
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "DRAFT",
        expectedFrom: ["PROPOSED"],
      }),
    );
    expect(agreements.record()?.proposedAt).toEqual(NOW);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.pulled_back" }),
    );
  });

  it("allows either party (venue admin pulls back the performer's proposal)", async () => {
    const { deps } = buildTransitionDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );

    const result = await pullBackBookingAgreement(deps, {
      ...baseInput,
      actorHumanId: VENUE_ADMIN_ID,
    });

    expect(result.status).toBe("DRAFT");
  });

  it("rejects when not PROPOSED", async () => {
    const { deps } = buildTransitionDeps(buildAgreementRecord());

    await expect(
      pullBackBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
  });

  it("surfaces the CAS conflict when a concurrent respond wins", async () => {
    const { deps } = buildTransitionDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
      { updateConflict: true },
    );

    await expect(
      pullBackBookingAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });
  });
});
