import { describe, expect, it } from "vitest";

import { filterSections } from "@th/ui";
import { ORG_FINANCE_ROLES, type OrgRole } from "@th/types";

import {
  ADMIN_SECTIONS,
  ORG_ONLY_ADMIN_ROUTE_IDS,
  withoutOrgOnlyItems,
} from "../admin-nav-sections";

/**
 * One-bottom-bar redesign: the mobile bottom bar flattens sections in order
 * and surfaces the first `maxItems - 1` visible items (skipping `disabled` /
 * `hideInBottomBar`, mirroring NavigationBottomBar's loop) plus More. These
 * pins keep the approved bar — Events · Orders · [SCAN] · Promos · More —
 * from silently regressing when someone reorders or adds a nav item.
 *
 * The dashboard deliberately left the nav (the rail identity block, and the
 * drawer's account header on mobile, are the one way home), so it is no
 * longer a bottom-bar tab either.
 */
const flattenForBottomBar = () =>
  ADMIN_SECTIONS.flatMap((section) =>
    section.items.filter((item) => !item.disabled && !item.hideInBottomBar),
  );

describe("ADMIN_SECTIONS mobile bottom bar shape", () => {
  it("flattens to Events / Orders / Promos in the three tab slots", () => {
    expect(flattenForBottomBar()
      .slice(0, 3)
      .map((item) => item.id)).toEqual(["events", "orders", "promos"]);
  });

  // The old invariant was "sections[0].items[0].route === 'dashboard'", which
  // AdminShell used as its fallback route id. That coupling is gone: the
  // fallback is now the explicit ADMIN_DASHBOARD_ROUTE constant, and the
  // dashboard must NOT reappear in the nav or it re-creates two links to the
  // same href inside one navigation landmark.
  it("does not list the dashboard as a nav item", () => {
    const routes = ADMIN_SECTIONS.flatMap((section) =>
      section.items.map((item) => item.route),
    );
    expect(routes).not.toContain("dashboard");
  });

  it.each([
    // Search lives in the navbar search slot on mobile.
    "search",
    // Places and Bookings yield their flatten-order slots so Orders is the
    // third tab; both remain in the rail and the More drawer.
    "places",
    "bookings",
    // Scan's mobile affordance is the raised center square — a scan TAB would
    // double up for SCANNER-role members.
    "scan",
  ])("hides %s from the bottom bar (rail/drawer keep it)", (id) => {
    const item = ADMIN_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === id,
    );
    expect(item, `nav item ${id} missing`).toBeDefined();
    expect(item!.hideInBottomBar).toBe(true);
  });
});

describe("Payouts in the bottom bar (owner ruling 2026-10-05)", () => {
  it("is a bar item, taking the slot Payments had", () => {
    const ids = flattenForBottomBar().map((item) => item.id);
    expect(ids).toContain("payouts");
    expect(ids).not.toContain("payments");
  });

  it("is the third tab when the promos flag is off", () => {
    const ids = flattenForBottomBar()
      .filter((item) => item.featureFlag !== "promos")
      .map((item) => item.id);
    expect(ids.slice(0, 3)).toEqual(["events", "orders", "payouts"]);
  });
});

describe("Payouts nav item (Payments merged in, 2026-10-05)", () => {
  const allItems = ADMIN_SECTIONS.flatMap((section) => section.items);
  const payouts = allItems.find((item) => item.id === "payouts")!;

  it("Payments is gone from the rail — `/payments` only redirects", () => {
    expect(allItems.map((item) => item.id)).not.toContain("payments");
    expect(allItems.map((item) => item.route)).not.toContain("payments");
  });

  it("Payouts has four anchor children in page order, Balance first", () => {
    expect(payouts.route).toBe("payouts");
    expect(
      payouts.children?.map((child) => [child.id, child.label, child.route]),
    ).toEqual([
      ["payouts-balance", "admin.payoutsSectionBalance", "payouts#balance"],
      ["payouts-ledger", "admin.payoutsLedgerHeading", "payouts#ledger"],
      ["payouts-schedule", "admin.payoutsSectionSchedule", "payouts#schedule"],
      ["payouts-stripe", "admin.payoutsSectionStripe", "payouts#stripe"],
    ]);
  });

  it("children carry icons (the 72px rail lists them flat) and no static `active`", () => {
    for (const child of payouts.children ?? []) {
      expect(child.icon, child.id).toBeTruthy();
      // AdminShell controls `active` from the page's scroll-spy.
      expect(child.active, child.id).toBeUndefined();
    }
  });
});

describe("Payouts nav gating (2026-10-06: VIEWER was refused every read on the page)", () => {
  const visibleIds = (role: OrgRole) =>
    filterSections(ADMIN_SECTIONS, [role]).flatMap((section) =>
      section.items.map((item) => item.id),
    );
  const payoutsFor = (role: OrgRole) =>
    filterSections(ADMIN_SECTIONS, [role])
      .flatMap((section) => section.items)
      .find((item) => item.id === "payouts");

  it.each(["OWNER", "ADMIN", "FINANCE"] as const)(
    "%s sees Payouts with its four children",
    (role) => {
      expect(payoutsFor(role)?.children).toHaveLength(4);
    },
  );

  it.each(["VIEWER", "EDITOR", "SCANNER"] as const)(
    "%s has no Payouts entry, so no children and no bottom-bar tab",
    (role) => {
      expect(visibleIds(role)).not.toContain("payouts");
    },
  );

  it("is exactly the roles that can read Balance and Ledger (canFinanceOrg)", () => {
    const payouts = ADMIN_SECTIONS.flatMap((s) => s.items).find(
      (item) => item.id === "payouts",
    )!;
    expect([...(payouts.rbac ?? [])].sort()).toEqual([...ORG_FINANCE_ROLES].sort());
  });

  it("VIEWER keeps the other finance-view pages (promos, memberships)", () => {
    const ids = visibleIds("VIEWER");
    expect(ids).toContain("memberships");
  });
});

describe("withoutOrgOnlyItems", () => {
  const item = (route: string) => ({ id: route, label: route, route });

  it("drops org-only items and keeps the rest in order", () => {
    const out = withoutOrgOnlyItems([
      {
        id: "a",
        label: "A",
        items: [item("volunteers"), item("volunteer-templates"), item("team")],
      },
    ]);
    expect(out[0]?.items.map((i) => i.route)).toEqual(["volunteers", "team"]);
  });

  it("drops a section left empty", () => {
    const out = withoutOrgOnlyItems([
      { id: "a", label: "A", items: [item("volunteer-templates")] },
      { id: "b", label: "B", items: [item("orders")] },
    ]);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });

  it("does not mutate its input", () => {
    const input = [
      { id: "a", label: "A", items: [item("volunteer-templates")] },
    ];
    withoutOrgOnlyItems(input);
    expect(input[0]?.items).toHaveLength(1);
  });

  it("hides Volunteer Roles from the real nav and nothing else of Volunteers", () => {
    expect(ORG_ONLY_ADMIN_ROUTE_IDS.has("volunteer-templates")).toBe(true);
    const routes = withoutOrgOnlyItems(ADMIN_SECTIONS).flatMap((s) =>
      s.items.map((i) => i.route),
    );
    expect(routes).not.toContain("volunteer-templates");
    expect(routes).toContain("volunteers");
  });
});
