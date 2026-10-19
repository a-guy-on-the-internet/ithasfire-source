import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";
import type { EntityPageContentData } from "../EntityPageContent";

/**
 * A VENUE HAS ONE NAME, AND IT IS `Place.name`.
 *
 * `PageFieldsEditor` no longer renders a display-name field for a PLACE owner
 * and omits the key from a PLACE save, so an `EntityPage.displayName` that has
 * drifted from the venue's real name is a name NOBODY CAN STILL EDIT. Every
 * PLACE reader therefore resolves `entity.name` first. The column is kept and
 * its value preserved — only the read order changed.
 *
 * HUMAN and ORGANIZATION are the regression risk and matter more here: their
 * `displayName` is still the editable field and must still win. The two
 * expressions are otherwise identical, which is how an autopilot edit breaks
 * an artist's stage name while "fixing" venues.
 *
 * Every fixture below gives the page a displayName that DIFFERS from the
 * entity name, so each assertion can only pass one way round.
 */

// maplibre-gl (reached via PlaceLogisticsCard → LocationMapPreview) calls
// `URL.createObjectURL` at IMPORT time, which jsdom lacks. Nothing here shows
// a map, so stub the module.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: () => null,
}));

// Client islands with trpc/session/overlay dependencies. The two ACTIONS
// components are stubbed to echo the name props under test rather than
// dropped, because those props are half the surface this pins.
vi.mock("../FollowButton", () => ({ FollowButton: () => null }));
vi.mock("../EditPageButton", () => ({ EditPageButton: () => null }));
vi.mock("../headers/HeroClaimPlaceButton", () => ({
  HeroClaimPlaceButton: () => null,
}));
vi.mock("../blocks/RateVenueModal", () => ({ RateVenueModal: () => null }));
vi.mock("../BookingRequestDialog", () => ({
  BookingRequestDialog: () => null,
}));
vi.mock("../blocks/use-place-booking-options", () => ({
  useBookingCtas: () => [],
}));
vi.mock("@/hooks/useSessionGate", () => ({
  useSessionGate: () => ({ isSignedIn: false, isPending: false }),
}));
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));
vi.mock("@/components/navigation/page-primary-action", () => ({
  usePagePrimaryAction: () => {},
}));
vi.mock("../PlaceHeroActions", () => ({
  PlaceHeroActions: ({
    placeName,
    shareTitle,
  }: {
    placeName: string;
    shareTitle: string;
  }) => (
    <div
      data-testid="place-hero-actions"
      data-place-name={placeName}
      data-share-title={shareTitle}
    />
  ),
}));
vi.mock("../EntityHeroActions", () => ({
  EntityHeroActions: ({ subjectName }: { subjectName: string }) => (
    <div data-testid="entity-hero-actions" data-subject-name={subjectName} />
  ),
}));

import { PlaceHero } from "../headers/PlaceHero";
import { PlacePageHeader } from "../headers/PlacePageHeader";
import { EntityPageContent } from "../EntityPageContent";

const PLACE_NAME = "The Basement East";
const STALE_PAGE_NAME = "Basement East (OLD NAME)";

function withProviders(node: ReactElement) {
  return render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          {node}
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );
}

function makePage(overrides: Partial<EntityPageRecord> = {}): EntityPageRecord {
  return {
    id: "page-1",
    ownerType: "PLACE",
    ownerId: "place-1",
    slug: "the-basement-east-a1b2c3d4",
    displayName: STALE_PAGE_NAME,
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
    ...overrides,
  } as unknown as EntityPageRecord;
}

const PLACE = {
  type: "PLACE",
  id: "place-1",
  name: PLACE_NAME,
  verified: true,
  claimable: false,
  acceptsBookingRequests: false,
  locationIsExact: false,
  locationHidden: true,
  formattedAddress: null,
  city: "Nashville",
  region: "TN",
  lat: null,
  lng: null,
} as unknown as Extract<EntitySummary, { type: "PLACE" }>;

