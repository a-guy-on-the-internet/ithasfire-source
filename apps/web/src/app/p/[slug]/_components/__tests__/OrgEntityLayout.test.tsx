import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import type { EntityPageContentData } from "../EntityPageContent";

/**
 * OrgEntityLayout (band archetype): the zone partition must additively surface
 * the band kinds (music/video media zone, press + booking sidebar zones) and
 * lift `genre_tags` into the hero chips, WITHOUT regressing a promoter /
 * collective / generic org that lacks those kinds. These tests pin the zone
 * routing by kind and the genre lift.
 */

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

// Capture the genres OrgHero receives so we can assert the genre_tags lift.
vi.mock("../headers/OrgHero", () => ({
  OrgHero: ({ genres }: { genres?: string[] }) => (
    <div data-testid="org-hero" data-genres={(genres ?? []).join(",")} />
  ),
}));

// BlockRenderer stub — render the block kind so zone membership is assertable.
vi.mock("../blocks", () => ({
  BlockRenderer: ({ block }: { block: PageBlockRecord }) => (
    <div data-block-kind={block.kind} />
  ),
}));

vi.mock("../FollowButton", () => ({
  FollowButton: () => <button type="button">follow</button>,
}));

import { OrgEntityLayout } from "../OrgEntityLayout";

function block(kind: string, data: Record<string, unknown> = {}): PageBlockRecord {
  return {
    id: `block-${kind}`,
    pageId: "page-1",
    kind,
    orderIndex: 0,
    data,
    visible: true,
  };
}

function makeData(
  blocks: PageBlockRecord[],
  bio: string | null = null,
): EntityPageContentData & {
  entity: Extract<EntityPageContentData["entity"], { type: "ORGANIZATION" }>;
} {
  return {
    page: {
      id: "page-1",
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      slug: "the-band",
      displayName: "The Band",
      bio,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PUBLIC",
      allowFollows: true,
      showFollowerCount: true,
      category: "band",
      templateAppliedCategories: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    blocks,
    theme: null,
    entity: {
      type: "ORGANIZATION",
      id: "org-1",
      name: "The Band",
      slug: "the-band",
      trustTier: "BASIC",
      trustBadgeLabel: null,
    },
  };
}

function renderLayout(blocks: PageBlockRecord[], bio: string | null = null) {
  return render(
    <OrgEntityLayout
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

describe("OrgEntityLayout band-aware zones", () => {
  it("lifts genre_tags into the hero chips and suppresses it from the body", () => {
    const { container } = renderLayout([
      block("genre_tags", { tags: ["Indie Rock", "Shoegaze"] }),
    ]);
    expect(screen.getByTestId("org-hero").getAttribute("data-genres")).toBe(
      "Indie Rock,Shoegaze",
    );
    // Never rendered as a body block.
    expect(kinds(container)).not.toContain("genre_tags");
  });

  it("renders music and video blocks (the media zone)", () => {
    const { container } = renderLayout([
      block("music", { embeds: [] }),
      block("video", { videos: [] }),
    ]);
    expect(kinds(container)).toEqual(
      expect.arrayContaining(["music", "video"]),
    );
  });

  it("renders press and booking_info blocks (sidebar band zones)", () => {
    const { container } = renderLayout([
      block("press", { mentions: [] }),
      block("booking_info", {}),
    ]);
    expect(kinds(container)).toEqual(
      expect.arrayContaining(["press", "booking_info"]),
    );
  });

  it("still renders team and about, and suppresses managed_places/past_events stubs", () => {
    const { container } = renderLayout([
      block("about", {}),
      block("team", { members: [] }),
      block("managed_places", {}),
      block("past_events", {}),
    ]);
    const rendered = kinds(container);
    expect(rendered).toEqual(expect.arrayContaining(["about", "team"]));
    expect(rendered).not.toContain("managed_places");
    expect(rendered).not.toContain("past_events");
  });

  it("does not regress an org lacking band kinds (only its own zones render)", () => {
    const { container } = renderLayout([
      block("about", {}),
      block("links", { links: [] }),
      block("upcoming_events", { events: [{ id: "e1", title: "Show", date: "2026-01-01" }] }),
    ]);
    const rendered = kinds(container);
    // No band-specific zones leak in when there are no band kinds.
    expect(rendered).not.toContain("music");
    expect(rendered).not.toContain("video");
    expect(rendered).not.toContain("press");
    expect(rendered).not.toContain("booking_info");
    // Its own blocks still render.
    expect(rendered).toEqual(
      expect.arrayContaining(["about", "links", "upcoming_events"]),
    );
    // No genres lifted.
    expect(screen.getByTestId("org-hero").getAttribute("data-genres")).toBe("");
  });

  it("suppresses an about block that duplicates the hero bio", () => {
    const { container } = renderLayout(
      [block("about", { content: "  We put on DIY shows.\n" })],
      "We put on DIY shows.",
    );
    expect(kinds(container)).not.toContain("about");
  });

  it("keeps an about block whose content differs from the hero bio", () => {
    const { container } = renderLayout(
      [block("about", { content: "Founded over tacos in 2019." })],
      "We put on DIY shows.",
    );
    expect(kinds(container)).toContain("about");
  });
});
