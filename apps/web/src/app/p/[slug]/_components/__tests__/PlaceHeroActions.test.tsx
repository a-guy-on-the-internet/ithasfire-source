/**
 * PlaceHeroActions — the venue hero's `⋯` overflow (formerly VenueCabActions,
 * which registered these into the floating action bar). The bar is gone from
 * this page, so the menu itself is now the only path to share / copy link /
 * request transfer / report. Claim left the menu for the hero row
 * (`HeroClaimPlaceButton`); the menu must never offer it again.
 *
 * Covered: the item set and its gates (transfer only when `already_claimed`,
 * claim never, not even while `claimable`), and the report action's
 * entity-report-intake FR-001 wiring — signed-out → sign-in overlay in place, no dialog and no
 * navigation; signed-in → the in-place ReportEntityDialog with the venue's
 * PLACE subject identity.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mockToast = { success: vi.fn(), danger: vi.fn(), info: vi.fn() };
vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: mockToast }),
  useTranslations: () => (key: string) => key,
  // The real Popover portals through Floating UI; here it only has to render
  // the anchor always and the menu when open, which is all RowActionMenu's
  // semantics depend on.
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

const mockRouterPush = vi.fn();
// `@bprogress/next/app` is aliased to `next/navigation` in vitest.setup.ts, so
// this one factory has to satisfy both importers.
vi.mock("next/navigation", () => ({
  usePathname: () => "/p/velvet-room",
  useRouter: () => ({ push: mockRouterPush }),
}));

// Owner-only editor link, shared with the hero's chip. Driven directly here:
// the hook's own gate (getPlaceForEdit + the owner-slug intersection) is not
// re-litigated in this file.
const editorHref: { current: string | null } = { current: null };
vi.mock("../useVenueEditorLink", () => ({
  useVenueEditorLink: () => ({ href: editorHref.current }),
}));

const sessionState = { data: null as { user: { id: string } } | null };
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => sessionState },
}));

const mockShowSignInOverlay = vi.fn();
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mockShowSignInOverlay }),
}));

type Eligibility = {
  state: "claimable" | "already_claimed" | string;
  domainProofAvailable?: boolean;
  fastTrackEligible?: boolean;
};
const eligibility: { current: Eligibility | undefined } = {
  current: undefined,
};
vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getPlaceClaimEligibility: {
        useQuery: () => ({ data: eligibility.current, refetch: vi.fn() }),
      },
    },
  },
}));

vi.mock("@/components/places/claim", () => ({
  ClaimVenueWizard: () => <div data-testid="claim-wizard" />,
  OwnershipDisputeDialog: ({ open }: { open: boolean }) => (
    <div data-testid="dispute-dialog" data-open={open ? "true" : "false"} />
  ),
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

import { PlaceHeroActions } from "../PlaceHeroActions";

const PLACE_ID = "11111111-1111-4111-8111-111111111111";

const baseProps = {
  placeId: PLACE_ID,
  placeName: "The Velvet Room",
  shareTitle: "The Velvet Room",
};

/** Open the `⋯` menu — every action lives behind it now. */
function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "pageActions.moreActions" }));
}

