import * as Sentry from "@sentry/nextjs";

import { scrubSentryEvent } from "./src/lib/sentry/redact-url-tokens";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  environment:
    process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",

  // Edge runs the same legitimate-interest model as the server config —
  // strip request PII before transmission. See sentry.server.config.ts for
  // the rationale.
  sendDefaultPii: false,

  // 100% in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  beforeSend(event) {
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
    // `request.url` still carries the query string — redact `token=` values.
    return scrubSentryEvent(event);
  },

  // Transactions bypass `beforeSend`: same strip + token redaction.
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
    return scrubSentryEvent(event);
  },

  // Suppress Sentry noise in local dev unless explicitly enabled
  debug: process.env.SENTRY_DEBUG === "true",
});
