import { describe, expect, it } from "vitest";

import {
  A_TERMS,
  NIGHT_AT,
  buildNightHarness,
  type NightHarness,
} from "../../booking-agreements/__tests__/night-harness";
import { challengeBookingHold } from "../challenge-booking-hold";
import { DATE, REQUEST_A, REQUEST_B, STAFF_ID, VIEWER_ID } from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// N20's dialog step "Also send terms to the 1st hold": SEQUENTIAL — every
// up-front refusal before the challenge writes; the challenge commits; then
// the existing "Send terms". A send that fails after the commit leaves the
// challenge standing, says so in `termsToFirstHold`, and is reported.
// ─────────────────────────────────────────────────────────────────────────────

/** A's terms back to DRAFT (unsent); A at 1st hold, B behind and ready. */
function draftNight(ctx: NightHarness) {
  ctx.agreements.set(A_TERMS, {
    ...ctx.agreements.get(A_TERMS)!,
    status: "DRAFT",
    proposedAt: null,
    sentForReviewByHumanId: null,
  });
  const a = ctx.seedHold(REQUEST_A);
  const b = ctx.seedHold(REQUEST_B);
  ctx.seedTerms(REQUEST_B);
  return { a, b };
}

const challenge = (ctx: NightHarness, holdId: string, actorHumanId = STAFF_ID) =>
  challengeBookingHold(ctx.deps, { actorHumanId, holdId, sendTermsToFirstHold: true });

describe("challengeBookingHold — also send terms to the 1st hold", () => {
  it("challenges, then sends the 1st hold's DRAFT terms for that night; the notice says Keep will book", async () => {
    const ctx = buildNightHarness();
    const { a } = draftNight(ctx);

    const result = await challenge(ctx, a.id);

    expect(result.hold.status).toBe("CHALLENGED");
    expect(result.termsToFirstHold).toEqual({ status: "sent", errorCode: null });
    expect(ctx.agreements.get(A_TERMS)).toMatchObject({ status: "PROPOSED", sentForReviewByHumanId: STAFF_ID, proposedDate: NIGHT_AT });
    expect(result.notificationIntents[0]).toMatchObject({ audience: "act", holdId: a.id, keepWill: "book_now" });
    // Challenge first, then the send — the thread reads in that order.
    const kinds = ctx.entries(REQUEST_A).map((e) => e.kind);
    expect(kinds.indexOf("booking_hold.challenged")).toBeLessThan(kinds.indexOf("booking_agreement.sent_for_review"));
  });

  it("terms already sent for the night → nothing to send (already_sent)", async () => {
    const ctx = buildNightHarness(); // A_TERMS PROPOSED for DATE
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B);
    ctx.seedTerms(REQUEST_B);

    const result = await challenge(ctx, a.id);
    expect(result.termsToFirstHold).toEqual({ status: "already_sent", errorCode: null });
    expect(ctx.entries(REQUEST_A).map((e) => e.kind)).toEqual(["booking_hold.challenged"]);
  });

  it("up-front refusals write NOTHING — no terms, terms past DRAFT, an actor who may not edit terms", async () => {
    // No terms at all on the 1st hold's request.
    {
      const ctx = buildNightHarness();
      ctx.requests.set(REQUEST_A, { ...ctx.requests.get(REQUEST_A)!, agreementId: null });
      const a = ctx.seedHold(REQUEST_A);
      ctx.seedHold(REQUEST_B);
      ctx.seedTerms(REQUEST_B);
      await expect(challenge(ctx, a.id)).rejects.toMatchObject({
        code: "AGREEMENT_NOT_FOUND",
        meta: { bookingRequestId: REQUEST_A, reason: "first_hold_has_no_terms" },
      });
      expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
      expect(ctx.entries(REQUEST_A)).toEqual([]);
    }
    // Terms already agreed FOR THIS NIGHT (review W3): book it, don't
    // challenge — refused up front with the venue's pointer to Create event.
    {
      const ctx = buildNightHarness();
      ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, status: "ACCEPTED" });
      const a = ctx.seedHold(REQUEST_A);
      ctx.seedHold(REQUEST_B);
      ctx.seedTerms(REQUEST_B);
      await expect(challenge(ctx, a.id)).rejects.toMatchObject({
        code: "TERMS_AGREED_FOR_THIS_NIGHT",
        meta: { holdId: a.id, agreementId: A_TERMS, date: DATE },
      });
      expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    }
    // Terms agreed for ANOTHER night: not DRAFT, nothing to send.
    {
      const ctx = buildNightHarness();
      ctx.agreements.set(A_TERMS, {
        ...ctx.agreements.get(A_TERMS)!,
        status: "ACCEPTED",
        proposedDate: new Date("2026-06-28T01:00:00.000Z"),
      });
      const a = ctx.seedHold(REQUEST_A);
      ctx.seedHold(REQUEST_B);
      ctx.seedTerms(REQUEST_B);
      await expect(challenge(ctx, a.id)).rejects.toMatchObject({ code: "AGREEMENT_NOT_DRAFT" });
      expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    }
    // A staff VIEWER may not edit terms (and may not challenge either).
    {
      const ctx = buildNightHarness();
      const { a } = draftNight(ctx);
      await expect(challenge(ctx, a.id, VIEWER_ID)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
      expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");
    }
  });

  it("the send fails AFTER the challenge committed: the challenge stands, the output says failed with the code, the failure is reported; the notice says Keep will ask for terms", async () => {
    const ctx = buildNightHarness();
    const { a } = draftNight(ctx);
    // The send's DRAFT → PROPOSED CAS loses (a concurrent edit).
    ctx.casLosses.next = 1;

    const result = await challenge(ctx, a.id);

    expect(result.hold.status).toBe("CHALLENGED");
    expect(ctx.bookingHolds.rows.get(a.id)?.status).toBe("CHALLENGED");
    expect(result.termsToFirstHold.status).toBe("failed");
    expect(result.termsToFirstHold.errorCode).toEqual(expect.any(String));
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");
    expect(ctx.deps.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: { useCase: "challengeBookingHold", step: "send_terms_to_first_hold" } }),
    );
    expect(ctx.logger.error).toHaveBeenCalledWith("booking_holds.challenge_send_terms_failed", expect.objectContaining({ holdId: a.id }));
    expect(result.notificationIntents[0]).toMatchObject({ audience: "act", holdId: a.id, keepWill: "ask_for_terms" });
  });

  it("a throwing reporter never changes the outcome", async () => {
    const ctx = buildNightHarness();
    const { a } = draftNight(ctx);
    ctx.casLosses.next = 1;
    (ctx.deps.reportError as unknown as { mockImplementation: (fn: () => never) => void }).mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(challenge(ctx, a.id)).resolves.toMatchObject({ termsToFirstHold: { status: "failed" } });
  });

  it("no ready act → NO_ACT_READY before anything is sent", async () => {
    const ctx = buildNightHarness();
    ctx.agreements.set(A_TERMS, { ...ctx.agreements.get(A_TERMS)!, status: "DRAFT" });
    const a = ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_B); // no terms → not ready

    await expect(challenge(ctx, a.id)).rejects.toMatchObject({ code: "NO_ACT_READY" });
    expect(ctx.agreements.get(A_TERMS)?.status).toBe("DRAFT");
    expect(ctx.entries(REQUEST_A)).toEqual([]);
  });
});
