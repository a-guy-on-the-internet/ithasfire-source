import * as Sentry from "@sentry/nextjs";
import { isbot } from "isbot";

import { buildReactQueryTitle } from "./src/lib/sentry/react-query-error-title";
import {
  scrubBreadcrumb,
  scrubSentryEvent,
} from "./src/lib/sentry/redact-url-tokens";

// Error capture runs under "legitimate interest" (Recital 49 GDPR — security
// and incident diagnostics) with PII scrubbed, so it needs no consent and sets
// no cookie.
//
// Session replay was removed deliberately, not overlooked. It required explicit
// consent, which meant a cookie banner, and the sampling made it weakest where
// it was most useful: a silent failure (blank screen, stuck latch) throws
// nothing, so the on-error capture never fired and only the 10% session sample
// applied — times the share of users who accepted. Stack traces plus the
// breadcrumbs, `queryPath`/`trpcKind` tags and fingerprinting below cover the
// debugging need without any of that. Re-add via `Sentry.addIntegration(
// replayIntegration())` behind consent if a bug ever genuinely resists them.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.NODE_ENV ??
    "development",

  // Off permanently — IPs, cookies, and request headers are PII. Nothing flips
  // this at runtime; error events never carry them.
  sendDefaultPii: false,

  // 100% in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Suppress Sentry noise in local dev unless explicitly enabled
  debug: process.env.SENTRY_DEBUG === "true",

  // Drop bot traffic. Search/audit/preview crawlers (Googlebot,
  // GoogleOther, AdsBot, Bingbot, Slackbot, Discordbot, Twitter, …)
  // execute our JS and trip the trpc client when their session/cookie
  // headers don't survive, generating "Failed to fetch" noise that
  // poisons real-user dashboards. `isbot` ships a maintained UA list
  // so we don't have to babysit a regex.
  beforeSend(event) {
    if (typeof navigator !== "undefined" && isbot(navigator.userAgent)) {
      return null;
    }

    // Rewrite low-signal react-query failure titles into descriptive,
    // host-free strings. Without this, every client-side tRPC failure lands
    // as a generic `TRPCClientError: Failed to fetch (api-dev.ithasfire.com)`
    // with culprit `/` — you can't tell WHICH query failed, or whether the
    // API was unreachable vs answered a 5xx, and the embedded host fragments
    // one problem across domains.
    //
    // The classification tags (`trpcKind`, `queryPath`) are set at capture in
    // `GlobalQueryErrorLogger`, which also sets an explicit `fingerprint` that
    // authoritatively controls grouping — so this transform only needs to make
    // the human-readable TITLE match. Every access is guarded: `beforeSend`
    // must never throw. Non-react-query events are left untouched.
    if (event.tags?.source === "react-query") {
      const primary = event.exception?.values?.[0];
      if (primary) {
        const trpcKind =
          typeof event.tags.trpcKind === "string"
            ? event.tags.trpcKind
            : undefined;
        const queryPath =
          typeof event.tags.queryPath === "string"
            ? event.tags.queryPath
            : undefined;

        const title = buildReactQueryTitle({ trpcKind, queryPath });

        // Preserve the original message so triage isn't lossy.
        event.extra = { ...event.extra, originalMessage: primary.value };

        // Drive the displayed title: `<type>: <value>`.
        primary.value = title;
        // For a genuine tRPC failure, normalise `type` to `TRPCClientError`
        // so the title reads coherently. The `unknown` class is NOT a tRPC
        // error (a thrown `select`/parse error), so leave its original type
        // intact rather than mislabelling it.
        if (trpcKind && trpcKind !== "unknown") {
          primary.type = "TRPCClientError";
        }
      }
    }

    // Bearer tokens in query strings (`/invite/accept?token=…`) must never
    // leave the browser: `sendDefaultPii: false` does not strip URLs.
    return scrubSentryEvent(event);
  },

  // Navigation / fetch breadcrumbs carry full URLs too.
  beforeBreadcrumb(breadcrumb) {
    return scrubBreadcrumb(breadcrumb);
  },

  // Transactions carry the URL in request + span data.
  beforeSendTransaction(event) {
    return scrubSentryEvent(event);
  },
});

// Hook into App Router navigation transitions
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
