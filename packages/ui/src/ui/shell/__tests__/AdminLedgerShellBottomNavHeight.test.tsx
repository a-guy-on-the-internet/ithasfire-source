import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminLedgerShell } from "../AdminLedgerShell";
import type { AdminLedgerShellProps } from "../AdminLedgerShell.types";
import type { NavigationSection } from "../NavigationShell.types";
import { ADMIN_BOTTOM_NAV_HEIGHT_VAR } from "../utils/admin-bottom-nav-height";
import { renderWithProvider } from "../../../../test/utils";

type ReactNativeModule = typeof import("react-native");

vi.mock("react-native", async () => {
  const actual = (await vi.importActual("react-native")) as ReactNativeModule;
  return {
    ...actual,
    Easing: actual.Easing ?? { bezier: () => (value: number) => value },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  };
});

/**
 * Pages dock a bar above the admin bottom nav by reading
 * `--admin-bottom-nav-height` (the seat price selection bar is the first).
 * If the shell stops publishing it, or the nav's test id and the lookup drift
 * apart, that bar slides under the nav and its button stops taking taps.
 * Nothing else fails, so this pins the source.
 */

const sections: NavigationSection[] = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "dashboard", label: "Dashboard", route: "/dashboard" },
      { id: "events", label: "Events", route: "/events" },
    ],
  },
];

const accountContext: AdminLedgerShellProps["accountContext"] = {
  id: "ctx-1",
  label: "Acme Org",
  type: "org",
  role: "ADMIN",
};

const renderShell = (override?: Partial<AdminLedgerShellProps>) =>
  renderWithProvider(
    <AdminLedgerShell
      navSections={sections}
      currentRoute="/events"
      accountContext={accountContext}
      onRouteSelect={vi.fn()}
      forceLayout="mobile"
      surfaceRole="Admin"
      {...override}
    >
      <div>Content</div>
    </AdminLedgerShell>,
  );

const published = () =>
  document.documentElement.style.getPropertyValue(ADMIN_BOTTOM_NAV_HEIGHT_VAR);

describe("AdminLedgerShell bottom nav height", () => {
  const NAV_HEIGHT = 85;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.documentElement.style.removeProperty(ADMIN_BOTTOM_NAV_HEIGHT_VAR);
    // jsdom lays nothing out: give the nav, and only the nav, a height.
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const isNav = this.getAttribute("data-testid")?.endsWith("-bottom-nav");
        const height = isNav ? NAV_HEIGHT : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: height,
          width: 0,
          height,
          toJSON: () => ({}),
        } as DOMRect;
      });
  });

  afterEach(() => {
    rectSpy.mockRestore();
  });

  it("publishes the nav's measured height on <html> while the nav is shown", () => {
    renderShell();
    // The default test id base: the one the web admin renders with.
    expect(screen.getByTestId("admin-ledger-shell-bottom-nav")).toBeInTheDocument();
    expect(published()).toBe(`${NAV_HEIGHT}px`);
  });

  it("follows a custom test id base, so the lookup cannot drift from the nav", () => {
    renderShell({ testIdBase: "ledger" });
    expect(screen.getByTestId("ledger-bottom-nav")).toBeInTheDocument();
    expect(published()).toBe(`${NAV_HEIGHT}px`);
  });

  it("publishes nothing on desktop, where there is no bottom nav", () => {
    renderShell({ forceLayout: "desktop" });
    expect(screen.queryByTestId("admin-ledger-shell-bottom-nav")).toBeNull();
    expect(published()).toBe("");
  });

  it("clears the value when the shell unmounts", () => {
    const { unmount } = renderShell();
    expect(published()).toBe(`${NAV_HEIGHT}px`);
    unmount();
    expect(published()).toBe("");
  });
});
