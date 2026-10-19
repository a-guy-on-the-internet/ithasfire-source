/**
 * `usePublicLinks` follows the page's URL (spanish-seo FR-006), not the
 * viewer's language: the same hook gives English links on an English page a
 * Spanish reader is viewing, and Spanish links on an /es page.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathname: string | null = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import { usePublicLinks } from "../use-public-links";

describe("usePublicLinks", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("links to the Spanish twins from an /es page", () => {
    pathname = "/es/eventos/categoria/musica";
    const { result } = renderHook(() => usePublicLinks());

    expect(result.current.locale).toBe("es");
    expect(result.current.path({ kind: "home" })).toBe("/es");
    expect(result.current.path({ kind: "about" })).toBe("/es/acerca-de");
    expect(
      result.current.path({
        kind: "category",
        slugs: { en: "music", es: "musica" },
      }),
    ).toBe("/es/eventos/categoria/musica");
  });

  it("links to the English pages from an English page", () => {
    pathname = "/events/category/music";
    const { result } = renderHook(() => usePublicLinks());

    expect(result.current.locale).toBe("en");
    expect(result.current.path({ kind: "home" })).toBe("/");
    expect(result.current.path({ kind: "contact" })).toBe("/contact");
    expect(
      result.current.path({
        kind: "category",
        slugs: { en: "music", es: "musica" },
      }),
    ).toBe("/events/category/music");
  });

  it("links in English outside the router (no pathname)", () => {
    pathname = null;
    const { result } = renderHook(() => usePublicLinks());

    expect(result.current.path({ kind: "home" })).toBe("/");
  });

  it("keeps the same helpers across renders on one page", () => {
    pathname = "/es";
    const { result, rerender } = renderHook(() => usePublicLinks());
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
