import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HeroPerformerBookingButton (organizer-booking-requests FR-009): viewer-state
 * contract of the performer heroes' "Request to book" CTA. Signed out, the
 * button opens the in-place sign-in overlay redirecting back to the CURRENT
 * page; signed in, it opens the OrganizerBookingDialog with the act's
 * identity.
 */

const testMocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  showSignInOverlay: vi.fn(),
}));

vi.mock("@th/ui", () => ({
  // Key-echo translator (same convention as HumanHero.test.tsx).
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/the-band",
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: testMocks.useSession },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: testMocks.showSignInOverlay }),
}));

vi.mock("../../OrganizerBookingDialog", () => ({
  OrganizerBookingDialog: ({
    open,
    performerOwnerType,
    performerOwnerId,
    performerName,
  }: {
    open: boolean;
    performerOwnerType: string;
    performerOwnerId: string;
    performerName: string;
  }) =>
    open ? (
      <div
        role="dialog"
        data-owner-type={performerOwnerType}
        data-owner-id={performerOwnerId}
        data-name={performerName}
      >
        dialog
      </div>
    ) : null,
}));

import { HeroPerformerBookingButton } from "../HeroPerformerBookingButton";

function renderButton() {
  return render(
    <HeroPerformerBookingButton
      performerOwnerType="org"
      performerOwnerId="org-1"
      performerName="The Band"
    />,
  );
}

describe("HeroPerformerBookingButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signed out: opens the sign-in overlay redirecting to the current page", () => {
    testMocks.useSession.mockReturnValue({ data: null, isPending: false });

    renderButton();

    fireEvent.click(
      screen.getByRole("button", { name: "profileStd.requestToBookCta" }),
    );
    expect(testMocks.showSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/the-band",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("signed in: opens the organizer booking dialog with the act identity", () => {
    testMocks.useSession.mockReturnValue({
      data: { user: { id: "human-1" } },
      isPending: false,
    });

    renderButton();

    fireEvent.click(
      screen.getByRole("button", { name: "profileStd.requestToBookCta" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-owner-type", "org");
    expect(dialog).toHaveAttribute("data-owner-id", "org-1");
    expect(dialog).toHaveAttribute("data-name", "The Band");
    expect(testMocks.showSignInOverlay).not.toHaveBeenCalled();
  });

  it("disables the trigger while the session is still resolving", () => {
    testMocks.useSession.mockReturnValue({ data: null, isPending: true });

    renderButton();

    expect(
      screen.getByRole("button", { name: "profileStd.requestToBookCta" }),
    ).toBeDisabled();
  });
});
