"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

import { publicRuntimeEnv } from "@/config/env.public";

import { isAnalyticsExcludedPath } from "./analytics-excluded-paths";
import { useAnalyticsUrlSafe } from "./analytics-url-guard";

/**
 * Cookieless analytics.
 *
 * Deliberately NOT consent-gated, and deliberately absent from
 * `optionalStorageKeys()`. Plausible sets no cookies, writes nothing to
 * localStorage, and builds no cross-site or persistent identifier — there is
 * nothing stored on the visitor's device to ask permission for, so ePrivacy
 * Art. 5(3) does not bite. That is the entire reason we chose it over GA4:
 * traffic numbers without a consent banner.
 *
 * If this is ever swapped for something that *does* store per-device state,
 * it must move behind `useConsentContext()` and gain an entry in
 * `optionalStorageKeys()` in the same commit.
 *
 * Host-agnostic: `NEXT_PUBLIC_PLAUSIBLE_SRC` defaults to Plausible Cloud but
 * can point at a self-hosted Community Edition instance (or an Umami-style
 * drop-in) without touching this file.
 */
const DEFAULT_SRC = "https://plausible.io/js/script.js";

export function PlausibleAnalytics() {
  const domain = publicRuntimeEnv.plausibleDomain;
  const pathname = usePathname();
  const urlSafe = useAnalyticsUrlSafe();
  if (!domain || !urlSafe || isAnalyticsExcludedPath(pathname)) return null;

  return (
    <Script
      defer
      data-domain={domain}
      src={publicRuntimeEnv.plausibleSrc ?? DEFAULT_SRC}
      strategy="afterInteractive"
    />
  );
}
