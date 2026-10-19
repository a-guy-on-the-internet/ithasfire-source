"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

import { publicRuntimeEnv } from "@/config/env.public";

import { isAnalyticsExcludedPath } from "./analytics-excluded-paths";
import { useAnalyticsUrlSafe } from "./analytics-url-guard";

/**
 * Cloudflare Web Analytics — cookieless.
 *
 * Injected here rather than left to Cloudflare's automatic edge injection.
 * Automatic setup was enabled for this zone and the beacon still never
 * appeared in the HTML (verified against a cache-busted `cf-cache-status:
 * MISS` response), so the tag ships in the bundle where it is versioned,
 * reviewable, and covered by the AppChrome mount test. A thing that is
 * supposed to be injected for you, silently isn't, is exactly how
 * `SentryReplayLoader` came to record nothing for its entire life.
 *
 * Deliberately NOT consent-gated and deliberately absent from
 * `optionalStorageKeys()`: the beacon sets no cookie, writes nothing to
 * device storage, and builds no cross-visit or cross-site identifier, so
 * ePrivacy Art. 5(3) does not bite and the site stays bannerless. If this is
 * ever swapped for something that stores per-device state, it must move behind
 * `useConsentContext()` and gain an entry in `optionalStorageKeys()` in the
 * same commit.
 *
 * The token is not a secret — it ships in the HTML by design — so it travels
 * as a repo variable, not a secret. Being `NEXT_PUBLIC_*` it is baked at build
 * time: changing it needs a REBUILD, not a redeploy.
 *
 * No `defer`/`async` here on purpose — `strategy` is what controls loading for
 * next/script, and setting both is redundant.
 */
export function CloudflareAnalytics() {
  const token = publicRuntimeEnv.cfBeaconToken;
  const pathname = usePathname();
  const urlSafe = useAnalyticsUrlSafe();
  if (!token || !urlSafe || isAnalyticsExcludedPath(pathname)) return null;

  return (
    <Script
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={JSON.stringify({ token })}
      strategy="afterInteractive"
    />
  );
}
