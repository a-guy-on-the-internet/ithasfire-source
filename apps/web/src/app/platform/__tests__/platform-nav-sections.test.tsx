import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";

import { describe, expect, it } from "vitest";

import { PLATFORM_SECTIONS } from "../_components/platform-nav-sections";
import enMessages from "../../../i18n/messages/en";
import esMessages from "../../../i18n/messages/es";
// Deep import rather than the `@th/ui` barrel: the barrel drags the whole
// Tamagui component graph into a jsdom unit test for one pure function.
import { filterSections } from "../../../../../../packages/ui/src/ui/shell/NavigationShell.hooks";
import { namespaceNavSections } from "../../../../../../packages/ui/src/ui/shell/utils/route-namespacing";

import type { StaffRole } from "@th/types";

/**
 * Guards the four-group platform rail (Queues / Records / Catalog & pricing /
 * Operations). Modelled on
 * `admin/[slug]/_components/__tests__/admin-nav-sections.test.tsx`.
 *
 * The reason this file exists at all: `/platform/claims` shipped as a fully
 * built review page with NO nav entry, so staff reached it by typing the URL.
 * Nothing was red. The route-coverage test below closes that class of hole in
 * both directions.
 */

const PLATFORM_APP_DIR = join(__dirname, "..");
/** `apps/web/src/app` — the root the cross-area routes below resolve against. */
const APP_DIR = join(__dirname, "..", "..");

/**
 * `overview` is the ONE route directory deliberately absent from the nav. It
 * is the rail identity block's target (`PLATFORM_OVERVIEW_ROUTE` in
 * PlatformShell), and listing it here too would put two links to the same href
 * inside one `role="navigation"`. Stated as an explicit exclusion so it reads
 * as a decision rather than as a gap the test forgot to cover.
 */
const ROUTES_INTENTIONALLY_NOT_IN_NAV = new Set(["overview"]);

/** Colocation folders, not routes. */
const NON_ROUTE_DIRS = new Set(["_components", "__tests__"]);

const allItems = () => PLATFORM_SECTIONS.flatMap((section) => section.items);

/**
 * CARVE-OUT (a decision, not a skip): a `route` written as an app-ABSOLUTE
 * path is a CROSS-AREA destination — today the `/moderate/**` review queues,
 * which live outside `/platform`, render their own shell and are gated by
 * `checkModeratorAccess` rather than `checkStaffAccess`. There is no
 * `app/platform/moderate/` directory and there must never be one, so those
 * routes cannot satisfy the `/platform/<route>/page.tsx` check below.
 *
 * They are NOT unchecked. They get their own assertion resolving each one to a
 * real `page.tsx` under `apps/web/src/app/`, so a typo'd cross-area route still
 * fails — the carve-out narrows WHERE the file is looked for, not WHETHER.
 */
const isCrossAreaRoute = (route: string) => route.startsWith("/");
const crossAreaRoutes = () =>
  allItems()
    .map((i) => i.route)
    .filter(isCrossAreaRoute);
const platformRoutes = () =>
  allItems()
    .map((i) => i.route)
    .filter((route) => !isCrossAreaRoute(route));

/**
 * Mirrors NavigationBottomBar's own flatten loop: sections in declaration
 * order, skipping `disabled` / `hideInBottomBar`.
 */
const flattenForBottomBar = (
  sections: typeof PLATFORM_SECTIONS = PLATFORM_SECTIONS,
) =>
  sections.flatMap((section) =>
    section.items.filter((item) => !item.disabled && !item.hideInBottomBar),
  );

const STAFF_ROLES: StaffRole[] = ["ADMIN", "SUPPORT", "DEVELOPER", "REVIEWER"];

/**
 * The RESOLVED rbac set for every item, pinned by id.
 *
 * Preserving these verbatim through the regroup was the whole point of the
 * change: each one is documented in `platform-nav-sections.tsx` against the
 * specific server-side guard it mirrors, and an entry shown to a role the
 * server rejects is a rail item whose every procedure 403s.
 *
 * Pinned as RESOLVED arrays, not as `STAFF_*` preset identifiers, because the
 * two failure modes this has to catch are both invisible to a preset
 * comparison:
 *   1. An item's `rbac` DELETED. `filterSections` treats an absent/empty
 *      constraint as visible-to-everyone (`isRolePermitted`), and the per-role
 *      leak assertion below is guarded on `item.rbac &&` — so a deletion would
 *      pass every other test in this file while handing, say,
 *      SUPPORT/DEVELOPER/REVIEWER the ADMIN-only Memberships screen.
 *   2. A shared preset WIDENED underneath an item that deliberately pinned a
 *      literal set equal to it today (image-moderation says exactly this).
 *
 * Changing an entry here is legitimate — but it must be a decision, made with
 * the guard it mirrors open in the other window.
 */
