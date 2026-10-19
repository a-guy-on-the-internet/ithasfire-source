import { describe, expect, it } from "vitest";

import { appRouter } from "../../router";

describe("entity-pages router (profile procedures)", () => {
  it("exposes profile procedures under entityPages.*", () => {
    const procedures = appRouter._def.procedures;

    expect(procedures).toHaveProperty("entityPages.getMyProfile");
    expect(procedures).toHaveProperty("entityPages.requestAvatarUpload");
    expect(procedures).toHaveProperty("entityPages.setAvatarFromUpload");
  });
});
