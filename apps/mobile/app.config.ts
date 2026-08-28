import type { ExpoConfig } from "expo/config";

/**
 * Dynamic Expo config for the Ithas Fire consumer mobile app.
 *
 * Mirrors apps/scanner/app.config.ts patterns with these intentional
 * differences:
 *   - No Tap to Pay entitlement tier (consumer pays, doesn't accept)
 *   - Public App Store distribution (not Unlisted)
 *   - `associatedDomains` for Universal Links (entitlement gate flips
 *     on once the AASA file is served from ithasfire.com/.well-known)
 *   - Sentry DSN is strictly env-driven — no embedded fallback. Set
 *     EXPO_PUBLIC_SENTRY_DSN locally for `expo start`, or rely on the
 *     EAS build env which gets it from EXPO_PUBLIC_SENTRY_DSN.
 *
 * See docs/specs/2026-04-26/scanner-deployment-tap-to-pay.spec.yaml →
 * mobile_app section for the full deployment story.
 */

const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "development";

// Universal Links: on by default. The associated domain entitlement is
// inert until ithasfire.com/.well-known/apple-app-site-association
// is served. Pre-declaring the entitlement now means we don't need a new
// binary release the day we wire up AASA on the web side.
const associatedDomainsEnabled = true;

const config: ExpoConfig = {
  name: "Ithas Fire",
  slug: "mobile",
  scheme: "ithasfire",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#000000",
  },
  ios: {
    // Re-registered on the business team (FJG7F43395) as `com.ithasfire.app`.
    // The bare `com.ithasfire` was burned in App Store Connect on the old
    // team (5J9DRDR2TB) and can't be reused. Android keeps `com.ithasfire`.
    bundleIdentifier: "com.ithasfire.app",
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription:
        "Scan ticket QR codes from emails or share sheets.",
      NSLocationWhenInUseUsageDescription: "Show events happening near you.",
      ITSAppUsesNonExemptEncryption: false,
    },
    associatedDomains: associatedDomainsEnabled
      ? ["applinks:ithasfire.com", "applinks:www.ithasfire.com"]
      : undefined,
  },
  android: {
    package: "com.ithasfire",
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    permissions: ["android.permission.CAMERA", "android.permission.VIBRATE"],
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#000000",
    },
    intentFilters: associatedDomainsEnabled
      ? [
          {
            action: "VIEW",
            autoVerify: true,
            data: [
              { scheme: "https", host: "ithasfire.com" },
              { scheme: "https", host: "www.ithasfire.com" },
            ],
            category: ["BROWSABLE", "DEFAULT"],
          },
        ]
      : undefined,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    [
      "expo-camera",
      {
        cameraPermission: "Allow $(PRODUCT_NAME) to scan ticket QR codes.",
      },
    ],
    "expo-secure-store",
    // Push registration (notifications.registerPushDevice). The plugin wires
    // the iOS `aps-environment` entitlement (EAS syncs the Push Notifications
    // capability at build time) and the Android manifest bits. Adding it
    // changes native config → requires a NEW EAS BUILD to take effect.
    "expo-notifications",
    [
      "@stripe/stripe-react-native",
      {
        // Must match STRIPE_MERCHANT_IDENTIFIER in src/features/checkout/PaymentsProvider.tsx
        merchantIdentifier: "merchant.com.ithasfire",
        enableGooglePay: true,
      },
    ],
    [
      "@sentry/react-native/expo",
      {
        organization: "hearth-fire",
        project: "hearth-fire-mobile",
      },
    ],
  ],
  extra: {
    appEnv,
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    stripePublishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    walletPaymentsEnabled:
      process.env.EXPO_PUBLIC_WALLET_PAYMENTS_ENABLED === "true",
    eas: {
      projectId: "9e866f04-bbb1-4b15-be4a-2faaf2aeb972",
    },
  },
  owner: "somehuman",
  runtimeVersion: { policy: "appVersion" },
  updates: {
    url: "https://u.expo.dev/9e866f04-bbb1-4b15-be4a-2faaf2aeb972",
  },
};

export default config;
