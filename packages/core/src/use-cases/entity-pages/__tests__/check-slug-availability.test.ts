import { describe, expect, it, vi } from "vitest";

import { checkSlugAvailability } from "../check-slug-availability";
import type { CheckSlugAvailabilityDeps } from "../check-slug-availability";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(
  isSlugAvailableFn?: (...args: any[]) => Promise<boolean>,
): CheckSlugAvailabilityDeps {
  return {
    repos: {
      entityPages: {
        isSlugAvailable: isSlugAvailableFn ?? vi.fn(async () => true),
      } as any,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("checkSlugAvailability", () => {
  it("returns available: true when slug is free", async () => {
    const deps = makeDeps(vi.fn(async () => true));

    const result = await checkSlugAvailability(deps, { slug: "fresh-slug" });

    expect(result).toEqual({ available: true });
  });

  it("returns available: false when slug is taken", async () => {
    const deps = makeDeps(vi.fn(async () => false));

    const result = await checkSlugAvailability(deps, { slug: "taken-slug" });

    expect(result).toEqual({ available: false });
  });

  it("passes excludePageId through to the repo", async () => {
    const fn = vi.fn(async () => true);
    const deps = makeDeps(fn);

    await checkSlugAvailability(deps, {
      slug: "my-slug",
      excludePageId: "page-123",
    });

    expect(fn).toHaveBeenCalledWith("my-slug", "page-123");
  });

  it("throws invalid_input for empty slug", async () => {
    const deps = makeDeps();

    await expect(
      checkSlugAvailability(deps, { slug: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws invalid_input when slug is missing", async () => {
    const deps = makeDeps();

    await expect(checkSlugAvailability(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("trims whitespace from slug", async () => {
    const fn = vi.fn(async () => true);
    const deps = makeDeps(fn);

    await checkSlugAvailability(deps, { slug: "  hello  " });

    expect(fn).toHaveBeenCalledWith("hello", undefined);
  });
});
