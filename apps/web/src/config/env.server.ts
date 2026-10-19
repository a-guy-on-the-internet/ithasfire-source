// ---------------------------------------------------------------------------
// Server-side env — uses process.env at runtime (Node), so indirection is OK.
//
// This file is ONLY imported by server components, API routes, and server
// utilities.  It must NEVER be imported (directly or transitively) by client
// components — doing so would drag envInputs (with non-inlined process.env
// references) into the client bundle and break Turbopack static replacement.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers (duplicated from env.public.ts to avoid cross-import)
// ---------------------------------------------------------------------------

const normalizeString = (value: string | undefined | null): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const ensureLeadingSlash = (value: string): string =>
  value.startsWith("/") ? value : `/${value}`;

const normalizeOrigin = (value: string): string => stripTrailingSlash(value);

// ---------------------------------------------------------------------------
// Schema + parse
// ---------------------------------------------------------------------------

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  WEB_API_BASE_URL: z.string().optional(),
  API_BASE_URL: z.string().optional(),
  NEXT_PUBLIC_API_BASE_URL: z.string().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().optional(),
  SITE_URL: z.string().optional(),
  WEB_SITE_URL: z.string().optional(),
  NEXT_PUBLIC_SITE_NAME: z.string().optional(),
  SITE_NAME: z.string().optional(),
  WEB_EVENT_RESOURCE_PATH: z.string().optional(),
  // Better Auth (server hosted in API; web talks to it directly via absolute API base URL)
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_BASE_URL: z.string().optional(),
  NEXT_PUBLIC_BETTER_AUTH_URL: z.string().optional(),
  WEB_SMOKE_BUILD: z.string().optional(),
  NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().optional(),
  // Sentry error tracking
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  // CDN-hosted sitemap (generated nightly by sitemaps.generate job).
  // When set, robots.txt advertises this URL as the canonical sitemap.
  SITEMAP_CDN_URL: z.string().optional(),
});

type RawEnv = z.infer<typeof envSchema>;
type RawEnvKey = Extract<keyof RawEnv, string>;

const envInputs: Record<RawEnvKey, string | undefined> = {
  NODE_ENV: process.env.NODE_ENV,
  WEB_API_BASE_URL: process.env.WEB_API_BASE_URL,
  API_BASE_URL: process.env.API_BASE_URL,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  SITE_URL: process.env.SITE_URL,
  WEB_SITE_URL: process.env.WEB_SITE_URL,
  NEXT_PUBLIC_SITE_NAME: process.env.NEXT_PUBLIC_SITE_NAME,
  SITE_NAME: process.env.SITE_NAME,
  WEB_EVENT_RESOURCE_PATH: process.env.WEB_EVENT_RESOURCE_PATH,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_BASE_URL: process.env.BETTER_AUTH_BASE_URL,
  NEXT_PUBLIC_BETTER_AUTH_URL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  WEB_SMOKE_BUILD: process.env.WEB_SMOKE_BUILD,
  NEXT_PUBLIC_GA_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  SENTRY_DSN: process.env.SENTRY_DSN,
  SITEMAP_CDN_URL: process.env.SITEMAP_CDN_URL,
};

const rawEnv = envSchema.parse(envInputs);

const pickFirst = (...keys: RawEnvKey[]): string | null => {
  for (const key of keys) {
    const value = normalizeString(rawEnv[key]);
    if (value) {
      return value;
    }
  }
  return null;
};

const apiBaseUrl = pickFirst(
  "WEB_API_BASE_URL",
  "API_BASE_URL",
  "NEXT_PUBLIC_API_BASE_URL",
);
const siteUrl = normalizeOrigin(
  pickFirst("NEXT_PUBLIC_SITE_URL", "SITE_URL", "WEB_SITE_URL") ??
    "http://localhost:3000",
);
const siteName =
  pickFirst("NEXT_PUBLIC_SITE_NAME", "SITE_NAME") ?? "Ithas Fire";
const eventResourcePath = ensureLeadingSlash(
  normalizeString(rawEnv.WEB_EVENT_RESOURCE_PATH) ?? "v1/events",
);

const betterAuthSecret = pickFirst("BETTER_AUTH_SECRET");
const betterAuthBaseUrl = pickFirst(
  "BETTER_AUTH_BASE_URL",
  "WEB_SITE_URL",
  "SITE_URL",
  "NEXT_PUBLIC_SITE_URL",
);

const smokeBuildEnabled =
  normalizeString(rawEnv.WEB_SMOKE_BUILD)?.toLowerCase() === "true";

const sitemapCdnUrl = pickFirst("SITEMAP_CDN_URL");

export const webEnv = {
  nodeEnv: rawEnv.NODE_ENV,
  apiBaseUrl: apiBaseUrl ? stripTrailingSlash(apiBaseUrl) : null,
  eventResourcePath,
  siteUrl,
  siteName,
  sitemapCdnUrl: sitemapCdnUrl ? stripTrailingSlash(sitemapCdnUrl) : null,
  betterAuth: {
    secret: betterAuthSecret,
    baseUrl: betterAuthBaseUrl ? stripTrailingSlash(betterAuthBaseUrl) : null,
  },
  flags: {
    smokeBuild: smokeBuildEnabled,
  },
};

export const serverRuntimeEnv = {
  apiBaseUrl: webEnv.apiBaseUrl,
  eventResourcePath: webEnv.eventResourcePath,
  flags: webEnv.flags,
} as const;
