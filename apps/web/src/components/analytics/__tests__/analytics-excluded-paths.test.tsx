/**
 * Token-bearing invite routes must never load third-party analytics, so the
 * bearer token in `?token=` can't ride out in a pageview.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const state = vi.hoisted(() => ({ pathname: "/" as string | null }));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/config/env.public", () => ({
  publicRuntimeEnv: {
    plausibleDomain: "ithasfire.com",
    plausibleSrc: null,
    cfBeaconToken: "cf-token",
    gaMeasurementId: "G-TEST",
  },
}));
vi.mock("next/script", () => ({
  default: (props: Record<string, string>) => (
    <div data-testid="script" data-src={props.src} />
  ),
}));
vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: () => <div data-testid="ga" />,
}));
vi.mock("@/components/gdpr/ConsentProvider", () => ({
  useConsentContext: () => ({ consent: "all", ready: true }),
}));

import { PlausibleAnalytics } from "../PlausibleAnalytics";
import { CloudflareAnalytics } from "../CloudflareAnalytics";
import { GoogleAnalyticsLoader } from "../GoogleAnalyticsLoader";
import { isAnalyticsExcludedPath } from "../analytics-excluded-paths";

const EXCLUDED = [
  "/invite/accept",
  "/invitations/accept",
  "/delegate/accept",
  "/invites/stop",
  "/booking-requests/claim/brq_token_in_the_path",
];

describe("analytics exclusion on token-bearing routes", () => {
  beforeEach(() => {
    state.pathname = "/";
    delete (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"];
  });

  it.each(EXCLUDED)("loads no analytics script on %s", (path) => {
    state.pathname = path;
    expect(isAnalyticsExcludedPath(path)).toBe(true);
    const { queryAllByTestId } = render(
      <>
        <PlausibleAnalytics />
        <CloudflareAnalytics />
        <GoogleAnalyticsLoader />
      </>,
    );
    expect(queryAllByTestId("script")).toHaveLength(0);
    expect(queryAllByTestId("ga")).toHaveLength(0);
    // An already-running gtag is switched off at hit time too.
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"],
    ).toBe(true);
  });

  it("still loads everything on ordinary routes", () => {
    state.pathname = "/events";
    const { queryAllByTestId } = render(
      <>
        <PlausibleAnalytics />
        <CloudflareAnalytics />
        <GoogleAnalyticsLoader />
      </>,
    );
    expect(queryAllByTestId("script")).toHaveLength(2);
    expect(queryAllByTestId("ga")).toHaveLength(1);
    expect(
      (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"],
    ).toBe(false);
  });

  it("does not over-match similar paths", () => {
    expect(isAnalyticsExcludedPath("/invite")).toBe(false);
    expect(isAnalyticsExcludedPath("/invite/acceptance")).toBe(false);
    expect(isAnalyticsExcludedPath("/invites")).toBe(false);
    expect(isAnalyticsExcludedPath("/invites/stopped")).toBe(false);
    expect(isAnalyticsExcludedPath(null)).toBe(false);
  });
});
