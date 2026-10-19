"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { GoogleAnalytics } from "@next/third-parties/google";

import { useConsentContext } from "@/components/gdpr/ConsentProvider";
import { publicRuntimeEnv } from "@/config/env.public";

import { isAnalyticsExcludedPath } from "./analytics-excluded-paths";
import { useAnalyticsUrlSafe } from "./analytics-url-guard";

/**
 * Consent-aware Google Analytics loader.
 *
 * Behaviour:
 * 1. On mount, pushes a `consent "default"` command that denies all
 *    non-essential storage. This satisfies Google Consent Mode v2 —
 *    the gtag snippet is always present but collects nothing until
 *    consent is granted.
 * 2. Once the user accepts (consent === "all"), pushes a
 *    `consent "update"` that unlocks analytics + ad storage and
 *    renders the `<GoogleAnalytics>` component which loads `gtag.js`.
 * 3. If the user later resets consent (via the footer link), the
 *    update revokes storage again. The gtag script stays loaded for
 *    the current session but will not write new cookies.
 */
export function GoogleAnalyticsLoader() {
  const gaId = publicRuntimeEnv.gaMeasurementId;
  const { consent, ready } = useConsentContext();
  const pathname = usePathname();
  const urlSafe = useAnalyticsUrlSafe();
  // A Stripe client secret on the URL (redirect-payment return) is excluded
  // the same way a bearer token is; `urlSafe` is false until mounted.
  const excluded = isAnalyticsExcludedPath(pathname) || !urlSafe;

  // Token-bearing routes: switch GA off at HIT time too, in case gtag is
  // already running from an earlier page (client-side navigation here).
  // `ga-disable-<id>` is Google's documented per-property opt-out flag.
  useEffect(() => {
    if (!gaId) return;
    (window as unknown as Record<string, unknown>)[`ga-disable-${gaId}`] =
      excluded;
  }, [gaId, excluded]);

  // Set the consent-mode defaults as early as possible.
  // This must run before gtag.js loads so Google respects the denial.
  useEffect(() => {
    if (!gaId) return;

    window.dataLayer = window.dataLayer ?? [];
    function gtag(..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    }
    gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      wait_for_update: 500,
    });
  }, [gaId]);

  // When the consent choice changes, push an update.
  useEffect(() => {
    if (!gaId || !ready) return;

    window.dataLayer = window.dataLayer ?? [];
    function gtag(..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    }

    const granted = consent === "all";
    gtag("consent", "update", {
      analytics_storage: granted ? "granted" : "denied",
      ad_storage: granted ? "granted" : "denied",
      ad_user_data: granted ? "granted" : "denied",
      ad_personalization: granted ? "granted" : "denied",
    });
  }, [gaId, consent, ready]);

  // Only render the script tag when we have an ID and consent is granted.
  if (!gaId || consent !== "all" || excluded) return null;

  return <GoogleAnalytics gaId={gaId} />;
}
