import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFeatureGates } from "@/lib/feature-gates/test-helpers";

const mockedUsePathname = vi.fn();
const mockedUseFeatureGates = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockedUsePathname(),
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => mockedUseFeatureGates(),
}));

vi.mock("@/components/layout/PagePrimitives", () => ({
  StatusScreen: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div data-testid="maintenance-screen">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
}));

import { FeatureGateGuard } from "../FeatureGateGuard";

describe("FeatureGateGuard", () => {
  beforeEach(() => {
    mockedUsePathname.mockReset();
    mockedUseFeatureGates.mockReset();
  });

  it("shows the maintenance screen when maintenanceMode=true on a non-exempt route", () => {
    mockedUsePathname.mockReturnValue("/events");
    mockedUseFeatureGates.mockReturnValue({
      isLoading: false,
      gates: makeFeatureGates({ maintenanceMode: true }),
    });

    render(
      <FeatureGateGuard>
        <div>guarded content</div>
      </FeatureGateGuard>,
    );

    expect(screen.getByTestId("maintenance-screen")).toBeInTheDocument();
    expect(screen.getByText("admin.maintenanceTitle")).toBeInTheDocument();
    expect(screen.queryByText("guarded content")).not.toBeInTheDocument();
  });

  it("renders children on a maintenance-exempt route even when maintenanceMode=true", () => {
    mockedUsePathname.mockReturnValue("/about");
    mockedUseFeatureGates.mockReturnValue({
      isLoading: false,
      gates: makeFeatureGates({ maintenanceMode: true }),
    });

    render(
      <FeatureGateGuard>
        <div>guarded content</div>
      </FeatureGateGuard>,
    );

    expect(screen.getByText("guarded content")).toBeInTheDocument();
    expect(screen.queryByTestId("maintenance-screen")).not.toBeInTheDocument();
  });

  it("renders children normally when no gates are active", () => {
    mockedUsePathname.mockReturnValue("/events");
    mockedUseFeatureGates.mockReturnValue({
      isLoading: false,
      gates: makeFeatureGates({ maintenanceMode: false }),
    });

    render(
      <FeatureGateGuard>
        <div>guarded content</div>
      </FeatureGateGuard>,
    );

    expect(screen.getByText("guarded content")).toBeInTheDocument();
    expect(screen.queryByTestId("maintenance-screen")).not.toBeInTheDocument();
  });
});
