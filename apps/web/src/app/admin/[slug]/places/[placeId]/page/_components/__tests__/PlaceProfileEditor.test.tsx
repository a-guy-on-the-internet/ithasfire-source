import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * `/page` is the block canvas only (FR-401): the settings drawer, the review
 * controls it carried and the booking signpost that lived in it are gone — the
 * settings are sections of `/settings` now.
 *
 * The booking half of this pin predates that: the booking acceptance switch
 * left the public-page editor for the bookings page.
 *
 * It used to render twice from this file — once as a standalone card on the
 * unverified gate screen, once inside the collapsed "Page settings" drawer for
 * verified venues, between the slug field and three raw hex colour inputs. That
 * second home is where a venue owner looked, failed to find it, and reported
 * that the control did not exist. One home now, and it is the bookings page
 * (`../../bookings/_components/BookingAcceptanceToggle`).
 *
 * This is a REGRESSION PIN, not a style preference: re-adding the switch here
 * would silently recreate two controls writing one flag, and only one of them
 * purges the public page's ISR cache.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    tabIndex,
    "aria-hidden": ariaHidden,
  }: {
    children?: ReactNode;
    tabIndex?: number;
    "aria-hidden"?: boolean;
  }) => (
    <button type="button" tabIndex={tabIndex} aria-hidden={ariaHidden}>
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    href,
    children,
    "aria-label": ariaLabel,
  }: {
    href: string;
    children?: ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={href} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <svg />;
  return {
    ShieldCheck: Icon,
    ShieldAlert: Icon,
    Clock: Icon,
    ShieldX: Icon,
  };
});

// Records what the canvas is asked to render. `showSettings` and
// `settingsExtra` are the whole question here: the drawer (and anything
// smuggled into it) must be GONE from this route.
const editorProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("@/components/entity-pages", () => ({
  CommunityHandoverNotice: ({ placeId }: { placeId: string }) => (
    <div data-testid="community-handover-notice" data-place-id={placeId} />
  ),
  PageEditorView: (props: Record<string, unknown>) => {
    editorProps.last = props;
    return (
      <div data-testid="page-editor">{props.settingsExtra as ReactNode}</div>
    );
  },
}));

import { PlaceProfileEditor } from "../PlaceProfileEditor";

const BASE_PROPS = {
  placeId: "place-1",
  slug: "acme",
} as const;

describe("PlaceProfileEditor — the block canvas and nothing else (FR-401)", () => {
  it("puts the moderator handover notice above the canvas for a verified place", () => {
    render(
      <PlaceProfileEditor {...BASE_PROPS} verificationStatus="VERIFIED" />,
    );
    const notice = screen.getByTestId("community-handover-notice");
    expect(notice).toHaveAttribute("data-place-id", "place-1");
    expect(
      notice.compareDocumentPosition(screen.getByTestId("page-editor")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the canvas with the settings drawer (and its Save) switched OFF", () => {
    render(
      <PlaceProfileEditor {...BASE_PROPS} verificationStatus="VERIFIED" />,
    );

    expect(screen.getByTestId("page-editor")).toBeInTheDocument();
    expect(editorProps.last).toMatchObject({
      ownerType: "PLACE",
      ownerId: "place-1",
      showSettings: false,
    });
    expect(editorProps.last?.settingsExtra).toBeUndefined();
  });

  it("renders no booking switch and no review switch — neither lives here", () => {
    for (const verificationStatus of ["VERIFIED", "UNVERIFIED"] as const) {
      const { unmount } = render(
        <PlaceProfileEditor
          {...BASE_PROPS}
          verificationStatus={verificationStatus}
        />,
      );
      // Booking moved to the bookings page; reviews moved to venue settings.
      // Re-adding either here would recreate two controls writing one flag.
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(screen.queryByText("admin.bkAcceptanceTitle")).toBeNull();
      expect(
        screen.queryByText("admin.peAttendeeReviewsPublicTitle"),
      ).toBeNull();
      unmount();
    }
  });

  it("signposts where the settings went, on both the canvas and the gate screen", () => {
    for (const verificationStatus of ["VERIFIED", "UNVERIFIED"] as const) {
      const { unmount } = render(
        <PlaceProfileEditor
          {...BASE_PROPS}
          verificationStatus={verificationStatus}
        />,
      );
      expect(
        screen.getByText("admin.placePageSettingsMovedNote"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "admin.placePageSettingsMovedCta" }),
      ).toHaveAttribute("href", "/admin/acme/places/place-1/settings");
      unmount();
    }
  });

  it("sends an unverified owner's request CTA to the Verification SECTION", () => {
    render(
      <PlaceProfileEditor {...BASE_PROPS} verificationStatus="UNVERIFIED" />,
    );
    expect(
      screen.getByText("admin.placePageGateRequestCta").closest("a"),
    ).toHaveAttribute("href", "/admin/acme/places/place-1/settings#verification");
  });
});