const EXPECTED_RBAC: Record<string, readonly StaffRole[]> = {
  // queues
  reports: ["ADMIN", "SUPPORT", "DEVELOPER"], // STAFF_CUSTOMER
  "invite-pauses": ["ADMIN", "REVIEWER", "SUPPORT"], // INVITE_PAUSE_VIEW_ROLES
  "image-moderation": ["ADMIN", "DEVELOPER"], // literal; tracks PLATFORM_OPS_ROLES
  reviews: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"], // STAFF_ALL
  claims: ["ADMIN", "SUPPORT"], // nav-visibility choice; no server guard exists
  disputes: ["ADMIN", "SUPPORT"], // DISPUTE_DESK_READ_ROLES
  support: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"], // STAFF_ALL
  "webhook-dlq": ["ADMIN", "DEVELOPER"], // STAFF_TECH
  // records
  orders: ["ADMIN", "SUPPORT", "DEVELOPER"], // STAFF_CUSTOMER
  tickets: ["ADMIN", "SUPPORT", "DEVELOPER"], // STAFF_CUSTOMER
  humans: ["ADMIN", "SUPPORT", "DEVELOPER"], // STAFF_CUSTOMER
  places: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"], // STAFF_ALL
  settlements: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  "cash-debts": ["ADMIN", "SUPPORT"], // PAYEE_DEBT_READ_ROLES
  // catalog & pricing
  fees: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  "fee-waivers": ["ADMIN", "DEVELOPER"], // STAFF_TECH
  promos: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  memberships: ["ADMIN"], // platform.*MembershipStanding* is ADMIN-only
  categories: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"], // STAFF_ALL
  featured: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"], // STAFF_ALL
  "community-listings": ["ADMIN"], // community.listListingsForPlatform is platform-ADMIN-only
  "ticket-packs": ["ADMIN", "DEVELOPER"], // STAFF_TECH
  "volunteer-packs": ["ADMIN", "DEVELOPER"], // STAFF_TECH
  // operations
  jobs: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  quotas: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  features: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  "theme-editor": ["ADMIN", "DEVELOPER"], // STAFF_TECH
  roles: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  "audit-log": ["ADMIN", "REVIEWER"], // listAuditLogs
  settings: ["ADMIN", "DEVELOPER"], // STAFF_TECH
  // cross-area (/moderate/**): `checkModeratorAccess` admits
  // COMMUNITY_MODERATOR or platform ADMIN, so ADMIN is the whole intersection
  // with the staff roles this rail filters on — the other three would reach
  // /access-denied, not a 403 page inside the console.
  "edit-suggestions": ["ADMIN"],
  "moderator-applications": ["ADMIN"],
};

const railFor = (role: StaffRole) =>
  filterSections(PLATFORM_SECTIONS, [role]);

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

