/**
 * The builder's "does this link work for a stranger?" gate and the link it
 * hands out.
 *
 * The gate restates the SERVER's rule, `isEventPubliclyReadable`, which
 * cannot ride into the client bundle. The first block pins the two to the
 * same answer for every status, published or not; the rest pin the paths.
 */
import { describe, expect, it } from "vitest";

import { isEventPubliclyReadable } from "@th/core/use-cases/events/_shared/event-public-readability";
import {
  eventPublicPath,
  eventShortPath,
} from "@th/core/lib/public-urls";

import {
  eventPublicLink,
  eventSharingSummary,
  isEventLinkPublic,
} from "../event-public-link.helpers";

const STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "CANCELLED",
  "COMPLETED",
  "ARCHIVED",
] as const;
const PUBLISHED_AT = new Date("2026-09-01T12:00:00.000Z");
const SLUG = "demo/us/general/lower-east-side-charity-fundraiser--ab12cd";

describe("isEventLinkPublic — the server's rule, restated", () => {
  const EXPECTED: Record<(typeof STATUSES)[number], [boolean, boolean]> = {
    // [never published, was published]
    DRAFT: [false, false],
    PUBLISHED: [true, true],
    CANCELLED: [false, true],
    COMPLETED: [true, true],
    ARCHIVED: [false, true],
  };
  for (const status of STATUSES) {
    for (const [i, publishedAt] of [null, PUBLISHED_AT].entries()) {
      it(`${status} / ${publishedAt ? "was published" : "never published"}`, () => {
        const state = { status, publishedAt };
        expect(isEventLinkPublic(state)).toBe(EXPECTED[status][i]);
        expect(isEventLinkPublic(state)).toBe(isEventPubliclyReadable(state));
      });
    }
  }
});

describe("eventPublicLink", () => {
  it("a published event with a short ID shares the short link and views the canonical page", () => {
    expect(
      eventPublicLink({
        status: "PUBLISHED",
        publishedAt: PUBLISHED_AT,
        slug: SLUG,
        shortId: "wqsdk6pxzi",
      }),
    ).toEqual({
      sharePath: eventShortPath("wqsdk6pxzi"),
      canonicalPath: eventPublicPath(SLUG),
    });
    // The canonical path keeps the slug's segments as real separators.
    expect(eventPublicPath(SLUG)).toBe(`/events/${SLUG}`);
  });

  it("a legacy event without a short ID falls back to the canonical page", () => {
    const link = eventPublicLink({
      status: "PUBLISHED",
      publishedAt: PUBLISHED_AT,
      slug: SLUG,
      shortId: null,
    });
    expect(link?.sharePath).toBe(`/events/${SLUG}`);
  });

  it("a DRAFT has no link, though it has a slug and short ID from creation", () => {
    expect(
      eventPublicLink({
        status: "DRAFT",
        publishedAt: null,
        slug: SLUG,
        shortId: "wqsdk6pxzi",
      }),
    ).toBeNull();
  });

  it("a CANCELLED event that never went live has no link", () => {
    expect(
      eventPublicLink({
        status: "CANCELLED",
        publishedAt: null,
        slug: SLUG,
        shortId: "wqsdk6pxzi",
      }),
    ).toBeNull();
  });

  it("no slug ⇒ no link, even with a short ID (`/e/` redirects TO the slug page)", () => {
    expect(
      eventPublicLink({
        status: "PUBLISHED",
        publishedAt: PUBLISHED_AT,
        slug: null,
        shortId: "wqsdk6pxzi",
      }),
    ).toBeNull();
  });
});

describe("eventSharingSummary", () => {
  it("shows the short link while it works", () => {
    expect(
      eventSharingSummary({
        status: "PUBLISHED",
        publishedAt: PUBLISHED_AT,
        slug: SLUG,
        shortId: "wqsdk6pxzi",
      }),
    ).toBe("/e/wqsdk6pxzi");
  });

  it("a DRAFT falls back to the long path (no short link)", () => {
    expect(
      eventSharingSummary({
        status: "DRAFT",
        publishedAt: null,
        slug: SLUG,
        shortId: "wqsdk6pxzi",
      }),
    ).toBe(`/events/${SLUG}`);
  });

  it("no slug ⇒ no summary", () => {
    expect(
      eventSharingSummary({
        status: "DRAFT",
        publishedAt: null,
        slug: null,
        shortId: null,
      }),
    ).toBeUndefined();
  });
});
