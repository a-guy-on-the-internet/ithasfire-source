import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

import { safeReporter } from "@th/ports/reporter";

import {
  AUTH_BASE_PATH,
  AUTH_RATE_LIMIT_RESPONSE_BODY,
  AUTH_RATE_LIMIT_RESPONSE_CONTENT_TYPE,
  AUTH_RATE_LIMIT_RETRY_AFTER_HEADER,
  createAtomicAuthRateLimiter,
} from "../auth/atomic-rate-limit";
import { env } from "../lib/env";
import { Sentry } from "../instrument";

/**
 * ATOMIC rate limiting for Better Auth's guess-space endpoints, enforced
 * BEFORE the request reaches `plugins/better-auth.ts`.
 *
 * Better Auth's own limiter is a non-atomic read-modify-write, so all of its
 * caps are bypassable by issuing requests concurrently instead of
 * sequentially (24 concurrent bad-password sign-ins passed a 5/60s cap on the
 * live dev API with zero 429s). The full mechanism, the measurement, the
 * endpoint scope and the keying/fail-open contracts live in
 * `../auth/atomic-rate-limit.ts` and `../auth/rate-limit-rules.ts` — read
 * those before changing anything here. This file is deliberately just the
 * transport: match the path, ask the evaluator, render Better Auth's exact
 * 429.
 *
 * `preHandler`, not `onRequest`, so `request.body` is already parsed and the
 * per-account bucket can read the email/username/phone out of it.
 *
 * Registered in `app.ts` BEFORE the better-auth plugin. Better Auth's own
 * limiter stays enabled and unchanged as a backstop — but ONLY for the
 * canonical path form; see the "THE BACKSTOP IS NOT A SAFETY NET" note in
 * `../auth/atomic-rate-limit.ts`. For any non-canonical form this hook is the
 * only layer applying the real cap.
 */
const plugin: FastifyPluginAsync = async (app) => {
  const limiter = createAtomicAuthRateLimiter({
    // The SAME RedisRateLimitAdapter instance (and therefore the same ioredis
    // client) the tRPC limiter uses — see `lib/dep.ts`. Deliberately not a
    // second Redis connection: `rate-limit-storage.ts` already had to open
    // its own because Better Auth's `auth` object is constructed at module
    // import time, before `buildDeps()`; a Fastify plugin has no such
    // constraint and `app.deps` is right here.
    rateLimit: app.deps.trpc.rateLimit,
    logger: app.deps.logger,
    // Keys the account-identifier HMAC. Reuses BETTER_AUTH_SECRET rather than
    // adding another env var: it is already required (min 32 chars) in
    // production, it is already the trust anchor for this exact subsystem's
    // data, and an auth server without it is non-functional anyway. Rotating
    // it re-buckets every account once — harmless at a 60s window.
    //
    // The dev/test fallback is NOT a security downgrade: the property the key
    // provides is "a Redis dump alone can't be dictionary-attacked back to
    // emails", and a local dev Redis holds only seeded fixtures. It exists so
    // the plugin cannot crash boot on a laptop where the var is unset (env.ts
    // makes it optional outside production).
    identifierHashKey:
      env.BETTER_AUTH_SECRET ?? "dev-only-auth-rate-limit-identifier-key",
    // Fail-open branches only (Redis unreachable ⇒ brute-force protection
    // silently off). `safeReporter` guarantees a throwing capture can never
    // convert the fail-open allow into a request failure.
    reportError: safeReporter(Sentry.captureException),
  });

  app.addHook("preHandler", async (request, reply) => {
    // Cheap prefix reject before any work — this hook is global
    // (fastify-plugin, like origin-guard) so it runs on every request.
    //
    // KEEP THIS EXACTLY `${AUTH_BASE_PATH}/`. It is a pre-filter, not the
    // path matcher: the real decision is `normalizeAuthPath`, which resolves
    // the target through `new URL()` the way `plugins/better-auth.ts` does.
    // Verified both directions — LOOSER leaks nothing extra (every target
    // that reaches the auth handler is routed by Fastify's `/api/auth/*`
    // route, so it necessarily carries this prefix verbatim), and TIGHTER
    // (e.g. pre-normalizing here, or matching the endpoint path at this
    // layer) breaks the dot-segment/backslash forms that Fastify routes to
    // the auth handler but that do not literally spell the endpoint.
    if (!request.url.startsWith(`${AUTH_BASE_PATH}/`)) return;

    const decision = await limiter({
      url: request.url,
      headers: request.headers,
      body: request.body,
      contentType: request.headers["content-type"],
      socketAddress: request.raw.socket?.remoteAddress,
    });

    if (!decision.limited) return;

    // Byte-for-byte Better Auth's own `rateLimitResponse()` — status,
    // `text/plain` content type (a `new Response(jsonString)` quirk), the
    // non-standard `X-Retry-After` header, and the message body. Matching it
    // means no existing client can tell the two limiters apart, and nothing
    // that already handles Better Auth 429s (e.g. the auth cold-load retry in
    // `apps/web/src/lib/trpc.ts`) has to learn a second shape.
    await reply
      .code(429)
      .header("content-type", AUTH_RATE_LIMIT_RESPONSE_CONTENT_TYPE)
      .header(
        AUTH_RATE_LIMIT_RETRY_AFTER_HEADER,
        String(decision.retryAfterSeconds),
      )
      .send(AUTH_RATE_LIMIT_RESPONSE_BODY);
  });
};

export default fp(plugin as unknown as never) as unknown as never;
