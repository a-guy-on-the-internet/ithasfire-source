import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "@th/locale";

import { formatSavedEventDate } from "../saved-strip-date";

/**
 * The home "Saved" strip prints each start in the EVENT's zone, in the
 * viewer's language. Each test switches the PROCESS zone between formats; that
 * only works in a forked child process (`poolMatchGlobs` in
 * `vitest.config.ts`), so every switch is asserted first.
 */

// Thu 15 Oct 2026, 7:00 PM CDT = Fri 16 Oct 2026, 00:00 UTC = 9:00 AM JST.
const THURSDAY_7PM_CHICAGO = "2026-10-16T00:00:00.000Z";
const ORIGINAL_TZ = process.env.TZ;

const inProcessZone = <T>(zone: "UTC" | "Asia/Tokyo", fn: () => T): T => {
  process.env.TZ = zone;
  const expectedHour = { UTC: 0, "Asia/Tokyo": 9 }[zone];
  expect(
    new Date(THURSDAY_7PM_CHICAGO).getHours(),
    `process TZ pin to ${zone} did not take`,
  ).toBe(expectedHour);
  return fn();
};

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const en = createTranslator("en-US", {}).formatDate;
const es = createTranslator("es", {}).formatDate;

describe("formatSavedEventDate", () => {
  it("prints the same text under UTC and Asia/Tokyo, in the event's zone", () => {
    const utc = inProcessZone("UTC", () =>
      formatSavedEventDate(en, THURSDAY_7PM_CHICAGO, "America/Chicago"),
    );
    const tokyo = inProcessZone("Asia/Tokyo", () =>
      formatSavedEventDate(en, THURSDAY_7PM_CHICAGO, "America/Chicago"),
    );
    expect(utc).toBe(tokyo);
    expect(utc).toMatch(/^Thu, Oct 15, 7:00\sPM$/);
  });

  it("follows the event's own zone", () => {
    const denver = inProcessZone("Asia/Tokyo", () =>
      formatSavedEventDate(en, new Date(THURSDAY_7PM_CHICAGO), "America/Denver"),
    );
    expect(denver).toMatch(/^Thu, Oct 15, 6:00\sPM$/);
  });

  it("no zone, or an unusable one, reads as America/Chicago (never the viewer's)", () => {
    for (const tz of [undefined, null, "", "Not/AZone"]) {
      const tokyo = inProcessZone("Asia/Tokyo", () =>
        formatSavedEventDate(en, THURSDAY_7PM_CHICAGO, tz),
      );
      expect(tokyo).toMatch(/^Thu, Oct 15, 7:00\sPM$/);
    }
  });

  it("keeps the viewer's language", () => {
    const utc = inProcessZone("UTC", () =>
      formatSavedEventDate(es, THURSDAY_7PM_CHICAGO, "America/Chicago"),
    );
    const tokyo = inProcessZone("Asia/Tokyo", () =>
      formatSavedEventDate(es, THURSDAY_7PM_CHICAGO, "America/Chicago"),
    );
    expect(utc).toBe(tokyo);
    expect(utc).toMatch(/jue/i);
    expect(utc).toMatch(/19:00|7:00/);
  });
});
