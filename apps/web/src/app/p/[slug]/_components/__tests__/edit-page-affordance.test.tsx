import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";
import type { EntityPageContentData } from "../EntityPageContent";

/**
 * WHICH LAYOUTS CARRY THE OWNER'S WAY BACK TO THE EDITOR.
 *
 * The "Edit page" link used to mount from `EntityPageShell`, gated on the
 * entity TYPE and nothing else — so it covered every place layout for free.
 * Moving it into the venue hero's action row quietly narrowed that to the
 * STANDARD template: a venue whose owner had switched their page to "stack"
 * or "grid" renders `PlacePageHeader` on the freeform canvas, never
 * `PlaceHero`, and the `⋯` overflow carries no edit item. The owner was left
 * with no link back to their own editor.
 *
 * `EntityPageContent` is the branch point, so these render it for real at
 * every layout key and assert the affordance survives the branch. Nothing
 * here is about how the chip LOOKS — only about whether it is reachable.
 */

// The REAL `EditPageButton` renders in these tests; only its data source is
// stubbed. That source is a hook rather than a component because the venue
// page has TWO halves of this affordance — this chip and an item in the `⋯`
// menu on phones — and both must reach the same answer from one pair of
// requests. Driving the hook lets the same file cover where the chip mounts
// AND the ownership gate that decides whether it mounts at all.
const editorHref: { current: string | null } = { current: null };
vi.mock("../useVenueEditorLink", () => ({
  useVenueEditorLink: () => ({ href: editorHref.current }),
}));

// maplibre-gl calls `URL.createObjectURL` at IMPORT time, which jsdom lacks.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: () => null,
}));

// Every other island in both branches reaches for trpc / session / overlays.
// None of them is what this test is about.
vi.mock("../PlaceHeroActions", () => ({
  PlaceHeroActions: () => <div data-testid="place-hero-actions" />,
}));
vi.mock("../headers/HeroClaimPlaceButton", () => ({
  HeroClaimPlaceButton: () => <div data-testid="hero-claim-place" />,
}));
vi.mock("../EntityHeroActions", () => ({
  EntityHeroActions: () => <div data-testid="entity-hero-actions" />,
}));
vi.mock("../FollowButton", () => ({
  FollowButton: () => <div data-testid="follow-button" />,
}));
vi.mock("../headers/HeroBookingRequestButton", () => ({
  HeroBookingRequestButton: () => <div data-testid="booking-button" />,
}));
vi.mock("@/components/actions/DirectionsDropdown", () => ({
  DirectionsDropdown: () => <div data-testid="directions-dropdown" />,
}));
vi.mock("../PlaceLogisticsCard", () => ({
  PlaceLogisticsCard: () => <div data-testid="logistics-card" />,
}));
vi.mock("../PlaceEventsSection", () => ({
  PlaceEventsSection: () => <div data-testid="events-section" />,
}));
vi.mock("@/components/places/claim", () => ({
  PlaceOwnerRow: () => <div data-testid="place-owner-row" />,
  ClaimVenueWizard: () => null,
  OwnershipDisputeDialog: () => null,
}));
vi.mock("../blocks", () => ({
  BlockRenderer: () => null,
}));
// Mounted unconditionally by the hero's rate-venue CTA (it owns only an open
// flag) and calls a trpc hook before its `open` guard, so it needs the trpc
// context even while closed. Mocked at the MODAL rather than at the CTA so
// this file does not depend on which hero buttons currently exist.
vi.mock("../blocks/RateVenueModal", () => ({
  RateVenueModal: () => null,
}));

import { EntityPageContent } from "../EntityPageContent";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const PLACE_ID = "place-1";

function data(
  layoutKey: string | null,
  entityType: "PLACE" | "HUMAN" = "PLACE",
): EntityPageContentData {
  return {
    page: {
      id: "page-1",
      ownerType: entityType,
      ownerId: PLACE_ID,
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
      createdAt: NOW,
      updatedAt: NOW,
    },
    blocks: [],
    theme: layoutKey ? { layoutKey } : null,
    entity:
      entityType === "PLACE"
        ? {
            type: "PLACE",
            id: PLACE_ID,
            name: "The Bat Cave",
            formattedAddress: null,
            city: "Nashville",
            region: "TN",
            lat: null,
            lng: null,
          }
        : {
            type: "HUMAN",
            id: "human-1",
            name: "Selina Kyle",
          },
  } as unknown as EntityPageContentData;
}

