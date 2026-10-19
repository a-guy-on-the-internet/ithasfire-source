import { describe, expect, it } from "vitest";
import type { NavigationSection } from "@th/ui";

import {
  collectPortableRouteSegments,
  resolveWorkspaceSwitchTarget,
} from "../workspace-switch-target";

const sections: NavigationSection[] = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "dashboard", label: "Dashboard", route: "dashboard" },
      { id: "events", label: "Events", route: "events" },
      { id: "orders", label: "Orders", route: "orders" },
    ],
  },
  {
    id: "ops",
    label: "Ops",
    items: [
      {
        id: "volunteers",
        label: "Volunteers",
        route: "volunteers",
        children: [
          {
            id: "volunteer-templates",
            label: "Templates",
            route: "volunteer-templates",
          },
        ],
      },
    ],
  },
];

const portableRoutes = collectPortableRouteSegments(sections);

const resolve = (pathname: string | null | undefined, base = "/admin/a") =>
  resolveWorkspaceSwitchTarget({
    pathname,
    adminBasePath: base,
    targetContextId: "b",
    portableRoutes,
  });

describe("collectPortableRouteSegments", () => {
  it("an anchor child (`payouts#ledger`) is its parent's segment, not a new one", () => {
    const anchored = collectPortableRouteSegments([
      {
        id: "sales",
        label: "Sales",
        items: [
          {
            id: "payouts",
            label: "Payouts",
            route: "payouts",
            children: [
              { id: "payouts-ledger", label: "Ledger", route: "payouts#ledger" },
              { id: "q", label: "Q", route: "orders?tab=x" },
            ],
          },
        ],
      },
    ]);
    expect([...anchored].sort()).toEqual(["orders", "payouts"]);
  });

  it("flattens item and nested child routes from the nav model", () => {
    expect([...portableRoutes].sort()).toEqual([
      "dashboard",
      "events",
      "orders",
      "volunteer-templates",
      "volunteers",
    ]);
  });

  it("reduces a multi-segment nav route to its first segment", () => {
    const segments = collectPortableRouteSegments([
      {
        id: "main",
        label: "Main",
        items: [{ id: "new", label: "New", route: "events/new" }],
      },
    ]);
    expect([...segments]).toEqual(["events"]);
  });
});

describe("resolveWorkspaceSwitchTarget", () => {
  it("preserves the section root across a workspace switch", () => {
    expect(resolve("/admin/a/orders")).toBe("/admin/b/orders");
  });

  it("collapses a nested entity route to the section root", () => {
    expect(resolve("/admin/a/events/evt_123/edit")).toBe("/admin/b/events");
  });

  it("falls back to the dashboard for a section the rail does not offer", () => {
    // e.g. a feature-gated section that is not in this workspace's `sections`.
    expect(resolve("/admin/a/memberships")).toBe("/admin/b/dashboard");
  });

  it("falls back to the dashboard on the bare admin base path", () => {
    expect(resolve("/admin/a")).toBe("/admin/b/dashboard");
    expect(resolve("/admin/a/")).toBe("/admin/b/dashboard");
  });

  it("falls back to the dashboard for a pathname outside the admin base", () => {
    expect(resolve("/events/some-public-event")).toBe("/admin/b/dashboard");
    expect(resolve("/admin/other-workspace/orders")).toBe(
      "/admin/b/dashboard",
    );
  });

  it("falls back to the dashboard when the pathname is missing", () => {
    expect(resolve(null)).toBe("/admin/b/dashboard");
    expect(resolve(undefined)).toBe("/admin/b/dashboard");
  });

  it("never carries a query string or hash across", () => {
    expect(resolve("/admin/a/orders?status=paid&page=3")).toBe(
      "/admin/b/orders",
    );
    expect(resolve("/admin/a/orders#refunds")).toBe("/admin/b/orders");
  });

  it("matches a human workspace whose slug is percent-encoded in the pathname", () => {
    // Not what in-app navigation produces (hrefs carry a literal "@"), but an
    // externally-supplied URL can: the base is built from the DECODED route
    // param, so the raw prefix match would miss.
    expect(
      resolveWorkspaceSwitchTarget({
        pathname: "/admin/%40steve-1/orders",
        adminBasePath: "/admin/@steve-1",
        targetContextId: "acme-co",
        portableRoutes,
      }),
    ).toBe("/admin/acme-co/orders");
  });

  it("matches a human workspace when the base itself arrives encoded", () => {
    expect(
      resolveWorkspaceSwitchTarget({
        pathname: "/admin/@steve-1/events/evt_1/edit",
        adminBasePath: "/admin/%40steve-1",
        targetContextId: "acme-co",
        portableRoutes,
      }),
    ).toBe("/admin/acme-co/events");
  });

  it("survives a base path carrying a malformed percent-escape", () => {
    // decodeURIComponent throws here; the raw + encoded candidates must
    // still be tried rather than the whole lookup collapsing.
    expect(() =>
      resolveWorkspaceSwitchTarget({
        pathname: "/admin/100%off/orders",
        adminBasePath: "/admin/100%off",
        targetContextId: "b",
        portableRoutes,
      }),
    ).not.toThrow();
    expect(
      resolveWorkspaceSwitchTarget({
        pathname: "/admin/100%off/orders",
        adminBasePath: "/admin/100%off",
        targetContextId: "b",
        portableRoutes,
      }),
    ).toBe("/admin/b/orders");
  });

  it("switches INTO a human workspace without mangling the slug", () => {
    expect(
      resolveWorkspaceSwitchTarget({
        pathname: "/admin/acme-co/events",
        adminBasePath: "/admin/acme-co",
        targetContextId: "@steve-1",
        portableRoutes,
      }),
    ).toBe("/admin/@steve-1/events");
  });
});
