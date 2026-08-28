/**
 * Sentry instrumentation for the Fastify API server.
 *
 * This file MUST be imported before any other modules so the SDK can
 * monkey-patch Node built-ins for automatic instrumentation.
 *
 * In production the entry-point uses `--import ./instrument.mjs` (ESM loader)
 * or `import "./instrument"` at the very top of `index.ts`.
 */
import * as Sentry from "@sentry/node";
import { isbot } from "isbot";
import { isInternalAppCode } from "@th/trpc/utils";

const dsn = process.env.SENTRY_DSN;

/**
 * Effective traces sample rate. Mirrors `apps/jobs/src/instrument.ts` — keep
 * the two in sync.
 *
 * Precedence: `SENTRY_TRACES_SAMPLE_RATE` (when a finite number in [0, 1]) →
 * environment default (0.1 in production, 1.0 elsewhere). An unparseable or
 * out-of-range value falls back to the default rather than throwing —
 * instrumentation must never be the reason a service fails to boot.
 *
 * NOTE for anyone reading span counts downstream: Sentry records the
 * effective rate on each trace as `client_sample_rate`, so absolute event
 * volume is `observed / client_sample_rate`. Ratios *between* spans in the
 * same transaction are unaffected by sampling and need no correction — that
 * distinction is what makes `[skill:resource-burn]`'s share-of-traffic
 * numbers trustworthy even while absolute counts carry sampling error.
 */
export function resolveTracesSampleRate(): number {
  const fallback = process.env.NODE_ENV === "production" ? 0.1 : 1.0;
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

/**
 * The "my volunteering" iCal feed puts a bearer capability token in the URL
 * path (`/api/volunteering/:feedToken/calendar.ics`). With `sendDefaultPii`
 * on, the fastify integration attaches the full request URL to every event,
 * so an error on that route would ship the secret to Sentry. Scrub the token
 * path segment (and any query string riding on a feed URL) before send.
 *
 * Narrowly scoped: only URLs under `/api/volunteering/` are touched.
 */
const VOLUNTEER_FEED_PATH_RE = /(\/api\/volunteering\/)[^/?#]+/;

const scrubVolunteerFeedToken = <
  E extends {
    request?: { url?: string; query_string?: unknown };
    transaction?: string;
  },
>(
  event: E,
): E => {
  const req = event.request;
  if (typeof req?.url === "string" && VOLUNTEER_FEED_PATH_RE.test(req.url)) {
    req.url = req.url.replace(VOLUNTEER_FEED_PATH_RE, "$1[redacted]");
    // The token lives in the path, but anything appended to a capability URL
    // is equally sensitive — drop the whole query string for this route.
    if (req.query_string) req.query_string = "[redacted]";
  }
  // Transaction names come from OTel's fastify route templating and are
  // normally already parameterized ("GET /api/volunteering/:feedToken/…"),
  // which we keep verbatim for grouping. Only scrub when a CONCRETE token
  // leaked into the name (e.g. no route matched and the raw path was used).
  if (
    typeof event.transaction === "string" &&
    VOLUNTEER_FEED_PATH_RE.test(event.transaction) &&
    !event.transaction.includes("/api/volunteering/:")
  ) {
    event.transaction = event.transaction.replace(
      VOLUNTEER_FEED_PATH_RE,
      "$1[redacted]",
    );
  }
  return event;
};

if (dsn) {
  Sentry.init({
    dsn,

    sendDefaultPii: true,

    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",

    // 100 % in dev, 10 % in production. Overridable via
    // SENTRY_TRACES_SAMPLE_RATE — see `resolveTracesSampleRate` below and
    // `[skill:resource-burn]` for why (exact span counts during a
    // resource-burn investigation).
    tracesSampleRate: resolveTracesSampleRate(),

    // Attach local variable values to stack frames
    includeLocalVariables: true,

    integrations: [
      Sentry.fastifyIntegration(),
      // Auto-instrument every pino logger created in this process so that:
      //   - all levels emit Sentry breadcrumbs / structured logs, and
      //   - `logger.error(..., { err })` is also captured as a handled
      //     exception with the `err` field linked via the SDK's default
      //     `linkedErrors` integration.
      //
      // This closes the gap where use-case "best-effort" failures
      // (transfer email failed, volunteer notify failed, etc.) were
      // only visible in Cloud Logging because the trpc/fastify
      // integrations only see thrown errors, not warn/error logs.
      Sentry.pinoIntegration({
        error: { levels: ["error", "fatal"], handled: true },
      }),
    ],

    // Suppress Sentry noise in local dev unless explicitly enabled
    debug: process.env.SENTRY_DEBUG === "true",

    // Drop crawler traffic. Bots execute our JS clients (via Googlebot
    // mobile rendering and friends) and trip trpc fetch paths, then we
    // see them as "TRPCClientError: Failed to fetch" events that look
    // like real user problems. `isbot` ships a maintained UA list.
    beforeSend(event) {
      // Redact the volunteering feed capability token from request URLs
      // before any other processing (bot-dropped events are gone anyway).
      scrubVolunteerFeedToken(event);

      const headers = event.request?.headers as
        | Record<string, string | string[] | undefined>
        | undefined;
      const ua = headers?.["user-agent"] ?? headers?.["User-Agent"];
      if (typeof ua === "string" && isbot(ua)) {
        return null;
      }

      // Drop EXPECTED domain errors. A `fail("PAID_TICKETING_REQUIRES_STRIPE")`
      // is an `AppError` that maps to a 412 (PRECONDITION_FAILED) — a normal
      // client-facing precondition, not a server fault. The pino integration
      // (`error.levels`) turns any error-level log of the thrown error into a
      // handled Sentry issue regardless of the deliberate warn/error gate in the
      // trpc onError hook, so this backstop is the guaranteed filter.
      //
      // We classify by the AppError's CANONICAL code (carried in the exception
      // value's `value`/message — `fail(code)` defaults the message to the code,
      // so it is the SCREAMING_SNAKE `AppErrorCode`). Codes that map to a
      // non-500 tRPC bucket are dropped; 500-bucket AppErrors and every
      // non-AppError exception are kept. An unrecognized code is treated as
      // internal (kept) so a genuinely-unknown failure is never hidden.
      const values = event.exception?.values;
      if (values?.length) {
        const appErrorValues = values.filter((v) => v.type === "AppError");
        if (
          appErrorValues.length > 0 &&
          // Drop only when EVERY AppError value is an expected non-500 code.
          // (Chained exceptions are rare here, but if any value is a real 500
          // we keep the event.)
          appErrorValues.every(
            (v) => typeof v.value === "string" && !isInternalAppCode(v.value),
          ) &&
          // And there is no non-AppError exception riding along that we'd lose.
          values.every((v) => v.type === "AppError")
        ) {
          return null;
        }
      }

      return event;
    },

    // Transactions bypass `beforeSend`; scrub the feed token from the
    // request context (and any leaked concrete path in the name) here too.
    beforeSendTransaction(event) {
      return scrubVolunteerFeedToken(event);
    },
  });
}

export { Sentry };
