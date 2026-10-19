import { describe, expect, it } from "vitest";

import type { NavigationSection } from "../../NavigationShell.types";
import { resolveBottomNavSwipe } from "../NavigationBottomBar";

const sampleSection: NavigationSection = {
  id: "main",
  label: "Main",
  items: [
    { id: "dashboard", label: "Dashboard", route: "/dashboard" },
    { id: "events", label: "Events", route: "/events" },
    { id: "orders", label: "Orders", route: "/orders" },
  ],
};

const toPrimaryItems = () =>
  sampleSection.items.map((route) => ({
    section: sampleSection,
    route,
  }));

describe("resolveBottomNavSwipe", () => {
  it("returns the next route when swiping forward", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/dashboard",
      primaryItems: toPrimaryItems(),
      shouldShowMore: false,
      direction: "next",
    });

    expect(outcome).toEqual({
      kind: "route",
      route: "/events",
      sectionId: sampleSection.id,
    });
  });

  it("returns the previous route when swiping backward", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/orders",
      primaryItems: toPrimaryItems(),
      shouldShowMore: false,
      direction: "prev",
    });

    expect(outcome).toEqual({
      kind: "route",
      route: "/events",
      sectionId: sampleSection.id,
    });
  });

  it("falls back to opening the drawer when swiping past the last item", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/orders",
      primaryItems: toPrimaryItems(),
      shouldShowMore: true,
      direction: "next",
    });

    expect(outcome).toEqual({ kind: "drawer" });
  });

  it("ignores swipes when the current route is unknown", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/missing",
      primaryItems: toPrimaryItems(),
      shouldShowMore: true,
      direction: "next",
    });

    expect(outcome).toEqual({ kind: "none" });
  });
});
