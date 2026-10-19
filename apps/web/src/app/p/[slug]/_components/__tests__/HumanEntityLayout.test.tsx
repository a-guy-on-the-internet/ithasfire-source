import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import type { EntityPageContentData } from "../EntityPageContent";

/**
 * HumanEntityLayout: the hero's genre chips resolve with owner-curated
 * `genre_tags` block tags winning over the settings fallback
 * (`entity.genreTags`), and the hero Booking CTA only arms when a visible
 * `booking_info` block carries an actionable contact means (email / phone /
 * booking URL — the same safe-href predicates the block renders with).
 */

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

// Capture the props HumanHero receives so the lift/fallback is assertable.
vi.mock("../headers/HumanHero", () => ({
  HumanHero: ({
    genres,
    hasBooking,
    bookingAnchorId,
  }: {
    genres: string[];
    hasBooking: boolean;
    bookingAnchorId: string;
  }) => (
    <div
      data-testid="human-hero"
      data-genres={genres.join(",")}
      data-has-booking={String(hasBooking)}
      data-booking-anchor={bookingAnchorId}
    />
  ),
}));

vi.mock("../blocks", () => ({
  BlockRenderer: ({ block }: { block: PageBlockRecord }) => (
    <div data-block-kind={block.kind} />
  ),
}));

vi.mock("../FollowButton", () => ({
  FollowButton: () => <button type="button">follow</button>,
}));

import { HumanEntityLayout } from "../HumanEntityLayout";

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

type HumanEntity = Extract<
  EntityPageContentData["entity"],
  { type: "HUMAN" }
>;

function makeData(
  blocks: PageBlockRecord[],
  entityOverrides: Partial<HumanEntity> = {},
  bio: string | null = null,
): EntityPageContentData & { entity: HumanEntity } {
  return {
    page: {
      id: "page-1",
      ownerType: "HUMAN",
      ownerId: "human-1",
      slug: "jo-artist",
      displayName: "Jo Artist",
      bio,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PUBLIC",
      allowFollows: true,
      showFollowerCount: true,
      category: "musician",
      templateAppliedCategories: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    blocks,
    theme: null,
    entity: {
      type: "HUMAN",
      id: "human-1",
      name: "Jo Artist",
      jobs: [],
      genreTags: [],
      otherJobDescription: null,
      ...entityOverrides,
    },
  };
}

function renderLayout(
  blocks: PageBlockRecord[],
  entityOverrides: Partial<HumanEntity> = {},
  bio: string | null = null,
) {
  return render(
    <HumanEntityLayout
      data={makeData(blocks, entityOverrides, bio)}
      themeVars={{}}
      fontKey="montserrat"
    />,
  );
}

function hero() {
  return screen.getByTestId("human-hero");
}

describe("HumanEntityLayout genre resolution", () => {
  it("block genre_tags win over the settings fallback", () => {
    renderLayout(
      [block("genre_tags", { tags: ["Indie Rock", "Shoegaze"] })],
      { genreTags: ["Country"] },
    );
    expect(hero().getAttribute("data-genres")).toBe("Indie Rock,Shoegaze");
  });

  it("falls back to entity.genreTags (trimmed + deduped) with no block", () => {
    renderLayout([], { genreTags: [" Jazz ", "jazz", "", "Soul"] });
    expect(hero().getAttribute("data-genres")).toBe("Jazz,Soul");
  });

  it("renders no genres when neither source has any", () => {
    renderLayout([]);
    expect(hero().getAttribute("data-genres")).toBe("");
  });
});

describe("HumanEntityLayout booking CTA arming", () => {
  it("arms the hero CTA and anchors the footer when booking_info has an email", () => {
    const { container } = renderLayout([
      block("booking_info", { contactEmail: "book@example.com" }),
    ]);
    expect(hero().getAttribute("data-has-booking")).toBe("true");
    // The anchor id is minted PER INSTANCE (useAnchorId) — the editor mounts
    // this layout twice, so a module constant would collide. Assert the hero
    // and the footer agree on whatever id this instance got, and that it still
    // reads as the booking anchor.
    const anchorId = hero().getAttribute("data-booking-anchor");
    expect(anchorId).toMatch(/^human-booking-/);
    expect(container.querySelector(`#${anchorId}`)).not.toBeNull();
  });

  it("mints a DIFFERENT booking anchor id for a second mounted copy", () => {
    // The entity page editor renders the authoring canvas and the preview at
    // once; a shared id sent the hero's getElementById to the hidden copy.
    const first = renderLayout([
      block("booking_info", { contactEmail: "book@example.com" }),
    ]);
    const firstId = within(first.container)
      .getByTestId("human-hero")
      .getAttribute("data-booking-anchor");
    const second = renderLayout([
      block("booking_info", { contactEmail: "book@example.com" }),
    ]);
    const secondId = within(second.container)
      .getByTestId("human-hero")
      .getAttribute("data-booking-anchor");

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    expect(document.querySelectorAll(`[id="${firstId}"]`)).toHaveLength(1);
  });

  it("arms on a valid bookingUrl or contactPhone alone", () => {
    for (const data of [
      { bookingUrl: "https://example.com/book" },
      { contactPhone: "+1 (615) 555-0100" },
    ]) {
      const { unmount } = renderLayout([block("booking_info", data)]);
      expect(hero().getAttribute("data-has-booking")).toBe("true");
      unmount();
    }
  });

  it("does not arm when booking_info only carries notes or invalid values", () => {
    for (const data of [
      { notes: "Email us via our label." },
      { contactEmail: "not-an-email", bookingUrl: "javascript:alert(1)" },
    ]) {
      const { unmount } = renderLayout([block("booking_info", data)]);
      expect(hero().getAttribute("data-has-booking")).toBe("false");
      unmount();
    }
  });

  it("does not arm without a booking_info block, even with links present", () => {
    renderLayout([block("links", { links: [] })]);
    expect(hero().getAttribute("data-has-booking")).toBe("false");
  });
});

describe("HumanEntityLayout about/bio dedupe", () => {
  it("suppresses an about block that duplicates the hero bio", () => {
    const { container } = renderLayout(
      [block("about", { content: "Songwriter from  East Nashville.\n" })],
      {},
      "Songwriter from East Nashville.",
    );
    expect(
      container.querySelector('[data-block-kind="about"]'),
    ).toBeNull();
  });

  it("keeps an about block whose content differs from the hero bio", () => {
    const { container } = renderLayout(
      [block("about", { content: "Three records, two tours, one van." })],
      {},
      "Songwriter from East Nashville.",
    );
    expect(
      container.querySelector('[data-block-kind="about"]'),
    ).not.toBeNull();
  });
});
