import { describe, expect, it } from "vitest";

import {
  getBlockingCalendars,
  joinCalendarNames,
} from "../calendar-space-error";

/**
 * The retire refusal is only useful if the venue learns WHICH calendar blocks
 * it (owner ruling 2026-09-23). This reader is what turns the server's `meta`
 * into that sentence, so it has to be strict about what it accepts: anything
 * it lets through half-formed renders as an empty or `undefined`-strewn toast.
 */

const CODE = "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR";

const err = (data: unknown) =>
  Object.assign(new Error(CODE), { data }) as unknown;

describe("getBlockingCalendars", () => {
  it("reads the calendars off a refusal's meta", () => {
    expect(
      getBlockingCalendars(
        err({
          appCode: CODE,
          meta: {
            placeId: "p1",
            spaceId: "s1",
            calendars: [
              { id: "c1", name: "Patio Sessions" },
              { id: "c2", name: "Brunch" },
            ],
          },
        }),
      ),
    ).toEqual([
      { id: "c1", name: "Patio Sessions" },
      { id: "c2", name: "Brunch" },
    ]);
  });

  it("resolves the code from the message when data.appCode is absent", () => {
    // Older/partial server builds put the code only on the message; the shared
    // `getAppErrorCode` handles both, and this reader rides on it.
    expect(
      getBlockingCalendars(
        err({ meta: { calendars: [{ id: "c1", name: "Patio" }] } }),
      ),
    ).toEqual([{ id: "c1", name: "Patio" }]);
  });

  it("returns null for a DIFFERENT error code carrying a calendars-shaped meta", () => {
    const other = Object.assign(new Error("CANNOT_RETIRE_LAST_ACTIVE_SPACE"), {
      data: {
        appCode: "CANNOT_RETIRE_LAST_ACTIVE_SPACE",
        meta: { calendars: [{ id: "c1", name: "Patio" }] },
      },
    });
    expect(getBlockingCalendars(other)).toBeNull();
  });

  it("returns null rather than an empty list when the meta is unusable", () => {
    expect(getBlockingCalendars(null)).toBeNull();
    expect(getBlockingCalendars(err(undefined))).toBeNull();
    expect(getBlockingCalendars(err({ appCode: CODE }))).toBeNull();
    expect(getBlockingCalendars(err({ appCode: CODE, meta: {} }))).toBeNull();
    expect(
      getBlockingCalendars(err({ appCode: CODE, meta: { calendars: [] } })),
    ).toBeNull();
    expect(
      getBlockingCalendars(
        err({ appCode: CODE, meta: { calendars: "Patio" } }),
      ),
    ).toBeNull();
  });

  it("drops malformed entries instead of rendering undefined names", () => {
    expect(
      getBlockingCalendars(
        err({
          appCode: CODE,
          meta: {
            calendars: [
              { id: "c1", name: "Patio" },
              { id: "c2" },
              { name: "Nameless id" },
              { id: "c3", name: "   " },
              null,
              "Brunch",
            ],
          },
        }),
      ),
    ).toEqual([{ id: "c1", name: "Patio" }]);
  });
});

describe("joinCalendarNames", () => {
  it("joins one, two and three names", () => {
    expect(joinCalendarNames([], "en")).toBe("");
    expect(joinCalendarNames(["Patio"], "en")).toBe("Patio");
    expect(joinCalendarNames(["Patio", "Brunch"], "en")).toBe("Patio and Brunch");
    expect(joinCalendarNames(["Patio", "Brunch", "Late"], "en")).toBe(
      "Patio, Brunch, and Late",
    );
  });

  it("survives a junk locale rather than throwing inside a render", () => {
    expect(joinCalendarNames(["Patio", "Brunch"], "not-a-locale!!")).toBe(
      "Patio, Brunch",
    );
  });
});
