import { describe, expect, it } from "vitest";

import { offersValidFrom } from "./offers-valid-from";

const SEP_01 = new Date("2026-09-01T12:00:00.000Z");
const SEP_10 = new Date("2026-09-10T12:00:00.000Z");
const SEP_20 = new Date("2026-09-20T12:00:00.000Z");

describe("offersValidFrom", () => {
  it("counts an unreadable opening as the publish date, not as no tier", () => {
    expect(
      offersValidFrom({ publishedAt: SEP_01 }, [
        { salesOpenAt: new Date("not-a-date") },
        { salesOpenAt: SEP_20 },
      ]),
    ).toEqual(SEP_01);
  });

  it("counts a non-Date runtime value as the publish date", () => {
    expect(
      offersValidFrom({ publishedAt: SEP_01 }, [
        { salesOpenAt: "2026-08-01" as unknown as Date },
        { salesOpenAt: SEP_20 },
      ]),
    ).toEqual(SEP_01);
  });

  it("ignores an unreadable publish date and keeps a real opening", () => {
    expect(
      offersValidFrom({ publishedAt: new Date("not-a-date") }, [
        { salesOpenAt: SEP_10 },
      ]),
    ).toEqual(SEP_10);
  });

  it("is null with no readable date anywhere", () => {
    expect(
      offersValidFrom({ publishedAt: null }, [
        { salesOpenAt: new Date("not-a-date") },
      ]),
    ).toBeNull();
  });
});
