import * as Sentry from "@sentry/react-native";

import { getAppEnv, getSentryDsn } from "./capabilities";
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

/**
 * Initialize Sentry for the scanner. Idempotent — safe to call once at
 * App.tsx top-level. Mirrors the web app's instrumentation-client.ts
 * defaults (10% trace sample in production, full in dev) with one
 * difference: `sendDefaultPii: false` because the scanner sees buyer
 * contact and operator identity, and we want explicit opt-in scrubbing
 * via `Sentry.setUser` calls, not blanket attribution.
 */
export const initSentry = (): void => {
  const dsn = getSentryDsn();
  if (!dsn) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn("[sentry] DSN not configured; skipping init");
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: getAppEnv(),
    sendDefaultPii: false,
    // 100% performance traces during launch — the scanner sees low
    // request volume (a handful of operators per event) and we want
    // full visibility into latency regressions before they hit a real
    // gate. Revisit when daily-active-operator counts justify a
    // sampling budget conversation. Errors are captured at 100% by
    // default (Sentry's `sampleRate` defaults to 1.0) so they are
    // never gated by this.
    tracesSampleRate: 1.0,
    debug: __DEV__ && process.env.SENTRY_DEBUG === "true",
    // Attach the scanner's release tag so issues group across builds.
    // EAS build sets EAS_BUILD_GIT_COMMIT_HASH for us.
    release: process.env.EAS_BUILD_GIT_COMMIT_HASH ?? undefined,
    // Attach stack traces to non-Error captures so we get *some* frame
    // info even without uploaded sourcemaps. Combined with the extras
    // we attach at fetch failure, this is enough to debug network
    // problems without symbolication.
    attachStacktrace: true,
    // Capture unhandled JS errors and promise rejections so issues that
    // happen outside a try/catch (e.g. inside React Query subscribers)
    // still reach Sentry with breadcrumbs attached.
    enableAutoSessionTracking: true,
    enableNativeCrashHandling: true,
    enableAutoPerformanceTracing: !__DEV__,
    // Larger breadcrumb budget — useful in scanner's flow where a
    // failure can be 5+ network calls deep.
    maxBreadcrumbs: 100,
    /**
     * Ticket codes are BEARER CREDENTIALS, and `scan.resolvePayload` is a tRPC
     * `.query()` — so the code travels in the GET query string, and `trpc.ts`'s
     * fetch instrumentation attaches that URL to every network-failure capture
     * (`extra.url`) and every non-OK breadcrumb (`data.url` + the crumb
     * message). A venue with flaky wifi was shipping live credentials into an
     * error tracker, one per failed scan.
     *
     * The scrub happens HERE — the last point every event and every crumb
     * passes through — rather than at the call sites, because a call-site fix
     * is a promise about every future call site. `sentry-scrub.ts` is pure and
     * node-tested, including the "must not throw" property: a `beforeSend` that
     * throws drops the event, which would trade a privacy fix for an
     * observability outage.
     */
    beforeSend: (event) => scrubEvent(event),
    /**
     * ⚠️ TRANSACTIONS DO NOT PASS THROUGH `beforeSend`.
     *
     * With `tracesSampleRate: 1.0` and `enableAutoPerformanceTracing` above,
     * every production session ships `http.client` spans — and a tRPC
     * `.query()` span carries the request URL in `span.description` and in its
     * `http.query` / `url.query` / `http.url` attributes. That is the same
     * bearer credential `beforeSend` exists to strip, leaving by the one door
     * `beforeSend` does not watch. Same scrubber, both doors.
     */
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  });
};