const HUMAN = {
  type: "HUMAN",
  id: "human-1",
  name: "Legal Human Name",
} as unknown as Extract<EntitySummary, { type: "HUMAN" }>;

const ORG = {
  type: "ORGANIZATION",
  id: "org-1",
  name: "Registered Org LLC",
  slug: "demo-org",
  trustTier: "STANDARD",
  trustBadgeLabel: null,
} as unknown as Extract<EntitySummary, { type: "ORGANIZATION" }>;

/** Freeform ("stack") theme — the layout that renders the `.pageActions` row. */
const STACK_THEME = {
  id: "theme-1",
  pageId: "page-1",
  colorPrimary: null,
  colorBg: null,
  colorText: null,
  fontKey: null,
  layoutKey: "stack",
};

function contentData(
  entity: EntitySummary,
  page: EntityPageRecord,
): EntityPageContentData {
  return {
    page,
    blocks: [],
    theme: STACK_THEME,
    entity,
  } as unknown as EntityPageContentData;
}

describe("PlaceHero — the venue's own name wins", () => {
  it("renders Place.name as the <h1>, not the stale page displayName", () => {
    withProviders(<PlaceHero page={makePage()} entity={PLACE} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      PLACE_NAME,
    );
    expect(screen.queryByText(STALE_PAGE_NAME)).toBeNull();
  });

  it("carries Place.name into the share / overflow actions too", () => {
    withProviders(<PlaceHero page={makePage()} entity={PLACE} />);

    const actions = screen.getByTestId("place-hero-actions");
    expect(actions.dataset.placeName).toBe(PLACE_NAME);
    expect(actions.dataset.shareTitle).toBe(PLACE_NAME);
  });

  it("falls back to the page displayName when the venue has no name", () => {
    withProviders(
      <PlaceHero
        page={makePage()}
        entity={{ ...PLACE, name: null as unknown as string }}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      STALE_PAGE_NAME,
    );
  });
});

describe("PlacePageHeader — the venue's own name wins", () => {
  it("renders Place.name as the <h1>, not the stale page displayName", () => {
    withProviders(<PlacePageHeader page={makePage()} entity={PLACE} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      PLACE_NAME,
    );
    expect(screen.queryByText(STALE_PAGE_NAME)).toBeNull();
  });
});

describe("EntityPageContent (freeform layout) — the PLACE arm", () => {
  it("names the venue by Place.name in the page-actions row", () => {
    withProviders(<EntityPageContent data={contentData(PLACE, makePage())} />);

    const actions = screen.getByTestId("place-hero-actions");
    expect(actions.dataset.placeName).toBe(PLACE_NAME);
    expect(actions.dataset.shareTitle).toBe(PLACE_NAME);
    // Same render also exercises PlacePageHeader, the freeform PLACE header.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      PLACE_NAME,
    );
  });
});

// ── Regression guards. These matter MORE than the PLACE cases above. ──────

describe("EntityPageContent (freeform layout) — HUMAN and ORG keep displayName", () => {
  it("keeps the page displayName for a HUMAN", () => {
    const page = makePage({
      ownerType: "HUMAN",
      ownerId: "human-1",
      displayName: "Stage Name",
      slug: "stage-name-a1b2c3d4",
    });
    withProviders(<EntityPageContent data={contentData(HUMAN, page)} />);

    expect(screen.getByTestId("entity-hero-actions").dataset.subjectName).toBe(
      "Stage Name",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Stage Name",
    );
    expect(screen.queryByText("Legal Human Name")).toBeNull();
  });

  it("keeps the page displayName for an ORGANIZATION", () => {
    const page = makePage({
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      displayName: "Act Name",
      slug: "act-name-a1b2c3d4",
    });
    withProviders(<EntityPageContent data={contentData(ORG, page)} />);

    expect(screen.getByTestId("entity-hero-actions").dataset.subjectName).toBe(
      "Act Name",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Act Name",
    );
    expect(screen.queryByText("Registered Org LLC")).toBeNull();
  });
});
