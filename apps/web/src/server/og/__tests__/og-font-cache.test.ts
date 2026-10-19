import { describe, expect, it, vi, beforeEach } from "vitest";

const readFile = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFile(...args),
  default: { readFile: (...args: unknown[]) => readFile(...args) },
}));

beforeEach(() => {
  readFile.mockReset();
  vi.resetModules();
});

const freshRender = async () => import("../render");

describe("OG font cache", () => {
  it("reads each face exactly once across many calls", async () => {
    readFile.mockResolvedValue(Buffer.from("not-a-real-font"));
    const { loadOgFonts, OG_FONT_SPECS } = await freshRender();

    await Promise.all([loadOgFonts(), loadOgFonts(), loadOgFonts()]);

    // One read per face — the concurrent callers share the in-flight promise.
    expect(readFile).toHaveBeenCalledTimes(OG_FONT_SPECS.length);
  });

  /**
   * A rejected promise must NOT stay in the memo. Caching one would mean a
   * single transient read failure at boot permanently downgrades every OG image
   * for the life of that container — the exact class of bug a module-scope memo
   * invites.
   */
  it("does NOT poison the cache when the first read fails", async () => {
    const { loadOgFonts } = await freshRender();

    readFile.mockRejectedValue(new Error("EMFILE"));
    await expect(loadOgFonts()).rejects.toThrow("EMFILE");

    readFile.mockResolvedValue(Buffer.from("recovered"));
    await expect(loadOgFonts()).resolves.toHaveLength(4);
  });
});

/**
 * The failure that used to ESCAPE the route's try/catch.
 *
 * `new ImageResponse(...)` returns a finished 200 `image/png` before satori has
 * laid out a single glyph — measured: with a junk font buffer the constructor
 * resolves cleanly with `cache-control: public, max-age=0, must-revalidate` and
 * it is `arrayBuffer()` that rejects with "Unsupported OpenType signature". So
 * a corrupt TTF used to error the BODY of an already-sent response and the
 * static-poster fallback never ran. Buffering the bytes before responding is
 * what makes this a rejected promise the caller can actually catch.
 */
describe("rasterisation failures", () => {
  it("REJECTS rather than returning a half-written 200", async () => {
    const { renderDateStubResponse } = await freshRender();
    readFile.mockResolvedValue(Buffer.from("not-a-real-font"));

    await expect(
      renderDateStubResponse({
        title: "Anything",
        startsAt: new Date("2026-05-05T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/OpenType|font/i);
  });
});
