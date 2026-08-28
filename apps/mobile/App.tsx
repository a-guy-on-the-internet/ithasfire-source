import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import * as Sentry from "@sentry/react-native";

import { Embers, IthasFireProvider } from "@th/ui";
import {
  FIXED,
  NativeThemeProvider,
  useIsDarkTheme,
  useNativeTheme,
} from "@th/ui-native";

import { PaymentsProvider } from "@/features/checkout/PaymentsProvider";
import { initSentry } from "@/lib/sentry";
import { TrpcProvider } from "@/lib/trpc";
import { RootNavigator } from "@/navigation/RootNavigator";

const SPLASH_ICON = require("./assets/splash-icon.png");

// Keep the native splash up until JS has fonts loaded, then hand off to the
// JS-side <Embers /> splash. Mirrors apps/scanner/App.tsx — without this,
// the native splash auto-hides as soon as the RN bridge is ready, exposing
// a brief unstyled flash before the JS tree mounts.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already-hidden / unsupported platform — safe to ignore.
});

// Minimum on-screen duration for the JS-side animated splash. Fonts load in
// ~50ms; this floor guarantees the embers + breath get a visible cycle on
// fast cold starts. 1000ms ≈ one half breath cycle.
const SPLASH_MIN_MS = 1000;

// Top-level Sentry init: a side-effect import would also work but doing
// it here makes the dependency explicit. Idempotent on hot reload.
initSentry();

/**
 * SecureStore key the theme preference is persisted under.
 *
 * Deliberately NOT the package default (`th.scanner.theme.v1`): the two apps
 * are separate installs with separate keychains today, but sharing a key name
 * would silently couple them if that ever stops being true. Mobile owns its
 * own namespace.
 */
const THEME_STORAGE_KEY = "th.mobile.theme.v1";

/**
 * Bridges the native theme into the two consumers that live outside the
 * `useColors()` world:
 *
 *   - `IthasFireProvider` — Tamagui's theme name. `NativeThemeName` is a
 *     subset of `IthasFireThemeName`, so the name passes straight through and
 *     `@th/ui` components (the `Text` inside every `@th/ui-native` primitive)
 *     resolve against the same palette the RN StyleSheets do.
 *   - `StatusBar` — expo-status-bar takes a light/dark CONTENT style, not a
 *     colour. Mobile now defaults to Stub (warm paper), so a hardcoded
 *     `style="light"` would paint white glyphs on a cream canvas.
 */
const ThemedRoot = () => {
  const { name } = useNativeTheme();
  const isDark = useIsDarkTheme();
  return (
    <IthasFireProvider theme={name}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <RootNavigator />
    </IthasFireProvider>
  );
};

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
      console.warn("[fonts] Montserrat load failed; falling back", fontError);
    }
  }, [fontError]);

  // Hide the native splash as soon as fonts are ready — reveals the JS
  // <Embers /> splash, which then stays up at least SPLASH_MIN_MS.
  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  const showSplash = (!fontsLoaded && !fontError) || !splashTimeElapsed;

  // The JS splash paints in FIXED colours in both themes — it has to be
  // pixel-identical to the NATIVE splash in `app.config.ts`, which runs before
  // any JS (and therefore before any stored theme) exists.
  if (showSplash) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: FIXED.splashBackground,
        }}
      >
        <Embers
          size={220}
          tint={FIXED.splashTint}
          iconSource={SPLASH_ICON}
        />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/*
          Above everything that paints: `ThemedRoot` reads the theme to drive
          both Tamagui and the status bar, and every screen below reaches it
          through `useColors()` / `useStyles()`. No `defaultTheme` /
          `enabledThemes` — mobile inherits the package default (Stub) with
          Ember available.
        */}
        <NativeThemeProvider storageKey={THEME_STORAGE_KEY}>
          <PaymentsProvider>
            <TrpcProvider>
              <ThemedRoot />
            </TrpcProvider>
          </PaymentsProvider>
        </NativeThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(App);
