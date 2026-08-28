import Fastify from "fastify";
import * as Sentry from "@sentry/node";

import { buildDeps, type AppDeps } from "./lib/dep";
import { env } from "./lib/env";
import {
  createMigrationDriftMonitor,
  readAppliedMigrations,
  readExpectedMigrations,
  resolveMigrationsDir,
} from "@th/adapters/infra/migration-drift";
import { validateJwks } from "./auth/validate-jwks";
import cors from "./plugins/cors";
import securityHeaders from "./plugins/security-headers";
import originGuard from "./plugins/origin-guard";
import authRateLimit from "./plugins/auth-rate-limit";
import betterAuth from "./plugins/better-auth";
import devRequestLogging from "./plugins/dev-request-logging";
import rawBody from "./plugins/raw-body";
import trpc from "./plugins/trpc";
import health from "./routes/health";
import cart from "./routes/cart";
import accountEmailChange from "./routes/account/email-change";
import stripeWebhook from "./routes/stripe/webhook";
import resendWebhook from "./routes/resend/webhook";
import snsSmsInbound from "./routes/aws/sms-inbound";
import ical from "./routes/ical";

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function createApp() {
  const deps = await buildDeps();

  // Self-heal: detect BETTER_AUTH_SECRET rotation and clear stale JWKS keys
  // before the server starts accepting auth requests.
  await validateJwks(env.BETTER_AUTH_SECRET, deps.logger);

  // Migration-drift guard. Checked at boot; /health serves the verdict.
  //
  // Caching is ASYMMETRIC (see createMigrationDriftMonitor): `ok` is cached
  // permanently so the probe stays free, while `drift`/`unknown` are re-queried
  // on a short interval. That matters because deploy #583 raced terraform
  // against migrate_db and cached a `drift` verdict that had stopped being true
  // 2m16s later — every probe replayed the stale 503 until the budget expired.
  //
  // We deliberately do NOT throw/exit on drift: the container must
  // stay up and answer the startup probe for the failure to be diagnosable.
  // A crash-loop on Cloud Run surfaces as a generic "container failed to
  // start" with the reason buried in logs, whereas a 503 whose body names the
  // pending migrations is self-explanatory in the deploy probe output — and
  // the revision is still never promoted to serve traffic either way.
  //
  // Detection is unconditional and always logged + reported; only the 503 is
  // gated (to Cloud Run / NODE_ENV=production, via shouldBlockOnDrift, with
  // MIGRATION_DRIFT_ENFORCE=false as the documented break-glass). A 503 on a
  // dev laptop would take the whole `pnpm dev` stack down via
  // scripts/human-dev.cjs's health gate — see
  // @th/adapters/infra/migration-drift.
  const migrationDrift = await createMigrationDriftMonitor({
    listExpectedMigrations: () =>
      readExpectedMigrations(resolveMigrationsDir()),
    listAppliedMigrations: () => readAppliedMigrations(deps.prisma),
    logger: deps.logger,
    reportError: Sentry.captureException,
  });

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    // `trustProxy` lets Fastify derive `req.ip`/`req.protocol` from forwarding
    // headers. NOTE: the anti-abuse rate limiters do NOT rely on `req.ip`; they
    // read `CF-Connecting-IP` (then `true-client-ip`/`x-real-ip`/`x-forwarded-for`,
    // socket last) explicitly via resolveClientIp — see
    // packages/transport/trpc/src/context.ts (extractClientIp) and client-ip.ts.
    //
    // Hop-trust (LB-revisit): `CF-Connecting-IP` is unforgeable ONLY while
    // traffic transits Cloudflare. The Cloud Run origin currently has public
    // ingress and there is NO GCLB in front (infra/terraform/stack/main.tf:
    // Cloudflare-proxied records + Cloud Run domain mapping to
    // ghs.googlehosted.com), so a request bypassing Cloudflare could forge that
    // header — an accepted soft-cap risk today (the throttled suggestion queue
    // is fully moderated before anything goes public).
    //
    // WHEN A GCLB IS INTRODUCED (client → Cloudflare → GCLB → Cloud Run with
    // internal ingress / Authenticated Origin Pulls), re-verify the header
    // precedence and hop-trust assumption in context.ts, and reconsider whether
    // `trustProxy` + `req.ip` should replace the explicit header reads.
    trustProxy: true,
    // Allow large CSV import batches (default is 1 MiB)
    bodyLimit: 10 * 1024 * 1024, // 10 MiB
    routerOptions: {
      maxParamLength: 5000,
    },
  });

  app.decorate("deps", deps);

  app.addHook("onClose", async (instance) => {
    await instance.deps.close();
  });

  await app.register(devRequestLogging);
  await app.register(securityHeaders);
  await app.register(cors);
  // Origin-secret guard — see plugins/origin-guard.ts and the trustProxy
  // note above. No-ops outside production; /health stays exempt.
  await app.register(originGuard);
  await app.register(rawBody);

  // ATOMIC guess-space rate limiting for /api/auth/*. MUST be registered
  // before the better-auth plugin so its `preHandler` runs ahead of the auth
  // handler; it also needs `rawBody` above so `request.body` is parsed by the
  // time the hook fires. Better Auth's own limiter stays enabled as a
  // backstop — see plugins/auth-rate-limit.ts for why a second layer exists
  // at all (Better Auth's is a non-atomic read-modify-write, so every cap is
  // bypassable under concurrency).
  await app.register(authRateLimit);
  await app.register(betterAuth);
  await app.register(trpc, { deps: deps.trpc });
  await app.register(health, { migrationDrift });
  await app.register(cart);
  await app.register(accountEmailChange);

  // E2E / test-only routes: only register outside production.
  if (process.env.NODE_ENV !== "production") {
    const [{ default: e2e }, { default: e2eDebugAuth }] = await Promise.all([
      import("./routes/e2e/index"),
      import("./routes/e2e-debug-auth"),
    ]);
    await app.register(e2e);
    await app.register(e2eDebugAuth);
  }

  await app.register(stripeWebhook);
  await app.register(resendWebhook);
  await app.register(snsSmsInbound);
  await app.register(ical);

  // Sentry error handler must be registered after all routes/plugins so it
  // can catch errors that bubble up from request handlers.
  Sentry.setupFastifyErrorHandler(app);

  return app;
}

export type App = Awaited<ReturnType<typeof createApp>>;
