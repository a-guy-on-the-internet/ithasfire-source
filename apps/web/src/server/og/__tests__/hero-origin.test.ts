import { afterEach, describe, expect, it } from "vitest";

import { isAllowedHeroImageUrl } from "../hero-origin";

const SITE = "https://ithasfire.com";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_CDN_HOSTNAME;
  delete process.env.OG_HERO_ALLOWED_HOSTS;
});

describe("isAllowedHeroImageUrl", () => {
  it("allows the site's own origin", () => {
    expect(isAllowedHeroImageUrl(`${SITE}/og-image-v2.png`, SITE)).toBe(true);
  });

  it("allows the seed image host", () => {
    expect(
      isAllowedHeroImageUrl("https://images.unsplash.com/photo-1.jpg", SITE),
    ).toBe(true);
  });

  it("allows the configured CDN host", () => {
    expect(isAllowedHeroImageUrl("https://cdn.ithasfire.com/a.jpg", SITE)).toBe(
      false,
    );
    process.env.NEXT_PUBLIC_CDN_HOSTNAME = "cdn.ithasfire.com";
    expect(isAllowedHeroImageUrl("https://cdn.ithasfire.com/a.jpg", SITE)).toBe(
      true,
    );
  });

  it("allows extra hosts from the comma-separated escape hatch", () => {
    process.env.OG_HERO_ALLOWED_HOSTS = " r2.example.test , other.test ";
    expect(isAllowedHeroImageUrl("https://r2.example.test/a.jpg", SITE)).toBe(
      true,
    );
    expect(isAllowedHeroImageUrl("https://other.test/a.jpg", SITE)).toBe(true);
    expect(isAllowedHeroImageUrl("https://nope.test/a.jpg", SITE)).toBe(false);
  });

  it.each([
    ["an unlisted origin", "https://evil.test/poster.jpg"],
    ["a look-alike subdomain", "https://images.unsplash.com.evil.test/a.jpg"],
    ["embedded credentials", "https://images.unsplash.com@evil.test/a.jpg"],
    ["a non-http scheme", "javascript:alert(1)"],
    ["a data url", "data:image/png;base64,AAAA"],
    ["a relative url", "/poster.jpg"],
    ["nonsense", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(isAllowedHeroImageUrl(url, SITE)).toBe(false);
  });

  it("rejects a userinfo-carrying url whose HOST is allowed", () => {
    // `https://user:pw@images.unsplash.com/x` resolves to an allowed host but
    // is a shape no legitimate `publicUrl` has, so it is refused outright.
    expect(
      isAllowedHeroImageUrl("https://u:p@images.unsplash.com/x.jpg", SITE),
    ).toBe(false);
  });
});
