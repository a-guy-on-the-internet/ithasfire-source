import { beforeEach, describe, expect, it, vi } from "vitest";

import * as stripeConnectUseCases from "@th/core/use-cases/stripe-connect";

import { stripeConnectRouter } from "../stripe-connect";
import { createCaller } from "./test-helpers";

const ACTOR_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const RETURN_URL = "https://example.com/return";
const REFRESH_URL = "https://example.com/refresh";

describe("stripeConnectRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults onboarding to the actor human owner", async () => {
    const initiateSpy = vi
      .spyOn(stripeConnectUseCases, "initiateOnboarding")
      .mockResolvedValue({
        payeeId: "payee-1",
        stripeAccountId: "acct_human",
        onboardingUrl: "https://connect.stripe.com/setup/test",
      });
    const { caller, ctx } = createCaller(stripeConnectRouter, {
      actorHumanId: ACTOR_HUMAN_ID,
    });

    const result = await caller.initiateOnboarding({
      returnUrl: RETURN_URL,
      refreshUrl: REFRESH_URL,
    });

    expect(result.stripeAccountId).toBe("acct_human");
    expect(initiateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency: ctx.idempotency }),
      {
        actorHumanId: ctx.actorHumanId,
        humanId: ctx.actorHumanId,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      },
    );
  });

  it("defaults status to the actor human owner", async () => {
    const statusSpy = vi
      .spyOn(stripeConnectUseCases, "getConnectStatus")
      .mockResolvedValue({
        connected: false,
        stripeAccountId: null,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirements: null,
        payoutsBlockedReason: null,
        capabilityOverride: null,
      });
    const { caller, ctx } = createCaller(stripeConnectRouter, {
      actorHumanId: ACTOR_HUMAN_ID,
    });

    await caller.getStatus();

    expect(statusSpy).toHaveBeenCalledWith(expect.anything(), {
      actorHumanId: ctx.actorHumanId,
      humanId: ctx.actorHumanId,
    });
  });

  it("maps cross-human onboarding to FORBIDDEN", async () => {
    const { caller } = createCaller(stripeConnectRouter, {
      actorHumanId: ACTOR_HUMAN_ID,
    });

    await expect(
      caller.initiateOnboarding({
        humanId: OTHER_HUMAN_ID,
        returnUrl: RETURN_URL,
        refreshUrl: REFRESH_URL,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_RESOURCE_OWNER",
      meta: { appCode: "NOT_RESOURCE_OWNER" },
    });
  });

  it("maps cross-human status reads to FORBIDDEN", async () => {
    const { caller } = createCaller(stripeConnectRouter, {
      actorHumanId: ACTOR_HUMAN_ID,
    });

    await expect(
      caller.getStatus({ humanId: OTHER_HUMAN_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_RESOURCE_OWNER",
      meta: { appCode: "NOT_RESOURCE_OWNER" },
    });
  });
});