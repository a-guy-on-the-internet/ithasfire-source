import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Sentry from "@sentry/react-native";

import { Embers, IthasFireProvider } from "@th/ui";

import { authClient } from "./src/features/auth/better-auth-client";
import {
  loadSessionToken,
  setSessionToken,
} from "./src/features/auth/auth-token-store";
import { loadApiOverridesAsync } from "./src/config/api";
import { initSentry } from "./src/lib/sentry";
import { ScannerApp } from "./src/scanner-app";
import { TrpcProvider } from "./src/trpc";
import { FIXED, NativeThemeProvider, useNativeTheme } from "@th/ui-native";

const SPLASH_ICON = require("./assets/splash-icon.png");

// Keep the native splash up until JS has fonts loaded, then hand off to the
// JS-side <Embers /> splash. Without this, the native splash auto-hides as
// soon as React Native's bridge is ready, exposing a brief unstyled flash
// before the JS tree mounts.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already-hidden / unsupported platform — safe to ignore.
});

// Minimum on-screen duration for the JS-side animated splash. Fonts load in
// ~50ms, so without this floor the embers + breath wouldn't get a single
// cycle on screen. 1000ms ≈ one half-cycle of the breath loop — enough to
// register as "alive" without taxing fast-device cold starts.
const SPLASH_MIN_MS = 1000;

/**
 * Handle a `ithasfire-scanner://auth-callback?token=…` URL by stashing
 * the session token and asking better-auth to refresh the session — the
 * `useSession` hook downstream will pick up the new user automatically.
 *
 * Returns true if a token was consumed; false otherwise.
 */
async function consumeAuthCallback(rawUrl: string | null): Promise<boolean> {
  if (!rawUrl) return false;
  if (!rawUrl.startsWith("ithasfire-scanner://auth-callback")) return false;
  let token: string | null = null;
  try {
    const u = new URL(rawUrl);
    token = u.searchParams.get("token");
  } catch {
    return false;
  }
  if (!token) return false;
  await setSessionToken(token);
  await authClient.getSession();
  return true;
}

// Init Sentry as a top-level side effect so the very first crash (e.g. font
// load failure inside React) is captured. Idempotent if hot-reloaded.
initSentry();

/**
 * Scanner root. Loads the Montserrat font family before mounting the
 * Tamagui tree so `@th/ui`'s `Text` and `Button` resolve to the canonical
 * Ithas Fire typeface (rather than the OS default San Francisco / Roboto).
 *
 * Mirrors `apps/mobile/App.tsx` — same three weights (Regular / Medium /
 * SemiBold), same fall-through behaviour if the asset registration fails
 * (we still render so we never hard-crash the operator out of the
 * scanner).
 */
function App() {
  const [fontsLoaded, fontError] = useFonts({
    Montserrat: require("./assets/fonts/Montserrat-Regular.ttf"),
    "Montserrat-Medium": require("./assets/fonts/Montserrat-Medium.ttf"),
    "Montserrat-SemiBold": require("./assets/fonts/Montserrat-SemiBold.ttf"),
  });

  const [splashTimeElapsed, setSplashTimeElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSplashTimeElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (fontError) {
      // eslint-disable-next-line no-console
      console.warn(
        "[fonts] failed to load Montserrat; falling back to system",
        fontError,
      );
    }
  }, [fontError]);

  // Hand off the native splash to the JS-rendered <Embers /> splash as soon
  // as fonts are ready. The JS splash is styled to match (white flame on
  // black bg) so the swap is invisible — only the embers + breath start to
  // animate.
  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  // App tree only mounts after fonts ready *and* the splash min-time floor
  // has elapsed — otherwise the embers + breath would barely flash before
  // the sign-in screen replaces them.
  const showSplash = (!fontsLoaded && !fontError) || !splashTimeElapsed;

  // Magic-link deep-link handler. The browser following an emailed magic
  // link redirects to `ithasfire-scanner://auth-callback?token=…`; both
  // a cold-start (`getInitialURL`) and a warm-start (`addEventListener`)
  // are possible depending on whether the app was already running.
  useEffect(() => {
    // Restore the session token from SecureStore so authClient requests carry
    // `Authorization: Bearer <token>` from the very first call after a cold
    // start. Then handle any pending deep-link auth callback.
    void (async () => {
      // Load API base URL overrides from SecureStore *before* any tRPC /
      // auth request fires, so the operator's pinned override (e.g. a
      // localhost LAN IP for local dev against this physical device)
      // wins over the baked EAS env var on the very first call.
      await loadApiOverridesAsync();
      await loadSessionToken();
      await authClient.getSession();
      const initial = await Linking.getInitialURL();
      await consumeAuthCallback(initial);
    })();
    const sub = Linking.addEventListener("url", ({ url }) => {
      void consumeAuthCallback(url);
    });
    return () => sub.remove();
  }, []);

  if (showSplash) {
    // JS splash: matches the native splash (white flame on black background
    // — see app.config.ts splash.image / splash.backgroundColor) so the
    // hand-off is seamless. Animated embers + breath signal "loading"
    // without a separate spinner.
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: FIXED.splashBackground,
        }}
      >
        <Embers size={220} tint={FIXED.splashTint} iconSource={SPLASH_ICON} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <TrpcProvider>
        <NativeThemeProvider>
          <ThemedRoot />
        </NativeThemeProvider>
      </TrpcProvider>
    </SafeAreaProvider>
  );
}

/**
 * Binds the scanner's theme state to the two consumers that need it at the
 * root: Tamagui (so `@th/ui`'s `Text` / `Button` resolve their own tokens for
 * the same theme the RN StyleSheets are using) and the native status bar.
 *
 * This has to be a child of `NativeThemeProvider` rather than inline in
 * `App` — `useNativeTheme` reads the context that provider supplies.
 */
function ThemedRoot() {
  const { name } = useNativeTheme();
  return (
    <IthasFireProvider theme={name}>
      {/*
        The status-bar area is painted with `structure`, which is steel blue on
        Ember and near-black ink on Stub — both dark, so light content is
        correct in both. Keyed to the theme anyway so a future light-chrome
        theme doesn't silently ship unreadable clock/battery glyphs.
      */}
      <StatusBar style="light" />
      <ScannerApp />
    </IthasFireProvider>
  );
}

export default Sentry.wrap(App);