const OWNER_HREF = "/admin/the-bat-cave/places/place-1/page";

/** The chip as a reader meets it: a link named by the visible label. */
const editChip = () =>
  screen.queryByRole("link", { name: /edit page/i });

const renderContent = (d: EntityPageContentData) =>
  render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <EntityPageContent data={d} />
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );

describe("the owner's Edit page affordance, per layout", () => {
  beforeEach(() => {
    editorHref.current = OWNER_HREF;
  });

  // "standard" is the app-controlled template: the chip rides PlaceHero's
  // action row.
  it("mounts on the STANDARD place template", () => {
    renderContent(data("standard"));
    expect(editChip()).toBeInTheDocument();
  });

  // "stack" / "grid" are the owner-controlled freeform canvas, which renders
  // PlacePageHeader and NO hero. This is the branch the hero-row move broke.
  it("mounts on the freeform STACK layout", () => {
    renderContent(data("stack"));
    expect(editChip()).toBeInTheDocument();
  });

  it("mounts on the freeform GRID layout", () => {
    renderContent(data("grid"));
    expect(editChip()).toBeInTheDocument();
  });

  // No stored layoutKey falls back to the per-owner-type default.
  it("mounts when no layout has been chosen at all", () => {
    renderContent(data(null));
    expect(editChip()).toBeInTheDocument();
  });

  // Order is part of the contract: the `⋯` overflow is last in the hero row
  // and must stay last here, so the edit chip precedes it in the DOM.
  it("precedes the ⋯ overflow on the freeform canvas", () => {
    const { container } = renderContent(data("stack"));
    const edit = editChip() as HTMLElement;
    const overflow = screen.getByTestId("place-hero-actions");
    expect(
      edit.compareDocumentPosition(overflow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ...and they share one row rather than stacking as loose siblings.
    expect(edit.parentElement).toBe(overflow.parentElement);
    expect(container.querySelector("[data-layout='stack']")).not.toBeNull();
  });

  // The component is place-scoped (it takes a placeId and calls the
  // place-scoped `places.getPlaceForEdit`), so HUMAN/ORG pages have no
  // equivalent. Pinned so "why is there no edit link on my artist page" is
  // answered by a test rather than by a bug report.
  it("does NOT mount on a non-place page", () => {
    renderContent(data("stack", "HUMAN"));
    expect(editChip()).toBeNull();
    expect(screen.getByTestId("entity-hero-actions")).toBeInTheDocument();
  });

  // A null href is what an anonymous viewer and a signed-in non-owner both
  // get from `useVenueEditorLink` (the ownership proof is server-side; see
  // that hook). Neither layout may render the chip for them.
  describe("a viewer who cannot edit gets nothing", () => {
    it.each(["standard", "stack", "grid"])("on the %s layout", (layout) => {
      editorHref.current = null;
      renderContent(data(layout));
      expect(editChip()).toBeNull();
    });
  });

  /**
   * NOT COVERED HERE, AND jsdom CANNOT COVER IT.
   *
   * Below 640px the chip is `display: none` and the `⋯` menu carries "Edit
   * page" as its first item instead; at 641px and up the reverse. That swap is
   * a CSS media query in a CSS module, and this suite runs under jsdom with
   * CSS-module imports stubbed to class-name objects — no stylesheet is
   * parsed, no media query is evaluated, and `getComputedStyle` sees only
   * inline styles. A test here could assert that a class NAME is on the
   * element, which would pass just as happily if the rule behind it were
   * deleted. That is not a guard, so it is not written.
   *
   * Both halves ARE pinned by what jsdom can see: this suite pins the chip's
   * presence and gate, and `PlaceHeroActions.test.tsx` pins the menu item's
   * gate, its position (first, above Share) and its navigation target. The
   * one-in-the-a11y-tree-at-a-time behaviour was verified in a real browser at
   * 320px and 1440px with an accessible-name scan.
   */
});
