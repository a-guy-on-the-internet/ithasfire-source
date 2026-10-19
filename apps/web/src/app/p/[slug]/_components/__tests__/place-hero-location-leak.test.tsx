/**
 * LEAK TEST — the venue HERO's directions affordance.
 *
 * The hero carries a second "Get directions" control, independent of the
 * sidebar's. It gated on `typeof entity.lat === "number"`, which is TRUE for a
 * venue that withholds its address with a circle: the coordinates it receives
 * are the deliberately-offset centre. So a withheld venue shipped a
 * prominent button offering to navigate someone to it, plus a copy-address
 * item inside the same menu.
 *
 * Fixing one of the two surfaces and not the other would have looked like a
 * fix, so both have their own test.
 */
import type { ReactElement, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { EntitySummary, EntityPageRecord } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

// The hero's other islands all reach for trpc / session / overlays. None of
// them is what this test is about. (Paths are relative to THIS file — vi.mock
// resolves from the test, not from the component under test.)
vi.mock("../FollowButton", () => ({
  FollowButton: () => <div data-testid="follow-button" />,
}));
vi.mock("../PlaceHeroActions", () => ({
  PlaceHeroActions: () => <div data-testid="hero-actions" />,
}));
vi.mock("../headers/HeroBookingRequestButton", () => ({
  HeroBookingRequestButton: () => <div data-testid="booking-button" />,
}));
// The rating CTA mounts RateVenueModal, which opens a trpc query + a session
// read on mount. Not what this test is about.
vi.mock("../headers/HeroRateVenueButton", () => ({
  HeroRateVenueButton: () => <div data-testid="rate-venue-button" />,
}));
// The claim chip reads eligibility over trpc + the session. Not what this
// test is about.
vi.mock("../headers/HeroClaimPlaceButton", () => ({
  HeroClaimPlaceButton: () => <div data-testid="claim-place-button" />,
}));
// Owner-only editor jump. It fires a trpc query + a session read on mount,
// neither of which has a provider here — and it is not what this test is
// about. Stubbed to null, i.e. the non-owner rendering.
vi.mock("../EditPageButton", () => ({
  EditPageButton: () => null,
}));

// Rendered as a REAL element (not null) so a regression that mounts it is
// visible to the assertions rather than silently swallowed by the mock.
vi.mock("@/components/actions/DirectionsDropdown", () => ({
  DirectionsDropdown: ({ labels }: { labels: { trigger: ReactNode } }) => (
    <button type="button" data-testid="directions-dropdown">
      {labels.trigger}
    </button>
  ),
}));

import { PlaceHero } from "../headers/PlaceHero";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

const PAGE = {
  id: "page-1",
  ownerType: "PLACE",
  ownerId: "place-1",
  slug: "the-bat-cave-a1b2c3d4",
  displayName: "The Bat Cave",
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

function place(overrides: Partial<PlaceEntity>): PlaceEntity {
  return {
    type: "PLACE",
    id: "place-1",
    name: "The Bat Cave",
    formattedAddress: null,
    city: "Nashville",
    region: "TN",
    lat: null,
    lng: null,
    ...overrides,
  } as PlaceEntity;
}

const renderHero = (entity: PlaceEntity): ReturnType<typeof render> =>
  render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <PlaceHero page={PAGE} entity={entity} />
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );

describe("PlaceHero directions affordance", () => {
  it("is absent for a venue withheld with a circle (offset coords are NOT a destination)", () => {
    renderHero(
      place({
        locationIsExact: false,
        locationHidden: false,
        locationRadiusMeters: 1200,
        lat: 36.1801,
        lng: -86.7355,
      }),
    );
    expect(screen.queryByTestId("directions-dropdown")).toBeNull();
  });

  it("is absent for a fully hidden venue", () => {
    renderHero(
      place({
        locationIsExact: false,
        locationHidden: true,
        locationRadiusMeters: null,
      }),
    );
    expect(screen.queryByTestId("directions-dropdown")).toBeNull();
  });

  it("is absent when the privacy flags are missing entirely (fail closed)", () => {
    renderHero(
      place({
        formattedAddress: "917 Woodland St, Nashville, TN",
        lat: 36.1789,
        lng: -86.7412,
      }),
    );
    expect(screen.queryByTestId("directions-dropdown")).toBeNull();
  });

  it("still shows the coarse city/region chip for a withheld venue", () => {
    // Coarse location is published in EVERY state on purpose — it is what
    // keeps a withheld venue findable without pinpointing it.
    renderHero(
      place({ locationIsExact: false, locationHidden: true }),
    );
    expect(screen.getByText("Nashville, TN")).toBeInTheDocument();
  });

  it("is present for an exact venue", () => {
    renderHero(
      place({
        locationIsExact: true,
        formattedAddress: "917 Woodland St, Nashville, TN",
        lat: 36.1789,
        lng: -86.7412,
      }),
    );
    expect(screen.getByTestId("directions-dropdown")).toBeInTheDocument();
  });
});
