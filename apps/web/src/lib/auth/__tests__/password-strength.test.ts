import { describe, expect, it } from "vitest";

import { evaluatePasswordStrength } from "../password-strength";

describe("evaluatePasswordStrength", () => {
  it("marks short/simple passwords as not meeting requirements", () => {
    const result = evaluatePasswordStrength("password");
    expect(result.metRequirements).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("accepts a reasonably complex password", () => {
    const result = evaluatePasswordStrength("CorrectHorseBatteryStaple!1");
    expect(result.metRequirements).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(3);
  });
});
