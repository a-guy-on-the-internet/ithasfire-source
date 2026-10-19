import { describe, expect, it } from "vitest";

import type { NavigationSection } from "../../types/navigation";
import {
  namespaceNavSections,
  parseNamespacedPathname,
  toNamespacedHref,
} from "./route-namespacing";

describe("route-namespacing", () => {
  const sections: NavigationSection[] = [
    {
      id: "main",
      label: "Main",
      items: [
        { id: "dashboard", label: "Dashboard", route: "dashboard" },
        { id: "orders", label: "Orders", route: "orders" },
      ],
    },
  ];

  it("namespaces section item routes under the admin base path", () => {
    const { sections: next, mapping } = namespaceNavSections(sections, {
      adminBasePath: "/admin/acme-co",
    });

    expect(next[0]?.items[0]?.route).toBe("/admin/acme-co/dashboard");
    expect(next[0]?.items[1]?.route).toBe("/admin/acme-co/orders");
    expect(mapping.get("dashboard")).toBe("/admin/acme-co/dashboard");
  });

  // A cross-area entry (the platform rail links the /moderate/** review
  // queues, which live outside /platform and render their own shell) declares
  // its route as an app-absolute path. Joining it under the base produced
  // `/platform/moderate/suggestions` — an anchor that 404s.
  it("passes an already-absolute route through instead of re-basing it", () => {
    const { sections: next, mapping } = namespaceNavSections(
      [
        {
          id: "queues",
          label: "Queues",
          items: [
            { id: "reports", label: "Reports", route: "reports" },
            {
              id: "edit-suggestions",
              label: "Edit suggestions",
              route: "/moderate/suggestions",
            },
          ],
        },
      ],
      { adminBasePath: "/platform" },
    );

    expect(next[0]?.items[0]?.route).toBe("/platform/reports");
    expect(next[0]?.items[1]?.route).toBe("/moderate/suggestions");
    expect(mapping.get("/moderate/suggestions")).toBe("/moderate/suggestions");
  });

  it("parses a namespaced pathname back into a stable route id", () => {
    const routeId = parseNamespacedPathname("/admin/acme-co/orders", {
      adminBasePath: "/admin/acme-co",
    });
    expect(routeId).toBe("orders");
  });

  it("handles query/hash segments", () => {
    const routeId = parseNamespacedPathname("/admin/acme-co/orders?x=1#y", {
      adminBasePath: "/admin/acme-co",
    });
    expect(routeId).toBe("orders");
  });

  it("falls back when pathname does not match base path", () => {
    const routeId = parseNamespacedPathname("/buyer/home", {
      adminBasePath: "/admin/acme-co",
      fallbackRouteId: "dashboard",
    });
    expect(routeId).toBe("dashboard");
  });

  // A human workspace slug (`@steve-1`) arrives percent-encoded when the URL
  // was pasted or bookmarked, while `adminBasePath` is built from the DECODED
  // route param. A bare prefix match missed it, so every caller fell back to
  // its default route: the rail highlighted Dashboard while the user was on
  // Orders, and the tab title said "Dashboard" too.
  it("matches a base whose slug is percent-encoded in the pathname", () => {
    expect(
      parseNamespacedPathname("/admin/%40steve-1/orders", {
        adminBasePath: "/admin/@steve-1",
        fallbackRouteId: "dashboard",
      }),
    ).toBe("orders");
  });

  it("matches a base whose slug is decoded in the pathname", () => {
    expect(
      parseNamespacedPathname("/admin/@steve-1/orders", {
        adminBasePath: "/admin/%40steve-1",
        fallbackRouteId: "dashboard",
      }),
    ).toBe("orders");
  });

  it("keeps deep segments of an encoded base path", () => {
    expect(
      parseNamespacedPathname("/admin/%40steve-1/places/abc-123/edit", {
        adminBasePath: "/admin/@steve-1",
        fallbackRouteId: "dashboard",
      }),
    ).toBe("places/abc-123/edit");
  });

  it("does not throw on a malformed percent-escape in the base", () => {
    expect(
      parseNamespacedPathname("/admin/100%off/orders", {
        adminBasePath: "/admin/100%off",
        fallbackRouteId: "dashboard",
      }),
    ).toBe("orders");
  });

  // Without a segment-boundary check `/admin/acme-corp/orders` "matches" the
  // base `/admin/acme` and yields the bogus route id `-corp/orders`.
  it("requires the base to end on a segment boundary", () => {
    expect(
      parseNamespacedPathname("/admin/acme-corp/orders", {
        adminBasePath: "/admin/acme",
        fallbackRouteId: "dashboard",
      }),
    ).toBe("dashboard");
  });

  it("still resolves the base path itself to the fallback", () => {
    expect(
      parseNamespacedPathname("/admin/acme-co", {
        adminBasePath: "/admin/acme-co",
        fallbackRouteId: "dashboard",
      }),
    ).toBe("dashboard");
  });

  it("builds namespaced hrefs from route ids", () => {
    expect(
      toNamespacedHref("orders", { adminBasePath: "/admin/acme-co" }),
    ).toBe("/admin/acme-co/orders");
  });
});
