import { describe, expect, it } from "vitest";

import * as components from "../index";

describe("ShowcaseCard", () => {
  it("is intentionally unexported until redesigned", () => {
    expect("ShowcaseCard" in components).toBe(false);
  });
});
