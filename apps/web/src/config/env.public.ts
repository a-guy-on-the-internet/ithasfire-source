// ---------------------------------------------------------------------------
// publicRuntimeEnv — consumed by CLIENT-SIDE code
//
// IMPORTANT: Turbopack/Webpack only inline `process.env.NEXT_PUBLIC_*` when
// the expression appears as a **direct property access** — e.g.
//   process.env.NEXT_PUBLIC_FOO            ← inlined ✓
//   const o = { x: process.env.NEXT_PUBLIC_FOO }; o.x  ← NOT inlined ✗
//
// Every value here MUST use a bare `process.env.NEXT_PUBLIC_*` expression so
// the bundler can statically replace it with the build-time string literal.
// Do NOT route these through envInputs / Zod / pickFirst — the indirection
// prevents the static replacement and leaves `undefined` on the client.
//
// This file MUST NOT import anything that pulls in Zod schemas, envInputs,
// or server-only env resolution.  Turbopack bundles entire modules, so even
// an unused re-export from a file that constructs envInputs will drag the
// non-inlined references into the client bundle.
// ---------------------------------------------------------------------------

const normalizeString = (value: string | undefined | null): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const normalizeOrigin = (value: string): string => stripTrailingSlash(value);

// Each variable MUST be read as a direct `process.env.NEXT_PUBLIC_*`
// expression — this is what Turbopack statically replaces at build time.
const _pubApiBase = normalizeString(process.env.NEXT_PUBLIC_API_BASE_URL);
const _pubSiteUrl = normalizeString(process.env.NEXT_PUBLIC_SITE_URL);
const _pubSiteName = normalizeString(process.env.NEXT_PUBLIC_SITE_NAME);
const _pubBetterAuthUrl = normalizeString(
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
);
const _pubGaMeasurementId = normalizeString(
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
);
const _pubPlausibleDomain = normalizeString(
  process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
);
const _pubPlausibleSrc = normalizeString(process.env.NEXT_PUBLIC_PLAUSIBLE_SRC);
const _pubCfBeaconToken = normalizeString(
  process.env.NEXT_PUBLIC_CF_BEACON_TOKEN,
);
const _pubBuildSha = normalizeString(process.env.NEXT_PUBLIC_BUILD_SHA);
const _pubAppVersion = normalizeString(process.env.NEXT_PUBLIC_APP_VERSION);

export const publicRuntimeEnv = {
  apiBaseUrl: _pubApiBase ? stripTrailingSlash(_pubApiBase) : null,
  siteUrl: _pubSiteUrl ? normalizeOrigin(_pubSiteUrl) : null,
  siteName: _pubSiteName ?? "Ithas Fire",
  betterAuth: {
    url: _pubBetterAuthUrl ? stripTrailingSlash(_pubBetterAuthUrl) : null,
  },
  gaMeasurementId: _pubGaMeasurementId,
  /**
   * Sentry DSN. Read here (not just in `instrumentation-client.ts`) so the
   * consent banner can tell whether session replay is actually wired before
   * claiming the user is consenting to it.
   */
  /**
   * Site domain registered in Plausible (e.g. "ithasfire.com"). Analytics is
   * off entirely when unset — this is the single switch.
   */
  plausibleDomain: _pubPlausibleDomain,
  /**
   * Script URL. Null uses Plausible Cloud; set it to a self-hosted Community
   * Edition instance to move off the SaaS without a code change.
   */
  plausibleSrc: _pubPlausibleSrc,
  /**
   * Cloudflare Web Analytics site token. Not a secret — it ships in the HTML
   * by design — so it travels as a repo variable. Unset means no beacon is
   * emitted at all; this is the single switch for cookieless analytics.
   */
  cfBeaconToken: _pubCfBeaconToken,
  /** Short git SHA baked in at build time (e.g. "43adb38"). Null in local dev. */
  buildSha: _pubBuildSha,
  /** Semver string baked in at build time (e.g. "0.1.0"). Null in local dev. */
  appVersion: _pubAppVersion,
} as const;

// ---------------------------------------------------------------------------
// Shared utility used by both client and server code
// ---------------------------------------------------------------------------

export const requireEnv = (value: string | null, message: string): string => {
  if (!value) {
    throw new Error(message);
  }
  return value;
};
