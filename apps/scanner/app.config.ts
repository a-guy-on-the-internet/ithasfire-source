import type { ExpoConfig } from "expo/config";

/**
 * Dynamic Expo config for the Ithas Fire Scanner.
 *
 * The Tap to Pay entitlement strategy lives here:
 * - `EXPO_TAP_TO_PAY_TIER=none` (default): no entitlement declared, builds
 *   sign for App Store without Apple's Tap to Pay publishing approval.
 * - `EXPO_TAP_TO_PAY_TIER=development`: declares the dev entitlement, used
 *   for `eas build --profile development` and Internal TestFlight.
 * - `EXPO_TAP_TO_PAY_TIER=publishing`: declares the full publishing
 *   entitlement, used for v1.1+ production builds AFTER Apple grants the
 *   publishing entitlement. Builds will fail to sign for App Store
 *   distribution until that approval lands.
 *
 * See docs/specs/2026-04-26/scanner-deployment-tap-to-pay.spec.yaml for
 * the full strategy and the binary-version safety check that prevents
 * v1.0 users from ever seeing the Sell UI.
 */

type EntitlementTier = "none" | "development" | "publishing";

const tier = (process.env.EXPO_TAP_TO_PAY_TIER ?? "none") as EntitlementTier;
const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? "development";

// Capability resolution (lib/capabilities.ts) silently defaults appEnv
// to "development" when the value baked into `extra` is missing. That
// makes a misconfigured EAS profile produce a prod APK that behaves
// like dev — cleartext traffic allowed, SecureStore developer overrides
// honored, Sentry environment tagged "development". This assertion
// fails the build if `EXPO_PUBLIC_APP_ENV` is set to anything we don't
// explicitly recognise, so a typo or new-profile-missing-the-env-var
// can't slip through to runtime.
const KNOWN_APP_ENVS = ["development", "preview", "staging", "production"];
if (!KNOWN_APP_ENVS.includes(appEnv)) {
  throw new Error(
    `EXPO_PUBLIC_APP_ENV="${appEnv}" is not recognised. ` +
      `Expected one of: ${KNOWN_APP_ENVS.join(", ")}. ` +
      `If a new environment is genuinely needed, add it to KNOWN_APP_ENVS ` +
      `in app.config.ts (and review every capabilities.ts consumer to ` +
      `decide whether the new env behaves like dev or prod).`,
  );
}

const tapToPaySupported = tier !== "none";

// Build-time guard: preview / staging binaries that don't have an API
// base URL baked in will silently fall back to `http://localhost:3001`
// at runtime (config/api.ts), which a physical Android tester can't
// reach. Catch the misconfig here so EAS builds fail loudly rather than
// producing an APK that "looks fine" until login. Exempt:
//   - "development": local Gradle / `expo start` legitimately rely on
//     `adb reverse` to expose localhost.
//   - "production": api.ts deliberately fails closed to the public prod
//     URL so a missing env var doesn't break a shipped build (security
//     defense-in-depth, not the primary path).
if (
  appEnv !== "development" &&
  appEnv !== "production" &&
  !(process.env.EXPO_PUBLIC_API_BASE_URL ?? "").trim()
) {
  throw new Error(
    `EXPO_PUBLIC_API_BASE_URL must be set for EXPO_PUBLIC_APP_ENV="${appEnv}". ` +
      `Set it in eas.json's profile env block before building, otherwise the ` +
      `binary will fall back to http://localhost:3001 at runtime.`,
  );
}

/**
 * Stripe Terminal Location ID (`tml_xxx`) on the platform account. The
 * Terminal SDK requires this to connect a Tap to Pay reader — see
 * sell-tab-screen.tsx → tap-to-pay-surface.tsx for usage. Threaded
 * through `extra` so the value is baked into the binary at EAS build
 * time and consumed at runtime via capabilities.ts.
 *
 * One platform-level Location works for every device, every operator,
 * every org under the SCT charge model (D-2026-04-26). Optional
 * future improvement: per-org Locations created on Connect onboarding.
 */
const stripeTerminalLocationId =
  process.env.EXPO_PUBLIC_STRIPE_TERMINAL_LOCATION_ID ?? null;

const tapToPayEntitlements = tapToPaySupported
  ? {
      "com.apple.developer.proximity-reader.payment.acceptance": true,
      "com.apple.developer.proximity-reader.tap-to-pay": true,
    }
  : {};

