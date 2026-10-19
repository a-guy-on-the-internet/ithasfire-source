// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORG_SETTINGS_SECTION,
  isOrgSettingsDynamicSlug,
  isOrgSettingsSectionSlug,
  ORG_SETTINGS_LEGACY_REDIRECTS,
  ORG_SETTINGS_SECTION_SLUGS,
  ORG_SETTINGS_STANDALONE_SLUGS,
  orgSettingsBasePath,
  orgSettingsLegacyRedirect,
  orgSettingsSectionHref,
} from "../org-settings-routes";

describe("isOrgSettingsSectionSlug", () => {
  it("accepts every registered slug", () => {
    for (const slug of ORG_SETTINGS_SECTION_SLUGS) {
      expect(isOrgSettingsSectionSlug(slug)).toBe(true);
    }
  });

  it("rejects anything else, including nullish and path-ish values", () => {
    for (const value of [
      "",
      "nope",
      "General",
      "general/",
      "../events",
      "__proto__",
      "constructor",
      undefined,
      null,
    ]) {
      expect(isOrgSettingsSectionSlug(value)).toBe(false);
    }
  });
});

describe("isOrgSettingsDynamicSlug", () => {
  it("accepts every slug the [section] route renders", () => {
    for (const slug of ORG_SETTINGS_SECTION_SLUGS) {
      const isStandalone = (
        ORG_SETTINGS_STANDALONE_SLUGS as readonly string[]
      ).includes(slug);
      expect(isOrgSettingsDynamicSlug(slug)).toBe(!isStandalone);
    }
  });

  it("renders default-agreement: the page is not behind the resale gate", () => {
    // Its default deal is for every group; only the resale parts inside the
    // page are gated (organiser-resale-share C2), so it rides `[section]`.
    expect(isOrgSettingsSectionSlug("default-agreement")).toBe(true);
    expect(isOrgSettingsDynamicSlug("default-agreement")).toBe(true);
  });
});

describe("orgSettingsLegacyRedirect", () => {
  it("sends the retired booking-requests section to the Bookings workspace", () => {
    // The org's received-as-act inbox moved OUT of settings: it is a daily work
    // queue, not configuration. The old URL must land on the inbox's real home,
    // not on the settings index.
    expect(orgSettingsLegacyRedirect("booking-requests", "acme")).toBe(
      "/admin/acme/bookings",
    );
    expect(orgSettingsLegacyRedirect("booking-requests", "@self")).toBe(
      "/admin/@self/bookings",
    );
  });

  it("sends the retired resale-policy section to the Default agreement", () => {
    // "Resale policy" was renamed (organiser-resale-share FR-012, owner R19).
    expect(orgSettingsLegacyRedirect("resale-policy", "acme")).toBe(
      "/admin/acme/settings/default-agreement",
    );
    expect(isOrgSettingsSectionSlug("resale-policy")).toBe(false);
    expect(isOrgSettingsDynamicSlug("resale-policy")).toBe(false);
  });

  it("does not answer for `booking-requests` as a SECTION any more", () => {
    // Belt and braces: if someone re-adds the slug to the union, the redirect
    // and the section route would both claim the URL. They must not coexist.
    expect(isOrgSettingsSectionSlug("booking-requests")).toBe(false);
    expect(isOrgSettingsDynamicSlug("booking-requests")).toBe(false);
  });

  it("has no entry for an unknown slug, so it still falls through to the index", () => {
    // FR-005's other half: the unknown-slug contract
    // (`redirect(/admin/[slug]/settings)`) is unchanged. A `null` here is what
    // hands the request to that fallback.
    for (const value of [
      "",
      "nope",
      "anything",
      "Booking-Requests",
      "booking-requests/",
      undefined,
      null,
    ]) {
      expect(orgSettingsLegacyRedirect(value, "acme")).toBeNull();
    }
  });

  it("cannot be walked into Object.prototype by a raw URL segment", () => {
    // The section comes straight off the URL. A plain object map would return
    // `Object` for "constructor" and hand back a callable; a Map cannot.
    for (const value of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(orgSettingsLegacyRedirect(value, "acme")).toBeNull();
    }
  });

  it("never redirects a slug that is still a live section", () => {
    for (const slug of ORG_SETTINGS_SECTION_SLUGS) {
      expect(orgSettingsLegacyRedirect(slug, "acme")).toBeNull();
      expect(ORG_SETTINGS_LEGACY_REDIRECTS.has(slug)).toBe(false);
    }
  });
});

describe("hrefs", () => {
  it("puts every section under the slug's settings base path", () => {
    for (const slug of ORG_SETTINGS_SECTION_SLUGS) {
      expect(orgSettingsSectionHref("acme", slug)).toBe(
        `/admin/acme/settings/${slug}`,
      );
    }
  });

  it("builds the base path from the admin slug", () => {
    expect(orgSettingsBasePath("acme")).toBe("/admin/acme/settings");
    expect(orgSettingsBasePath("@self")).toBe("/admin/@self/settings");
  });

  it("defaults to general", () => {
    expect(DEFAULT_ORG_SETTINGS_SECTION).toBe("general");
    expect(isOrgSettingsSectionSlug(DEFAULT_ORG_SETTINGS_SECTION)).toBe(true);
  });
});
