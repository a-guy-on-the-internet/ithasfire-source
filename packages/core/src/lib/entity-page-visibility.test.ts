import { describe, expect, it } from "vitest";

import {
  crawlablePageSlug,
  linkablePageSlug,
} from "./entity-page-visibility";

/**
 * The single policy that decides whether an EntityPage's slug may become a
 * link. The trap these guard is that a non-PUBLIC page KEEPS its slug in the
 * database — a bare `page?.slug ?? null` reads as correct and is not.
 */

const page = (visibility: "PUBLIC" | "PRIVATE" | "UNLISTED") => ({
  slug: "the-basement-east-a1b2c3d4",
  visibility,
});

describe("crawlablePageSlug — PUBLIC only", () => {
  it("returns the slug for a PUBLIC page", () => {
    expect(crawlablePageSlug(page("PUBLIC"))).toBe(
      "the-basement-east-a1b2c3d4",
    );
  });

  // PRIVATE: `get-public-page` throws PAGE_NOT_FOUND and the route calls
  // notFound(), so the slug resolves to a 404 for everyone, owner included.
  it("returns null for a PRIVATE page even though the slug exists", () => {
    expect(crawlablePageSlug(page("PRIVATE"))).toBeNull();
  });

  // UNLISTED renders fine — but the owner was told, in the page editor,
  // "Only people with the link can open it. It stays out of search and
  // browse." A sitemap or a search index is precisely that.
  it("returns null for an UNLISTED page — the owner opted out of discovery", () => {
    expect(crawlablePageSlug(page("UNLISTED"))).toBeNull();
  });

  it("returns null for a missing page (no EntityPage row at all)", () => {
    expect(crawlablePageSlug(null)).toBeNull();
    expect(crawlablePageSlug(undefined)).toBeNull();
  });

  it("treats an empty slug as no slug (it would build a bare `/p/`)", () => {
    expect(crawlablePageSlug({ slug: "", visibility: "PUBLIC" })).toBeNull();
  });

  // Fail closed: a visibility value added to the enum later must be excluded
  // by default rather than silently published.
  it("FAILS CLOSED on an unknown visibility value", () => {
    expect(
      crawlablePageSlug({
        slug: "x-11111111",
        visibility: "SOME_FUTURE_VALUE" as never,
      }),
    ).toBeNull();
  });
});

describe("linkablePageSlug — anything but PRIVATE", () => {
  it("returns the slug for a PUBLIC page", () => {
    expect(linkablePageSlug(page("PUBLIC"))).toBe("the-basement-east-a1b2c3d4");
  });

  // The looser gate exists for authenticated surfaces that ARE the link: the
  // claimant's own claims list, the owner's admin panel.
  it("KEEPS an UNLISTED page — these surfaces are the link it is meant for", () => {
    expect(linkablePageSlug(page("UNLISTED"))).toBe(
      "the-basement-east-a1b2c3d4",
    );
  });

  it("still refuses PRIVATE — that slug 404s for everyone", () => {
    expect(linkablePageSlug(page("PRIVATE"))).toBeNull();
  });

  it("returns null for a missing page", () => {
    expect(linkablePageSlug(null)).toBeNull();
    expect(linkablePageSlug(undefined)).toBeNull();
  });

  it("treats an empty slug as no slug", () => {
    expect(linkablePageSlug({ slug: "", visibility: "PUBLIC" })).toBeNull();
  });

  // The mirror of crawlablePageSlug's fail-closed test. This half was briefly
  // a DENYLIST (`=== "PRIVATE"`), which fails OPEN: adding a value to
  // PageVisibility — ARCHIVED for a soft-deleted page, say — would have handed
  // an owner a live link to a 404 with no line of code changing.
  it("FAILS CLOSED on an unknown visibility value", () => {
    expect(
      linkablePageSlug({
        slug: "x-11111111",
        visibility: "SOME_FUTURE_VALUE" as never,
      }),
    ).toBeNull();
  });

  it("admits exactly PUBLIC and UNLISTED, and nothing else", () => {
    // Enumerating the allowlist, so a new enum value cannot quietly join it.
    const admitted = (["PUBLIC", "PRIVATE", "UNLISTED"] as const).filter(
      (v) => linkablePageSlug({ slug: "x-11111111", visibility: v }) !== null,
    );
    expect(admitted).toEqual(["PUBLIC", "UNLISTED"]);
  });
});

describe("the two gates differ ONLY on UNLISTED", () => {
  it.each(["PUBLIC", "PRIVATE"] as const)(
    "agrees on %s",
    (visibility) => {
      expect(crawlablePageSlug(page(visibility))).toBe(
        linkablePageSlug(page(visibility)),
      );
    },
  );

  it("disagrees on UNLISTED, which is the whole point of having two", () => {
    expect(crawlablePageSlug(page("UNLISTED"))).toBeNull();
    expect(linkablePageSlug(page("UNLISTED"))).not.toBeNull();
  });
});
