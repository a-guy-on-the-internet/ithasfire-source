import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { describeClientIp } from "@th/trpc/client-ip";

import { Sentry } from "../instrument";

const isProd = process.env.NODE_ENV === "production";

/** Probe paths that would drown the prod access log. */
const PROD_SKIP_PATHS = new Set(["/health"]);

/**
 * Client-IP fields for this request — see `describeClientIp`
 * (packages/transport/trpc/src/client-ip.ts) for what each field means and
 * the hop-trust caveat: `cf-connecting-ip` is forgeable on direct-to-origin
 * requests while ENFORCE_ORIGIN_SECRET is off, so the full XFF chain is
 * logged beside it.
 */
export const requestIpFields = (request: FastifyRequest) =>
  describeClientIp(request.headers, request.socket?.remoteAddress);

/**
 * Per-request access log.
 *
 * Production (added 2026-09-29): behind Cloudflare, Cloud Run's own request
 * log only shows Cloudflare edge IPs, so the attacker that night could not be
 * identified. This line carries the real client IP. It logs the matched ROUTE
 * TEMPLATE, never `request.url`: raw URLs carry capability tokens (the
 * volunteering iCal feed token sits in the path; unsubscribe/claim tokens ride
 * query strings), and Cloud Logging is not the place for them.
 *
 * Local/dev keeps the raw URL, as before.
 *
 * The same `onRequest` hook tags the request's Sentry isolation scope with
 * `client_ip`, so every event captured during the request carries it — see
 * `beforeSend` in instrument.ts, which pins `user.ip_address` to that tag.
 */
const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (request as any).__thStartAt = Date.now();
    const { clientIp } = requestIpFields(request);
    if (clientIp) {
      try {
        Sentry.getIsolationScope().setTag("client_ip", clientIp);
      } catch {
        // Tagging is best-effort; never fail a request over it.
      }
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const startedAt = (request as any).__thStartAt as number | undefined;
    const durationMs =
      typeof startedAt === "number" ? Date.now() - startedAt : undefined;

    const route = request.routeOptions?.url;
    if (isProd && route && PROD_SKIP_PATHS.has(route)) return;

    const ip = requestIpFields(request);

    // Use the existing app logger port (pino adapter) so logs land wherever
    // the rest of the app logs go.
    app.deps.logger.info("http_request", {
      method: request.method,
      // fastify's request.url includes the full path + querystring — dev only.
      // Unmatched (404 probe) paths are logged without their query string:
      // every capability-token route is a MATCHED route, so this can't leak
      // one, and the probed path is exactly what forensics wants.
      ...(isProd
        ? route
          ? { route }
          : { path: (request.url.split("?")[0] ?? "").slice(0, 256) }
        : { url: request.url }),
      statusCode: reply.statusCode,
      durationMs,
      clientIp: ip.clientIp,
      cfConnectingIp: ip.cfConnectingIp,
      forwardedFor: ip.forwardedFor,
    });
  });
};

export default fp(plugin as unknown as never) as unknown as never;
