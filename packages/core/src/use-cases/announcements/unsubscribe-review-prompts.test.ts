import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";

import {
  unsubscribeReviewPrompts,
  type UnsubscribeReviewPromptsDeps,
} from "./unsubscribe-review-prompts";
import { generateReviewPromptUnsubscribeToken } from "./unsubscribe-from-audience";

const SECRET = "test-unsubscribe-secret";
const HUMAN = "11111111-1111-4111-8111-111111111111";
const EMAIL = "Fan@Example.com";
const NOW = new Date("2026-07-16T16:00:00Z");

function makeDeps() {
  const upsertSubscription = vi.fn(async () => ({
    humanId: HUMAN,
    digestType: "ATTENDEE_FEEDBACK" as const,
    subscribed: false,
    consecutiveIgnored: 0,
  }));
  const clock: ClockPort = { now: vi.fn(() => new Date(NOW)) };
  const deps: UnsubscribeReviewPromptsDeps = {
    repos: { notificationDigests: { upsertSubscription } } as never,
    clock,
    unsubscribeSecret: SECRET,
  };
  return { deps, upsertSubscription };
}

describe("unsubscribeReviewPrompts", () => {
  it("a valid token flips the ATTENDEE_FEEDBACK subscription to subscribed=false", async () => {
    const { deps, upsertSubscription } = makeDeps();
    const token = generateReviewPromptUnsubscribeToken(SECRET, HUMAN, EMAIL);

    const result = await unsubscribeReviewPrompts(deps, {
      kind: "review-prompts",
      humanId: HUMAN,
      email: EMAIL,
      token,
    });

    expect(result).toEqual({ ok: true });
    expect(upsertSubscription).toHaveBeenCalledWith({
      humanId: HUMAN,
      digestType: "ATTENDEE_FEEDBACK",
      subscribed: false,
      reason: "user_unsubscribed",
      unsubscribedAt: NOW,
    });
  });

  it("is case-insensitive on the email (token signs the lowercased address)", async () => {
    const { deps, upsertSubscription } = makeDeps();
    // Token minted over the lowercased email, request carries mixed case.
    const token = generateReviewPromptUnsubscribeToken(
      SECRET,
      HUMAN,
      EMAIL.toLowerCase(),
    );

    await unsubscribeReviewPrompts(deps, {
      kind: "review-prompts",
      humanId: HUMAN,
      email: EMAIL,
      token,
    });

    expect(upsertSubscription).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered token without mutating anything", async () => {
    const { deps, upsertSubscription } = makeDeps();

    await expect(
      unsubscribeReviewPrompts(deps, {
        kind: "review-prompts",
        humanId: HUMAN,
        email: EMAIL,
        token: "deadbeef".repeat(8),
      }),
    ).rejects.toMatchObject({ code: "INVALID_UNSUBSCRIBE_TOKEN" });

    expect(upsertSubscription).not.toHaveBeenCalled();
  });

  it("rejects a token minted for a different email", async () => {
    const { deps, upsertSubscription } = makeDeps();
    const token = generateReviewPromptUnsubscribeToken(
      SECRET,
      HUMAN,
      "someone-else@example.com",
    );

    await expect(
      unsubscribeReviewPrompts(deps, {
        kind: "review-prompts",
        humanId: HUMAN,
        email: EMAIL,
        token,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UNSUBSCRIBE_TOKEN" });

    expect(upsertSubscription).not.toHaveBeenCalled();
  });

  it("rejects a token minted for a different human", async () => {
    const { deps, upsertSubscription } = makeDeps();
    const token = generateReviewPromptUnsubscribeToken(
      SECRET,
      "22222222-2222-4222-8222-222222222222",
      EMAIL,
    );

    await expect(
      unsubscribeReviewPrompts(deps, {
        kind: "review-prompts",
        humanId: HUMAN,
        email: EMAIL,
        token,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UNSUBSCRIBE_TOKEN" });

    expect(upsertSubscription).not.toHaveBeenCalled();
  });
});
