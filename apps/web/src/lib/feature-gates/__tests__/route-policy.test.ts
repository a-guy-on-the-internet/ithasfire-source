import { describe, expect, it } from "vitest";

import { isMaintenanceExemptPath } from "../route-policy";

describe("isMaintenanceExemptPath", () => {
  it("keeps prior maintenance exemptions for legal and contact pages", () => {
    expect(isMaintenanceExemptPath("/about")).toBe(true);
    expect(isMaintenanceExemptPath("/contact")).toBe(true);
    expect(isMaintenanceExemptPath("/events/abc")).toBe(false);
  });

  it("allows auth pages during maintenance", () => {
    expect(isMaintenanceExemptPath("/sign-in")).toBe(true);
    expect(isMaintenanceExemptPath("/forgot-password")).toBe(true);
    expect(isMaintenanceExemptPath("/reset-password")).toBe(true);
  });

  it("matches prefixes by segment: the base and descendants, not siblings", () => {
    expect(isMaintenanceExemptPath("/admin")).toBe(true);
    expect(isMaintenanceExemptPath("/admin/org/dashboard")).toBe(true);
    expect(isMaintenanceExemptPath("/administrators")).toBe(false);
  });
});
