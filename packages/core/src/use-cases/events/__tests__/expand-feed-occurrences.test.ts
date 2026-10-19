import { describe, expect, it } from "vitest";

import { expandEventDates } from "../expand-event-dates";
import {
  expandFeedOccurrences,
  type FeedExpandableEvent,
  type FeedExpandableEventDate,
} from "../expand-feed-occurrences";

const NOW = new Date("2026-05-01T12:00:00Z");
const T0 = new Date("2026-04-01T00:00:00Z");
const T1 = new Date("2026-04-20T00:00:00Z");

const event = (
  id: string,
  status: string,
  startsAt: string,
  extra: Partial<FeedExpandableEvent> = {},
): FeedExpandableEvent => ({
  id,
  status,
  startsAt: new Date(startsAt),
  endsAt: null,
  updatedAt: T0,
  ...extra,
});

const night = (
  id: string,
  eventId: string,
  startsAt: string,
  status: "SCHEDULED" | "CANCELLED" = "SCHEDULED",
  updatedAt: Date = T0,
): FeedExpandableEventDate => ({
  id,
  eventId,
  startsAt: new Date(startsAt),
  endsAt: null,
  status,
  updatedAt,
});

describe("expandFeedOccurrences", () => {
  const window = { from: NOW, to: new Date("2026-08-01T00:00:00Z") };

  it("a live listing: SCHEDULED nights live, a called-off night CANCELLED, each with its own eventDateId", () => {
    const listing = event("L", "PUBLISHED", "2026-05-06T20:00:00Z");
    const dates = [
      night("d1", "L", "2026-05-06T20:00:00Z"),
      night("d2", "L", "2026-05-13T20:00:00Z", "CANCELLED", T1),
      night("d3", "L", "2026-05-20T20:00:00Z"),
    ];
    const out = expandFeedOccurrences([listing], dates, { window, cancelledFrom: NOW });
    expect(out.map((o) => [o.eventDateId, o.cancelled])).toEqual([
      ["d1", false],
      ["d2", true],
      ["d3", false],
    ]);
    // LAST-MODIFIED source: the later of the event's and the night's write.
    expect(out[1]!.lastModified).toEqual(T1);
    expect(out[0]!.lastModified).toEqual(T0);
  });

  it("a taken-down (CANCELLED) listing: every upcoming night CANCELLED; past nights dropped", () => {
    const listing = event("L", "CANCELLED", "2026-05-06T20:00:00Z");
    const dates = [
      night("past", "L", "2026-04-29T20:00:00Z"),
      night("d1", "L", "2026-05-06T20:00:00Z", "CANCELLED"),
      night("d2", "L", "2026-05-13T20:00:00Z", "CANCELLED"),
    ];
    const out = expandFeedOccurrences([listing], dates, { window, cancelledFrom: NOW });
    expect(out.map((o) => [o.eventDateId, o.cancelled])).toEqual([
      ["d1", true],
      ["d2", true],
    ]);
  });

  it("a cancelled single-date event → the parent, cancelled, no eventDateId", () => {
    const out = expandFeedOccurrences(
      [event("E", "CANCELLED", "2026-05-10T20:00:00Z")],
      [],
      { window, cancelledFrom: NOW },
    );
    expect(out).toEqual([
      expect.objectContaining({ eventDateId: null, cancelled: true }),
    ]);
  });

  it("cancelledFrom: a cancelled night already past is dropped even inside the live window", () => {
    const liveFrom = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const listing = event("L", "PUBLISHED", "2026-04-22T20:00:00Z");
    const dates = [
      night("live-past", "L", "2026-04-22T20:00:00Z"),
      night("cx-past", "L", "2026-04-25T20:00:00Z", "CANCELLED"),
      night("cx-next", "L", "2026-05-02T20:00:00Z", "CANCELLED"),
    ];
    const out = expandFeedOccurrences([listing], dates, {
      window: { from: liveFrom },
      cancelledFrom: NOW,
    });
    expect(out.map((o) => o.eventDateId)).toEqual(["live-past", "cx-next"]);
  });

  it("sorts every occurrence chronologically across events", () => {
    const a = event("A", "PUBLISHED", "2026-05-10T20:00:00Z");
    const b = event("B", "CANCELLED", "2026-05-08T20:00:00Z");
    const out = expandFeedOccurrences([a, b], [], { window });
    expect(out.map((o) => o.event.id)).toEqual(["B", "A"]);
  });
});

describe("place page path is unchanged: expandEventDates still hides cancelled nights", () => {
  it("drops a CANCELLED night that the feed keeps", () => {
    const listing = { id: "L", startsAt: new Date("2026-05-06T20:00:00Z") };
    const dates = [
      night("d1", "L", "2026-05-06T20:00:00Z"),
      night("d2", "L", "2026-05-13T20:00:00Z", "CANCELLED"),
    ];
    expect(
      expandEventDates([listing], dates).map((o) => o.occurrence?.eventDateId),
    ).toEqual(["d1"]);
    expect(
      expandFeedOccurrences(
        [{ ...listing, status: "PUBLISHED", endsAt: null }],
        dates,
        { window: {} },
      ).map((o) => o.eventDateId),
    ).toEqual(["d1", "d2"]);
  });
});
