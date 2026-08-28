import Constants from "expo-constants";

/**
 * Binary-level capability checks. These read values baked into the bundle
 * at EAS Build time (see app.config.ts → `extra`) and are immutable for
 * the lifetime of an installed binary. They CANNOT be flipped at runtime
 * via OTA updates or server flags — that's the whole point.
 *
 * Use these as a guardrail composed WITH server feature flags, not as a
 * replacement for them. The composition pattern:
 *
 *   const sellTabVisible =
 *     featureGates["scanner.pos_tap_to_pay"]   // server-controlled rollout
 *     && binarySupportsTapToPay()              // does THIS binary have it?
 *     && terminalSdk.supportsReadersOfType("tapToPayReader"); // device check
 */

const extra = (Constants.expoConfig?.extra ?? {}) as {
  tapToPaySupported?: boolean;
  stripeTerminalLocationId?: string | null;
  appEnv?: string;
  sentryDsn?: string;
};

/**
 * True only if this binary was built with Tap to Pay entitlements declared
 * (i.e. `EXPO_TAP_TO_PAY_TIER` was `development` or `publishing` at build
 * time). Always false in v1.0 production binaries.
 */
export const binarySupportsTapToPay = (): boolean =>
  extra.tapToPaySupported === true;

/**
 * Stripe Terminal Location ID (`tml_xxx`), baked in at build time via
 * `EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID`. The Terminal SDK requires
 * one to connect a Tap to Pay reader. Returns null when not
 * configured — TapToPaySurface surfaces a clear configuration error
 * in that case so cash sales still work.
 */
export const getStripeTerminalLocationId = (): string | null =>
  extra.stripeTerminalLocationId ?? null;

/** Build-time app environment: development | preview | production. */
export const getAppEnv = (): string => extra.appEnv ?? "development";

/**
 * Sentry DSN for this build. Present in production builds (env var or
 * embedded fallback in app.config.ts); undefined in dev/preview builds
 * unless EXPO_PUBLIC_SENTRY_DSN was set at build time — sentry.ts no-ops
 * in that case.
 */
export const getSentryDsn = (): string | undefined => extra.sentryDsn;
