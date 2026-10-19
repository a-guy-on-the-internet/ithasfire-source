import { describe, expect, it, vi } from "vitest";

// The nav model builds React elements (icons) but this suite never renders
// them — it asserts the DATA: which groups exist, which items are in them, and
// which sections a member may open. The icon module is stubbed so the import is
// cheap and the assertions stay about routing, not rendering.
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    AlertTriangle: Icon,
    Building2: Icon,
    CalendarCheck: Icon,
    Globe: Icon,
    Mail: Icon,
    Mic: Icon,
    Tag: Icon,
    Tags: Icon,
  };
});

import {
  buildOrgSettingsGroups,
  type OrgSettingsNavInput,
} from "../org-settings-sections";
import {
  DEFAULT_ORG_SETTINGS_SECTION,
  ORG_SETTINGS_SECTION_SLUGS,
  type OrgSettingsSectionSlug,
} from "../org-settings-routes";

/** Echoes the key back, so assertions name the i18n key, not a translation. */
const t = (key: string) => key;

const input = (
  overrides: Partial<OrgSettingsNavInput> = {},
): OrgSettingsNavInput => ({
  slug: "acme",
  canEdit: true,
  isOwner: true,
  ...overrides,
});

const build = (overrides: Partial<OrgSettingsNavInput> = {}) =>
  buildOrgSettingsGroups(input(overrides), { t });

const groupIds = (overrides: Partial<OrgSettingsNavInput> = {}) =>
  build(overrides).groups.map((g) => g.id);

const itemIds = (groupId: string, overrides: Partial<OrgSettingsNavInput> = {}) =>
  build(overrides)
    .groups.find((g) => g.id === groupId)
    ?.items.map((i) => i.id) ?? null;

describe("buildOrgSettingsGroups — Organization group", () => {
  it("is always present, in slot order", () => {
    expect(itemIds("organization")).toEqual(["general", "contact", "page"]);
  });

  it("survives a read-only member", () => {
    expect(itemIds("organization", { canEdit: false, isOwner: false })).toEqual(
      ["general", "contact", "page"],
    );
  });

  it("routes every item at its own URL under the slug", () => {
    const org = build().groups.find((g) => g.id === "organization")!;
    expect(org.items.map((i) => i.href)).toEqual([
      "/admin/acme/settings/general",
      "/admin/acme/settings/contact",
      "/admin/acme/settings/page",
    ]);
  });

  it("carries the slug into every href, including a human-style slug", () => {
    const hrefs = build({ slug: "@self" }).groups.flatMap((g) =>
      g.items.map((i) => i.href),
    );
    for (const href of hrefs) {
      expect(href.startsWith("/admin/@self/settings/")).toBe(true);
    }
  });
});

describe("buildOrgSettingsGroups — Getting booked group", () => {
  it("lists performer and defaults for an editor — configuration only", () => {
    expect(itemIds("booking")).toEqual([
      "performer",
      "booking-defaults",
      "booking-tags",
    ]);
  });

  it("keeps ORG booking config here — it never moves to account settings", () => {
    // The hard product rule, from the other direction: account settings shows a
    // human's own performer tools, and this page owns the GROUP's.
    const { entitled } = build();
    expect(entitled.has("performer")).toBe(true);
    expect(entitled.has("booking-defaults")).toBe(true);
    expect(entitled.has("booking-tags")).toBe(true);
  });

  it("shows a read-only member the performer row only", () => {
    // Booking defaults is an edit surface; it never rendered for a VIEWER, so
    // it never lists for one either.
    expect(itemIds("booking", { canEdit: false, isOwner: false })).toEqual([
      "performer",
    ]);

    const { entitled } = build({ canEdit: false, isOwner: false });
    expect(entitled.has("performer")).toBe(true);
    expect(entitled.has("booking-defaults")).toBe(false);
    expect(entitled.has("booking-tags")).toBe(false);
  });
});

describe("buildOrgSettingsGroups — the inbox is NOT a settings section", () => {
  // A POSITIVE pin, not the absence of an old assertion. The org's
  // received-as-act booking inbox is a daily work queue and lives at
  // /admin/[slug]/bookings; settings holds configuration. The spec calls
  // "someone cites the hard-product-rule comment and migrates it back" a named
  // risk, so this test is the tripwire for that specific drift.
  it("never lists or entitles `booking-requests`, at any permission level", () => {
    for (const canEdit of [true, false]) {
      for (const isOwner of [true, false]) {
        const built = build({ canEdit, isOwner });
        const listed = [
          ...built.groups.flatMap((g) => g.items),
          ...built.footerItems,
        ];

        expect(listed.map((i) => i.id)).not.toContain("booking-requests");
        expect(listed.map((i) => i.href)).not.toContain(
          "/admin/acme/settings/booking-requests",
        );
        expect(
          // Cast: the slug is deliberately no longer in the union, and that
          // is the point of the assertion.
          built.entitled.has("booking-requests" as OrgSettingsSectionSlug),
        ).toBe(false);
      }
    }
  });

  it("is not a legal settings slug at all", () => {
    expect(
      (ORG_SETTINGS_SECTION_SLUGS as readonly string[]).includes(
        "booking-requests",
      ),
    ).toBe(false);
  });
});

