import { describe, expect, it, vi } from "vitest";

import { CURRENT_CHARGEBACK_TERMS_VERSION } from "@th/core/lib/payments/chargeback-terms";
import type { Ctx } from "../../context";
import { humansRouter } from "../humans";
import { createCaller } from "./test-helpers";

/**
 * `humans.getMyProfile` is an inline transport read (no core use case, no
 * output schema), so the field set IS the contract. Pins that the human's
 * OWN chargeback-terms acceptance rides along — the payments page needs it
 * to recognise a returning solo organizer instead of re-prompting (and
 * re-accepting overwrites the legal `acceptedAt`). No gating: own record.
 */
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ACCEPTED_AT = new Date("2025-11-02T09:30:00.000Z");

function buildRepos(options: { accepted: boolean }) {
  const human = {
    id: ACTOR_ID,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    jobs: [],
    genreTags: [],
    otherJobDescription: null,
    chargebackTermsVersion: options.accepted
      ? CURRENT_CHARGEBACK_TERMS_VERSION
      : null,
    chargebackTermsAcceptedAt: options.accepted ? ACCEPTED_AT : null,
  };
  return {
    humans: { getById: vi.fn(async () => human) },
  } as unknown as Ctx["repos"];
}

describe("humansRouter.getMyProfile", () => {
  it("exposes the human's own chargebackTermsVersion + chargebackTermsAcceptedAt", async () => {
    const { caller } = createCaller(humansRouter, {
      repos: buildRepos({ accepted: true }),
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.getMyProfile();

    expect(result).toMatchObject({
      chargebackTermsVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      chargebackTermsAcceptedAt: ACCEPTED_AT,
    });
  });

  it("returns explicit nulls when the human has never accepted", async () => {
    const { caller } = createCaller(humansRouter, {
      repos: buildRepos({ accepted: false }),
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.getMyProfile();

    expect(result).toHaveProperty("chargebackTermsVersion", null);
    expect(result).toHaveProperty("chargebackTermsAcceptedAt", null);
  });
});
