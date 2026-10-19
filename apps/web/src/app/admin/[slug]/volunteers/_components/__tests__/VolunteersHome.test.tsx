import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  currentOwner: null as unknown,
  isLoading: false,
}));

// Plain DOM for the Tamagui primitives. `styled(View)` is the tab button, so
// the mock keeps what the assertions read: role, testid, aria-*, and the
// press handler.
vi.mock("tamagui", async () => {
  const React = await import("react");
  const Box = ({
    children,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (
        key === "role" ||
        key === "id" ||
        key === "data-testid" ||
        key.startsWith("aria-")
      ) {
        safe[key] = value;
      }
    }
    return React.createElement("div", { ...safe, onClick: onPress }, children);
  };
  return { YStack: Box, XStack: Box, View: Box, styled: () => Box };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme-co" }),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.currentOwner,
    isLoading: testState.isLoading,
  }),
}));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

vi.mock("@/components/volunteering/AsksList", () => ({
  AsksList: () => <div data-testid="asks-list" />,
}));

vi.mock("../VolunteerHoursView", () => ({
  VolunteerHoursView: () => <div data-testid="hours-view" />,
}));

import { VolunteersHome } from "../VolunteersHome";

const orgOwner = (role: string) => ({
  kind: "org",
  orgId: "org-1",
  orgName: "Acme",
  orgSlug: "acme-co",
  role,
  adminSlug: "acme-co",
});

/**
 * The nav offers this page to every org role because the hours report
 * (`volunteer.hours.orgSummary`) admits them all. The Asks tab's org read is
 * `asks.listByOrg`, ORG_EDIT_ROLES server-side, so only those roles (and a
 * personal workspace, which lists its own asks) may be offered it.
 */
describe("VolunteersHome — Asks tab follows the server's edit gate", () => {
  beforeEach(() => {
    testState.currentOwner = null;
    testState.isLoading = false;
  });

  it.each(["VIEWER", "FINANCE", "SCANNER"])(
    "gives %s the hours report and no Asks tab",
    (role) => {
      testState.currentOwner = orgOwner(role);
      render(<VolunteersHome />);

      expect(screen.getByTestId("hours-view")).toBeInTheDocument();
      expect(
        screen.getByTestId("volunteers-home-tab-hours"),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("volunteers-home-tab-asks")).toBeNull();
      expect(screen.queryByTestId("asks-list")).toBeNull();
    },
  );

  it.each(["OWNER", "ADMIN", "EDITOR"])(
    "offers %s the Asks tab, which opens the asks list",
    (role) => {
      testState.currentOwner = orgOwner(role);
      render(<VolunteersHome />);

      fireEvent.click(screen.getByTestId("volunteers-home-tab-asks"));

      expect(screen.getByTestId("asks-list")).toBeInTheDocument();
      expect(screen.queryByTestId("hours-view")).toBeNull();
    },
  );

  it("shows a personal workspace its own asks and no Hours (orgSummary needs an orgId)", () => {
    testState.currentOwner = {
      kind: "human",
      humanId: "me",
      humanName: "Me",
      adminSlug: "@me",
    };
    render(<VolunteersHome />);

    expect(screen.getByTestId("asks-list")).toBeInTheDocument();
    expect(screen.queryByTestId("hours-view")).toBeNull();
    expect(screen.queryByTestId("volunteers-home-tab-hours")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "volunteering.asksTitle" }),
    ).toBeInTheDocument();
  });

  it("holds the Asks tab back while the owner is still loading", () => {
    testState.currentOwner = null;
    testState.isLoading = true;
    render(<VolunteersHome />);

    expect(screen.queryByTestId("volunteers-home-tab-asks")).toBeNull();
    expect(screen.getByTestId("hours-view")).toBeInTheDocument();
  });
});
