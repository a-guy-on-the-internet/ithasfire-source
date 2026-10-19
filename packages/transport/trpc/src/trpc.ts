import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Ctx } from "./context";
import type { ProcedureMeta } from "./key-scope/meta";
import {
  readCuratedDomainMeta,
  readDomainMeta,
  resolveWireAppCode,
} from "./utils";

/**
 * tRPC honors `errorFormatter` ONLY when it is set on `initTRPC.create(...)` —
 * NOT when passed to a server adapter's options (the Fastify adapter silently
 * ignored it, so `data.appCode` / `data.meta` were missing on the wire). We add
 * it here so EVERY transport of this router (Fastify, tests, future adapters)
 * surfaces the domain `meta` and a stable `appCode` on `data`.
 *
 * `...shape.data` is preserved so tRPC's built-in fields (dev-only `stack`,
 * `code`, `httpStatus`, `path`, and zodError formatting) are untouched. Errors
 * that never carried a domain code (e.g. Zod input-validation BAD_REQUESTs)
 * simply omit `meta`/`appCode` — expected.
 *
 * INTERNAL_SERVER_ERROR in production: the wire message is replaced with
 * {@link INTERNAL_ERROR_WIRE_MESSAGE} and `meta`/`stack` are dropped. The raw
 * message of an unexpected failure is internals — on 2026-09-29 a 500 handed a
 * scanner `Invalid prisma.$queryRaw() invocation … column h.email does not
 * exist`. `meta` goes too because an adapter error (e.g. Prisma P2010) carries
 * the DB message on its own `.meta`, which `toTrpcError` / `readDomainMeta`
 * pass through — EXCEPT meta a use case curated on an AppError
 * (`readCuratedDomainMeta`), which is written for the client (the dispute desk
 * reads `meta.processorError` off DISPUTE_EVIDENCE_SUBMIT_FAILED, a 500). `appCode` survives — it is a validated `AppErrorCode`, and the
 * client translates it. This shapes the RESPONSE only: the `error` object the
 * apps/api `onError` hook logs and reports to Sentry is untouched.
 */
export const INTERNAL_ERROR_WIRE_MESSAGE = "Internal server error";

/**
 * Fail-safe: either signal of production scrubs. A missing ctx (context
 * creation itself threw) or a ctx built without `isProduction` must never
 * un-scrub a production response.
 */
export const shouldScrubInternalErrors = (ctx: Ctx | undefined): boolean =>
  ctx?.isProduction === true || process.env.NODE_ENV === "production";

export const t = initTRPC.context<Ctx>().meta<ProcedureMeta>().create({
  transformer: superjson,
  errorFormatter({ shape, error, ctx }) {
    const appCode = resolveWireAppCode(error);
    if (
      error.code === "INTERNAL_SERVER_ERROR" &&
      shouldScrubInternalErrors(ctx)
    ) {
      const { stack: _stack, ...data } = shape.data as typeof shape.data & {
        stack?: unknown;
      };
      const curatedMeta = readCuratedDomainMeta(error);
      return {
        ...shape,
        message: INTERNAL_ERROR_WIRE_MESSAGE,
        data: {
          ...data,
          ...(curatedMeta ? { meta: curatedMeta } : {}),
          ...(appCode ? { appCode } : {}),
        },
      };
    }
    const meta = readDomainMeta(error);
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(meta ? { meta } : {}),
        ...(appCode ? { appCode } : {}),
      },
    };
  },
});

/**
 * After every mutation by a RESOLVED actor (a verified session or API key),
 * bump the shared "public read models changed" generation, so the in-process
 * caches of anonymous reads (`publicDiscoveryCache`, the platform-settings
 * snapshot) stop serving pre-write answers on every instance within the
 * generation's memo window. Chained AFTER auth + the rate-limit floor in
 * `init.ts` (`optionalProcedure`, `authedProcedure`), never on `proc`: an
 * unverified Bearer token or a `th_eu_*` cookie must not be able to force
 * bumps. (`isAnonymousRequest` stays the READ gate, which is deliberately
 * stricter.)
 *
 * Deliberately a superset. Every write that can make a public card more
 * private — a venue withholding its address, an event's location/visibility
 * tightening, unpublish/cancel/delete, staff moderation, a ban, a feature
 * flag such as `humanProfilesPublic` — is an actor's mutation, and an
 * allowlist of those paths would silently miss the next one.
 *
 * Bumps whether or not the mutation SUCCEEDED: a use case can commit and then
 * throw (e.g. a save commits, then `idempotency.commit` fails), and a failed
 * mutation costs only one extra reload. Rate-limited and unauthenticated
 * calls never get this far.
 *
 * The SEARCH INDEX is written later than the mutation (post-commit reindex,
 * jobs drains), so index writes bump again on their own — see
 * `with-public-read-bump-on-search-writes.ts`.
 *
 * Not awaited: it moves THIS instance synchronously, and its store round-trip
 * must not add latency to (or fail) the mutation.
 */
export const bumpPublicReadsAfterActorMutation = t.middleware(
  async ({ ctx, type, path, next }) => {
    try {
      return await next();
    } finally {
      if (type === "mutation" && ctx.actorHumanId && ctx.publicReadGeneration) {
        // The port never rejects or throws; a broken one must not fail the
        // mutation — but the swallow is reported (CLAUDE.md reporter rule).
        const reportBumpFailure = (err: unknown) => {
          try {
            ctx.reportError?.(err, {
              tags: { area: "public-read-generation", step: "bump" },
              extra: { path },
            });
          } catch {
            // Best-effort reporting.
          }
        };
        try {
          void ctx.publicReadGeneration.bump(path).catch(reportBumpFailure);
        } catch (err) {
          reportBumpFailure(err);
        }
      }
    }
  },
);

export const router = t.router;
export const proc = t.procedure;

const SLOW_PROCEDURE_MS = 3000;

export const timingMiddleware = t.middleware(
  async ({ ctx, path, type, next }) => {
    const start = performance.now();
    const result = await next();
    const durationMs = Math.round(performance.now() - start);
    if (durationMs > SLOW_PROCEDURE_MS) {
      ctx.logger.warn("trpc.slow_procedure", {
        trpcPath: path,
        trpcType: type,
        durationMs,
      });
    }
    return result;
  },
);
