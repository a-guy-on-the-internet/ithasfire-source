import { describe, expect, it } from "vitest";

import { initialsFrom } from "../avatar-initials";

describe("initialsFrom", () => {
  it("keeps accented letters", () => {
    expect(initialsFrom("Ángela Núñez")).toBe("ÁN");
    expect(initialsFrom("Peña Flamenca")).toBe("PF");
  });

  it("handles a plain ASCII name", () => {
    expect(initialsFrom("Jane Doe")).toBe("JD");
  });

  it("uses the email local part", () => {
    expect(initialsFrom("jane.doe@example.com")).toBe("JD");
  });

  it("returns U for empty input", () => {
    expect(initialsFrom("")).toBe("U");
    expect(initialsFrom(null)).toBe("U");
  });
});
