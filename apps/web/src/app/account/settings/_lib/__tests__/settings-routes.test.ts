// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSectionSlug,
  resolveLegacyHashTarget,
  sectionForHash,
  sectionFromPathname,
  SETTINGS_BASE_PATH,
  SETTINGS_SECTION_SLUGS,
  settingsSectionHref,
} from "../settings-routes";

describe("isSettingsSectionSlug", () => {
  it("accepts every registered slug", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      expect(isSettingsSectionSlug(slug)).toBe(true);
    }
  });

  it("rejects anything else, including nullish and path-ish values", () => {
    for (const value of [
      "",
      "nope",
      "Profile",
      "profile/",
      "../admin",
      "__proto__",
      "constructor",
      undefined,
      null,
    ]) {
      expect(isSettingsSectionSlug(value)).toBe(false);
    }
  });
});

describe("settingsSectionHref", () => {
  it("is always a child of the settings base path", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      expect(settingsSectionHref(slug)).toBe(`${SETTINGS_BASE_PATH}/${slug}`);
    }
  });

  it("defaults to profile", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("profile");
    expect(isSettingsSectionSlug(DEFAULT_SETTINGS_SECTION)).toBe(true);
  });
});

describe("sectionForHash", () => {
  it.each([
    ["#email", "email"],
    ["email", "email"],
    ["#notifications", "notifications"],
    ["#profile", "profile"],
    // Old camelCase rail ids from the single-scroll page.
    ["#rolesCraft", "roles"],
    ["#bookingDefaults", "booking-defaults"],
    ["#bookingRequests", "booking-requests"],
    ["#venueClaims", "venues"],
    ["#suggestions", "contributions"],
    // The phone card moved under Security.
    ["#phone-number-section", "security"],
  ])("maps %s to %s", (hash, expected) => {
    expect(sectionForHash(hash)).toBe(expected);
  });

  it("returns null for an unknown or empty hash", () => {
    expect(sectionForHash("#whatever")).toBeNull();
    expect(sectionForHash("#")).toBeNull();
    expect(sectionForHash("")).toBeNull();
    expect(sectionForHash(null)).toBeNull();
    expect(sectionForHash(undefined)).toBeNull();
  });
});

describe("resolveLegacyHashTarget", () => {
  it("carries the query string through so ?redirect_url survives", () => {
    expect(
      resolveLegacyHashTarget("#email", "?redirect_url=%2Fadmin%2Facme"),
    ).toBe("/account/settings/email?redirect_url=%2Fadmin%2Facme");
  });

  it("drops a fragment that would dangle on the destination route", () => {
    expect(resolveLegacyHashTarget("#email", "")).toBe(
      "/account/settings/email",
    );
  });

  it("keeps the phone anchor, which still resolves on Security", () => {
    expect(resolveLegacyHashTarget("#phone-number-section", "")).toBe(
      "/account/settings/security#phone-number-section",
    );
  });

  it("returns null for an unmapped hash so the index simply stays put", () => {
    expect(resolveLegacyHashTarget("#nope", "")).toBeNull();
    expect(resolveLegacyHashTarget(null, null)).toBeNull();
  });
});

describe("sectionFromPathname", () => {
  it("maps the bare base path to the default section in mobile INDEX view", () => {
    expect(sectionFromPathname(SETTINGS_BASE_PATH)).toEqual({
      section: DEFAULT_SETTINGS_SECTION,
      isIndex: true,
    });
  });

  it("maps every section route to that section in DETAIL view", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      expect(sectionFromPathname(settingsSectionHref(slug))).toEqual({
        section: slug,
        isIndex: false,
      });
    }
  });

  it("returns null for anything outside the settings tree so Next owns it", () => {
    for (const pathname of [
      "/",
      "/account",
      "/account/notifications",
      // A nested or unknown segment is not a section route.
      "/account/settings/email/extra",
      "/account/settings/nope",
      "/account/settings/",
      // A different route that merely shares the prefix as a string.
      "/account/settings-other",
    ]) {
      expect(sectionFromPathname(pathname)).toBeNull();
    }
  });
});