describe("PlaceHeroActions overflow menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogProps.current = null;
    sessionState.data = null;
    eligibility.current = undefined;
    editorHref.current = null;
  });

  // The phone half of the hero's "Edit page" chip. WHICH of the two halves is
  // visible is a CSS media query, and jsdom applies no stylesheets here, so
  // these cover what jsdom CAN answer: the ownership gate, the position in the
  // menu, and the navigation target. The width behaviour itself is only
  // provable in a real browser.
  describe("the owner's Edit page item", () => {
    const editItem = () =>
      screen.queryByRole("menuitem", { name: "places.editPage" });

    it("is absent for a viewer with no editor link (anonymous or non-owner)", () => {
      render(<PlaceHeroActions {...baseProps} />);
      openMenu();
      expect(editItem()).toBeNull();
    });

    it("is FIRST in the menu for an owner, above Share", () => {
      editorHref.current = "/admin/velvet-room/places/p1/page";
      render(<PlaceHeroActions {...baseProps} />);
      openMenu();

      const names = screen
        .getAllByRole("menuitem")
        .map((el) => el.textContent?.trim());
      expect(names[0]).toBe("places.editPage");
      expect(names).toContain("pageActions.share");
    });

    it("navigates to the editor when pressed", () => {
      editorHref.current = "/admin/velvet-room/places/p1/page";
      render(<PlaceHeroActions {...baseProps} />);
      openMenu();
      fireEvent.click(editItem() as HTMLElement);
      expect(mockRouterPush).toHaveBeenCalledWith(
        "/admin/velvet-room/places/p1/page",
      );
    });
  });

  it("exposes a labelled menu trigger and the always-on items", () => {
    render(<PlaceHeroActions {...baseProps} />);

    const trigger = screen.getByRole("button", { name: "pageActions.moreActions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Closed → no menu items in the tree.
    expect(screen.queryByTestId("place-hero-share")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("place-hero-share")).toBeInTheDocument();
    expect(screen.getByTestId("place-hero-copy-link")).toBeInTheDocument();
    expect(screen.getByTestId("place-hero-report")).toBeInTheDocument();
    // Eligibility unresolved → neither ownership item is offered.
    expect(screen.queryByTestId("place-hero-claim")).toBeNull();
    expect(screen.queryByTestId("place-hero-dispute")).toBeNull();

    cleanup();
  });

  it("never offers Claim, even while the place is claimable (it lives in the hero row)", () => {
    sessionState.data = { user: { id: "human-1" } };
    eligibility.current = {
      state: "claimable",
      domainProofAvailable: false,
      fastTrackEligible: false,
    };
    render(<PlaceHeroActions {...baseProps} />);

    openMenu();
    expect(screen.queryByTestId("place-hero-claim")).toBeNull();
    const names = screen
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim());
    // No menu item names a claim, under any key (the translator mock renders
    // keys, so this also catches a claim item re-added under a new key).
    expect(names.filter((n) => /claim/i.test(n ?? ""))).toEqual([]);
    expect(screen.queryByTestId("place-hero-dispute")).toBeNull();
    // The wizard is not mounted from here either.
    expect(screen.queryByTestId("claim-wizard")).toBeNull();

    cleanup();
  });

  it("offers Request transfer only once the venue is claimed", () => {
    eligibility.current = { state: "already_claimed" };
    render(<PlaceHeroActions {...baseProps} />);

    openMenu();
    expect(screen.getByTestId("place-hero-dispute")).toBeInTheDocument();
    expect(screen.queryByTestId("place-hero-claim")).toBeNull();

    cleanup();
  });

  it("signed-out report: opens the sign-in overlay in place — no dialog, no navigation", () => {
    render(<PlaceHeroActions {...baseProps} />);

    openMenu();
    fireEvent.click(screen.getByTestId("place-hero-report"));

    expect(mockShowSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/velvet-room",
    });
    // Signed out → the dialog is not even mounted, and no support-hub toast.
    expect(dialogProps.current).toBeNull();
    expect(mockToast.info).not.toHaveBeenCalled();

    cleanup();
  });

  it("signed-in report: opens the in-place dialog with the venue's PLACE subject", () => {
    sessionState.data = { user: { id: "human-1" } };
    render(<PlaceHeroActions {...baseProps} />);

    // Mounted closed for signed-in viewers.
    expect(dialogProps.current).toMatchObject({
      subjectType: "PLACE",
      subjectId: PLACE_ID,
      subjectName: "The Velvet Room",
      open: false,
    });

    openMenu();
    fireEvent.click(screen.getByTestId("place-hero-report"));

    expect(dialogProps.current?.open).toBe(true);
    expect(mockShowSignInOverlay).not.toHaveBeenCalled();

    cleanup();
  });

  it("copy link writes the current URL and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<PlaceHeroActions {...baseProps} />);

    openMenu();
    fireEvent.click(screen.getByTestId("place-hero-copy-link"));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(window.location.href);
      expect(mockToast.success).toHaveBeenCalledWith("places.shareCopiedToast");
    });

    cleanup();
  });
});
