import Constants from "expo-constants";

/**
 * Binary-level capability checks. Reads values baked into the bundle at
 * EAS Build time (see app.config.ts → `extra`). Immutable for the
 * lifetime of an installed binary — cannot be flipped at runtime via OTA
 * updates or server flags.
 *
 * Mobile is intentionally simpler than scanner here: no Tap to Pay
 * tier system because consumer pays (Apple Pay / Google Pay / card via
 * Stripe Payment Sheet) rather than accepting payments.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as {
  appEnv?: string;
  sentryDsn?: string;
  stripePublishableKey?: string;
  walletPaymentsEnabled?: boolean;
};

/** Build-time app environment: development | preview | production. */
export const getAppEnv = (): string => extra.appEnv ?? "development";

/** Sentry DSN for this build. Returns undefined if not configured. */
export const getSentryDsn = (): string | undefined => extra.sentryDsn;

/**
 * Stripe publishable key for this build (EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY).
 * Returns undefined if not configured — payments are unavailable in that
 * case and the app renders without <StripeProvider>.
 */
export const getStripePublishableKey = (): string | undefined =>
  extra.stripePublishableKey || undefined;

/**
 * Whether Apple Pay / Google Pay buttons are enabled in the Payment Sheet
 * (EXPO_PUBLIC_WALLET_PAYMENTS_ENABLED === "true"). Defaults to false —
 * card-only checkout — until the Apple merchant ID / payment-processing
 * certificate setup is verified per EAS channel.
 */
export const getWalletPaymentsEnabled = (): boolean =>
  extra.walletPaymentsEnabled === true;
