import { describe, expect, it, vi } from "vitest";

import { setThemePreference } from "../set-theme-preference";
import type { SetThemePreferenceDeps } from "../set-theme-preference";
import type { Repos } from "@th/ports/repos";
import type { HumansRepo } from "@th/ports/repos/humans";

const BASE_HUMAN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ada",
  status: "ACTIVE" as const,
  roles: ["USER"],
  locale: null,
  themeMode: null,
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

function makeDeps(humansImpl: Partial<HumansRepo>): SetThemePreferenceDeps {
  const humans = {
    getById: vi.fn(),
    setThemeMode: vi.fn(async () => undefined),
    ...humansImpl,
  } as unknown as HumansRepo;

  const repos: Repos = {
    humans,
    tx: async () => {
      throw new Error("unexpected tx call");
    },
  } as unknown as Repos;

  return { repos };
}

describe("setThemePreference", () => {
  it("persists the dark mode preference for the acting user", async () => {
    const setThemeMode = vi.fn(async () => undefined);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      setThemeMode,
    });

    const result = await setThemePreference(deps, {
      actingUserId: BASE_HUMAN.id,
      mode: "dark",
    });

    expect(result).toEqual({ mode: "dark" });
    expect(setThemeMode).toHaveBeenCalledWith(BASE_HUMAN.id, "dark");
  });

  it("persists the light mode preference for the acting user", async () => {
    const setThemeMode = vi.fn(async () => undefined);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      setThemeMode,
    });

    const result = await setThemePreference(deps, {
      actingUserId: BASE_HUMAN.id,
      mode: "light",
    });

    expect(result).toEqual({ mode: "light" });
    expect(setThemeMode).toHaveBeenCalledWith(BASE_HUMAN.id, "light");
  });

  it("throws not_found when the human does not exist", async () => {
    const setThemeMode = vi.fn(async () => undefined);
    const deps = makeDeps({
      getById: vi.fn(async () => null),
      setThemeMode,
    });

    await expect(
      setThemePreference(deps, {
        actingUserId: BASE_HUMAN.id,
        mode: "dark",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "HUMAN_NOT_FOUND" }));
    expect(setThemeMode).not.toHaveBeenCalled();
  });

  it("throws invalid_input for a missing acting user id", async () => {
    const deps = makeDeps({});

    await expect(
      setThemePreference(deps, { mode: "dark" }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });

  it("throws invalid_input for an unsupported mode", async () => {
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
    });

    await expect(
      setThemePreference(deps, {
        actingUserId: BASE_HUMAN.id,
        mode: "swiss",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });
});
