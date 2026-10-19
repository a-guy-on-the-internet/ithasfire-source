import { describe, expect, it, vi } from "vitest";

// The shell's module pulls the tRPC client; this test reads one pure helper.
vi.mock("@/trpc", () => ({ trpc: {} }));

import { moderateContentMaxWidth } from "../ModerateShell";

/**
 * The /moderate band is 960px, except on the place page editor, which takes
 * the full width like the owner's editor under /admin.
 */
describe("moderateContentMaxWidth", () => {
  it("lifts the cap on the place page editor", () => {
    expect(
      moderateContentMaxWidth(
        "/moderate/places/0b5c8f3e-1d2a-4c6b-9e7f-1a2b3c4d5e6f/page",
      ),
    ).toBeUndefined();
    expect(moderateContentMaxWidth("/moderate/places/abc/page/")).toBeUndefined();
  });

  it("keeps 960px on every other /moderate page", () => {
    for (const path of [
      "/moderate",
      "/moderate/suggestions",
      "/moderate/images",
      "/moderate/applications",
      "/moderate/listings/abc",
      "/moderate/places/abc",
      "/moderate/places/abc/page/extra",
    ]) {
      expect(moderateContentMaxWidth(path)).toBe(960);
    }
    expect(moderateContentMaxWidth(null)).toBe(960);
  });
});
