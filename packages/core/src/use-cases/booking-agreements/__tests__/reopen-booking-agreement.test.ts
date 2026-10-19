import { describe, expect, it, vi } from "vitest";

import { reopenBookingAgreement } from "../reopen-booking-agreement";
import {
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  OUTSIDER_ID,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  VENUE_VIEWER_ID,
  buildAgreementRecord,
  buildTransitionDeps,
} from "./helpers";

const baseInput = {
  actorHumanId: PERFORMER_ID,
  agreementId: AGREEMENT_ID,
};

const accepted = () =>
  buildAgreementRecord({ status: "ACCEPTED", acceptedAt: NOW });

describe("reopenBookingAgreement", () => {
  it("moves unfinalized ACCEPTED → DRAFT (acceptedAt kept as history)", async () => {
    const { deps, agreements, audit } = buildTransitionDeps(accepted());

    const result = await reopenBookingAgreement(deps, baseInput);

    expect(result).toEqual({ agreementId: AGREEMENT_ID, status: "DRAFT" });
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith({
      id: AGREEMENT_ID,
      status: "DRAFT",
      expectedFrom: ["ACCEPTED"],
      expectEventIdNull: true,
    });
    expect(agreements.record()?.acceptedAt).toEqual(NOW);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.reopened" }),
    );
  });

  it("allows either party (venue admin reopens too)", async () => {
    const { deps } = buildTransitionDeps(accepted());

    const result = await reopenBookingAgreement(deps, {
      ...baseInput,
      actorHumanId: VENUE_ADMIN_ID,
    });

    expect(result.status).toBe("DRAFT");
  });

  it("notifies the other party best-effort and survives notify failures", async () => {
    const notify = vi.fn(async () => ({}) as never);
    const { deps } = buildTransitionDeps(accepted(), { notify });

    await reopenBookingAgreement(deps, baseInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: VENUE_ADMIN_ID,
        variant: "notification.generic",
        idempotencyKey: expect.stringContaining(":reopened:"),
      }),
    );

    const failing = vi.fn(async () => {
      throw new Error("comms down");
    });
    const { deps: deps2 } = buildTransitionDeps(accepted(), {
      notify: failing,
    });
    await expect(reopenBookingAgreement(deps2, baseInput)).resolves.toMatchObject(
      { status: "DRAFT" },
    );
  });

  it("rejects a finalized agreement (eventId stamped) with agreement_finalized", async () => {
    const { deps, agreements } = buildTransitionDeps(
      buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
    );

    await expect(reopenBookingAgreement(deps, baseInput)).rejects.toMatchObject(
      { code: "AGREEMENT_FINALIZED" },
    );
    expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
  });

  it("rejects when not ACCEPTED", async () => {
    const { deps } = buildTransitionDeps(
      buildAgreementRecord({ status: "PROPOSED" }),
    );

    await expect(reopenBookingAgreement(deps, baseInput)).rejects.toMatchObject(
      { code: "AGREEMENT_NOT_ACCEPTED" },
    );
  });

  it("surfaces the CAS conflict when a concurrent transition wins", async () => {
    const { deps } = buildTransitionDeps(accepted(), { updateConflict: true });

    await expect(reopenBookingAgreement(deps, baseInput)).rejects.toMatchObject(
      { code: "conflict", message: "agreement_status_changed" },
    );
  });

  it("rejects non-party actors and org members below edit roles", async () => {
    const { deps } = buildTransitionDeps(accepted());
    await expect(
      reopenBookingAgreement(deps, { ...baseInput, actorHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });

    const { deps: deps2 } = buildTransitionDeps(accepted());
    await expect(
      reopenBookingAgreement(deps2, {
        ...baseInput,
        actorHumanId: VENUE_VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  it("404s on a missing agreement", async () => {
    const { deps } = buildTransitionDeps(null);

    await expect(reopenBookingAgreement(deps, baseInput)).rejects.toMatchObject(
      { code: "AGREEMENT_NOT_FOUND" },
    );
  });
});
