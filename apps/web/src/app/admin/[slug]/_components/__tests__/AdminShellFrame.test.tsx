import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin half of the print layer's chrome bypass.
 *
 * Next layouts NEST, so `AppChrome` dropping the CONSUMER shell for a
 * `…/print` route does nothing about `/admin/[slug]/layout.tsx`, which wraps
 * every admin child in `AdminShell`. Without this frame the volunteer badge
 * sheet would preview inside the admin rail and — the actual defect — the
 * rail, top bar and bottom bar would print on the paper, since none of that
 * chrome carries `[data-print-hide]`.
 */

const pathname = vi.hoisted(() => ({ current: "/admin/east-side/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

vi.mock("../AdminShell", () => ({
  AdminShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="admin-shell">{children}</div>
  ),
}));

import { AdminShellFrame } from "../AdminShellFrame";

const renderFrame = () =>
  render(
    <AdminShellFrame
      slug="east-side"
      sections={[]}
      accountContext={{ id: "admin:east-side", label: "east-side", type: "org" }}
    >
      <p data-testid="document">the sheet</p>
    </AdminShellFrame>,
  );

beforeEach(() => {
  pathname.current = "/admin/east-side/dashboard";
});

describe("AdminShellFrame", () => {
  it("renders the admin shell on an ordinary admin route", () => {
    renderFrame();

    expect(screen.getByTestId("admin-shell")).toBeInTheDocument();
    expect(screen.getByTestId("document")).toBeInTheDocument();
  });

  it("drops the admin shell entirely on a printable document route", () => {
    // Not hidden — GONE. A `display: none` rail would still be in the DOM and
    // still be a print-media liability; the point is that the document renders
    // bare, exactly as `/embed/*` and the other two print routes do.
    pathname.current =
      "/admin/east-side/events/evt-1/volunteers/badges/print";

    renderFrame();

    expect(screen.queryByTestId("admin-shell")).toBeNull();
    expect(screen.getByTestId("document")).toBeInTheDocument();
  });

  it("does not mistake a route that merely CONTAINS 'print' for a document", () => {
    // The predicate is a suffix match on the last segment. A hypothetical
    // `/admin/[slug]/printers` must keep its chrome.
    pathname.current = "/admin/east-side/printers";

    renderFrame();

    expect(screen.getByTestId("admin-shell")).toBeInTheDocument();
  });
});
