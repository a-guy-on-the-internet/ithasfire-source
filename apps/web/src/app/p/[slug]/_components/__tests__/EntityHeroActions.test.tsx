/**
 * EntityHeroActions — the HUMAN / ORG hero's `⋯` overflow (formerly
 * EntityCabActions, which registered these into the retired action bar).
 * Follow and Share keep their own hero controls, so this menu carries Copy
 * link and Report only.
 *
 * The report action is the entity-report-intake FR-001 wiring: signed-out →
 * sign-in overlay in place (no dialog, no navigation); signed-in → the
 * in-place ReportEntityDialog with this page's subject identity.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mockToast = { success: vi.fn(), danger: vi.fn(), info: vi.fn() };
vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: mockToast }),
  useTranslations: () => (key: string) => key,
  // The real Popover portals through Floating UI; here it only has to render
  // the anchor always and the menu when open.
  Popover: ({
    open,
    anchor,
    children,
  }: {
    open: boolean;
    anchor: ReactNode;
    children: ReactNode;
  }) => (
    <>
      {anchor}
      {open ? children : null}
    </>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/somebody",
}));

const sessionState = { data: null as { user: { id: string } } | null };
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => sessionState },
}));

const mockShowSignInOverlay = vi.fn();
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mockShowSignInOverlay }),
}));

type DialogProps = {
  subjectType: string;
  subjectId: string;
  subjectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
const dialogProps: { current: DialogProps | null } = { current: null };
vi.mock("@/components/community/ReportEntityDialog", () => ({
  ReportEntityDialog: (props: DialogProps) => {
    dialogProps.current = props;
    return <div data-testid="report-entity-dialog" />;
  },
}));

import { EntityHeroActions } from "../EntityHeroActions";

const baseProps = {
  subjectType: "HUMAN" as const,
  subjectId: "33333333-3333-4333-8333-333333333333",
  subjectName: "Some Band",
};

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "pageActions.moreActions" }));
}

describe("EntityHeroActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogProps.current = null;
    sessionState.data = null;
  });

  /**
   * Copy link is only offered where the hero's Share button hands off to the OS
   * share sheet — without `navigator.share`, ProfileShareButton IS
   * copy-to-clipboard and the menu item would duplicate it. jsdom has no
   * `navigator.share`, so tests that want the item must install one.
   */
  const withNativeShare = () => {
    Object.defineProperty(navigator, "share", {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
  };

  it("exposes a labelled menu trigger holding copy link + report", () => {
    withNativeShare();
    render(<EntityHeroActions {...baseProps} />);

    const trigger = screen.getByRole("button", { name: "pageActions.moreActions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("entity-hero-report")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("entity-hero-copy-link")).toBeInTheDocument();
    expect(screen.getByTestId("entity-hero-report")).toBeInTheDocument();

    cleanup();
  });

  it("report signed-out: opens the sign-in overlay in place — no dialog, no navigation", () => {
    render(<EntityHeroActions {...baseProps} />);

    openMenu();
    fireEvent.click(screen.getByTestId("entity-hero-report"));

    expect(mockShowSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/somebody",
    });
    // Signed out → the dialog is not even mounted.
    expect(dialogProps.current).toBeNull();
    expect(mockToast.info).not.toHaveBeenCalled();

    cleanup();
  });

  it.each([
    ["HUMAN" as const, "33333333-3333-4333-8333-333333333333", "Some Band"],
    [
      "ORGANIZATION" as const,
      "44444444-4444-4444-8444-444444444444",
      "Some Org",
    ],
  ])(
    "report signed-in (%s): opens the in-place dialog with this page's subject",
    (subjectType, subjectId, subjectName) => {
      sessionState.data = { user: { id: "human-1" } };

      render(
        <EntityHeroActions
          subjectType={subjectType}
          subjectId={subjectId}
          subjectName={subjectName}
        />,
      );

      // Mounted closed for signed-in viewers.
      expect(dialogProps.current).toMatchObject({
        subjectType,
        subjectId,
        subjectName,
        open: false,
      });

      openMenu();
      fireEvent.click(screen.getByTestId("entity-hero-report"));

      expect(dialogProps.current?.open).toBe(true);
      expect(mockShowSignInOverlay).not.toHaveBeenCalled();

      cleanup();
    },
  );

  it("omits copy link when there is no native share sheet to hand off to", () => {
    // ProfileShareButton is the copy path on these browsers; offering both
    // would be the same action twice with two different confirmations.
    Reflect.deleteProperty(navigator, "share");
    render(<EntityHeroActions {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "pageActions.moreActions" }));
    expect(screen.queryByTestId("entity-hero-copy-link")).toBeNull();
    expect(screen.getByTestId("entity-hero-report")).toBeInTheDocument();

    cleanup();
  });

  it("copy link writes the current URL and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    withNativeShare();
    render(<EntityHeroActions {...baseProps} />);

    openMenu();
    fireEvent.click(screen.getByTestId("entity-hero-copy-link"));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(window.location.href);
      expect(mockToast.success).toHaveBeenCalledWith("places.shareCopiedToast");
    });

    cleanup();
  });
});
