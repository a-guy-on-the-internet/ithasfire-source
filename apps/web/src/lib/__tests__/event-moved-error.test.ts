import { describe, expect, it } from "vitest";

import { extractEventMoved } from "../event-moved-error";

const trpcError = (appCode: string, meta?: unknown) =>
  Object.assign(new Error(appCode), { data: { appCode, meta } });

describe("extractEventMoved", () => {
  it("reads the event's new start from the meta", () => {
    expect(
      extractEventMoved(
        trpcError("EVENT_MOVED", {
          eventId: "e-1",
          expectedStartsAt: "2026-10-03T20:00:00.000Z",
          startsAt: "2026-10-10T20:00:00.000Z",
        }),
      ),
    ).toEqual({ startsAt: new Date("2026-10-10T20:00:00.000Z") });
  });

  it("reports a move with an unknown new start (caught by the write's CAS)", () => {
    expect(
      extractEventMoved(
        trpcError("EVENT_MOVED", { eventId: "e-1", startsAt: null }),
      ),
    ).toEqual({ startsAt: null });
    expect(extractEventMoved(trpcError("EVENT_MOVED"))).toEqual({
      startsAt: null,
    });
    expect(
      extractEventMoved(trpcError("EVENT_MOVED", { startsAt: "not a date" })),
    ).toEqual({ startsAt: null });
  });

  it("ignores every other error", () => {
    expect(extractEventMoved(trpcError("FORBIDDEN"))).toBeNull();
    expect(extractEventMoved(new Error("boom"))).toBeNull();
    expect(extractEventMoved(null)).toBeNull();
  });
});
