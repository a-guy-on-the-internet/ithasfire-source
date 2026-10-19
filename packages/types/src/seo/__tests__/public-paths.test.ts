import { describe, expect, it } from "vitest";

import { publicPath } from "../public-paths";

describe("publicPath", () => {
  it.each([
    ["en", { kind: "home" }, "/"],
    ["es", { kind: "home" }, "/es"],
    ["en", { kind: "category", slug: "open-mics" }, "/events/category/open-mics"],
    [
      "es",
      { kind: "category", slug: "micro-abierto" },
      "/es/eventos/categoria/micro-abierto",
    ],
    [
      "es",
      { kind: "cityCategory", slug: "micro-abierto", city: "nashville-tn" },
      "/es/eventos/categoria/micro-abierto/nashville-tn",
    ],
    ["en", { kind: "about" }, "/about"],
    ["es", { kind: "about" }, "/es/acerca-de"],
    ["en", { kind: "contact" }, "/contact"],
    ["es", { kind: "contact" }, "/es/contacto"],
  ] as const)("%s %j -> %s", (locale, page, expected) => {
    expect(publicPath(locale, page)).toBe(expected);
  });

  it("percent-encodes slug segments", () => {
    expect(publicPath("es", { kind: "category", slug: "a b/ñ" })).toBe(
      "/es/eventos/categoria/a%20b%2F%C3%B1",
    );
  });
});
