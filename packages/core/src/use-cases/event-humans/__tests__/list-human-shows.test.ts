import { describe, expect, it, vi } from "vitest";

import type { HumanPerformanceSummary } from "@th/types/repos/event-humans";
import { PUBLIC_LINEUP_ROLES } from "../../../lib/event-human-roles";
import {
  PAST_SHOWS_LIMIT,
  listHumanShows,
  toHumanShowSummary,
} from "../list-human-shows";
import type { ListHumanShowsDeps } from "../list-human-shows";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function makeDeps(performances: HumanPerformanceSummary[]) {
  const listPerformancesByHuman = vi.fn(async () => performances);
  const deps = {
    repos: { eventHumans: { listPerformancesByHuman } },
  } as unknown as ListHumanShowsDeps;
  return { deps, listPerformancesByHuman };
}

const perf = (
  overrides: Partial<HumanPerformanceSummary> = {},
): HumanPerformanceSummary => ({
  eventId: "event-1",
  title: "Show One",
  startsAt: new Date("2026-08-01T20:00:00.000Z"),
  venueName: "The Basement",
  slug: "show-one",
  ...overrides,
});

describe("toHumanShowSummary", () => {
  it("maps to the renderer shape (ISO date, slug omitted when null)", () => {
    expect(toHumanShowSummary(perf())).toEqual({
      id: "event-1",
      title: "Show One",
      date: "2026-08-01T20:00:00.000Z",
      venueName: "The Basement",
      slug: "show-one",
    });

    const noSlug = toHumanShowSummary(perf({ slug: null, venueName: null }));
    expect(noSlug).toEqual({
      id: "event-1",
      title: "Show One",
      date: "2026-08-01T20:00:00.000Z",
      venueName: null,
    });
    expect(noSlug).not.toHaveProperty("slug");
  });
});

describe("listHumanShows", () => {
  it("queries upcoming with PUBLIC_LINEUP_ROLES and no limit", async () => {
    const { deps, listPerformancesByHuman } = makeDeps([perf()]);

    const result = await listHumanShows(deps, {
      humanId: HUMAN_ID,
      when: "upcoming",
    });

    expect(result).toEqual([
      {
        id: "event-1",
        title: "Show One",
        date: "2026-08-01T20:00:00.000Z",
        venueName: "The Basement",
        slug: "show-one",
      },
    ]);
    expect(listPerformancesByHuman).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: HUMAN_ID,
        when: "upcoming",
        // Any public-lineup credit lists the show (HOST included);
        // VOLUNTEER is operational and never surfaces.
        roles: PUBLIC_LINEUP_ROLES,
        limit: undefined,
      }),
    );
    expect(PUBLIC_LINEUP_ROLES).toContain("HOST");
    expect(PUBLIC_LINEUP_ROLES).not.toContain("VOLUNTEER");
  });

  it("queries past with the FR-002 cap", async () => {
    const { deps, listPerformancesByHuman } = makeDeps([]);

    await listHumanShows(deps, { humanId: HUMAN_ID, when: "past" });

    expect(listPerformancesByHuman).toHaveBeenCalledWith(
      expect.objectContaining({ when: "past", limit: PAST_SHOWS_LIMIT }),
    );
    expect(PAST_SHOWS_LIMIT).toBe(20);
  });

  it("rejects an invalid `when`", async () => {
    const { deps } = makeDeps([]);
    await expect(
      listHumanShows(deps, { humanId: HUMAN_ID, when: "someday" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
