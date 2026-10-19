import { describe, expect, it } from "vitest";

import { figureSizeFor, figureSizeXs } from "../PayoutPanel";

describe("figureSizeXs — one rung below the desktop figure", () => {
  it("steps $7 down to $6 (up to nine characters)", () => {
    expect(figureSizeFor("$6,640.99").fontSize).toBe("$7");
    expect(figureSizeXs("$6,640.99")).toEqual({
      fontSize: "$6",
      lineHeight: "$6",
    });
  });

  it("steps $6 down to $5 (ten and eleven characters)", () => {
    expect(figureSizeXs("$66,640.99")).toEqual({
      fontSize: "$5",
      lineHeight: "$5",
    });
  });

  it("bottoms out at $5 for longer figures", () => {
    expect(figureSizeXs("$1,666,640.99")).toEqual({
      fontSize: "$5",
      lineHeight: "$5",
    });
  });
});
