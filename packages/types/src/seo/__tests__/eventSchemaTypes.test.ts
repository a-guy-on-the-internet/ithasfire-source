import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVENT_SCHEMA_TYPE,
  EVENT_SCHEMA_TYPES,
  isValidEventSchemaType,
} from "../eventSchemaTypes";

describe("eventSchemaTypes", () => {
  it("defaults to Event", () => {
    expect(DEFAULT_EVENT_SCHEMA_TYPE).toBe("Event");
    expect(EVENT_SCHEMA_TYPES[0]).toBe("Event");
  });

  it("includes MusicEvent for the music SEO goal", () => {
    expect(EVENT_SCHEMA_TYPES).toContain("MusicEvent");
  });

  it("accepts every curated type", () => {
    for (const type of EVENT_SCHEMA_TYPES) {
      expect(isValidEventSchemaType(type)).toBe(true);
    }
  });

  it("rejects unknown / malformed values", () => {
    expect(isValidEventSchemaType("MovieEvent")).toBe(false);
    expect(isValidEventSchemaType("musicevent")).toBe(false);
    expect(isValidEventSchemaType("")).toBe(false);
    expect(isValidEventSchemaType(null)).toBe(false);
    expect(isValidEventSchemaType(undefined)).toBe(false);
    expect(isValidEventSchemaType(42)).toBe(false);
  });
});
