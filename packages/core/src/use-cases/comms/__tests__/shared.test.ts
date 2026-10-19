import { describe, expect, it } from "vitest";

import { normalizeTemplateRef } from "../shared";

describe("normalizeTemplateRef", () => {
  it("returns undefined when template is null", () => {
    expect(normalizeTemplateRef(null)).toBeUndefined();
  });

  it("removes blank version values", () => {
    expect(
      normalizeTemplateRef({
        key: "foo",
        version: "  ",
        variables: { bar: 1 },
      }),
    ).toEqual({ key: "foo", variables: { bar: 1 } });
  });

  it("passes through valid template refs", () => {
    expect(
      normalizeTemplateRef({
        key: "foo",
        version: "v1",
        variables: { bar: 1 },
      }),
    ).toEqual({ key: "foo", version: "v1", variables: { bar: 1 } });
  });
});
