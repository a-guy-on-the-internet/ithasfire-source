import { expect, test } from "./fixtures";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const origin = baseURL.replace(/\/+$/, "");

// The sitemap is no longer served by the app. The nightly sitemaps.generate
// job uploads a sitemap index to the public CDN bucket, and robots.txt
// advertises it (cross-host sitemaps count only when robots.txt names them).
// The CDN line appears only when the web server has SITEMAP_CDN_URL, so this
// spec asserts it exactly when the test process knows the value, and
// otherwise only that no Sitemap line points back at the app's own origin.
const configuredCdnSitemap =
  process.env.SITEMAP_CDN_URL?.trim().replace(/\/+$/, "") || null;

const sitemapLines = (text: string): string[] =>
  Array.from(text.matchAll(/^sitemap:\s*(\S+)\s*$/gim)).map((m) => m[1]!);

test.describe("Sitemap + robots", () => {
  test("robots.txt allows indexing and advertises the sitemaps", async ({
    request,
  }) => {
    const res = await request.get(`${origin}/robots.txt`);
    expect(res.ok(), await res.text()).toBeTruthy();

    const text = await res.text();

    expect(text).toMatch(/user-agent:\s*\*/i);
    expect(text).toMatch(/allow:\s*\//i);

    const sitemaps = sitemapLines(text);
    expect(sitemaps.length).toBeGreaterThan(0);
    for (const url of sitemaps) {
      expect(url).toMatch(/^https?:\/\//);
    }

    // llms.txt is always advertised, on the site's own origin.
    const llms = sitemaps.filter((url) => new URL(url).pathname === "/llms.txt");
    expect(llms).toHaveLength(1);

    // The in-app /sitemap.xml route is gone; nothing may point back at it.
    for (const url of sitemaps) {
      expect(new URL(url).pathname).not.toBe("/sitemap.xml");
    }

    if (configuredCdnSitemap) {
      expect(sitemaps).toContain(configuredCdnSitemap);
    }
  });

  test("llms.txt names the canonical place and category routes", async ({
    request,
  }) => {
    const res = await request.get(`${origin}/llms.txt`);
    expect(res.ok(), await res.text()).toBeTruthy();

    const text = await res.text();

    expect(text).toContain("`/places/<slug>`");
    expect(text).not.toContain("`/p/<slug>`");
    expect(text).toContain("`/events/category/<category>`");
    expect(text).toContain("`/events/category/<category>/<city>-<region>`");
  });
});
