import { describe, expect, it } from "vitest";

import { shouldShowManageRolesLink } from "../event-volunteering-section.helpers";

describe("shouldShowManageRolesLink", () => {
  it("shows the manage roles link when the event id and slug are available", () => {
    expect(shouldShowManageRolesLink("evt_123", "my-org")).toBe(true);
  });

  it("hides the manage roles link when the event id is missing", () => {
    expect(shouldShowManageRolesLink("", "my-org")).toBe(false);
  });

  it("hides the manage roles link when the slug is missing", () => {
    expect(shouldShowManageRolesLink("evt_123", undefined)).toBe(false);
  });
});
