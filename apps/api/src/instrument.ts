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
import { scrubLocationFromErrorEvent } from "@th/errors";
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

/**
 * Pin `user.ip_address` to our resolved client IP (the `client_ip` tag set per
 * request in plugins/dev-request-logging.ts and in the tRPC onError hook).
 *
 * With `sendDefaultPii`, Sentry's requestDataIntegration fills
 * `user.ip_address` from `X-Client-IP`, then the leftmost `X-Forwarded-For`
 * (@sentry/core 10.46 `vendor/getIpAddress.js`), both of which the client
 * writes, and it runs AFTER scope data is applied, so setting the user on the
 * scope loses. `beforeSend` runs last; overwrite there. No tag → untouched.
 *
 * The pinned value is NOT proof of origin. `client_ip` prefers
 * `cf-connecting-ip`, which is client-forgeable on direct-to-origin requests
 * (`*.run.app`, bypassing Cloudflare) for as long as ENFORCE_ORIGIN_SECRET is
 * off — the origin guard only blocks such requests when it is on. For a
 * forensic read, cross-check the rightmost `forwardedFor` hops logged beside it (see
 * `describeClientIp` in @th/trpc/client-ip).
 */
/**
 * Invitation accept/preview calls (`orgs.acceptInvitation`,
 * `orgs.previewInvitation`, `delegates.acceptInvite`, `delegates.previewInvite`)
 * carry a BEARER invite token in the POST body. With `sendDefaultPii` the
 * body lands in `request.data`, so an error on those routes would ship a live
 * credential. Redact any `*token` key at the top level and in the tRPC
 * envelope (`{ json: { token } }`, batched `{ "0": { json: { token } } }`) —
 * depth-bounded, never throws, handles an object or a JSON string body.
 *
 * `*secret` keys are redacted the same way: `embeds.confirmGuestPayment`
 * carries a Stripe PaymentIntent client secret (`clientSecret`) in its body,
 * the guest's only proof that an order is theirs, and the use case holds it
 * in locals named `*Secret` for the frame-vars pass below.
 *
 * `clientKey` is redacted too. It is a checkout's idempotency key, and for
 * `embeds.createGuestCheckout` it works as a credential: sent again with the
 * same guest email and cart, it replays the stored answer, client secret
 * included. `*clientKey` also covers `orders.createCheckout`'s key.
 */
const BODY_TOKEN_KEY_RE = /(token|secret|clientKey)$/i;