describe("PLATFORM_SECTIONS shape", () => {
  it("is the four approved task-kind groups, in order", () => {
    expect(PLATFORM_SECTIONS.map((s) => s.id)).toEqual([
      "queues",
      "records",
      "catalog",
      "operations",
    ]);
  });

  it("sets off Operations with a rule in the wide rail", () => {
    const operations = PLATFORM_SECTIONS.find((s) => s.id === "operations");
    expect(operations?.separatorAbove).toBe(true);
  });

  it("labels the groups with i18n keys", () => {
    expect(PLATFORM_SECTIONS.map((s) => s.label)).toEqual([
      "admin.navGroupQueues",
      "admin.navGroupRecords",
      "admin.navGroupCatalog",
      "admin.navGroupOperations",
    ]);
  });

  it("resolves every label against BOTH app catalogs", () => {
    // PlatformShell calls `t(label)` and a MISSING key renders VERBATIM, so an
    // unbacked key puts raw "admin.navGroupQueues" on screen in whichever
    // locale lacks it. The app catalogs are deep-merged OVER the package ones
    // with app keys winning (`i18n/locale-provider.tsx`), so a key satisfied by
    // either side is fine — this asserts the app side, which is where these
    // were added. en/es parity itself is gated by `catalog-parity.test.ts`.
    const labels = [
      ...PLATFORM_SECTIONS.map((section) => section.label),
      ...allItems().map((item) => item.label),
    ];

    for (const catalog of [enMessages, esMessages]) {
      const missing = labels.filter((label) => {
        const path = label.split(".");
        let node: unknown = catalog;
        for (const part of path) {
          if (typeof node !== "object" || node === null) return true;
          node = (node as Record<string, unknown>)[part];
        }
        return typeof node !== "string";
      });
      expect(missing).toEqual([]);
    }
  });

  it("gives every item a non-empty rbac", () => {
    // An item with no `rbac` is visible to EVERY staff role — `isRolePermitted`
    // returns true on an empty constraint. On this console that is never what
    // anyone means.
    const unguarded = allItems()
      .filter((item) => !item.rbac?.length)
      .map((item) => item.id);
    expect(unguarded).toEqual([]);
  });

  it("pins the exact rbac set of every item", () => {
    const actual = Object.fromEntries(
      allItems().map((item) => [item.id, [...(item.rbac ?? [])]]),
    );
    expect(actual).toEqual(EXPECTED_RBAC);
  });

  it("has unique item ids and routes", () => {
    const ids = allItems().map((i) => i.id);
    const routes = allItems().map((i) => i.route);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route coverage (the /platform/claims regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("PLATFORM_SECTIONS route coverage", () => {
  const routeDirs = readdirSync(PLATFORM_APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !NON_ROUTE_DIRS.has(name))
    .filter((name) => existsSync(join(PLATFORM_APP_DIR, name, "page.tsx")));

  it("finds the platform route directories on disk", () => {
    // Sanity check: an empty scan would make both assertions below vacuous.
    expect(routeDirs.length).toBeGreaterThan(20);
    expect(routeDirs).toContain("claims");
    expect(routeDirs).toContain("overview");
  });

  it("points every nav route at a real /platform/<route>/page.tsx", () => {
    const missing = platformRoutes().filter(
      (route) => !routeDirs.includes(route),
    );
    expect(missing).toEqual([]);
  });

  it("points every CROSS-AREA nav route at a real page.tsx under app/", () => {
    // The other half of the carve-out documented on `isCrossAreaRoute`. Same
    // strength as the platform check: `/moderate/nope` fails here.
    const missing = crossAreaRoutes().filter(
      (route) => !existsSync(join(APP_DIR, route.slice(1), "page.tsx")),
    );
    expect(missing).toEqual([]);
  });

  it("never lets the cross-area carve-out swallow a /platform route", () => {
    // Writing `/platform/foo` instead of `foo` would otherwise route around
    // the directory check above — the exact hole the carve-out must not open.
    const smuggled = crossAreaRoutes().filter((route) =>
      route.startsWith("/platform"),
    );
    expect(smuggled).toEqual([]);
  });

  it("still has cross-area routes to check", () => {
    // Guard against the two assertions above quietly going vacuous if the
    // /moderate entries are ever dropped from the rail. Exact equality, so it
    // also pins the deliberate omission of `/moderate/images`: that is the
    // human review queue and `/platform/image-moderation` is the pipeline ops
    // dashboard — adjacent near-identical rows would invite mis-clicks, and
    // the ops dashboard already links it from its body.
    expect(crossAreaRoutes()).toEqual([
      "/moderate/suggestions",
      "/moderate/applications",
    ]);
  });

  it("lists every platform page in the nav (except the identity target)", () => {
    const navRoutes = new Set(allItems().map((item) => item.route));
    const unreachable = routeDirs.filter(
      (dir) => !navRoutes.has(dir) && !ROUTES_INTENTIONALLY_NOT_IN_NAV.has(dir),
    );
    expect(unreachable).toEqual([]);
  });

  it("renders the href staff actually click, not a re-based one", () => {
    // The rail's anchor is `item.route` AFTER PlatformShell runs it through
    // `namespaceNavSections({ adminBasePath: "/platform" })`. That used to
    // join an absolute route under the base, so `/moderate/suggestions`
    // shipped as an anchor to `/platform/moderate/suggestions` — a 404 no
    // test in this file could see, because the nav constant looked right.
    const { sections } = namespaceNavSections(PLATFORM_SECTIONS, {
      adminBasePath: "/platform",
    });
    const hrefs = new Map(
      sections
        .flatMap((section) => section.items)
        .map((item) => [item.id, item.route]),
    );

    expect(hrefs.get("reports")).toBe("/platform/reports");
    expect(hrefs.get("edit-suggestions")).toBe("/moderate/suggestions");
    expect(hrefs.get("moderator-applications")).toBe("/moderate/applications");
  });

  it("keeps every cross-area route's last segment off the platform namespace", () => {
    // COLLISION THIS PREVENTS — a live latent one, not a hypothetical.
    // `isRouteActive` (packages/ui/src/ui/shell/utils/route-active.ts) matches
    // rule 2 as `itemRoute.endsWith("/" + currentRoute)`, and `currentRoute`
    // inside this console is the BARE id ("orders", "suggestions"). A
    // cross-area route reaches the rail verbatim, so `/moderate/suggestions`
    // already satisfies that rule for `currentRoute === "suggestions"`.
    //
    // The day someone adds `app/platform/suggestions/page.tsx` with
    // `route: "suggestions"`, visiting /platform/suggestions lights BOTH rows
    // at once — the real one and the cross-area Edit suggestions one. The
    // coverage assertions above check that routes EXIST, never that only one
    // is active, so nothing else here would go red.
    //
    // Fixing it in `isRouteActive` is not an option: the admin / seller /
    // event rails all depend on the bare-id-vs-namespaced match. So the
    // constraint is enforced at the nav constant instead — rename the platform
    // route (or the directory) rather than relaxing this.
    const lastSegmentOf = (route: string) => {
      const segments = route.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "";
    };
    // Both the declared nav routes and what is actually on disk: a new
    // colliding page is a collision the moment it exists, whether or not its
    // nav entry landed in the same commit.
    const sameShellIds = new Set([...platformRoutes(), ...routeDirs]);

    const collisions = crossAreaRoutes().filter((route) =>
      sameShellIds.has(lastSegmentOf(route)),
    );
    expect(collisions).toEqual([]);
  });

  it("keeps overview OUT of the nav — the rail identity block is the way home", () => {
    expect(allItems().map((item) => item.route)).not.toContain("overview");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

describe("PLATFORM_SECTIONS icons", () => {
  it("gives every item a distinct icon component", () => {
    // Two items sharing a glyph are indistinguishable in the 72px collapsed
    // rail, which is icon-only. Categories/Promos both used Tag and
    // Tickets/Ticket packs both used Ticket before this regroup.
    const seen = new Map<unknown, string>();
    const collisions: string[] = [];

    for (const item of allItems()) {
      expect(item.icon, `nav item ${item.id} has no icon`).toBeTruthy();
      const type = (item.icon as ReactElement).type;
      const previous = seen.get(type);
      if (previous) {
        collisions.push(`${previous} + ${item.id}`);
      } else {
        seen.set(type, item.id);
      }
    }

    expect(collisions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Role filtering
// ─────────────────────────────────────────────────────────────────────────────

describe("PLATFORM_SECTIONS role filtering", () => {
  it.each(STAFF_ROLES)("gives %s a non-empty rail", (role) => {
    const rail = railFor(role);
    expect(rail.length).toBeGreaterThan(0);
    expect(rail.every((section) => section.items.length > 0)).toBe(true);
  });

  it.each(STAFF_ROLES)("never shows %s an item its rbac excludes", (role) => {
    const leaked = railFor(role)
      .flatMap((section) => section.items)
      .filter((item) => item.rbac && !item.rbac.includes(role))
      .map((item) => item.id);
    expect(leaked).toEqual([]);
  });

  it("drops a section entirely when every item is filtered out", () => {
    // REVIEWER is the narrowest role: Records is STAFF_ALL Places only, and
    // Catalog keeps only the two STAFF_ALL entries, but Operations is nearly
    // all STAFF_TECH.
    const reviewer = railFor("REVIEWER");
    expect(reviewer.map((s) => s.id)).toEqual([
      "queues",
      "records",
      "catalog",
      "operations",
    ]);
    expect(
      reviewer.find((s) => s.id === "operations")?.items.map((i) => i.id),
    ).toEqual(["audit-log"]);

    // And a section really does disappear when nothing survives: a role with
    // no matching rbac anywhere yields no sections at all.
    expect(
      filterSections(PLATFORM_SECTIONS, ["SCANNER"]),
    ).toEqual([]);
  });

  it("shows ADMIN every item", () => {
    const adminRoutes = railFor("ADMIN").flatMap((s) =>
      s.items.map((i) => i.id),
    );
    expect(adminRoutes).toEqual(allItems().map((i) => i.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mobile bottom bar
// ─────────────────────────────────────────────────────────────────────────────

describe("PLATFORM_SECTIONS mobile bottom bar", () => {
  it("keeps configuration and judgement desks out of the bar", () => {
    // Settlements (an ADMIN/DEVELOPER reconciliation screen) held a thumb-reach
    // tab purely because the bar flattens in order and nothing opted out.
    //
    // Image moderation / Claims / Disputes are out for a different reason:
    // they are judgement desks. You cannot assess a flagged image, read claim
    // evidence, or build a dispute response on a phone — and left eligible
    // they filled ADMIN's whole bar with three of them and no way to look up
    // an order. What remains is a bar about triage.
    const hidden = allItems()
      .filter((item) => item.hideInBottomBar)
      .map((item) => item.id);

    expect(hidden.sort()).toEqual(
      [
        "image-moderation",
        "invite-pauses",
        "claims",
        "disputes",
        // Cross-area /moderate/** queues: same desk-workflow reasoning, plus
        // they leave this console entirely — not something to put a thumb on.
        "edit-suggestions",
        "moderator-applications",
        "settlements",
        "cash-debts",
        "webhook-dlq",
        ...PLATFORM_SECTIONS.filter(
          (s) => s.id === "catalog" || s.id === "operations",
        ).flatMap((s) => s.items.map((i) => i.id)),
      ].sort(),
    );
  });

  it("leaves the triage queues and record lookups eligible", () => {
    expect(flattenForBottomBar().map((i) => i.id)).toEqual([
      "reports",
      "reviews",
      "support",
      "orders",
      "tickets",
      "humans",
      "places",
    ]);
  });

  it.each([
    // [role, the role's own eligible list after rbac filtering]
    // The first three of each list are the tabs; the rest fall into MORE.
    // ADMIN's list is unchanged by the two ADMIN-only /moderate entries
    // precisely because both opt out of the bar — if either ever drops
    // `hideInBottomBar`, ADMIN's bar diverges from SUPPORT's and this fails.
    [
      "ADMIN" as const,
      ["reports", "reviews", "support", "orders", "tickets", "humans", "places"],
    ],
    [
      "SUPPORT" as const,
      ["reports", "reviews", "support", "orders", "tickets", "humans", "places"],
    ],
    [
      "DEVELOPER" as const,
      ["reports", "reviews", "support", "orders", "tickets", "humans", "places"],
    ],
    // REVIEWER sees only the STAFF_ALL queues/records, so their bar is
    // Reviews · Support · Places — Reviews being the single surface their job
    // is about, which is why it stays eligible while the other queues do not.
    //
    // Three eligible items is BELOW BOTTOM_BAR_DEFAULT_MAX_ITEMS (4), so the
    // bar renders no MORE tab — exactly the case NavigationShell keeps the
    // top-bar hamburger for (`drawerReachableFromBottomBar`). The drawer stays
    // reachable; do not "fix" this by hiding more items, which is what would
    // strand it.
    ["REVIEWER" as const, ["reviews", "support", "places"]],
  ])("gives %s the intended bottom-bar candidates", (role, expected) => {
    expect(flattenForBottomBar(railFor(role)).map((i) => i.id)).toEqual(
      expected,
    );
  });

  it.each(STAFF_ROLES)("never leaves %s with an empty bar", (role) => {
    expect(flattenForBottomBar(railFor(role)).length).toBeGreaterThan(0);
  });
});
