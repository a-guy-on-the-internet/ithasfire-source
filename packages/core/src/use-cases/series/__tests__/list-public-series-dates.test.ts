import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { PublicSeriesDateRecord } from "@th/types";

import { listPublicSeriesDates } from "../list-public-series-dates";
import type { ListPublicSeriesDatesDeps } from "../list-public-series-dates";

const SERIES_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_A = "00000000-0000-4000-8000-000000000001";
const EVENT_B = "00000000-0000-4000-8000-000000000002";
const EVENT_C = "00000000-0000-4000-8000-000000000003";
const OCC_A = "00000000-0000-4000-8000-000000000101";
const OCC_B = "00000000-0000-4000-8000-000000000102";
const OCC_C = "00000000-0000-4000-8000-000000000103";

function makeRow(
  overrides: Partial<PublicSeriesDateRecord> & { eventId: string },
): PublicSeriesDateRecord {
  return {
    occurrenceId: "00000000-0000-4000-8000-000000000100",
    eventId: overrides.eventId,
    slug: `slug-${overrides.eventId}`,
    title: "Weekly Jam",
    startsAt: new Date("2026-04-06T18:00:00.000Z"),
    endsAt: new Date("2026-04-06T20:00:00.000Z"),
    timezone: "America/Chicago",
    ...overrides,
  };
}

function makeDeps(seriesOccurrences: {
  findSeriesIdByEventId: ReturnType<typeof vi.fn>;
  listPublishedDatesBySeriesId: ReturnType<typeof vi.fn>;
}): ListPublicSeriesDatesDeps {
  return {
    repos: {
      seriesOccurrences,
    } as unknown as Repos,
  };
}

describe("listPublicSeriesDates", () => {
  it("returns empty result when the event is not part of a series", async () => {
    const findSeriesIdByEventId = vi.fn().mockResolvedValue(null);
    const listPublishedDatesBySeriesId = vi.fn();
    const deps = makeDeps({
      findSeriesIdByEventId,
      listPublishedDatesBySeriesId,
    });

    const result = await listPublicSeriesDates(deps, { eventId: EVENT_A });

    expect(result).toEqual({ seriesId: null, seriesName: null, dates: [] });
    expect(findSeriesIdByEventId).toHaveBeenCalledWith(EVENT_A);
    expect(listPublishedDatesBySeriesId).not.toHaveBeenCalled();
  });

  it("maps published sibling dates and flags the current event", async () => {
    const findSeriesIdByEventId = vi
      .fn()
      .mockResolvedValue({ seriesId: SERIES_ID, seriesName: "Weekly Jam" });
    const listPublishedDatesBySeriesId = vi.fn().mockResolvedValue([
      makeRow({ occurrenceId: OCC_A, eventId: EVENT_A, startsAt: new Date("2026-04-06T18:00:00.000Z") }),
      makeRow({ occurrenceId: OCC_B, eventId: EVENT_B, startsAt: new Date("2026-04-13T18:00:00.000Z") }),
      makeRow({
        occurrenceId: OCC_C,
        eventId: EVENT_C,
        startsAt: new Date("2026-04-20T18:00:00.000Z"),
        endsAt: null,
      }),
    ]);
    const deps = makeDeps({
      findSeriesIdByEventId,
      listPublishedDatesBySeriesId,
    });

    const result = await listPublicSeriesDates(deps, { eventId: EVENT_B });

    expect(result.seriesId).toBe(SERIES_ID);
    expect(result.seriesName).toBe("Weekly Jam");
    expect(result.dates).toHaveLength(3);
    expect(result.dates.map((d) => d.isCurrent)).toEqual([false, true, false]);
    expect(result.dates[0]?.startsAt).toBe("2026-04-06T18:00:00.000Z");
    expect(result.dates[2]?.endsAt).toBeNull();
    expect(listPublishedDatesBySeriesId).toHaveBeenCalledWith(SERIES_ID, 60);
  });
});
