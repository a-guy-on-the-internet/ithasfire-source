import type { MetadataRoute } from "next";

import { webEnv } from "@/config/env.server";
import { getSiteUrl } from "@/config/site";

// Rendered per request, never prerendered. SITEMAP_CDN_URL is a runtime env
// var on the web service (Terraform sets it, it is not a Docker build arg), so
// a build-time prerender has no sitemap URL and bakes a robots.txt without the
// Sitemap line. `revalidate` used to make this a static ISR route, and
// production served that build-time copy (x-nextjs-cache: HIT, no Sitemap
// line). The handler is cheap, so dynamic is fine.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();
  const cdnSitemap = webEnv.sitemapCdnUrl;

  // The nightly sitemaps.generate job uploads the sitemap-index + sub-sitemaps
  // to the public CDN bucket. We advertise that URL when SITEMAP_CDN_URL is
  // configured. There's no in-app fallback — the route was removed in favour
  // of the CDN-hosted artifact — and no derived default: the web service gets
  // no storage base URL to build one from, so unset means no CDN line.
  const sitemap = cdnSitemap
    ? [cdnSitemap, `${siteUrl}/llms.txt`]
    : [`${siteUrl}/llms.txt`];

  return {
    rules: [
      { userAgent: "*", allow: "/" },

      { userAgent: "OAI-SearchBot", allow: "/" },
      { userAgent: "ChatGPT-User", allow: "/" },
      { userAgent: "Claude-SearchBot", allow: "/" },
      { userAgent: "Claude-User", allow: "/" },
      { userAgent: "PerplexityBot", allow: "/" },
      { userAgent: "Perplexity-User", allow: "/" },
      { userAgent: "Google-Extended", allow: "/" },
      { userAgent: "Applebot-Extended", allow: "/" },

      { userAgent: "GPTBot", allow: "/" },
      { userAgent: "ClaudeBot", allow: "/" },
      { userAgent: "anthropic-ai", allow: "/" },
      { userAgent: "CCBot", allow: "/" },
      { userAgent: "Bytespider", disallow: "/" },
    ],
    sitemap,
    host: siteUrl,
  };
}
