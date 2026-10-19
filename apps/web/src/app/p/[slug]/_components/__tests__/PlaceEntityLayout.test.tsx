import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import type { EntityPageContentData } from "../EntityPageContent";

/**
 * PlaceEntityLayout: the main-column filter chain composes three suppressions
 * (logistics-owned kinds, `request_to_play`, and the about-vs-hero-bio dedupe).
 * These tests pin the dedupe arm — suppress an about block only when it adds
 * nothing beyond the hero bio (equal / contained), keep it when it carries
 * more — and that the composed chain doesn't regress the other suppressions.
 */

vi.mock("../headers/PlaceHero", () => ({
  PlaceHero: () => <div data-testid="place-hero" />,
}));

vi.mock("../PlaceLogisticsCard", () => ({
  PlaceLogisticsCard: () => <div data-testid="logistics-card" />,
}));

vi.mock("../PlaceEventsSection", () => ({
  PlaceEventsSection: () => <div data-testid="events-section" />,
}));

// Claimed-venue owner row (FR-008). Stubbed here: it is a client island with
// its own trpc/session/overlay dependencies and its own test file; this suite
// is about the main-column block filter chain.
vi.mock("@/components/places/claim", () => ({
  PlaceOwnerRow: () => <div data-testid="place-owner-row" />,
}));

// BlockRenderer stub — render the block kind so column membership is assertable.
vi.mock("../blocks", () => ({
  BlockRenderer: ({ block }: { block: PageBlockRecord }) => (
    <div data-block-kind={block.kind} />
  ),
}));

// The notice is a client island with its own suite; here only WHETHER it
// mounts, and with what, matters.
vi.mock("@/components/community/CommunityListingNotice", () => ({
  placeClaimableFrom: (entity: object) =>
    "claimable" in entity && entity.claimable === true,
  CommunityListingNotice: ({
    subject,
    lastChangedAt,
    placeClaimable,
  }: {
    subject?: string;
    lastChangedAt?: string;
    placeClaimable?: boolean;
  }) => (
    <div
      data-testid={`community-${subject}-notice`}
      data-last-changed={lastChangedAt}
      data-claimable={String(placeClaimable)}
    />
  ),
}));

import { PlaceEntityLayout } from "../PlaceEntityLayout";

function block(
  kind: string,
  data: Record<string, unknown> = {},
): PageBlockRecord {
  return {
    id: `block-${kind}`,
    pageId: "page-1",
    kind,
    orderIndex: 0,
    data,
    visible: true,
  };
}

type PlaceEntity = Extract<EntityPageContentData["entity"], { type: "PLACE" }>;

function makeData(
  blocks: PageBlockRecord[],
  bio: string | null = null,
): EntityPageContentData & { entity: PlaceEntity } {
  return {
    page: {
      id: "page-1",
      ownerType: "PLACE",
      ownerId: "place-1",
      slug: "the-basement-a1b2c3d4",
      displayName: "The Basement",
      bio,
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
    blocks,
    theme: null,
    entity: {
      type: "PLACE",
      id: "place-1",
      name: "The Basement",
      formattedAddress: "917 Woodland St, Nashville, TN",
      city: "Nashville",
      region: "TN",
      lat: 36.17,
      lng: -86.75,
      website: null,
    },
  };
}

function renderLayout(blocks: PageBlockRecord[], bio: string | null = null) {
  return render(
    <PlaceEntityLayout
      data={makeData(blocks, bio)}
      themeVars={{}}
      fontKey="montserrat"
    />,
  );
}

function kinds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-block-kind]")).map(
    (el) => el.getAttribute("data-block-kind") ?? "",
  );
}

describe("PlaceEntityLayout about/bio dedupe", () => {
  it("suppresses an about block that equals the hero bio (whitespace-insensitive)", () => {
    const { container } = renderLayout(
      [block("about", { content: "  A DIY room under\nGrimey's. " })],
      "A DIY room under Grimey's.",
    );
    expect(kinds(container)).not.toContain("about");
  });

  it("suppresses an about block fully contained in the hero bio", () => {
    const { container } = renderLayout(
      [block("about", { content: "A DIY room under Grimey's." })],
      "A DIY room under Grimey's. All ages, most nights.",
    );
    expect(kinds(container)).not.toContain("about");
  });

  it("keeps an about block that carries MORE than the hero bio", () => {
    const { container } = renderLayout(
      [
        block("about", {
          content: "A DIY room under Grimey's. All ages, most nights.",
        }),
      ],
      "A DIY room under Grimey's.",
    );
    expect(kinds(container)).toContain("about");
  });

  it("keeps an about block when the page has no hero bio", () => {
    const { container } = renderLayout(
      [block("about", { content: "A DIY room under Grimey's." })],
      null,
    );
    expect(kinds(container)).toContain("about");
  });

  it("composes with the existing request_to_play + logistics suppressions", () => {
    const { container } = renderLayout(
      [
        block("about", { content: "A DIY room under Grimey's." }),
        block("request_to_play", {}),
        block("links", { links: [] }),
        block("location_map", {}),
        block("upcoming_events", { events: [] }),
        block("photos", { photos: [] }),
      ],
      "A DIY room under Grimey's.",
    );
    const rendered = kinds(container);
    expect(rendered).not.toContain("about"); // dedupe (adds nothing)
    expect(rendered).not.toContain("request_to_play"); // hero CTA owns it
    expect(rendered).not.toContain("links"); // logistics sidebar owns it
    expect(rendered).not.toContain("location_map"); // logistics sidebar owns it
    expect(rendered).not.toContain("upcoming_events"); // events section owns it
    expect(rendered).toContain("photos"); // untouched kinds still render
  });
});

describe("PlaceEntityLayout community attribution (moderator-place-page D7)", () => {
  it.each([
    [true, "true"],
    [false, "false"],
  ])("passes the place's claimable flag (%s) so the byline stays true", (claimable, attr) => {
    const base = makeData([]);
    const { getByTestId } = render(
      <PlaceEntityLayout
        data={{
          ...base,
          entity: { ...base.entity, ...{ claimable } },
          communityAttribution: {
            maintainedByCommunity: true,
            lastUpdatedAt: "2026-10-12T15:00:00.000Z",
          },
        }}
        themeVars={{}}
        fontKey="montserrat"
      />,
    );
    expect(getByTestId("community-place-notice")).toHaveAttribute(
      "data-claimable",
      attr,
    );
  });

  it("renders the place notice while moderators' work is pending", () => {
    const { getByTestId } = render(
      <PlaceEntityLayout
        data={{
          ...makeData([]),
          communityAttribution: {
            maintainedByCommunity: true,
            lastUpdatedAt: "2026-10-12T15:00:00.000Z",
          },
        }}
        themeVars={{}}
        fontKey="montserrat"
      />,
    );
    expect(getByTestId("community-place-notice")).toHaveAttribute(
      "data-last-changed",
      "2026-10-12T15:00:00.000Z",
    );
  });

  it("renders no notice without an attribution", () => {
    const { queryByTestId } = renderLayout([]);
    expect(queryByTestId("community-place-notice")).toBeNull();
  });
});
