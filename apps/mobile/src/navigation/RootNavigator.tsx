import { ActivityIndicator, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { useColors, useIsDarkTheme } from "@th/ui-native";

import { useAuthSession } from "@/features/auth/use-auth-session";
import { useSentryUserSync } from "@/lib/sentry";
import { SignInScreen } from "@/screens/SignInScreen";
import { SignedInTabs } from "./SignedInTabs";
import type { SignedOutStackParamList } from "./types";

const SignedOutStack = createNativeStackNavigator<SignedOutStackParamList>();

const SignedOutNavigator = () => (
  <SignedOutStack.Navigator screenOptions={{ headerShown: false }}>
    <SignedOutStack.Screen name="SignIn" component={SignInScreen} />
  </SignedOutStack.Navigator>
);

const SplashGate = () => {
  const colors = useColors();
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.background,
      }}
    >
      <ActivityIndicator color={colors.color} />
    </View>
  );
};

/**
 * The single switch between signed-in and signed-out worlds. Uses the
 * NavigationContainer's `key` prop so we tear down + remount the entire
 * stack on auth-state transitions — eliminates the entire class of
 * "stale screen mounted with stale data after sign-out" bugs.
 *
 * Theme tokens come from `@th/ui-native` so the navigation chrome (header
 * bg, tab bar, text) tracks the active theme without manual hex repetition.
 * `dark` is derived rather than hardcoded — React Navigation feeds it to the
 * platform's default header/blur treatment, and mobile now ships Stub (light)
 * by default.
 */
export const RootNavigator = () => {
  const { isLoading, isSignedIn, humanId } = useAuthSession();
  const colors = useColors();
  const isDark = useIsDarkTheme();

  // Tag every Sentry event with the current humanId (or clear it on sign-out).
  useSentryUserSync(humanId);

  if (isLoading) return <SplashGate />;

  return (
    <NavigationContainer
      key={isSignedIn ? "signed-in" : "signed-out"}
      theme={{
        dark: isDark,
        colors: {
          // `primary`/`notification` render as TEXT and icons (header tint,
          // badge), so they take `accentText`, not the raw `accent` fill.
          primary: colors.accentText,
          background: colors.background,
          card: colors.surface,
          text: colors.color,
          // Chrome hairline between the header/tab bar and content — the soft
          // rung, matching the package sheet's `navBorder`.
          border: colors.borderColorSoft,
          notification: colors.accentText,
        },
        fonts: {
          regular: { fontFamily: "Montserrat", fontWeight: "400" },
          medium: { fontFamily: "Montserrat-Medium", fontWeight: "500" },
          bold: { fontFamily: "Montserrat-SemiBold", fontWeight: "700" },
          heavy: { fontFamily: "Montserrat-SemiBold", fontWeight: "900" },
        },
      }}
    >
      {isSignedIn ? <SignedInTabs /> : <SignedOutNavigator />}
    </NavigationContainer>
  );
};
