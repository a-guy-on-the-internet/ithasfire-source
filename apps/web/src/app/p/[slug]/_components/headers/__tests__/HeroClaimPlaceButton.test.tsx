/**
 * HeroClaimPlaceButton — the place hero's "Claim this place" chip, which
 * replaced the claim item buried in the `⋯` overflow.
 *
 * Covered: the no-layout-shift rule (before eligibility answers, the chip
 * follows the server-known hint; after, it follows `state === "claimable"`
 * only; a failed query hides it), the auth fork (signed-out opens the sign-in
 * overlay in place, signed-in opens the wizard, a press while the session
 * resolves does neither), the pre-data press intent (consumed once, never
 * replayed), and the wizard outliving the refetch its own success triggers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/velvet-room",
}));

const sessionState = {
  data: null as { user: { id: string } } | null,
  isPending: false,
};
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => sessionState },
}));

const mockShowSignInOverlay = vi.fn();
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mockShowSignInOverlay }),
}));

type Eligibility = {
  state: string;
  domainProofAvailable?: boolean;
  fastTrackEligible?: boolean;
};
const mockRefetch = vi.fn();
const query: {
  data: Eligibility | undefined;
  isError: boolean;
} = { data: undefined, isError: false };
vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getPlaceClaimEligibility: {
        useQuery: () => ({
          data: query.data,
          isError: query.isError,
          refetch: mockRefetch,
        }),
      },
    },
  },
}));

type WizardProps = {
  open: boolean;
  onClose: () => void;
  onClaimed: () => void;
  domainProofAvailable: boolean;
  fastTrackEligible: boolean;
};
const wizard: { last: WizardProps | null } = { last: null };
vi.mock("@/components/places/claim", () => ({
  ClaimVenueWizard: (props: WizardProps) => {
    wizard.last = props;
    return (
      <div data-testid="claim-wizard" data-open={props.open ? "true" : "false"} />
    );
  },
}));

import { HeroClaimPlaceButton } from "../HeroClaimPlaceButton";

const baseProps = {
  placeId: "11111111-1111-4111-8111-111111111111",
  placeName: "The Velvet Room",
};

const CLAIMABLE: Eligibility = {
  state: "claimable",
  domainProofAvailable: false,
  fastTrackEligible: false,
};

const chip = () => screen.queryByTestId("place-hero-claim");

describe("HeroClaimPlaceButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.data = null;
    sessionState.isPending = false;
    wizard.last = null;
    query.data = undefined;
    query.isError = false;
  });
  afterEach(() => cleanup());

  describe("visibility", () => {
    it("shows from the hint while eligibility has not answered", () => {
      render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
      expect(chip()).not.toBeNull();
    });

    it("stays hidden before data when the hint says not claimable", () => {
      render(
        <HeroClaimPlaceButton {...baseProps} initiallyClaimable={false} />,
      );
      expect(chip()).toBeNull();
    });

    it("shows once eligibility says claimable, whatever the hint", () => {
      query.data = CLAIMABLE;
      render(
        <HeroClaimPlaceButton {...baseProps} initiallyClaimable={false} />,
      );
      expect(chip()).not.toBeNull();
    });

    it.each(["already_claimed", "pending", "not_eligible"])(
      "hides for %s even when the hint said claimable",
      (state) => {
        query.data = { state };
        render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
        expect(chip()).toBeNull();
      },
    );

    it("hides when the eligibility query fails", () => {
      query.isError = true;
      render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
      expect(chip()).toBeNull();
    });
  });

  it("is a labelled dialog-opening button", () => {
    query.data = CLAIMABLE;
    render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
    const button = screen.getByRole("button", { name: "places.claimCta" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("data-testid")).toBe("place-hero-claim");
  });

  it("signed-out press opens the sign-in overlay in place, not the wizard", () => {
    query.data = CLAIMABLE;
    render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);

    fireEvent.click(chip() as HTMLElement);

    expect(mockShowSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/velvet-room",
    });
    expect(screen.queryByTestId("claim-wizard")).toBeNull();
  });

  it("signed-in press opens the wizard", () => {
    sessionState.data = { user: { id: "human-1" } };
    query.data = CLAIMABLE;
    render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);

    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("false");
    fireEvent.click(chip() as HTMLElement);

    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("true");
    expect(mockShowSignInOverlay).not.toHaveBeenCalled();
  });

  it("signed-in press before eligibility loads opens the wizard once it confirms claimable", () => {
    sessionState.data = { user: { id: "human-1" } };
    const { rerender } = render(
      <HeroClaimPlaceButton {...baseProps} initiallyClaimable />,
    );

    fireEvent.click(chip() as HTMLElement);
    // No data yet → nothing to mount, nothing harmful happens.
    expect(screen.queryByTestId("claim-wizard")).toBeNull();
    expect(mockShowSignInOverlay).not.toHaveBeenCalled();

    query.data = CLAIMABLE;
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("true");
  });

  it("a press while the session is resolving opens neither the sign-in card nor the wizard", () => {
    sessionState.data = { user: { id: "human-1" } };
    sessionState.isPending = true;
    query.data = CLAIMABLE;
    render(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);

    const button = chip() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);

    expect(mockShowSignInOverlay).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("claim-wizard")?.getAttribute("data-open") ?? "false",
    ).toBe("false");
  });

  it("a successful claim keeps the wizard (and its success screen) mounted until it is closed", () => {
    sessionState.data = { user: { id: "human-1" } };
    query.data = { ...CLAIMABLE, domainProofAvailable: true, fastTrackEligible: true };
    const { rerender } = render(
      <HeroClaimPlaceButton {...baseProps} initiallyClaimable />,
    );
    fireEvent.click(chip() as HTMLElement);
    expect(wizard.last?.open).toBe(true);

    // The wizard's success path: onClaimed → refetch → the place is no longer
    // claimable, so the chip goes.
    act(() => wizard.last?.onClaimed());
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    query.data = { state: "pending" };
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);

    expect(chip()).toBeNull();
    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("true");
    // Still the eligibility it opened with, so its reset effect never fires.
    expect(wizard.last?.domainProofAvailable).toBe(true);
    expect(wizard.last?.fastTrackEligible).toBe(true);

    act(() => wizard.last?.onClose());
    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("false");
  });

  it("keeps the eligibility the wizard opened with when a later answer differs", () => {
    sessionState.data = { user: { id: "human-1" } };
    query.data = { ...CLAIMABLE, domainProofAvailable: true };
    const { rerender } = render(
      <HeroClaimPlaceButton {...baseProps} initiallyClaimable />,
    );
    fireEvent.click(chip() as HTMLElement);
    expect(wizard.last?.open).toBe(true);

    query.data = { state: "claimable", domainProofAvailable: false };
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);

    expect(wizard.last?.open).toBe(true);
    expect(wizard.last?.domainProofAvailable).toBe(true);
  });

  it("moves focus to the page heading when the wizard closes and the chip is gone", () => {
    sessionState.data = { user: { id: "human-1" } };
    query.data = CLAIMABLE;
    const { rerender } = render(
      <>
        <h1>The Velvet Room</h1>
        <HeroClaimPlaceButton {...baseProps} initiallyClaimable />
      </>,
    );
    fireEvent.click(chip() as HTMLElement);
    query.data = { state: "pending" };
    rerender(
      <>
        <h1>The Velvet Room</h1>
        <HeroClaimPlaceButton {...baseProps} initiallyClaimable />
      </>,
    );
    expect(chip()).toBeNull();

    act(() => wizard.last?.onClose());
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("leaves focus alone when the wizard closes and the chip is still there", () => {
    sessionState.data = { user: { id: "human-1" } };
    query.data = CLAIMABLE;
    render(
      <>
        <h1>The Velvet Room</h1>
        <HeroClaimPlaceButton {...baseProps} initiallyClaimable />
      </>,
    );
    fireEvent.click(chip() as HTMLElement);
    act(() => wizard.last?.onClose());
    expect(document.activeElement).not.toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });

  it("a press before data is dropped by a non-claimable answer, and a later claimable answer opens nothing", () => {
    sessionState.data = { user: { id: "human-1" } };
    const { rerender } = render(
      <HeroClaimPlaceButton {...baseProps} initiallyClaimable />,
    );
    fireEvent.click(chip() as HTMLElement);

    query.data = { state: "pending" };
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
    expect(screen.queryByTestId("claim-wizard")).toBeNull();

    // e.g. refetch on window focus after the claim was rejected
    query.data = CLAIMABLE;
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("false");
  });

  it("a press before data is dropped by a failed query", () => {
    sessionState.data = { user: { id: "human-1" } };
    const { rerender } = render(
      <HeroClaimPlaceButton {...baseProps} initiallyClaimable />,
    );
    fireEvent.click(chip() as HTMLElement);

    query.isError = true;
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);
    query.isError = false;
    query.data = CLAIMABLE;
    rerender(<HeroClaimPlaceButton {...baseProps} initiallyClaimable />);

    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("false");
  });

  it("a press before data never carries over to another place", () => {
    sessionState.data = { user: { id: "human-1" } };
    const { rerender } = render(
      <HeroClaimPlaceButton {...baseProps} initiallyClaimable />,
    );
    fireEvent.click(chip() as HTMLElement);

    const otherPlace = "22222222-2222-4222-8222-222222222222";
    rerender(
      <HeroClaimPlaceButton
        {...baseProps}
        placeId={otherPlace}
        initiallyClaimable
      />,
    );
    query.data = CLAIMABLE;
    rerender(
      <HeroClaimPlaceButton
        {...baseProps}
        placeId={otherPlace}
        initiallyClaimable
      />,
    );

    expect(
      screen.getByTestId("claim-wizard").getAttribute("data-open"),
    ).toBe("false");
  });
});
