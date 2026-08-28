import { useEffect } from "react";
import * as Sentry from "@sentry/react-native";

import { getAppEnv, getSentryDsn } from "./capabilities";

/**
 * Initialize Sentry. Idempotent — safe to call once at App.tsx top-level.
 *
 * Differences from apps/scanner/src/lib/sentry.ts (intentional improvements):
 *   - DSN must come through extra (env-driven). No embedded fallback —
 *     a missing DSN means Sentry is silently disabled rather than every
 *     dev-build pinging prod.
 *   - Wired with `attachScreenshot` so issues show what the user saw.
 *   - `attachStacktrace` adds stacks to plain `Sentry.captureMessage` calls.
 */
export const initSentry = (): void => {
  const dsn = getSentryDsn();
  if (!dsn) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn("[sentry] EXPO_PUBLIC_SENTRY_DSN not set; skipping init");
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: getAppEnv(),
    sendDefaultPii: false,
    tracesSampleRate: __DEV__ ? 1.0 : 0.1,
    attachScreenshot: true,
    attachStacktrace: true,
    debug: __DEV__ && process.env.SENTRY_DEBUG === "true",
    release: process.env.EAS_BUILD_GIT_COMMIT_HASH ?? undefined,
  });
};

/**
 * React hook that keeps Sentry's user context aligned with the current
 * auth session. Call once near the root, after the auth provider mounts.
 *
 * On sign-in: tags every subsequent event with the operator's humanId.
 * On sign-out: clears the user context so prior identity doesn't leak.
 *
 * `email` is intentionally NOT sent — sendDefaultPii is false above and
 * we don't want to leak buyer/operator emails to crash reports.
 */
export const useSentryUserSync = (humanId: string | null): void => {
  useEffect(() => {
    if (humanId) {
      Sentry.setUser({ id: humanId });
    } else {
      Sentry.setUser(null);
    }
  }, [humanId]);
};
