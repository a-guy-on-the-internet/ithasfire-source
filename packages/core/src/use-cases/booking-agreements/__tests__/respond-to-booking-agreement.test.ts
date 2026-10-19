import { describe, expect, it, vi } from "vitest";

import { respondToBookingAgreement } from "../respond-to-booking-agreement";
import { sendBookingAgreementForReview } from "../send-booking-agreement-for-review";
import { systemEntriesFor } from "../../booking-requests/__tests__/helpers";
import {
  AGREEMENT_ID,
  NOW,
  OUTSIDER_ID,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  VENUE_VIEWER_ID,
  buildAgreementRecord,
  buildLinkedBookingRequest,
  buildTransitionDeps,
} from "./helpers";

const proposed = () => buildAgreementRecord({ status: "PROPOSED" });

const baseInput = {
  actorHumanId: VENUE_ADMIN_ID,
  agreementId: AGREEMENT_ID,
};

describe("respondToBookingAgreement", () => {
  it("accept → ACCEPTED with acceptedAt stamped via CAS", async () => {
    const { deps, agreements, audit } = buildTransitionDeps(proposed());

    const result = await respondToBookingAgreement(deps, {
      ...baseInput,
      action: "accept",
    });

    expect(result).toMatchObject({
      agreementId: AGREEMENT_ID,
      status: "ACCEPTED",
      acceptedAt: NOW,
      declinedAt: null,
    });
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ACCEPTED",
        expectedFrom: ["PROPOSED"],
        acceptedAt: NOW,
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.accepted" }),
    );
  });

  it("decline requires a reason", async () => {
    const { deps } = buildTransitionDeps(proposed());

    await expect(
      respondToBookingAgreement(deps, { ...baseInput, action: "decline" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("decline → DECLINED with the reason recorded", async () => {
    const { deps, agreements } = buildTransitionDeps(proposed());

    const result = await respondToBookingAgreement(deps, {
      ...baseInput,
      action: "decline",
      declineReason: "Date no longer available",
    });

    expect(result.status).toBe("DECLINED");
    expect(result.declinedAt).toEqual(NOW);
    expect(agreements.record()?.declinedReason).toBe(
      "Date no longer available",
    );
  });

  // ── The reason is SANITIZED at the boundary ───────────────────────────────
  // It is copied onto the booking ledger and rendered where both parties read
  // it, so it goes through the same `plainTextMultilineRequired` pipeline as
  // the request-side decline reason — strip first, then apply the floor.
  it("strips markup and control characters from the decline reason", async () => {
    const { deps, agreements } = buildTransitionDeps(proposed());

    await respondToBookingAgreement(deps, {
      ...baseInput,
      action: "decline",
      declineReason:
        "<script>alert(1)</script>Guarantee is‮above what the room carries.",
    });

    // `<script>` is discarded WITH its content; the bidi override (U+202E)
    // between "is" and "above" is stripped as a Cf character.
    expect(agreements.record()?.declinedReason).toBe(
      "Guarantee isabove what the room carries.",
    );
  });

  it("rejects a reason that is nothing but markup — the floor applies to the CLEANED value", async () => {
    const { deps } = buildTransitionDeps(proposed());

    // `.trim().min(3)` would have accepted this and stored the tag.
    await expect(
      respondToBookingAgreement(deps, {
        ...baseInput,
        action: "decline",
        declineReason: "<b></b>",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("notifies the other side after accepting (best-effort)", async () => {
    const notify = vi.fn(async () => ({}) as never);
    const { deps } = buildTransitionDeps(proposed(), { notify });

    await respondToBookingAgreement(deps, {
      // Performer responds → the venue org's admins get pinged. The
      // performer IS the proposer-side human, so the ping goes to the org.
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
      action: "accept",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: VENUE_ADMIN_ID }),
    );
  });

  describe("decline — swallowed notify failures are reported", () => {
    const declineInput = {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
      action: "decline" as const,
      declineReason: "Date no longer available",
    };

    it("a throwing notify does not fail the decline, and is REPORTED once", async () => {
      const notifyError = new Error("notify down");
      const notify = vi.fn(async () => {
        throw notifyError;
      });
      const reportError = vi.fn();
      const { deps, agreements } = buildTransitionDeps(proposed(), {
        notify,
        reportError,
      });

      await expect(
        respondToBookingAgreement(deps, declineInput),
      ).resolves.toMatchObject({ status: "DECLINED" });
      expect(agreements.record()?.status).toBe("DECLINED");
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(notifyError, {
        tags: {
          useCase: "booking-agreements.notify-party",
          eventKey: "declined",
        },
        extra: { agreementId: AGREEMENT_ID, actorHumanId: PERFORMER_ID },
      });
    });

    it("a throwing reporter changes nothing", async () => {
      const notify = vi.fn(async () => {
        throw new Error("notify down");
      });
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const { deps, agreements } = buildTransitionDeps(proposed(), {
        notify,
        reportError,
      });

      await expect(
        respondToBookingAgreement(deps, declineInput),
      ).resolves.toMatchObject({ status: "DECLINED" });
      expect(agreements.record()?.status).toBe("DECLINED");
    });
  });

  it("rejects responses when not PROPOSED", async () => {
    const { deps } = buildTransitionDeps(buildAgreementRecord());

    await expect(
      respondToBookingAgreement(deps, { ...baseInput, action: "accept" }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_PROPOSED" });
  });

  it("rejects non-party actors and viewer-role org members", async () => {
    const { deps } = buildTransitionDeps(proposed());

    await expect(
      respondToBookingAgreement(deps, {
        ...baseInput,
        actorHumanId: OUTSIDER_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });

    await expect(
      respondToBookingAgreement(deps, {
        ...baseInput,
        actorHumanId: VENUE_VIEWER_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  // ── The act side: accept / decline ONLY ───────────────────────────────────
  // Owner decision 2026-08-25 — the act never edits terms, and a counter is a
  // terms edit by another name. There is no counter action on this use case
  // at all, so the act (and everyone else) gets `invalid_input` for one.
  describe("act side on a linked agreement", () => {
    const linked = { bookingRequest: buildLinkedBookingRequest("TO_VENUE") };

    it("may accept", async () => {
      const { deps } = buildTransitionDeps(proposed(), linked);

      const result = await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "accept",
      });

      expect(result.status).toBe("ACCEPTED");
    });

    it("may decline — request-linked terms go back to the venue as a DRAFT (N16)", async () => {
      const { deps } = buildTransitionDeps(proposed(), linked);

      const result = await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "decline",
        declineReason: "The guarantee is below what we need.",
      });

      expect(result.status).toBe("DRAFT");
    });

    it("cannot counter — the payload is rejected at the boundary, nothing changes", async () => {
      const { deps, agreements } = buildTransitionDeps(proposed(), linked);

      await expect(
        respondToBookingAgreement(deps, {
          actorHumanId: PERFORMER_ID,
          agreementId: AGREEMENT_ID,
          action: "counter",
          counterGuaranteeCents: 75_000,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(agreements.record()?.status).toBe("PROPOSED");
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });

    it("the EDITOR cannot accept or decline its own proposal (ACT_RESPONSE_ONLY)", async () => {
      const { deps, agreements } = buildTransitionDeps(proposed(), linked);

      await expect(
        respondToBookingAgreement(deps, {
          actorHumanId: VENUE_ADMIN_ID,
          agreementId: AGREEMENT_ID,
          action: "accept",
        }),
      ).rejects.toMatchObject({ code: "ACT_RESPONSE_ONLY" });
      await expect(
        respondToBookingAgreement(deps, {
          actorHumanId: VENUE_ADMIN_ID,
          agreementId: AGREEMENT_ID,
          action: "decline",
          declineReason: "Changed our mind.",
        }),
      ).rejects.toMatchObject({ code: "ACT_RESPONSE_ONLY" });
      expect(agreements.record()?.status).toBe("PROPOSED");
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });

    it("nor can it smuggle a COUNTERED status through the action field", async () => {
      const { deps, agreements } = buildTransitionDeps(proposed(), linked);

      await expect(
        respondToBookingAgreement(deps, {
          actorHumanId: PERFORMER_ID,
          agreementId: AGREEMENT_ID,
          action: "COUNTERED",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });
  });

  it("surfaces the CAS conflict when a concurrent pull-back wins", async () => {
    const { deps } = buildTransitionDeps(proposed(), { updateConflict: true });

    await expect(
      respondToBookingAgreement(deps, { ...baseInput, action: "accept" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });
  });

  // ── booking-the-night N16 / FR-012: declined terms go back to draft ───────
  // A request-linked decline is PROPOSED → DRAFT (the pull-back CAS), with
  // `booking_agreement.declined` (the reason) and `.returned_to_draft` on the
  // thread and the venue told. Unlinked terms, and terms on a closed request,
  // keep DECLINED (terminal). Lineup v3 punch list item 2.
  describe("declined terms go back to draft (N16 / FR-012)", () => {
    const REASON = "The guarantee is below what we need.";
    const sentAt = new Date("2026-06-09T12:00:00.000Z");
    const proposedSent = () =>
      buildAgreementRecord({ status: "PROPOSED", proposedAt: sentAt });

    it("CAS PROPOSED → DRAFT, no decline stamp, both entries with the reason, the venue pinged", async () => {
      const notify = vi.fn(async () => ({}) as never);
      const request = buildLinkedBookingRequest("TO_VENUE");
      const { deps, agreements, audit } = buildTransitionDeps(proposedSent(), {
        bookingRequest: request,
        notify,
      });

      const result = await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "decline",
        declineReason: REASON,
      });

      expect(result).toMatchObject({ status: "DRAFT", declinedAt: null });
      expect(agreements.repo.updateStatus).toHaveBeenCalledWith({
        id: AGREEMENT_ID,
        status: "DRAFT",
        expectedFrom: ["PROPOSED"],
      });
      // A DRAFT carries no decline stamp; the reason lives on the ledger.
      expect(agreements.record()).toMatchObject({
        status: "DRAFT",
        declinedAt: null,
        declinedReason: null,
      });
      expect(
        systemEntriesFor(deps.repos, request.id).map((e) => ({
          kind: e.systemKind,
          data: e.systemData,
          author: e.authorHumanId,
        })),
      ).toEqual([
        {
          kind: "booking_agreement.declined",
          data: { agreementId: AGREEMENT_ID, actorSide: "PERFORMER", reason: REASON },
          author: PERFORMER_ID,
        },
        {
          kind: "booking_agreement.returned_to_draft",
          data: { agreementId: AGREEMENT_ID, reason: REASON },
          author: PERFORMER_ID,
        },
      ]);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_agreement.declined",
          data: expect.objectContaining({ returnedToDraft: true, declineReason: REASON }),
        }),
      );
      // The venue (the org's admins) is told the terms are theirs to resend.
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: VENUE_ADMIN_ID,
          payload: expect.objectContaining({ title: "Terms declined" }),
          idempotencyKey: `bookingAgreement:${AGREEMENT_ID}:returned_to_draft:${sentAt.toISOString()}:${VENUE_ADMIN_ID}`,
        }),
      );
    });

    it("the venue can change and resend them: DRAFT → PROPOSED again (the decline is no longer terminal)", async () => {
      const request = buildLinkedBookingRequest("TO_VENUE");
      const { deps, agreements } = buildTransitionDeps(proposedSent(), {
        bookingRequest: request,
      });
      await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "decline",
        declineReason: REASON,
      });

      await sendBookingAgreementForReview(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(agreements.record()?.status).toBe("PROPOSED");
    });

    it("an organiser's request (TO_PERFORMER) linked and ACCEPTED goes back to draft too", async () => {
      const request = buildLinkedBookingRequest("TO_PERFORMER");
      const { deps } = buildTransitionDeps(
        buildAgreementRecord({
          status: "PROPOSED",
          proposerType: "organization",
          proposerId: "99999999-9999-4999-8999-999999999999",
          counterpartyType: "human",
          counterpartyId: PERFORMER_ID,
          placeId: null,
        }),
        { bookingRequest: request },
      );

      const result = await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "decline",
        declineReason: REASON,
      });

      expect(result.status).toBe("DRAFT");
    });

    it("terms on a CLOSED request keep DECLINED (terminal): there is no conversation to return to", async () => {
      const request = { ...buildLinkedBookingRequest("TO_VENUE"), status: "WITHDRAWN" as const };
      const { deps } = buildTransitionDeps(proposedSent(), { bookingRequest: request });

      const result = await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "decline",
        declineReason: REASON,
      });

      expect(result.status).toBe("DECLINED");
      expect(
        systemEntriesFor(deps.repos, request.id).map((e) => e.systemKind),
      ).toEqual(["booking_agreement.declined"]);
    });

    it("unlinked terms keep DECLINED, stamped with the reason", async () => {
      const { deps, agreements } = buildTransitionDeps(proposedSent());

      const result = await respondToBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "decline",
        declineReason: REASON,
      });

      expect(result.status).toBe("DECLINED");
      expect(agreements.record()?.declinedReason).toBe(REASON);
    });

    it("the reason is still required on a linked decline (N18)", async () => {
      const { deps, agreements } = buildTransitionDeps(proposedSent(), {
        bookingRequest: buildLinkedBookingRequest("TO_VENUE"),
      });

      await expect(
        respondToBookingAgreement(deps, {
          actorHumanId: PERFORMER_ID,
          agreementId: AGREEMENT_ID,
          action: "decline",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(agreements.record()?.status).toBe("PROPOSED");
    });

    it("a lost CAS (pulled back / agreed meanwhile) writes nothing — conflict surfaces", async () => {
      const request = buildLinkedBookingRequest("TO_VENUE");
      const { deps, agreements } = buildTransitionDeps(proposedSent(), {
        bookingRequest: request,
        updateConflict: true,
      });

      await expect(
        respondToBookingAgreement(deps, {
          actorHumanId: PERFORMER_ID,
          agreementId: AGREEMENT_ID,
          action: "decline",
          declineReason: REASON,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(agreements.record()?.status).toBe("PROPOSED");
      expect(systemEntriesFor(deps.repos, request.id)).toEqual([]);
    });
  });
});
