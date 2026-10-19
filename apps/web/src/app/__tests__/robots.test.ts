// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// webEnv and publicRuntimeEnv read process.env at module load, so each case
// stubs the env first and imports robots.ts fresh.
const loadRobots = async () => {
  vi.resetModules();
  return import("../robots");
};

describe("robots.txt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders per request, never as a build-time prerender", async () => {
    vi.stubEnv("SITEMAP_CDN_URL", "");
    const mod = await loadRobots();
    expect(mod.dynamic).toBe("force-dynamic");
    expect((mod as Record<string, unknown>).revalidate).toBeUndefined();
  });

  it("advertises the CDN sitemap index and llms.txt when SITEMAP_CDN_URL is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example");
    vi.stubEnv(
      "SITEMAP_CDN_URL",
      "https://cdn.example/sitemaps/sitemap.xml/",
    );
    const { default: robots } = await loadRobots();

    const result = robots();

    expect(result.sitemap).toEqual([
      "https://cdn.example/sitemaps/sitemap.xml",
      "https://site.example/llms.txt",
    ]);
    expect(result.host).toBe("https://site.example");
  });

  it("advertises only llms.txt when SITEMAP_CDN_URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example");
    vi.stubEnv("SITEMAP_CDN_URL", "");
    const { default: robots } = await loadRobots();

    expect(robots().sitemap).toEqual(["https://site.example/llms.txt"]);
  });

  it("keeps the crawler rules", async () => {
    vi.stubEnv("SITEMAP_CDN_URL", "");
    const { default: robots } = await loadRobots();

    const rules = robots().rules;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toContainEqual({ userAgent: "*", allow: "/" });
    expect(rules).toContainEqual({ userAgent: "Bytespider", disallow: "/" });
  });
});