const config: ExpoConfig = {
  name: "Ithas Fire Scanner",
  slug: "ithas-fire-scanner",
  scheme: "ithasfire-scanner",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    // ⚠️ Keep in sync with `FIXED.splashBackground` (src/ui/palette.ts). The
    // JS splash re-renders this exact backdrop, so a drift here shows up as a
    // colour flash on the native→JS hand-off. This file is resolved by the
    // Expo CLI/EAS outside the RN runtime and cannot import the palette —
    // see eslint-color-permanents.mjs.
    backgroundColor: "#000000",
  },
  ios: {
    bundleIdentifier: "com.ithasfire.scan",
    // iOS doesn't do adaptive icons — whatever's in the PNG ships as-is.
    // The shared icon.png has alpha, so dark glyphs vanish against the
    // Light Mode home screen. icon-ios.png is the same artwork composited
    // over solid black, 1024×1024, no alpha.
    icon: "./assets/icon-ios.png",
    supportsTablet: false,
    infoPlist: {
      NSCameraUsageDescription:
        "Scan ticket and volunteer QR codes at the gate.",
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      ...tapToPayEntitlements,
    },
    // Associated Domains — required for WebAuthn / passkeys to be shared
    // with the canonical web origin. Apple verifies the AASA file at
    // https://ithasfire.com/.well-known/apple-app-site-association.
    // Only `webcredentials` here — we don't define any universal-link paths
    // for the scanner yet. Add `applinks:ithasfire.com` later if we
    // build a deep-link route under apps/web/src/app/sign-in/scanner/*.
    associatedDomains: ["webcredentials:ithasfire.com"],
  },
  android: {
    // iOS and Android now share the `com.ithasfire.scan` leaf. The original
    // iOS bundle `com.ithasfire.scanner` was burned in App Store Connect on
    // the old team (5J9DRDR2TB) and can't be reused, so when re-registering
    // on the business team (FJG7F43395) we unified on the shorter `scan`
    // leaf that Android already used.
    package: "com.ithasfire.scan",
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    permissions: ["android.permission.CAMERA", "android.permission.VIBRATE"],
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      // Matches the splash backdrop — see the note on `splash` above.
      backgroundColor: "#000000",
    },
    // Auto-verify the digital asset link with the web origin so
    // Credential Manager can resolve passkeys created on web.
    intentFilters: [
      {
        action: "VIEW",
        category: ["DEFAULT", "BROWSABLE"],
        data: [{ scheme: "https", host: "ithasfire.com" }],
        autoVerify: true,
      },
    ],
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    // Stripe Terminal Android SDK requires minSdkVersion 26.
    // Default Expo Android minSdk is 24, so we bump it here. Pixel 7
    // and any device that supports Tap to Pay is well above 26 anyway
    // (Tap to Pay needs Android 11 = API 30+).
    //
    // Why proguard / shrinkResources are on:
    //   The scanner pulls in @stripe/stripe-terminal-react-native +
    //   Sentry + a half-dozen expo-* native modules. Without R8 the
    //   release APK ships every Java class those SDKs declare, even
    //   the ~30% that's never reachable from our entry points. R8
    //   (proguard) prunes dead Kotlin/Java; shrinkResources prunes
    //   unused drawables / strings. Combined ~20-30 MB savings on
    //   release builds. Hermes already handles JS-side dead code.
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 26,
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          // Allow plain HTTP only on non-production builds so preview APKs
          // can hit a localhost dev API over `adb reverse tcp:3001`. Prod
          // stays HTTPS-only — Android blocks cleartext by default on API 28+.
          usesCleartextTraffic: appEnv !== "production",
          // Keep rules needed for R8 minification on this stack. Without
          // these the activity / native bridges get their constructors or
          // JNI lookups trimmed and the app fails to launch with cryptic
          // "Activity class does not exist" errors. Survives
          // `expo prebuild --clean` because expo-build-properties writes
          // the rules into android/app/proguard-rules.pro on prebuild.
          extraProguardRules: `
# App entry point — without this R8 trims MainActivity's default
# constructor and Android's PackageManager can't instantiate it.
-keep class com.ithasfire.scan.MainActivity { *; }
-keep class com.ithasfire.scan.MainApplication { *; }

# React Native baseline.
-keep class com.facebook.react.ReactActivity { *; }
-keep class * extends com.facebook.react.ReactActivity { *; }
-keep class com.facebook.react.ReactApplication { *; }
-keep class * extends com.facebook.react.ReactApplication { *; }
-keep class com.facebook.react.ReactNativeHost { *; }
-keep class * extends com.facebook.react.ReactNativeHost { *; }
-keep class * implements com.facebook.react.ReactPackage { *; }

# Hermes JNI lookups.
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# Stripe Terminal — uses reflection internally for SDK plumbing.
-keep class com.stripe.stripeterminal.** { *; }
-keep class com.stripe.cots.** { *; }
`,
        },
      },
    ],
    // Inline config plugin — restrict release builds to arm64-v8a only.
    // A "universal APK" includes native libs for arm64-v8a, armeabi-v7a,
    // x86, and x86_64. Modern Android phones are 100% arm64; the other
    // three ABIs are dead weight (only useful for emulators or pre-2019
    // devices the scanner doesn't support anyway). With Stripe Terminal
    // shipping ~50 MB of `.so` per ABI, this 4× collapse is the single
    // biggest size win — typically 250 MB → ~80-90 MB. Production builds
    // (AAB / app-bundle) handle this server-side via Play Store; this
    // plugin makes preview/internal-distribution APKs sane to install.
    [
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./scripts/with-arm64-only-android.js"),
    ],
    // Inline config plugin — fail-fast on local debug-signed release
    // builds. The RN template ships `release { signingConfig
    // signingConfigs.debug }`, which EAS replaces with managed
    // credentials but a plain `./gradlew assembleRelease` happily
    // produces. See scripts/with-release-signing-guard.js for the
    // opt-in escape hatch (sideload-only release APKs).
    [
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./scripts/with-release-signing-guard.js"),
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow $(PRODUCT_NAME) to access the camera for ticket and volunteer QR scanning.",
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    // Sentry plugin only registers in production builds — the gradle
    // sourcemap upload task hard-requires SENTRY_AUTH_TOKEN, which we
    // don't want to provision for preview/internal builds. For dev and
    // preview we still get runtime crash reporting via the SDK's DSN
    // (configured in src/lib/sentry.ts), just without uploaded
    // sourcemaps.
    // Annotated as Expo's own plugin-entry type rather than `as const`. The
    // const assertion produced a READONLY tuple, which is not assignable to
    // `[string, any]`, so this entry — and, through the union, the Stripe
    // Terminal entry below it — failed to typecheck. Nothing caught that
    // because the scanner had no typecheck step; it is a config file, so the
    // cost of being wrong here is a build that misconfigures a native plugin.
    ...(appEnv === "production"
      ? ([
          [
            "@sentry/react-native/expo",
            {
              organization: "hearth-fire",
              project: "hearth-fire-scanner",
              // Auth token comes from SENTRY_AUTH_TOKEN as an EAS Secret.
            },
          ],
        ] satisfies NonNullable<ExpoConfig["plugins"]>)
      : []),
    // Stripe Terminal SDK — present in every binary (v1.0 included) so
    // a native rebuild for v1.1 is one entitlement flip and an EAS submit,
    // not a dependency change. The SDK config plugin wires:
    //   • iOS Info.plist usage strings (location, bluetooth, local-net)
    //   • iOS noop Swift file (required for RN native modules with Swift)
    //   • Android: BT + location permissions, MainApplication delegate
    //     and the TapToPay isInTapToPayProcess() short-circuit
    //
    // Whether Tap to Pay is actually USABLE on a given binary is gated
    // separately by the iOS entitlements above (see EXPO_TAP_TO_PAY_TIER)
    // and the runtime `binarySupportsTapToPay()` check in
    // src/lib/capabilities.ts.
    [
      "@stripe/stripe-terminal-react-native",
      {
        appDelegate: true,
        tapToPayCheck: true,
        locationWhenInUsePermission:
          "Location is required by Stripe to accept in-person payments.",
        bluetoothAlwaysUsagePermission:
          "Bluetooth is required to connect to supported card readers (future).",
        bluetoothPeripheralPermission:
          "Bluetooth is required to connect to supported card readers (future).",
        localNetworkUsagePermission:
          "Local network access is required to connect to supported card readers (future).",
      },
    ],
    // expo-updates: enabled implicitly by EAS Build when channels are set
    // in eas.json. Add explicit plugin only if we need custom config.
  ],
  extra: {
    // Baked into the binary at build time. The runtime capability check
    // (apps/scanner/src/lib/capabilities.ts) reads this to decide whether
    // Tap to Pay UI may be exposed, even if the server feature flag is on.
    tapToPaySupported,
    stripeTerminalLocationId,
    appEnv,
    // Sentry DSN resolution:
    //   1. EXPO_PUBLIC_SENTRY_DSN, when set (per-profile via eas.json or a
    //      local shell), always wins.
    //   2. Production builds fall back to the embedded hearth-fire-scanner
    //      project DSN so a missing EAS env var can never ship a store
    //      binary with crash reporting silently disabled.
    //   3. Dev/preview builds get NO fallback — src/lib/sentry.ts no-ops
    //      without a DSN, so local crashes stop polluting the production
    //      Sentry project.
    sentryDsn:
      process.env.EXPO_PUBLIC_SENTRY_DSN ??
      (appEnv === "production"
        ? "https://a334111b8354f829475f8067510ebfc1@o4511120392454144.ingest.us.sentry.io/4511284791607296"
        : undefined),
    eas: {
      projectId: "b1ff8fa0-7672-47f1-bbb2-0b2deb4c17da",
    },
  },
  owner: "somehuman",
  runtimeVersion: { policy: "appVersion" },
  updates: {
    url: "https://u.expo.dev/b1ff8fa0-7672-47f1-bbb2-0b2deb4c17da",
  },
};

export default config;
