import { describe, expect, it, vi } from "vitest";

import { confirmClaimEmailChallenge } from "../confirm-claim-email-challenge";
import type { ConfirmClaimEmailChallengeDeps } from "../confirm-claim-email-challenge";
import { hashChallengeCode, MAX_CHALLENGE_ATTEMPTS } from "../_shared/claim";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const ACTOR = "11111111-1111-4111-8111-111111111111";
const CHALLENGE = "77777777-7777-4777-8777-777777777777";
const CODE = "123456";

function buildDeps(
  overrides: {
    verifiedAt?: Date | null;
    expiresAt?: Date;
    attempts?: number;
    codeHash?: string;
    humanId?: string;
    exists?: boolean;
  } = {},
) {
  const challenge = overrides.exists === false
    ? null
    : {
        id: CHALLENGE,
        placeId: "place",
        humanId: overrides.humanId ?? ACTOR,
        email: "owner@venue.com",
        codeHash: overrides.codeHash ?? hashChallengeCode(CODE),
        expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60_000),
        verifiedAt: overrides.verifiedAt ?? null,
        attempts: overrides.attempts ?? 0,
        createdAt: NOW,
      };

  let attempts = challenge?.attempts ?? 0;
  const repo = {
    getById: vi.fn(async () => challenge),
    incrementAttempts: vi.fn(async () => {
      attempts += 1;
      return attempts;
    }),
    markVerified: vi.fn(async () => ({ ...challenge!, verifiedAt: NOW })),
  };

  const deps = {
    repos: { placeClaimEmailChallenges: repo },
    clock: { now: () => NOW },
  } as unknown as ConfirmClaimEmailChallengeDeps;

  return { deps, repo };
}

describe("confirmClaimEmailChallenge", () => {
  it("verifies a correct code and marks the challenge satisfied", async () => {
    const { deps, repo } = buildDeps();
    const out = await confirmClaimEmailChallenge(deps, {
      actorHumanId: ACTOR,
      challengeId: CHALLENGE,
      code: CODE,
    });
    expect(out.verified).toBe(true);
    expect(repo.markVerified).toHaveBeenCalledOnce();
  });

  it("rejects a wrong code with CLAIM_CHALLENGE_CODE_INVALID and counts the attempt", async () => {
    const { deps, repo } = buildDeps();
    await expect(
      confirmClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        challengeId: CHALLENGE,
        code: "000000",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_CHALLENGE_CODE_INVALID" });
    expect(repo.incrementAttempts).toHaveBeenCalledOnce();
  });

  it("locks after the final failed attempt with CLAIM_CHALLENGE_LOCKED", async () => {
    const { deps } = buildDeps({ attempts: MAX_CHALLENGE_ATTEMPTS - 1 });
    await expect(
      confirmClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        challengeId: CHALLENGE,
        code: "000000",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_CHALLENGE_LOCKED" });
  });

  it("refuses an already-locked challenge", async () => {
    const { deps } = buildDeps({ attempts: MAX_CHALLENGE_ATTEMPTS });
    await expect(
      confirmClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        challengeId: CHALLENGE,
        code: CODE,
      }),
    ).rejects.toMatchObject({ code: "CLAIM_CHALLENGE_LOCKED" });
  });

  it("refuses an expired challenge", async () => {
    const { deps } = buildDeps({ expiresAt: new Date(NOW.getTime() - 1) });
    await expect(
      confirmClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        challengeId: CHALLENGE,
        code: CODE,
      }),
    ).rejects.toMatchObject({ code: "CLAIM_CHALLENGE_EXPIRED" });
  });

  it("is idempotent — an already-verified challenge returns verified", async () => {
    const { deps, repo } = buildDeps({ verifiedAt: NOW });
    const out = await confirmClaimEmailChallenge(deps, {
      actorHumanId: ACTOR,
      challengeId: CHALLENGE,
      code: CODE,
    });
    expect(out.verified).toBe(true);
    expect(repo.markVerified).not.toHaveBeenCalled();
  });

  it("rejects a challenge owned by a different human (CLAIM_CHALLENGE_NOT_FOUND)", async () => {
    const { deps } = buildDeps({ humanId: "someone-else" });
    await expect(
      confirmClaimEmailChallenge(deps, {
        actorHumanId: ACTOR,
        challengeId: CHALLENGE,
        code: CODE,
      }),
    ).rejects.toMatchObject({ code: "CLAIM_CHALLENGE_NOT_FOUND" });
  });
});
