import { describe, expect, it } from "vitest";

import { buildEntityPageMetadata } from "../buildEntityPageMetadata";
import type { SeoEntityPage } from "../entity-page-types";

const BASE_PAGE: SeoEntityPage = {
  url: "https://ithasfire.com/p/alice",
  ownerType: "HUMAN",
  displayName: "Alice",
  bio: "Singer-songwriter from Austin",
  avatarUrl: "https://cdn.example.com/alice.jpg",
  bannerUrl: "https://cdn.example.com/alice-banner.jpg",
  entity: { type: "HUMAN", id: "h1", name: "Alice" },
};

describe("buildEntityPageMetadata", () => {
  it("builds bare title (root template adds the brand)", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });

    expect(meta.title).toBe("Alice");
    expect(String(meta.title)).not.toContain("Ithas Fire");
    expect((meta.openGraph as { siteName?: string }).siteName).toBe(
      "Ithas Fire",
    );
  });

  it("uses bio as description", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });

    expect(meta.description).toBe("Singer-songwriter from Austin");
  });

  it("falls back to generic description when bio is null", () => {
    const page = { ...BASE_PAGE, bio: null };
    const meta = buildEntityPageMetadata({ page, siteName: "Ithas Fire" });

    expect(meta.description).toBe("Alice on Ithas Fire");
  });

  it("sets canonical URL", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });

    expect(meta.alternates?.canonical).toBe(
      "https://ithasfire.com/p/alice",
    );
  });

  it("includes OG metadata", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });
    const og = meta.openGraph as Record<string, unknown>;

    expect(og.type).toBe("website");
    expect(og.title).toBe("Alice");
    expect(og.siteName).toBe("Ithas Fire");
  });

  it("includes Twitter card", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });
    const tw = meta.twitter as Record<string, unknown>;

    expect(tw.card).toBe("summary_large_image");
    expect(tw.title).toBe("Alice");
  });

  it("prefers banner over avatar for OG image", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });
    const og = meta.openGraph as Record<string, unknown>;

    const images = og.images as Array<{ url: string }>;
    expect(images[0]!.url).toBe("https://cdn.example.com/alice-banner.jpg");
  });

  it("falls back to avatar when no banner", () => {
    const page = { ...BASE_PAGE, bannerUrl: null };
    const meta = buildEntityPageMetadata({ page, siteName: "Ithas Fire" });
    const og = meta.openGraph as Record<string, unknown>;

    const images = og.images as Array<{ url: string }>;
    expect(images[0]!.url).toBe("https://cdn.example.com/alice.jpg");
  });

  it("uses summary card when no images", () => {
    const page = { ...BASE_PAGE, avatarUrl: null, bannerUrl: null };
    const meta = buildEntityPageMetadata({ page, siteName: "Ithas Fire" });
    const tw = meta.twitter as Record<string, unknown>;

    expect(tw.card).toBe("summary");
  });

  it("sets robots to index + follow", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
    });
    const robots = meta.robots as Record<string, boolean>;

    expect(robots.index).toBe(true);
    expect(robots.follow).toBe(true);
  });

  it("respects shouldIndex = false", () => {
    const meta = buildEntityPageMetadata({
      page: BASE_PAGE,
      siteName: "Ithas Fire",
      shouldIndex: false,
    });
    const robots = meta.robots as Record<string, boolean>;

    expect(robots.index).toBe(false);
    expect(robots.follow).toBe(false);
  });
});
