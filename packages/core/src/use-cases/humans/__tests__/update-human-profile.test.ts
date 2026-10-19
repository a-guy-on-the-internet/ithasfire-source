import { describe, expect, it, vi } from "vitest";

import { updateHumanProfile } from "../update-human-profile";
import type { UpdateHumanProfileDeps } from "../update-human-profile";
import type { Repos } from "@th/ports/repos";
import type { HumansRepo } from "@th/ports/repos/humans";

const BASE_HUMAN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ada",
  status: "ACTIVE" as const,
  roles: ["USER"],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

function makeDeps(humansImpl: Partial<HumansRepo>): UpdateHumanProfileDeps {
  const humans = {
    getById: vi.fn(),
    getByIdWithIdentity: vi.fn(),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),
    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    batchLookupHumanIdsByEmail: vi.fn(),
    searchByQuery: vi.fn(),
    getHumanTrustStats: vi.fn(),
    ...humansImpl,
  } as unknown as HumansRepo;

  const repos: Repos = {
    humans,
    audit: {} as any,
    tx: async () => {
      throw new Error("unexpected tx call");
    },
  } as unknown as Repos;

  return { repos };
}

describe("updateHumanProfile", () => {
  it("saves phone number to the human record", async () => {
    const updateFn = vi.fn(async () => ({
      ...BASE_HUMAN,
      phone: "+15551234567",
    }));
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      update: updateFn,
    });

    const result = await updateHumanProfile(deps, {
      actorHumanId: BASE_HUMAN.id,
      phone: "+15551234567",
    });

    expect(result).toEqual({ success: true });
    expect(updateFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      phone: "+15551234567",
    });
  });

  it("saves billing address to the human record", async () => {
    const updateFn = vi.fn(async () => BASE_HUMAN);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      update: updateFn,
    });

    const result = await updateHumanProfile(deps, {
      actorHumanId: BASE_HUMAN.id,
      billingAddress: {
        line1: "123 Main St",
        line2: "Apt 4B",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      },
    });

    expect(result).toEqual({ success: true });
    expect(updateFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      billingAddressLine1: "123 Main St",
      billingAddressLine2: "Apt 4B",
      billingCity: "San Francisco",
      billingState: "CA",
      billingPostalCode: "94103",
      billingCountry: "US",
    });
  });

  it("saves phone and billing address together", async () => {
    const updateFn = vi.fn(async () => BASE_HUMAN);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      update: updateFn,
    });

    const result = await updateHumanProfile(deps, {
      actorHumanId: BASE_HUMAN.id,
      phone: "+15551234567",
      billingAddress: {
        line1: "456 Oak Ave",
        city: "Austin",
        state: "TX",
        postalCode: "73301",
        country: "US",
      },
    });

    expect(result).toEqual({ success: true });
    expect(updateFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      phone: "+15551234567",
      billingAddressLine1: "456 Oak Ave",
      billingAddressLine2: null,
      billingCity: "Austin",
      billingState: "TX",
      billingPostalCode: "73301",
      billingCountry: "US",
    });
  });

  it("throws not_found when human does not exist", async () => {
    const deps = makeDeps({
      getById: vi.fn(async () => null),
    });

    await expect(
      updateHumanProfile(deps, {
        actorHumanId: BASE_HUMAN.id,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "HUMAN_NOT_FOUND" }));
  });

  it("throws invalid_input for missing actorHumanId", async () => {
    const deps = makeDeps({});

    await expect(updateHumanProfile(deps, {})).rejects.toEqual(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("clears phone when empty string is passed", async () => {
    const updateFn = vi.fn(async () => BASE_HUMAN);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      update: updateFn,
    });

    await updateHumanProfile(deps, {
      actorHumanId: BASE_HUMAN.id,
      phone: "",
    });

    expect(updateFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      phone: null,
    });
  });
});
