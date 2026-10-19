import "server-only";

/**
 * Origin-secret header for SERVER-SIDE (SSR / server-to-server) calls into the
 * API.
 *
 * The API's origin-guard (apps/api/src/plugins/origin-guard.ts) verifies an
 * `x-origin-secret` header on every request. In production that header is set
 * by a Cloudflare Transform Rule on traffic that transits the edge. When web's
 * SSR tRPC client calls the API directly at its internal Cloud Run *.run.app
 * origin (see config/trpc.ts `getServerTrpcHttpUrl` + WEB_API_BASE_URL), the
 * request never transits Cloudflare, so no header is injected — the web app
 * must set it itself, using the same shared secret (ORIGIN_SHARED_SECRET,
 * injected into the web service via secret_env in infra/terraform/secrets.tf).
 *
 * `import "server-only"` guarantees this module — and the secret read below —
 * can never be pulled into a client bundle. Returns an empty object when the
 * secret is unset (local dev), where the API guard is a no-op anyway.
 */
const HEADER_NAME = "x-origin-secret";

export function originSecretHeaders(): Record<string, string> {
  const secret = process.env.ORIGIN_SHARED_SECRET?.trim();
  if (typeof secret === "string" && secret.length > 0) {
    return { [HEADER_NAME]: secret };
  }
  return {};
}
