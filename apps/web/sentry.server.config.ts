import * as Sentry from "@sentry/nextjs";
import { isbot } from "isbot";
import { scrubLocationFromErrorEvent } from "@th/errors";

import { scrubSentryEvent } from "./src/lib/sentry/redact-url-tokens";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  environment:
    process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",

  // Server-side error capture runs under "legitimate interest" (GDPR
  // Recital 49 — security and incident diagnostics). To stay inside that
  // basis we strip request PII before transmission. Identifiers we still
  // need for triage (orgId, eventId, …) get attached explicitly via
  // Sentry.setContext / setTag, never auto-collected.
  sendDefaultPii: false,

  // 100% in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Attach local variable values to server-side stack frames
  includeLocalVariables: true,

  beforeSend(event) {
    // Drop crawler traffic before any PII scrubbing so we don't waste a
    // round trip / quota on Googlebot, GoogleOther, AdsBot, Bingbot,
    // Slackbot, Discordbot, Twitter and friends. Their JS-executing
    // crawlers trip our trpc fetch path and poison real-user signal.
    const headers = event.request?.headers as
      | Record<string, string | string[] | undefined>
      | undefined;
    const ua = headers?.["user-agent"] ?? headers?.["User-Agent"];
    if (typeof ua === "string" && isbot(ua)) {
      return null;
    }
    if (event.request) {
      delete event.request.cookies;
      delete event.request.headers;
      delete event.request.data;
      delete event.request.query_string;
    }
    if (event.user) {
      delete event.user.ip_address;
      delete event.user.email;
    }
    // `includeLocalVariables` above: a server render holding a Place/Event
    // row (an owner's own editor, a holder's order page) would ship the true
    // address of a venue that withholds it. Strip street / pin / postcode /
    // phone from frame locals, extra, contexts and breadcrumbs. Never throws.
    // `query_string` is deleted above, but `request.url` still carries it —
    // redact bearer `token=` values there (and in breadcrumbs / spans).
    return scrubLocationFromErrorEvent(scrubSentryEvent(event));
  },

  // Transactions bypass `beforeSend`: same request-PII strip, same token
  // redaction (request.url, span data, breadcrumbs, transaction name), and
  // the same location scrub (extra, contexts, tags, breadcrumbs), as the api
  // and jobs hooks do.
  beforeSendTransaction(event) {
    if (event.request) {
      delete event.request.cookies;
      delete event.request.headers;
      delete event.request.data;
      delete event.request.query_string;
    }
    if (event.user) {
      delete event.user.ip_address;
      delete event.user.email;
    }
    return scrubLocationFromErrorEvent(scrubSentryEvent(event));
  },

  // Suppress Sentry noise in local dev unless explicitly enabled
  debug: process.env.SENTRY_DEBUG === "true",
});
