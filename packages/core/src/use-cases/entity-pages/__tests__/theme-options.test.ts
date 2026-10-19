import { describe, expect, it } from "vitest";

import {
  ENTITY_PAGE_LAYOUT_KEYS,
  normalizeEntityPageLayoutKey,
  resolveDefaultEntityPageLayoutKey,
} from "../theme-options";

describe("entity page layout keys", () => {
  it("includes the standard template plus the freeform canvases", () => {
    expect(ENTITY_PAGE_LAYOUT_KEYS).toEqual(["standard", "stack", "grid"]);
  });

  it("normalizes the standard key (case/whitespace insensitive)", () => {
    expect(normalizeEntityPageLayoutKey(" STANDARD ")).toBe("standard");
    expect(normalizeEntityPageLayoutKey("stack")).toBe("stack");
    expect(normalizeEntityPageLayoutKey("grid")).toBe("grid");
  });

  it("returns null for unknown layout keys", () => {
    expect(normalizeEntityPageLayoutKey("masonry")).toBeNull();
    expect(normalizeEntityPageLayoutKey(null)).toBeNull();
  });
});

describe("resolveDefaultEntityPageLayoutKey", () => {
  it("defaults PLACE pages to the standard venue template", () => {
    expect(resolveDefaultEntityPageLayoutKey("PLACE")).toBe("standard");
  });

  it("defaults HUMAN and ORGANIZATION pages to the standard template", () => {
    // Every owner type now defaults to the app-controlled standard template;
    // stack/grid stay valid explicit opt-in choices.
    expect(resolveDefaultEntityPageLayoutKey("HUMAN")).toBe("standard");
    expect(resolveDefaultEntityPageLayoutKey("ORGANIZATION")).toBe("standard");
  });
});
