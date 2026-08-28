import { timingSafeEqual } from "node:crypto";

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import { env } from "../lib/env";

// Matches the convention used elsewhere in this app (e.g.
// dev-request-logging.ts, cors.ts) rather than exporting an `isProd` flag
// from env.ts.
const isProd = process.env.NODE_ENV === "production";

const HEADER_NAME = "x-origin-secret";

/**
 * Paths that must always be reachable directly, even when the origin guard
 * is enforced (403 mode) — e.g. Cloud Run startup/liveness probes, which
 * never carry the Cloudflare-injected header. Keep this list easy to extend
 * as more probe paths get added.
 */
const EXEMPT_PATHS = ["/health"];

/**
 * Constant-time comparison of the provided header value against the
 * configured secret. `timingSafeEqual` throws on a buffer-length mismatch,
 * so length is checked first and any mismatch is treated as a failed
 * comparison rather than letting the exception propagate.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Origin-secret guard — interim mitigation for the "direct-to-Cloud-Run
 * origin bypass" documented in app.ts (see the `trustProxy` note). Cloud Run
 * has public ingress and no GCLB in front of it, so anyone who resolves the
 * *.run.app origin can skip Cloudflare's edge entirely (WAF, rate limiting
 * keyed on CF-Connecting-IP, etc).
 *
 * A Cloudflare Transform Rule (infra/terraform/modules/cloudflare) sets the
 * `x-origin-secret` header to a shared secret on every request that transits
 * the edge. Requests that hit the origin directly won't carry it (or will
 * carry the wrong value). This plugin compares it in constant time and:
 *
 *  - always logs a mismatch (never the secret value itself)
 *  - only blocks (403) when ENFORCE_ORIGIN_SECRET=true — the default is
 *    log-only so a bad rollout (missing/rotated secret, Cloudflare rule not
 *    yet live) can't brick prod traffic.
 *
 * The long-term fix is a GCLB + Cloudflare Authenticated Origin Pulls — see
 * the note in app.ts for the full plan.
 */
const plugin: FastifyPluginAsync = async (app) => {
  // Local/preview environments have no Cloudflare edge in front of them —
  // there is no header to check, so skip entirely outside production.
  if (!isProd) {
    return;
  }

  app.addHook("onRequest", async (request, reply) => {
    // `request.url` is the raw, un-normalized URL Node received — it still
    // carries any query string (and wouldn't have a trailing slash
    // stripped), so `/health?foo=bar` would fail an exact-string match
    // against EXEMPT_PATHS and fall through to the secret check. Per
    // Fastify's request lifecycle, routing resolves *before* `onRequest`
    // fires, so `request.routeOptions.url` — the matched route's registered
    // path, with no query string — is already populated here and is what we
    // actually want to compare. Fall back to a manually query-stripped
    // `request.url` for the (routing-failed / 404) case where no route
    // matched and `routeOptions` is unset.
    const requestPath =
      request.routeOptions?.url ?? request.url.split("?")[0] ?? request.url;
    if (EXEMPT_PATHS.includes(requestPath)) {
      return;
    }

    const expected = env.ORIGIN_SHARED_SECRET;
    const provided = request.headers[HEADER_NAME];

    const matches =
      typeof expected === "string" &&
      expected.length > 0 &&
      typeof provided === "string" &&
      secretsMatch(provided, expected);

    if (matches) {
      return;
    }

    // Never log the secret value itself — only that a mismatch occurred and
    // where. Stable message so this is easy to alert on / grep for.
    app.deps.logger.warn("origin_secret_mismatch", {
      path: request.url,
      method: request.method,
    });

    if (env.ENFORCE_ORIGIN_SECRET) {
      await reply.code(403).send({ error: "origin_secret_mismatch" });
    }
  });
};

export default fp(plugin);
