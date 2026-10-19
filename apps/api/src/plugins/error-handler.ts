import { STATUS_CODES } from "node:http";

import type { FastifyError, FastifyInstance } from "fastify";

import type { LoggerPort } from "@th/ports/logger";

/**
 * Wire message for any 5xx in production. Same string the tRPC
 * errorFormatter uses (packages/transport/trpc/src/trpc.ts) so a client sees
 * one vocabulary whichever transport failed.
 */
export const INTERNAL_ERROR_WIRE_MESSAGE = "Internal server error";

export type InstallErrorHandlerOptions = {
  logger: Pick<LoggerPort, "warn">;
  /**
   * Scrub 5xx messages. Fail-safe like `shouldScrubInternalErrors` in the
   * tRPC package: `NODE_ENV=production` scrubs even if this is false.
   */
  isProduction: boolean;
};

/**
 * The status Fastify's default handler would send for `error`: `statusCode`,
 * else `status` (http-errors style), when it is >= 400; else the reply's
 * status if already an error; else 500.
 */
export function resolveErrorStatus(
  error: { statusCode?: unknown; status?: unknown },
  replyStatus: number,
): number {
  const own =
    typeof error.statusCode === "number"
      ? error.statusCode
      : typeof error.status === "number"
        ? error.status
        : undefined;
  if (own !== undefined && own >= 400) {
    return own;
  }
  return replyStatus >= 400 ? replyStatus : 500;
}

/**
 * Error handler for the NON-tRPC routes (webhooks, iCal, cart, account,
 * health). tRPC shapes its own errors; this never sees them.
 *
 * Fastify's default handler puts `error.message` on the wire for every status,
 * 500s included — measured 2026-09-29 against fastify 5.6.0 with
 * NODE_ENV=production: a thrown Prisma error answered
 * `{"statusCode":500,…,"message":"Invalid prisma.$queryRaw() invocation: …"}`
 * (security review F14). In production a 5xx now answers a fixed message;
 * 4xx and every non-production response keep Fastify's default body.
 *
 * Capture is untouched: Sentry's Fastify integration reports the error from
 * its own `onError` hook / diagnostics channel (see
 * `Sentry.setupFastifyErrorHandler` in app.ts), which runs regardless of what
 * this handler sends. That is also why the log line below is `warn`, not
 * `error`: `logger.error` is captured again by Sentry's pinoIntegration, and
 * this failure is already reported once.
 *
 * MUST be installed before any route is registered: Fastify binds a route to
 * the error handler in force when the route is added.
 */
export function installErrorHandler(
  app: FastifyInstance,
  opts: InstallErrorHandlerOptions,
): void {
  const scrub = opts.isProduction || process.env.NODE_ENV === "production";

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = resolveErrorStatus(
      error as FastifyError & { status?: unknown },
      reply.statusCode,
    );

    if (statusCode < 500 || !scrub) {
      // Hand back to Fastify's default serializer (the parent handler).
      reply.send(error);
      return;
    }

    opts.logger.warn("http_unhandled_error_scrubbed", {
      err: error,
      statusCode,
      method: request.method,
      route: request.routeOptions?.url ?? null,
    });

    reply.code(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode] ?? "Internal Server Error",
      message: INTERNAL_ERROR_WIRE_MESSAGE,
    });
  });
}
