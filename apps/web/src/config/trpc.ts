import { publicRuntimeEnv } from "./env.public";

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const resolvePublicEnvBaseUrl = (): string | null =>
  publicRuntimeEnv.apiBaseUrl;

const resolveBrowserBaseUrl = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  // Prefer a configured API base URL when present.
  //
  // This is important in E2E/preview environments where the web app is served from
  // one origin (Next dev server) but the API is hosted separately. In those cases,
  // window.location.origin would incorrectly point the tRPC client at Next's /trpc,
  // which may not exist.
  if (publicRuntimeEnv.apiBaseUrl) {
    return normalizeBaseUrl(publicRuntimeEnv.apiBaseUrl);
  }

  return window.location.origin
    ? normalizeBaseUrl(window.location.origin)
    : null;
};

/**
 * Resolve the tRPC HTTP URL for server-side callers.
 * Server modules (e.g., server/trpc-client.ts) that know they run on Node
 * should pass their own base URL via `getServerTrpcHttpUrl()` instead of
 * relying on this shared resolver.
 */
const resolveServerEnvBaseUrl = (): string | null => {
  if (typeof window !== "undefined") {
    return null;
  }

  // On the server, read directly from process.env (Node runtime).
  // WEB_API_BASE_URL takes priority, then fall back to API_BASE_URL / NEXT_PUBLIC_*.
  const candidates = [
    process.env.WEB_API_BASE_URL,
    process.env.API_BASE_URL,
    process.env.NEXT_PUBLIC_API_BASE_URL,
  ];
  for (const c of candidates) {
    if (c && c.trim().length > 0) {
      return normalizeBaseUrl(c.trim());
    }
  }
  return null;
};

/**
 * Resolve the tRPC HTTP URL for callers that KNOW they run on Node (SSR data
 * fetchers, route handlers). Unlike `getTrpcHttpUrl`, this prefers the
 * server-runtime env (`WEB_API_BASE_URL` → `API_BASE_URL` → `NEXT_PUBLIC_*`)
 * BEFORE the build-time-inlined `NEXT_PUBLIC_API_BASE_URL`.
 *
 * This ordering matters: `NEXT_PUBLIC_API_BASE_URL` is inlined into the bundle
 * at build time (see config/env.public.ts), so on the server it is a non-null
 * string literal and `getTrpcHttpUrl()` would return the PUBLIC api hostname —
 * shadowing `WEB_API_BASE_URL` and routing SSR calls back out through
 * Cloudflare. `WEB_API_BASE_URL` is a runtime-only (non-`NEXT_PUBLIC_`) env,
 * so it is read from the live Cloud Run env here and points SSR traffic at the
 * API's internal *.run.app origin (see infra/terraform/main.tf resolved_web_env).
 *
 * Falls back to the public/browser resolvers so local dev (no
 * `WEB_API_BASE_URL`) still works.
 *
 * LOAD-BEARING for the API's rate limiting: the global-bucket fail-safe in
 * packages/transport/trpc/src/guard.ts (`defaultRateLimit`) relies on SSR
 * calling the INTERNAL origin. Those calls never transit Cloudflare, so they
 * carry no `cf-connecting-ip`, and when the signed visitor forward
 * (x-th-client-ip*) is missing or broken they resolve to `clientIpSource:
 * "direct"` and skip the per-IP global bucket instead of piling every visitor
 * onto the web server's egress IP. If SSR is ever routed through Cloudflare
 * (public hostname), a broken forward would 429 the whole site: revisit that
 * fail-safe first.
 */
export const getServerTrpcHttpUrl = (): string => {
  const baseUrl =
    resolveServerEnvBaseUrl() ??
    resolvePublicEnvBaseUrl() ??
    resolveBrowserBaseUrl() ??
    "http://localhost:3001";

  return `${normalizeBaseUrl(baseUrl)}/trpc`;
};

export const getTrpcHttpUrl = (): string => {
  const baseUrl =
    resolvePublicEnvBaseUrl() ??
    resolveServerEnvBaseUrl() ??
    resolveBrowserBaseUrl() ??
    "http://localhost:3001";

  const url = `${normalizeBaseUrl(baseUrl)}/trpc`;

  // Dev-only visibility: helps catch cases where the browser falls back to
  // window.location.origin (and therefore points at the Next dev server).
  if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
    console.log("[trpc] resolved http url", {
      url,
      publicEnv: resolvePublicEnvBaseUrl(),
      windowOrigin: window.location?.origin,
    });
  }

  return url;
};
