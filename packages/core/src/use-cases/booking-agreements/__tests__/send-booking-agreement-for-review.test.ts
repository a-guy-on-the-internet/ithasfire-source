import { describe, expect, it, vi } from "vitest";

import { sendBookingAgreementForReview } from "../send-booking-agreement-for-review";
import {
  AGREEMENT_ID,
  NOW,
  OUTSIDER_ID,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  buildAgreementRecord,
  buildTransitionDeps,
} from "./helpers";

const baseInput = {
  actorHumanId: PERFORMER_ID,
  agreementId: AGREEMENT_ID,
};

describe("sendBookingAgreementForReview", () => {
  it("moves DRAFT → PROPOSED via CAS and stamps proposedAt", async () => {
    const { deps, agreements, audit } = buildTransitionDeps(
      buildAgreementRecord(),
    );

    const result = await sendBookingAgreementForReview(deps, baseInput);

    expect(result).toMatchObject({
      agreementId: AGREEMENT_ID,
      status: "PROPOSED",
      proposedAt: NOW,
    });
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "PROPOSED",
        expectedFrom: ["DRAFT"],
        proposedAt: NOW,
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.proposed" }),
    );
  });

  it("pings the other side's org OWNER/ADMINs in-app (not viewers, not the actor)", async () => {
    const notify = vi.fn(async () => ({}) as never);
    const { deps } = buildTransitionDeps(buildAgreementRecord(), { notify });

    await sendBookingAgreementForReview(deps, baseInput);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: VENUE_ADMIN_ID,
        variant: "notification.generic",
        channels: expect.objectContaining({ inApp: { enabled: true } }),
      }),
    );
  });

  it("never fails the transition when notify blows up (best-effort)", async () => {
    const notify = vi.fn(async () => {
      throw new Error("comms down");
    });
    const { deps } = buildTransitionDeps(buildAgreementRecord(), { notify });

    const result = await sendBookingAgreementForReview(deps, baseInput);

    expect(result.status).toBe("PROPOSED");
  });

  it("rejects when not DRAFT", async () => {
    const { deps } = buildTransitionDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );

    await expect(
      sendBookingAgreementForReview(deps, baseInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_DRAFT" });
  });

  it("rejects non-party actors", async () => {
    const { deps } = buildTransitionDeps(buildAgreementRecord());

    await expect(
      sendBookingAgreementForReview(deps, {
        ...baseInput,
        actorHumanId: OUTSIDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  it("surfaces the CAS conflict when a concurrent transition wins", async () => {
    const { deps } = buildTransitionDeps(buildAgreementRecord(), {
      updateConflict: true,
    });

    await expect(
      sendBookingAgreementForReview(deps, baseInput),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });
  });
});
