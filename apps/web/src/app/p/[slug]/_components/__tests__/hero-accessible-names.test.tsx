import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { EntitySummary, EntityPageRecord } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

/**
 * THE HERO'S CONTROLS MUST NOT SHARE A NAME WITH THEIR TWINS FURTHER DOWN.
 *
 * A venue page renders "Play here" twice (hero action row + Booking section)
 * and "Get directions" twice (hero action row + Location sidebar). All four
 * are plain buttons, so a screen-reader user listing the page's controls heard
 * each name twice with nothing to tell them apart. The hero copies now name
 * the venue; the in-section ones keep the bare label, because they sit under a
 * visible heading that already supplies the context.
 *
 * The constraint that makes this delicate is WCAG 2.5.3 Label in Name (A):
 * adding an `aria-label` to a control that has visible text is only legal if
 * the accessible name still CONTAINS that visible text, verbatim and in order
 * — otherwise a speech-input user saying the words they can see stops matching
 * the control. So each assertion below checks containment, not equality, and
 * checks the name actually changed. Real `enMessages` are used rather than
 * echoed keys precisely so the containment check is meaningful.
 *
 * Page-wide uniqueness is not provable from here (the twins live in other
 * components); that was verified in the browser with a full accessible-name
 * scan.
 */

// Booking CTAs come from a trpc-backed hook. Both intents are offered so the
// rent CTA is covered too — it has the same twin problem.
vi.mock("../blocks/use-place-booking-options", () => ({
  useBookingCtas: () => [
    { kind: "play", intent: "PERFORM" },
    { kind: "rent", intent: "RENT" },
  ],
}));
vi.mock("@/hooks/useSessionGate", () => ({
  useSessionGate: () => ({ isSignedIn: true, isPending: false }),
}));
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));
vi.mock("@/components/navigation/page-primary-action", () => ({
  usePagePrimaryAction: () => {},
}));
vi.mock("../BookingRequestDialog", () => ({
  BookingRequestDialog: () => null,
}));

// Islands with their own trpc/session/overlay dependencies, none of which
// carries a name this test is about. DirectionsDropdown is deliberately NOT
// mocked — its trigger is one of the two controls under test.
vi.mock("../FollowButton", () => ({ FollowButton: () => null }));
vi.mock("../PlaceHeroActions", () => ({ PlaceHeroActions: () => null }));
vi.mock("../EditPageButton", () => ({ EditPageButton: () => null }));
vi.mock("../blocks/RateVenueModal", () => ({ RateVenueModal: () => null }));
// The claim chip renders for real so the uniqueness check below covers its
// name too; only its data and wizard are stubbed. SYNTHETIC with the fixture
// below: see the note on PLACE.
vi.mock("@/trpc", () => ({
  trpc: {
    places: {
      getPlaceClaimEligibility: {
        useQuery: () => ({
          data: { state: "claimable" },
          isError: false,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));
vi.mock("@/components/places/claim", () => ({
  ClaimVenueWizard: () => null,
}));

import { PlaceHero } from "../headers/PlaceHero";

const DISPLAY_NAME = "The Bat Cave";

const PAGE = {
  id: "page-1",
  ownerType: "PLACE",
  ownerId: "place-1",
  slug: "the-bat-cave-a1b2c3d4",
  displayName: DISPLAY_NAME,
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC",
  allowFollows: true,
  showFollowerCount: true,
  category: "venue",
  templateAppliedCategories: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as EntityPageRecord;

// An EXACT venue (so the directions trigger renders) that is verified and
// accepting booking requests (so the two booking CTAs render).
//
// SYNTHETIC: `verified` and `claimable` are never both true on a real place
// (a VERIFIED place is `already_claimed`), and the booking CTAs need
// `verified`. Both are set so EVERY control the hero can render is on screen
// at once, which is the point of a name-uniqueness check.
const PLACE = {
  type: "PLACE",
  id: "place-1",
  name: DISPLAY_NAME,
  verified: true,
  claimable: true,
  acceptsBookingRequests: true,
  locationIsExact: true,
  locationHidden: false,
  formattedAddress: "1007 Mountain Drive, Gotham",
  city: "Gotham",
  region: "NJ",
  lat: 40.7,
  lng: -74.1,
} as unknown as Extract<EntitySummary, { type: "PLACE" }>;

function renderHero() {
  return render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <PlaceHero page={PAGE} entity={PLACE} />
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );
}

/** The visible label is what a speech-input user can read off the screen. */
function expectLabelInName(control: HTMLElement, visible: string) {
  const name = control.getAttribute("aria-label") ?? control.textContent ?? "";
  expect(name).toContain(visible);
  expect(name).not.toBe(visible);
  expect(name).toContain(DISPLAY_NAME);
}

describe("hero controls carry venue-qualified accessible names", () => {
  it("names the venue on the directions trigger", () => {
    renderHero();
    const trigger = screen.getByRole("button", {
      name: "Get directions to The Bat Cave",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    // Visible text is untouched — only the accessible name grew.
    expect(trigger.textContent).toContain("Get directions");
    expectLabelInName(trigger, "Get directions");
  });

  it("names the venue on both booking CTAs", () => {
    renderHero();
    const play = screen.getByRole("button", {
      name: "Play here at The Bat Cave",
    });
    const rent = screen.getByRole("button", {
      name: "Rent or use a space at The Bat Cave",
    });
    expect(play.textContent).toContain("Play here");
    expect(rent.textContent).toContain("Rent or use a space");
    expectLabelInName(play, "Play here");
    expectLabelInName(rent, "Rent or use a space");
  });

  it("renders the claim chip with its own accessible name", () => {
    renderHero();
    expect(
      screen.getByRole("button", { name: "Claim this place" }),
    ).toBeTruthy();
  });

  it("leaves no two hero controls sharing an accessible name", () => {
    renderHero();
    const names = screen
      .getAllByRole("button")
      .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim())
      .filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
  });
});