describe("buildOrgSettingsGroups — Policies group (Default agreement)", () => {
  it("lists the Default agreement for an editor, with no resale gate", () => {
    // The page holds the group's default deal too; only its resale parts are
    // gated, inside the page (organiser-resale-share C2).
    expect(groupIds({})).toEqual(["organization", "booking", "policies"]);
    expect(itemIds("policies", {})).toEqual(["default-agreement"]);
    expect(build({}).entitled.has("default-agreement")).toBe(true);
  });

  it("hides it from a read-only member entirely", () => {
    expect(groupIds({ canEdit: false, isOwner: false })).toEqual(
      ["organization", "booking"],
    );
    expect(
      build({ canEdit: false, isOwner: false }).entitled.has("default-agreement"),
    ).toBe(false);
  });

  it("is reachable at all — it was an orphaned route with no nav entry", () => {
    const item = build({})
      .groups.find((g) => g.id === "policies")!
      .items[0]!;
    expect(item.href).toBe("/admin/acme/settings/default-agreement");
    expect(item.label).toBe("admin.settingsDefaultAgreement");
  });
});

describe("buildOrgSettingsGroups — the index's default section", () => {
  // `/admin/[slug]/settings` renders DEFAULT_ORG_SETTINGS_SECTION's content on
  // desktop AND passes it as `activeId`, so the rail marks it current —
  // matching `/account/settings`, which does the same with Profile. An earlier
  // pass made the index pass an empty `activeId`; driving the page showed the
  // General panel on screen with nothing marked in the rail, which reads as
  // "nothing is selected" while something plainly is. Reverted.
  //
  // That only holds up if the default is a row EVERY member actually sees. If
  // someone repoints the default at an entitlement-gated section, a read-only
  // member would land on an index highlighting a row that isn't in their nav —
  // or worse, get bounced by the entitlement redirect on the bare URL.
  it("is a row every member sees, at every permission level", () => {
    for (const canEdit of [true, false]) {
      for (const isOwner of [true, false]) {
        const built = build({ canEdit, isOwner });
        const listed = built.groups.flatMap((g) => g.items).map((i) => i.id);

        expect(listed).toContain(DEFAULT_ORG_SETTINGS_SECTION);
        expect(built.entitled.has(DEFAULT_ORG_SETTINGS_SECTION)).toBe(true);
      }
    }
  });

  it("is never the danger footer or a gated section", () => {
    const built = build({ canEdit: false, isOwner: false });
    expect(built.footerItems.some((i) => i.id === DEFAULT_ORG_SETTINGS_SECTION)).toBe(
      false,
    );
    expect(DEFAULT_ORG_SETTINGS_SECTION).toBe("general");
  });
});

describe("buildOrgSettingsGroups — danger footer", () => {
  it("pins exactly one danger-toned item outside every group, for the owner", () => {
    const { groups, footerItems, entitled } = build({ isOwner: true });

    expect(footerItems).toHaveLength(1);
    expect(footerItems[0]).toMatchObject({
      id: "danger",
      href: "/admin/acme/settings/danger",
      tone: "danger",
      // NOT `admin.deleteOrgButton` — the danger route's own trigger button
      // already carries that exact phrase, and a rail LINK repeating it makes a
      // screen reader announce "Delete group" twice on one page. Nav items name
      // destinations; buttons name actions.
      label: "admin.settingsDanger",
    });
    expect(footerItems[0]!.label).not.toBe("admin.deleteOrgButton");
    expect(entitled.has("danger")).toBe(true);
    for (const group of groups) {
      expect(group.items.some((i) => i.id === "danger")).toBe(false);
    }
  });

  it("is absent, and unreachable, for a non-owner admin", () => {
    // An ADMIN can still edit everything else; deleting the group is OWNER
    // only. Previously a non-owner landing on /settings/danger silently
    // rendered General while the URL kept saying "danger".
    const built = build({ canEdit: true, isOwner: false });
    expect(built.footerItems).toEqual([]);
    expect(built.entitled.has("danger")).toBe(false);
  });
});

describe("buildOrgSettingsGroups — entitlement ↔ nav agreement", () => {
  it("never lists a row the member is not entitled to open", () => {
    for (const canEdit of [true, false]) {
      for (const isOwner of [true, false]) {
        const built = build({ canEdit, isOwner });
        const listed: OrgSettingsSectionSlug[] = [
          ...built.groups.flatMap((g) => g.items),
          ...built.footerItems,
        ].map((i) => i.id as OrgSettingsSectionSlug);

        for (const id of listed) {
          expect(built.entitled.has(id)).toBe(true);
        }
      }
    }
  });
});
