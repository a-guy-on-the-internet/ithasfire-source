import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/auth/AdminEmailVerificationGate", () => {
  return {
    AdminEmailVerificationGate: ({
      children,
    }: {
      children: React.ReactNode;
    }) => <div>{children}</div>,
  };
});

vi.mock("../_components/PlacesTable", () => {
  return {
    PlacesTable: () => (
      <div data-testid="admin-places-mounted">Places mounted</div>
    ),
  };
});

describe("/admin/[slug]/places", () => {
  it("renders the places client", async () => {
    const { default: AdminPlacesPage } = await import("../page");
    render(<AdminPlacesPage />);

    expect(screen.getByTestId("admin-places-mounted")).toBeTruthy();
  });
});