const redactBodyTokens = (value: unknown, depth: number): unknown => {
  if (depth > 3 || !value || typeof value !== "object") {
    return value;
  }
  // An array is walked, not skipped: a batched tRPC body can arrive as one
  // (`[{ json: { token } }]`). It costs a level of depth like an object.
  if (Array.isArray(value)) {
    return value.map((item) => redactBodyTokens(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      BODY_TOKEN_KEY_RE.test(k) && typeof v === "string"
        ? "[redacted]"
        : redactBodyTokens(v, depth + 1);
  }
  return out;
};

export const scrubRequestBodyTokens = <E extends { request?: { data?: unknown } }>(
  event: E,
): E => {
  try {
    const data = event.request?.data;
    if (typeof data === "string") {
      if (/token|secret|clientKey/i.test(data)) {
        try {
          event.request!.data = JSON.stringify(
            redactBodyTokens(JSON.parse(data), 0),
          );
        } catch {
          // Not JSON — redact `token=value` / `"token":"value"` (and the
          // `secret` forms) textually. The `=` pattern starts AT the word:
          // a leading `[a-z_-]*` would re-scan a long run of letters from
          // every position (quadratic on a caller-sized body), and it is not
          // needed, since `$1` only has to carry `token=`; the key's prefix
          // (`refresh` in `refreshToken=`) is left where it is either way.
          event.request!.data = data
            .replace(/((?:token|secret|clientKey)=)[^&\s]+/gi, "$1[redacted]")
            .replace(
              /("[a-z_-]*(?:token|secret|clientKey)"\s*:\s*)"[^"]*"/gi,
              '$1"[redacted]"',
            );
        }
      }
    } else if (data && typeof data === "object") {
      event.request!.data = redactBodyTokens(data, 0);
    }
  } catch {
    // never throw from a Sentry hook
  }
  return event;
};

/**
 * The same credentials in the URL: a tRPC call sent as a GET carries its
 * input in the query string, and a hand-built link can carry
 * `?token=…` / `?client_secret=…` (Stripe appends
 * `payment_intent_client_secret=` to a redirect return URL).
 *
 * Covers exactly two fields, `event.request.url` and
 * `event.request.query_string`: the value of any `*token=` / `*secret=`
 * parameter, and of a `*token` / `*secret` key inside URL-encoded JSON
 * (`…secret%22%3A%22<value>%22`). Never throws.
 *
 * NOT covered: span attributes. A transaction's root span can carry the raw
 * query too (`contexts.trace.data` keys such as `url`, `http.target`,
 * `http.query`, and each `spans[].data`), and nothing here reads them.
 *
 * Both patterns start at a literal, never at a repeated class: they run in
 * `beforeSendTransaction` on a caller-controlled URL, so each must stay
 * linear in its length.
 */
const URL_PARAM_TOKEN_RE = /((?:token|secret)=)[^&#\s]+/gi;
const URL_ENCODED_JSON_TOKEN_RE =
  /((?:token|secret)%22%3A%22)(?:(?!%22)[^&#\s])*/gi;

const redactUrlTokens = (value: string): string =>
  value
    .replace(URL_PARAM_TOKEN_RE, "$1[redacted]")
    .replace(URL_ENCODED_JSON_TOKEN_RE, "$1[redacted]");

export const scrubRequestUrlTokens = <
  E extends { request?: { url?: string; query_string?: unknown } },
>(
  event: E,
): E => {
  const req = event.request;
  if (!req) return event;
  try {
    if (typeof req.url === "string") req.url = redactUrlTokens(req.url);
    const qs = req.query_string;
    if (typeof qs === "string") {
      req.query_string = redactUrlTokens(qs);
    } else if (Array.isArray(qs)) {
      // Sentry also accepts `[key, value]` pairs.
      req.query_string = qs.map((pair) =>
        Array.isArray(pair) &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string"
          ? [
              pair[0],
              BODY_TOKEN_KEY_RE.test(pair[0])
                ? "[redacted]"
                : redactUrlTokens(pair[1]),
            ]
          : pair,
      );
    } else if (qs && typeof qs === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(qs as Record<string, unknown>)) {
        out[k] =
          typeof v !== "string"
            ? v
            : BODY_TOKEN_KEY_RE.test(k)
              ? "[redacted]"
              : redactUrlTokens(v);
      }
      req.query_string = out;
    }
  } catch {
    // never throw from a Sentry hook
  }
  return event;
};

/**
 * Frame locals (`frames[].vars`) can hold the same bearer invite token (a
 * use case's `input.token`, a local `token`). The API does not turn on
 * `includeLocalVariables`, so this is a no-op today; it stays as defence in
 * depth in case the option, or another source of frame vars, returns. Walk
 * `exception.values[].stacktrace.frames[].vars` the way
 * `scrubLocationFromErrorEvent` does and redact `*token` keys (depth-bounded,
 * never throws). On an internal failure, drop that frame's vars.
 */
export const scrubFrameVarTokens = <E extends { exception?: unknown }>(
  event: E,
): E => {
  const values = (event.exception as { values?: unknown } | undefined)?.values;
  if (!Array.isArray(values)) return event;
  for (const value of values) {
    const frames = (value as { stacktrace?: { frames?: unknown } } | null)
      ?.stacktrace?.frames;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!frame || typeof frame !== "object") continue;
      const f = frame as { vars?: unknown };
      if (f.vars === undefined) continue;
      try {
        f.vars = redactBodyTokens(f.vars, 0);
      } catch {
        delete f.vars;
      }
    }
  }
  return event;
};

export const pinUserIpToClientIpTag = <
  E extends {
    tags?: Record<string, unknown>;
    user?: Record<string, unknown>;
  },
>(
  event: E,
): E => {
  const ip = event.tags?.client_ip;
  if (typeof ip === "string" && ip.length > 0) {
    event.user = { ...event.user, ip_address: ip };
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

    // `includeLocalVariables` is deliberately OFF (the default). It cost
    // ~75 MiB of native memory (a second V8 isolate worker plus the
    // inspector), paused the main thread on every exception, and across 90
    // days of Sentry events no frame carried vars (checked via the Sentry API
    // 2026-10-18). `beforeSend` still scrubs frame vars as defence in depth.

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
      scrubRequestBodyTokens(event);
      scrubRequestUrlTokens(event);
      scrubFrameVarTokens(event);

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

      // LAST, on everything that is actually going out: strip street / pin /
      // postcode / phone from frame locals, the request body, extra, contexts
      // and breadcrumbs (withheld venue addresses — see the helper). Never
      // throws; on an internal failure it drops the frames' locals.
      return scrubLocationFromErrorEvent(pinUserIpToClientIpTag(event));
    },

    // Transactions bypass `beforeSend`; scrub the feed token from the
    // request context (and any leaked concrete path in the name) here too,
    // and the same location scrub (request body, contexts, breadcrumbs).
    beforeSendTransaction(event) {
      return scrubLocationFromErrorEvent(
        pinUserIpToClientIpTag(
          scrubRequestUrlTokens(
            scrubRequestBodyTokens(scrubVolunteerFeedToken(event)),
          ),
        ),
      );
    },
  });
}

export { Sentry };
