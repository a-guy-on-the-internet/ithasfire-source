import type { Metadata } from "next";

import { HomeRouteBody, homeMetadata } from "./_lib/home-route";

// The page itself lives in `_lib/home-route.tsx`, shared with its Spanish
// twin `/es` (spanish-seo R21).

/**
 * NOT the control that matters for edge caching — see the `source: "/"` rule in
 * `next.config.ts`, which sends the `Cache-Control` Cloudflare actually acts on
 * (`cloudflare-cache` uses `edge_ttl.mode = "respect_origin"`). Kept in step
 * with it at 300s so the two never disagree. The Spanish twin (`/es`) keeps
 * the same value and has its own header rule.
 *
 * This value is inert today: the SSR tRPC client's `httpBatchLink` header
 * callback awaits `headers()`, which opts the whole render out of Next's route
 * cache. It becomes live the day that changes, and a stale value here would
 * then quietly contradict the header.
 *
 * Personalized "near you" content (when the user has granted geolocation) is
 * fetched client-side after first paint and bypasses the edge cache.
 */
export const revalidate = 300;

export function generateMetadata(): Metadata {
  return homeMetadata("en");
}

export default async function Home() {
  return HomeRouteBody({ locale: "en" });
}
