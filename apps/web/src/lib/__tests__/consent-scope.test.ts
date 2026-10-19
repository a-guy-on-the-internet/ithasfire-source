/**
 * consent-scope — what, if anything, the cookie banner may ask for.
 *
 * The site ships bannerless: error capture rides legitimate interest and stores
 * nothing on the device, and Plausible is cookieless, so neither needs consent.
 * Session replay, the one thing that did, was removed. That leaves GA as the
 * only switch that can bring the banner back.
 *
 * This is the assertion the bannerless claim rests on — if something starts
 * storing per-device state without also being declared here, the banner will
 * not appear and we will be collecting without asking.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// `vi.mock` is hoisted above module-level consts, so the shared handle has to
// be created with `vi.hoisted` or the factory closes over a TDZ binding.
const mockEnv = vi.hoisted(() => ({
  gaMeasurementId: null as string | null,
}));
vi.mock("@/config/env.public", () => ({
  publicRuntimeEnv: mockEnv,
}));

import { hasOptionalStorage, optionalStorageKeys } from "@/lib/consent-scope";

beforeEach(() => {
  mockEnv.gaMeasurementId = null;
});

describe("consent scope", () => {
  it("asks for nothing when only Sentry and Plausible are active", () => {
    expect(optionalStorageKeys()).toEqual([]);
    expect(hasOptionalStorage()).toBe(false);
  });

  it("asks for analytics once a GA measurement id is configured", () => {
    mockEnv.gaMeasurementId = "G-TEST12345";

    expect(optionalStorageKeys()).toEqual(["common.cookieOptionalAnalytics"]);
    expect(hasOptionalStorage()).toBe(true);
  });

  it("names only keys the banner can translate", () => {
    mockEnv.gaMeasurementId = "G-TEST12345";

    for (const key of optionalStorageKeys()) {
      expect(key).toMatch(/^common\.cookieOptional[A-Z]/);
    }
  });
});
