import { describe, expect, it } from "vitest";

import {
  applyInstructionExemption,
  isInstructionExemptSitus,
  TN_INSTRUCTION_EXEMPT_SOURCE,
} from "../instruction-exemption";

const TN = { countryCode: "US", region: "TN" };
const CA = { countryCode: "US", region: "CA" };

describe("isInstructionExemptSitus", () => {
  it("is true only for US/TN", () => {
    expect(isInstructionExemptSitus(TN)).toBe(true);
    expect(isInstructionExemptSitus(CA)).toBe(false);
    expect(isInstructionExemptSitus({ countryCode: "CA", region: "TN" })).toBe(
      false,
    );
    expect(isInstructionExemptSitus(null)).toBe(false);
    expect(isInstructionExemptSitus(undefined)).toBe(false);
    expect(isInstructionExemptSitus({ countryCode: "US", region: null })).toBe(
      false,
    );
  });
});

describe("applyInstructionExemption", () => {
  it("zeroes the rate for an instructional TN event", () => {
    const result = applyInstructionExemption({
      instructionalAdmission: true,
      situs: TN,
      rateBps: 975,
      source: "ziptax",
    });
    expect(result).toEqual({
      rateBps: 0,
      source: TN_INSTRUCTION_EXEMPT_SOURCE,
    });
  });

  it("leaves the rate unchanged for a TN event that is NOT instructional", () => {
    const result = applyInstructionExemption({
      instructionalAdmission: false,
      situs: TN,
      rateBps: 975,
      source: "ziptax",
    });
    expect(result).toEqual({ rateBps: 975, source: "ziptax" });
  });

  it("treats an undefined flag as not instructional (unchanged)", () => {
    const result = applyInstructionExemption({
      instructionalAdmission: undefined,
      situs: TN,
      rateBps: 975,
      source: "ziptax",
    });
    expect(result).toEqual({ rateBps: 975, source: "ziptax" });
  });

  it("does NOT exempt an instructional event in another US state (CA)", () => {
    const result = applyInstructionExemption({
      instructionalAdmission: true,
      situs: CA,
      rateBps: 725,
      source: "ziptax",
    });
    expect(result).toEqual({ rateBps: 725, source: "ziptax" });
  });

  it("does NOT exempt an instructional event outside the US (region TN)", () => {
    const result = applyInstructionExemption({
      instructionalAdmission: true,
      situs: { countryCode: "CA", region: "TN" },
      rateBps: 500,
      source: "ca_gst_hst",
    });
    expect(result).toEqual({ rateBps: 500, source: "ca_gst_hst" });
  });

  it("leaves the rate unchanged when there is no situs", () => {
    const result = applyInstructionExemption({
      instructionalAdmission: true,
      situs: null,
      rateBps: 975,
      source: "ziptax",
    });
    expect(result).toEqual({ rateBps: 975, source: "ziptax" });
  });
});
