import { describe, expect, it } from "vitest";

import { buildStatementDescriptorSuffix } from "./statement-descriptor";

const EVENT_ID = "12345678-1234-4234-8234-123456789abc";

describe("buildStatementDescriptorSuffix", () => {
  it("strips diacritics and uppercases unicode titles", () => {
    expect(buildStatementDescriptorSuffix("Café São João", EVENT_ID)).toBe(
      "CAFE SAO JOAO",
    );
  });

  it("truncates long titles at the last word boundary", () => {
    expect(
      buildStatementDescriptorSuffix(
        "The Extremely Long Launch Party Downtown",
        EVENT_ID,
      ),
    ).toBe("THE EXTREMELY LONG");
  });

  it("falls back for emoji-only titles", () => {
    expect(buildStatementDescriptorSuffix("🎟️🔥✨", EVENT_ID)).toBe(
      "EVENT 12345678",
    );
  });

  it("falls back for all-digit titles", () => {
    expect(buildStatementDescriptorSuffix("1234567890", EVENT_ID)).toBe(
      "EVENT 12345678",
    );
  });

  it("falls back for empty titles", () => {
    expect(buildStatementDescriptorSuffix("", EVENT_ID)).toBe(
      "EVENT 12345678",
    );
  });
});