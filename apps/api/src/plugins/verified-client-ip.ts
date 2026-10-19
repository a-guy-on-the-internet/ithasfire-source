import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import {
  VERIFIED_CLIENT_IP_HEADER,
  checkClientIpForward,
  transitedEdge,
  type ClientIpForwardVerdict,
} from "@th/trpc/client-ip";

import { env } from "../lib/env";
import { trpcClientIpDepsFromEnv } from "../lib/trpc-ip-deps";
import { Sentry } from "../instrument";

/**
 * Verifies the web app's signed visitor-IP forward (`x-th-client-ip*`, see
 * packages/transport/trpc/src/client-ip.ts) ONCE per request and stamps the
 * result as `x-th-verified-client-ip`, so header-only consumers key on the
 * visitor rather than on the web server:
 *
 *  - Better Auth's own rate limiter (`advanced.ipAddress.ipAddressHeaders` in
 *    auth/better-auth.ts lists the stamped header first). `/api/auth/token`
 *    and `/api/auth/get-session` are called server-to-server by the web app
 *    on signed-in SSR renders, so without this every signed-in visitor shares
 *    the web server's `/token` bucket.
 *  - the atomic auth pre-limiter and the ban-gate network sightings, both via
 *    `resolveTrustedClientIp`.
 *
 * The tRPC context still verifies the forward itself (`extractClientIp` in
 * context.ts) and does not read the stamped header.
 *
 * SECURITY INVARIANT — the reason any of the above may trust the header:
 * every request has any inbound `x-th-verified-client-ip` DELETED here before
 * anything else can read it, and it is set only on an accepted HMAC. This must
 * stay a global (`fastify-plugin`) `onRequest` hook, registered in app.ts
 * right after the origin guard and BEFORE EVERY ROUTE PLUGIN. Being `fp` is
 * not enough on its own: an encapsulated (non-`fp`) plugin such as `cart` or
 * `accountEmailChange` copies its parent's hooks at the moment it is
 * registered, so one registered before this hook would never strip, and its
 * routes would see a client-sent `x-th-verified-client-ip`. The order is
 * pinned by a source-order test in apps/api/test/verified-client-ip.test.ts.
 * `onRequest` runs ahead of every `preHandler`, so the atomic limiter in
 * plugins/auth-rate-limit.ts always sees the stamped value.
 *
 * Mutates `request.raw.headers` — the Node `IncomingMessage` headers object
 * that `request.headers` returns (Fastify 5 `lib/request.js`, unless something
 * assigns `request.headers`, which nothing in this app does). The Better Auth
 * mount (plugins/better-auth.ts) copies `request.headers` into the Web
 * `Request` it hands to `auth.handler`, so the stamp reaches Better Auth's
 * `getIp` and its hook contexts. `rawHeaders` / `headersDistinct` still carry
 * the client's original bytes; nothing that keys on an IP reads those.
 *
 * Never blocks and never throws: an absent or rejected forward just leaves the
 * header unset, and resolution falls back to the proxy headers as before.
 */

/**
 * Strip any inbound verified-IP header (every case spelling — Node lowercases
 * keys, but a test or non-Node transport may not), then stamp the verified IP
 * when the signed forward checks out. Returns the verdict for reporting.
 */
export function stampVerifiedClientIp(
  headers: Record<string, unknown>,
  secret: string | null | undefined,
  nowSeconds: number,
): ClientIpForwardVerdict {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === VERIFIED_CLIENT_IP_HEADER) delete headers[key];
  }
  const verdict = checkClientIpForward(headers, secret, nowSeconds);
  if (verdict.ok) headers[VERIFIED_CLIENT_IP_HEADER] = verdict.ip;
  return verdict;
}

/**
 * Matches context.ts's throttle: one report per (`reason`, `via`) per 15
 * minutes, so a sustained break leaves periodic breadcrumbs and a caller
 * spraying junk headers cannot flood Sentry.
 */
const REJECTION_REPORT_THROTTLE_MS = 15 * 60 * 1000;

/**
 * tRPC requests are reported by the tRPC context's own verifier
 * (`reportRejectedForward` in context.ts); reporting them here too would
 * double every event. `routeOptions.url` is the matched route pattern (routing
 * resolves before `onRequest`); the raw URL is the fallback for a 404.
 */
const isTrpcRequest = (routeUrl: string | undefined, url: string): boolean => {
  const path = routeUrl ?? url.split("?")[0] ?? url;
  return path === "/trpc" || path.startsWith("/trpc/");
};

const plugin: FastifyPluginAsync = async (app) => {
  // Read the same way dep.ts wires the tRPC context's secret, so the two
  // verifiers can never disagree about which forwards are valid.
  const { clientIpForwardSecret } = trpcClientIpDepsFromEnv(env);
  const capture = safeReporter(Sentry.captureException);

  const reportRejection: ReporterPort = createThrottledReporter(
    (error, context) => {
      try {
        app.deps.logger.error("client_ip_forward_rejected", {
          ...(context?.extra ?? {}),
        });
      } catch {
        // Logging is best-effort here.
      }
      capture(error, context);
    },
    REJECTION_REPORT_THROTTLE_MS,
  );

  app.addHook("onRequest", async (request) => {
    let verdict: ClientIpForwardVerdict;
    try {
      verdict = stampVerifiedClientIp(
        request.raw.headers as Record<string, unknown>,
        clientIpForwardSecret,
        Math.floor(Date.now() / 1000),
      );
    } catch (err) {
      // Unreachable in practice (deleting a key from a plain object and a
      // never-throwing verifier). If it ever fires, the request proceeds
      // without a stamp, i.e. keyed as it was before this plugin existed.
      capture(err, { tags: { area: "verified_client_ip_stamp_failed" } });
      return;
    }

    // Same shape and semantics as context.ts's report (see the `via=direct`
    // vs `via=edge` note there): only a complete-but-rejected forward is
    // reported; `absent` is the normal case for every non-web caller.
    if (verdict.ok || !verdict.complete) return;
    if (isTrpcRequest(request.routeOptions?.url, request.url)) return;
    try {
      const via = transitedEdge(request.headers) ? "edge" : "direct";
      reportRejection(
        new Error(`client_ip_forward_rejected: ${verdict.reason} via ${via}`),
        {
          tags: {
            area: "client_ip_forward_rejected",
            reason: verdict.reason,
            via,
            surface: "http",
          },
          extra: {
            reason: verdict.reason,
            via,
            surface: "http",
            // Client-written; clipped so it cannot pad the log line.
            path: (request.url.split("?")[0] ?? "").slice(0, 256),
            ...(verdict.skewSeconds !== undefined
              ? { skewSeconds: verdict.skewSeconds }
              : {}),
          },
        },
      );
    } catch {
      // Reporting must never affect the request.
    }
  });
};

export default fp(plugin as unknown as never) as unknown as never;
