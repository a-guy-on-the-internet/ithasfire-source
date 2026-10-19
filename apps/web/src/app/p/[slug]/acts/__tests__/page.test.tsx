import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route shell for `/p/[slug]/acts` (venue-track-record-and-review-switch
 * FR-016). Pins what the component tests cannot: the NOINDEX metadata, the
 * 404 for a non-PLACE page at the slug, the historical-slug redirect, and
 * that the roster receives the lineup's `all` set plus the profile gate.
 */

const mocks = vi.hoisted(() => ({
  loadEntityPageBySlug: vi.fn(),
  loadPlaceLineupHistory: vi.fn(),
  getFeatureGatesServer: vi.fn(),
  rosterProbe: vi.fn(),
}));

class NotFoundSignal extends Error {}
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock("@/server/entity-pages", () => ({
  loadEntityPageBySlug: mocks.loadEntityPageBySlug,
}));

vi.mock("@/server/places", () => ({
  loadPlaceLineupHistory: mocks.loadPlaceLineupHistory,
}));

vi.mock("@/server/feature-gates", () => ({
  getFeatureGatesServer: mocks.getFeatureGatesServer,
}));

vi.mock("../_components/ActsRoster", () => ({
  ActsRoster: (props: Record<string, unknown>) => {
    mocks.rosterProbe(props);
    return <div data-testid="acts-roster" />;
  },
}));

import PlaceActsPage, { generateMetadata } from "../page";

const PLACE_ID = "11111111-1111-4111-8111-111111111111";

function placePage(overrides: Record<string, unknown> = {}) {
  return {
    redirect: false,
    data: {
      page: { slug: "fishbowl-house-00000000", displayName: null },
      entity: { type: "PLACE", id: PLACE_ID, name: "Fishbowl House" },
      theme: { colorPrimary: "#112233", colorBg: null, colorText: null, fontKey: "mono" },
      blocks: [
        {
          id: "b1",
          pageId: "p1",
          kind: "track_record",
          orderIndex: 0,
          visible: true,
          data: {
            dataSource: "track_record",
            showsHosted: 14,
            firstShowAt: "2025-01-10T02:00:00.000Z",
            lastShowAt: "2026-09-18T02:00:00.000Z",
            timeZone: "America/New_York",
          },
        },
      ],
      ...overrides,
    },
  };
}

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("/p/[slug]/acts route", () => {
  beforeEach(() => {
    mocks.loadEntityPageBySlug.mockReset();
    mocks.loadPlaceLineupHistory.mockReset();
    mocks.getFeatureGatesServer.mockReset();
    mocks.rosterProbe.mockReset();
    mocks.getFeatureGatesServer.mockResolvedValue({ humanProfilesPublic: false });
    mocks.loadPlaceLineupHistory.mockResolvedValue({
      recent: [],
      all: [
        {
          key: "h:0123456789ab",
          name: "Rat Cathedral",
          profileUrl: "/humans/rat-cathedral",
          timesPlayed: 5,
          lastPlayedAt: new Date("2026-09-18T01:00:00.000Z"),
        },
      ],
      allActsCount: 1,
    });
  });

  it("is noindex with a follow, titled after the venue", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(placePage());
    await expect(
      generateMetadata(params("fishbowl-house-00000000")),
    ).resolves.toEqual({
      title: "Who's played Fishbowl House",
      robots: { index: false, follow: true },
    });
  });

  it("does not advertise a HUMAN page's slug", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(
      placePage({ entity: { type: "HUMAN", id: "h1", name: "Someone" } }),
    );
    await expect(generateMetadata(params("someone"))).resolves.toEqual({
      title: "Page not found",
      robots: { index: false, follow: false },
    });
  });

  it("404s a HUMAN page at the slug", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(
      placePage({ entity: { type: "HUMAN", id: "h1", name: "Someone" } }),
    );
    await expect(PlaceActsPage(params("someone"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    expect(mocks.loadPlaceLineupHistory).not.toHaveBeenCalled();
  });

  it("404s an unknown slug", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(null);
    await expect(PlaceActsPage(params("nope"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });

  it("redirects a historical slug to the current acts page", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue({
      ...placePage(),
      redirect: true,
    });
    await expect(PlaceActsPage(params("old-slug"))).rejects.toMatchObject({
      to: "/p/fishbowl-house-00000000/acts",
    });
  });

  it("hands the roster the whole lineup, the summary and the profile gate", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(placePage());
    const tree = await PlaceActsPage(params("fishbowl-house-00000000"));
    render(tree);

    expect(screen.getByTestId("acts-roster")).toBeInTheDocument();
    expect(mocks.loadPlaceLineupHistory).toHaveBeenCalledWith(PLACE_ID);
    expect(mocks.rosterProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        venueName: "Fishbowl House",
        venueHref: "/p/fishbowl-house-00000000",
        linkProfiles: false,
        summary: {
          showsHosted: 14,
          firstShowAt: "2025-01-10T02:00:00.000Z",
          lastShowAt: "2026-09-18T02:00:00.000Z",
          timeZone: "America/New_York",
        },
        // The venue's zone from the block, not the platform default.
        timeZone: "America/New_York",
        acts: [
          {
            key: "h:0123456789ab",
            name: "Rat Cathedral",
            profileUrl: "/humans/rat-cathedral",
            timesPlayed: 5,
            lastPlayedAt: "2026-09-18T01:00:00.000Z",
          },
        ],
      }),
    );
    // The venue's theme wraps the roster.
    const root = screen.getByTestId("acts-roster").parentElement!;
    expect(root.getAttribute("data-font")).toBe("mono");
    expect(root.style.getPropertyValue("--th-color-primary")).toBe("#112233");
  });

  it("falls back to the platform zone when the block predates the zone field", async () => {
    mocks.loadEntityPageBySlug.mockResolvedValue(
      placePage({
        blocks: [
          {
            id: "b1",
            pageId: "p1",
            kind: "track_record",
            orderIndex: 0,
            visible: true,
            data: { dataSource: "track_record", showsHosted: 2 },
          },
        ],
      }),
    );
    render(await PlaceActsPage(params("fishbowl-house-00000000")));
    expect(mocks.rosterProbe).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: "America/Chicago" }),
    );
  });
});
