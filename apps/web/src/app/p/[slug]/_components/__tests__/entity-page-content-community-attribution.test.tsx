import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EntityPageContentData } from "../EntityPageContent";

/**
 * The freeform ("stack" / "grid") PLACE layout carries the community
 * attribution too (moderator-place-page D7), with the place's claimable flag
 * so the byline stays true after a claim is approved but before the owner
 * keeps or clears the moderators' work.
 */

vi.mock("@/components/community/CommunityListingNotice", () => ({
  placeClaimableFrom: (entity: object) =>
    "claimable" in entity && entity.claimable === true,
  CommunityListingNotice: ({
    subject,
    placeClaimable,
  }: {
    subject?: string;
    placeClaimable?: boolean;
  }) => (
    <div
      data-testid={`community-${subject}-notice`}
      data-claimable={String(placeClaimable)}
    />
  ),
}));
vi.mock("../EditPageButton", () => ({ EditPageButton: () => null }));
vi.mock("../PlaceHeroActions", () => ({ PlaceHeroActions: () => null }));
vi.mock("../headers/HeroClaimPlaceButton", () => ({
  HeroClaimPlaceButton: () => null,
}));
vi.mock("../EntityHeroActions", () => ({ EntityHeroActions: () => null }));
vi.mock("../blocks", () => ({ BlockRenderer: () => null }));
vi.mock("../headers", () => ({
  HumanPageHeader: () => null,
  OrgPageHeader: () => null,
  PlacePageHeader: () => null,
}));
vi.mock("../PlaceEntityLayout", () => ({ PlaceEntityLayout: () => null }));
vi.mock("../HumanEntityLayout", () => ({ HumanEntityLayout: () => null }));
vi.mock("../OrgEntityLayout", () => ({ OrgEntityLayout: () => null }));

import { EntityPageContent } from "../EntityPageContent";

function data(claimable: boolean, attribution: boolean): EntityPageContentData {
  return {
    page: {
      id: "page-1",
      ownerType: "PLACE",
      ownerId: "place-1",
      slug: "the-basement",
      displayName: null,
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
    },
    blocks: [],
    theme: { layoutKey: "stack" } as EntityPageContentData["theme"],
    entity: {
      type: "PLACE",
      id: "place-1",
      name: "The Basement",
      formattedAddress: null,
      city: null,
      region: null,
      lat: null,
      lng: null,
      claimable,
    } as EntityPageContentData["entity"],
    communityAttribution: attribution
      ? {
          maintainedByCommunity: true,
          lastUpdatedAt: "2026-10-12T15:00:00.000Z",
        }
      : null,
  };
}

describe("EntityPageContent freeform PLACE: community attribution", () => {
  it("passes claimable=true while nobody has claimed the place", () => {
    render(<EntityPageContent data={data(true, true)} />);
    expect(screen.getByTestId("community-place-notice")).toHaveAttribute(
      "data-claimable",
      "true",
    );
  });

  it("passes claimable=false once the place is claimed but unreviewed", () => {
    render(<EntityPageContent data={data(false, true)} />);
    expect(screen.getByTestId("community-place-notice")).toHaveAttribute(
      "data-claimable",
      "false",
    );
  });

  it("renders no notice without an attribution", () => {
    render(<EntityPageContent data={data(true, false)} />);
    expect(screen.queryByTestId("community-place-notice")).toBeNull();
  });
});
