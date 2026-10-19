import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";

/**
 * OrgHero (band archetype): the eyebrow label is category-aware — an org's
 * stored `category` selects the chip label, and genre chips lifted from the
 * layout render alongside it. These tests pin the label mapping (band /
 * collective / default) and the genre-chip render.
 */

vi.mock("@th/ui", () => ({
  // Key-echo translator (same convention as VenueStatsBlock.test.tsx).
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../FollowButton", () => ({
  FollowButton: () => <button type="button">follow</button>,
}));

vi.mock("../../ProfileShareButton", () => ({
  ProfileShareButton: ({ title }: { title: string }) => (
    <button type="button" data-share-title={title}>
      share
    </button>
  ),
}));

// The hero `⋯` overflow is a client island (session, overlay, report dialog,
// shared Popover) with its own test file — stubbed so these suites stay about
// the heroes' own gating logic.
vi.mock("../../EntityHeroActions", () => ({
  EntityHeroActions: () => <button type="button">more-actions</button>,
}));

// The CTA's internals (session, overlay, dialog) get their own test —
// here only the hero's gating logic is under test.
vi.mock("../HeroPerformerBookingButton", () => ({
  HeroPerformerBookingButton: () => (
    <button type="button">request-to-book</button>
  ),
}));

import { OrgHero } from "../OrgHero";

function makePage(category: string | null): EntityPageRecord {
  return {
    id: "page-1",
    ownerType: "ORGANIZATION",
    ownerId: "org-1",
    slug: "the-band",
    displayName: "The Band",
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: "PUBLIC",
    allowFollows: true,
    showFollowerCount: true,
    category,
    templateAppliedCategories: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const ENTITY: Extract<EntitySummary, { type: "ORGANIZATION" }> = {
  type: "ORGANIZATION",
  id: "org-1",
  name: "The Band",
  slug: "the-band",
  trustTier: "BASIC",
  trustBadgeLabel: null,
};

function renderHero(
  category: string | null,
  genres: string[] = [],
  entity: Extract<EntitySummary, { type: "ORGANIZATION" }> = ENTITY,
  hasContact = false,
) {
  return render(
    <OrgHero
      page={makePage(category)}
      entity={entity}
      contactAnchorId="org-contact"
      hasContact={hasContact}
      genres={genres}
    />,
  );
}

describe("OrgHero category-aware label", () => {
  it("renders the band label for category 'band'", () => {
    renderHero("band");
    expect(screen.getByText("profileStd.bandLabel")).toBeInTheDocument();
    expect(
      screen.queryByText("profileStd.promoterLabel"),
    ).not.toBeInTheDocument();
  });

  it("renders the collective label for category 'collective'", () => {
    renderHero("collective");
    expect(screen.getByText("profileStd.collectiveLabel")).toBeInTheDocument();
  });

  it("falls back to the promoter label for 'promoter', 'generic', and null", () => {
    for (const category of ["promoter", "generic", null] as const) {
      const { unmount } = renderHero(category);
      expect(screen.getByText("profileStd.promoterLabel")).toBeInTheDocument();
      expect(
        screen.queryByText("profileStd.bandLabel"),
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("renders genre chips passed from the layout (band archetype)", () => {
    renderHero("band", ["Indie Rock", "Shoegaze"]);
    expect(screen.getByText("Indie Rock")).toBeInTheDocument();
    expect(screen.getByText("Shoegaze")).toBeInTheDocument();
  });

  it("renders no genre chips when none are provided (promoter/collective unchanged)", () => {
    renderHero("promoter");
    // Only the label chip renders; no stray genre chips.
    expect(screen.getByText("profileStd.promoterLabel")).toBeInTheDocument();
  });
});

describe("OrgHero request-to-book CTA (organizer-booking-requests FR-009)", () => {
  it("does not render the CTA when the entity does not accept booking requests", () => {
    renderHero("band");
    expect(
      screen.queryByRole("button", { name: "request-to-book" }),
    ).not.toBeInTheDocument();
  });

  it("renders the CTA when the org act accepts booking requests", () => {
    renderHero("band", [], { ...ENTITY, acceptsBookingRequests: true });
    expect(
      screen.getByRole("button", { name: "request-to-book" }),
    ).toBeInTheDocument();
  });

  it("keeps the generic Contact jump alongside the CTA (distinct affordances)", () => {
    renderHero("band", [], { ...ENTITY, acceptsBookingRequests: true }, true);
    expect(
      screen.getByRole("button", { name: "request-to-book" }),
    ).toBeInTheDocument();
    expect(screen.getByText("places.contact")).toBeInTheDocument();
  });
});
