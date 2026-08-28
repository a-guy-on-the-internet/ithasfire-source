import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AlertTriangle, Eye, EyeOff, Mail } from "lucide-react-native";

import { formatAuthErrorMessage } from "@th/errors";
import {
  SquarePrimaryButton,
  SquareSecondaryButton,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { getWebBaseUrl } from "@/config/api";
import { useAuthSession } from "@/features/auth/use-auth-session";
import { ScreenHeading, ScreenSurface, SectionNum } from "@/ui/primitives";

export const SignInScreen = () => {
  const { sendMagicLink, signInWithPassword } = useAuthSession();
  const colors = useColors();
  const shared = useStyles();
  const styles = useThemedSheet(makeSheet);
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [focusedField, setFocusedField] = useState<"email" | "password" | null>(
    null,
  );
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [magicPending, setMagicPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);

  const normalizedEmail = email.trim();
  const isBusy = passwordPending || magicPending;
  const canPasswordSubmit =
    normalizedEmail.length >= 3 && password.length > 0 && !isBusy;
  const canSendMagicLink = normalizedEmail.length >= 3 && !isBusy;

  const handleEmailChange = useCallback(
    (value: string) => {
      setEmail(value);
      setErrorMessage(null);
      if (linkSent) setLinkSent(false);
    },
    [linkSent],
  );

  const handlePasswordChange = useCallback((value: string) => {
    setPassword(value);
    setErrorMessage(null);
  }, []);

  const handlePasswordSubmit = useCallback(async () => {
    setErrorMessage(null);
    setPasswordPending(true);
    try {
      await signInWithPassword(email, password);
    } catch (err) {
      setErrorMessage(formatAuthErrorMessage(err));
    } finally {
      setPasswordPending(false);
    }
  }, [email, password, signInWithPassword]);

  const handleMagicLinkSubmit = useCallback(async () => {
    setErrorMessage(null);
    setMagicPending(true);
    try {
      await sendMagicLink(email);
      setLinkSent(true);
    } catch (err) {
      setErrorMessage(formatAuthErrorMessage(err));
    } finally {
      setMagicPending(false);
    }
  }, [email, sendMagicLink]);

  const openForgotPassword = useCallback(async () => {
    setErrorMessage(null);
    try {
      await Linking.openURL(`${getWebBaseUrl()}/forgot-password`);
    } catch {
      setErrorMessage("Couldn't open the password reset page.");
    }
  }, []);

  const openSignUp = useCallback(async () => {
    setErrorMessage(null);
    try {
      await Linking.openURL(`${getWebBaseUrl()}/sign-up`);
    } catch {
      setErrorMessage("Couldn't open the create account page.");
    }
  }, []);

  return (
    <ScreenSurface testID="sign-in-screen">
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.authCard}>
              <View style={styles.heading}>
                <SectionNum index="00" label="Ithas Fire" />
                <ScreenHeading>Sign in to Ithas Fire</ScreenHeading>
                <Text style={styles.subtitle}>
                  Access your tickets, orders, and event updates.
                </Text>
              </View>

              {errorMessage ? (
                <View style={styles.errorBanner} accessibilityRole="alert">
                  <AlertTriangle color={colors.dangerSoft} size={18} />
                  <Text style={styles.errorText}>{errorMessage}</Text>
                </View>
              ) : null}

              <View style={styles.formGroup}>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    value={email}
                    onChangeText={handleEmailChange}
                    placeholder="you@example.com"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    textContentType="emailAddress"
                    keyboardType="email-address"
                    inputMode="email"
                    returnKeyType="next"
                    enterKeyHint="next"
                    editable={!isBusy}
                    onFocus={() => setFocusedField("email")}
                    onBlur={() => setFocusedField(null)}
                    onSubmitEditing={() => passwordRef.current?.focus()}
                    accessibilityLabel="Email"
                    style={[
                      shared.input,
                      focusedField === "email" ? shared.inputFocused : null,
                    ]}
                  />
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Password</Text>
                  <View
                    style={[
                      styles.passwordField,
                      focusedField === "password" ? shared.inputFocused : null,
                    ]}
                  >
                    <TextInput
                      ref={passwordRef}
                      value={password}
                      onChangeText={handlePasswordChange}
                      placeholder="Password"
                      placeholderTextColor={colors.placeholder}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="current-password"
                      textContentType="password"
                      secureTextEntry={!passwordVisible}
                      returnKeyType="go"
                      enterKeyHint="go"
                      editable={!isBusy}
                      onFocus={() => setFocusedField("password")}
                      onBlur={() => setFocusedField(null)}
                      onSubmitEditing={() => {
                        if (canPasswordSubmit) void handlePasswordSubmit();
                      }}
                      accessibilityLabel="Password"
                      style={styles.passwordInput}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        passwordVisible ? "Hide password" : "Show password"
                      }
                      accessibilityState={{ selected: passwordVisible }}
                      onPress={() => setPasswordVisible((visible) => !visible)}
                      disabled={isBusy}
                      hitSlop={6}
                      style={({ pressed }) => [
                        styles.passwordToggle,
                        pressed && !isBusy
                          ? styles.passwordTogglePressed
                          : null,
                      ]}
                    >
                      {({ pressed }) => {
                        // The pressed state fills with `structure`, which is
                        // DARK in both themes (steel blue on Ember, ink on
                        // Stub). A `color` icon would vanish into it on Stub,
                        // so the glyph inverts with the fill.
                        const iconColor =
                          pressed && !isBusy
                            ? colors.onStructure
                            : colors.color;
                        return passwordVisible ? (
                          <EyeOff color={iconColor} size={18} />
                        ) : (
                          <Eye color={iconColor} size={18} />
                        );
                      }}
                    </Pressable>
                  </View>
                </View>

                <View style={styles.forgotRow}>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="Forgot password"
                    disabled={isBusy}
                    onPress={() => void openForgotPassword()}
                    style={({ pressed }) => [
                      styles.textLinkButton,
                      pressed && !isBusy ? styles.textLinkButtonPressed : null,
                      isBusy ? styles.textLinkButtonDisabled : null,
                    ]}
                  >
                    {({ pressed }) => (
                      <Text
                        style={[
                          styles.linkText,
                          pressed && !isBusy ? styles.linkTextPressed : null,
                          isBusy ? styles.linkTextDisabled : null,
                        ]}
                      >
                        Forgot password?
                      </Text>
                    )}
                  </Pressable>
                </View>

                <View style={styles.ctaWrapper}>
                  <SquarePrimaryButton
                    label={passwordPending ? "Signing in..." : "Sign in"}
                    onPress={() => void handlePasswordSubmit()}
                    disabled={!canPasswordSubmit}
                    accessibilityHint="Signs in with your email and password."
                  />
                  {passwordPending ? (
                    <View style={styles.spinnerOverlay} pointerEvents="none">
                      {/* Sits ON the primary button's `ctaFill`. */}
                      <ActivityIndicator color={colors.onCta} />
                    </View>
                  ) : null}
                </View>
              </View>

              <View
                style={styles.dividerRow}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>Or</Text>
                <View style={styles.dividerLine} />
              </View>

              <View style={styles.magicGroup}>
                {linkSent ? (
                  <View style={styles.successCard}>
                    <Mail color={colors.accentText} size={24} />
                    <Text style={styles.successText}>
                      Check your inbox. We sent a sign-in link to{" "}
                      <Text style={styles.successEmail}>{normalizedEmail}</Text>
                      .
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Use a different email"
                      disabled={isBusy}
                      onPress={() => setLinkSent(false)}
                      style={({ pressed }) => [
                        styles.textLinkButton,
                        pressed && !isBusy
                          ? styles.textLinkButtonPressed
                          : null,
                        isBusy ? styles.textLinkButtonDisabled : null,
                      ]}
                    >
                      {({ pressed }) => (
                        <Text
                          style={[
                            styles.linkText,
                            pressed && !isBusy ? styles.linkTextPressed : null,
                            isBusy ? styles.linkTextDisabled : null,
                          ]}
                        >
                          Use a different email
                        </Text>
                      )}
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <Text style={styles.magicCopy}>
                      Prefer a one-time email link?
                    </Text>
                    <View style={styles.ctaWrapper}>
                      <SquareSecondaryButton
                        label={
                          magicPending ? "Sending..." : "Send sign-in link"
                        }
                        onPress={() => void handleMagicLinkSubmit()}
                        disabled={!canSendMagicLink}
                        accessibilityHint="Sends a one-time sign-in link to the email above."
                      />
                      {magicPending ? (
                        <View
                          style={styles.spinnerOverlay}
                          pointerEvents="none"
                        >
                          {/* Sits on the SECONDARY button, whose resting
                              fill is the canvas — full-contrast `color`. */}
                          <ActivityIndicator color={colors.color} />
                        </View>
                      ) : null}
                    </View>
                  </>
                )}
              </View>

              <View style={styles.footer}>
                <Text style={styles.footerText}>Need an account?</Text>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="Create account"
                  accessibilityState={{ disabled: isBusy }}
                  disabled={isBusy}
                  onPress={() => void openSignUp()}
                  style={({ pressed }) => [
                    styles.createAccountButton,
                    pressed && !isBusy
                      ? styles.createAccountButtonPressed
                      : null,
                    isBusy ? styles.createAccountButtonDisabled : null,
                  ]}
                >
                  {({ pressed }) => (
                    <Text
                      style={[
                        styles.createAccountText,
                        pressed && !isBusy
                          ? styles.createAccountTextPressed
                          : null,
                        isBusy ? styles.createAccountTextDisabled : null,
                      ]}
                    >
                      Create account
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ScreenSurface>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    scrollContent: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      paddingVertical: 24,
    },
    authCard: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surfaceMuted,
      padding: 20,
      gap: 18,
    },
    heading: { gap: 8 },
    subtitle: {
      fontFamily: "Montserrat",
      fontSize: 14,
      color: c.colorMuted,
      lineHeight: 20,
    },
    formGroup: { gap: 14 },
    fieldGroup: { gap: 7 },
    label: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1.1,
      textTransform: "uppercase",
    },
    // Mirrors the package sheet's `input` recipe so this composite field is
    // indistinguishable from the plain email input above it.
    passwordField: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
    },
    passwordInput: {
      flex: 1,
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 14,
      color: c.color,
      fontFamily: "Montserrat",
      fontSize: 16,
    },
    passwordToggle: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 4,
      borderWidth: 1,
      borderColor: c.borderColorSoft,
    },
    // Press inverts to the structural fill; the glyph moves to `onStructure`
    // (see the icon-colour note at the call site).
    passwordTogglePressed: {
      backgroundColor: c.structure,
      borderColor: c.structure,
    },
    forgotRow: {
      minHeight: 44,
      alignItems: "flex-end",
      justifyContent: "center",
    },
    ctaWrapper: { position: "relative" },
    spinnerOverlay: {
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    // Outlined-tone banner: the tone lives on the border + label, the fill
    // stays a theme surface (the package's `banner` pattern).
    errorBanner: {
      minHeight: 44,
      borderWidth: 2,
      borderColor: c.danger,
      backgroundColor: c.surface,
      padding: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    errorText: {
      flex: 1,
      color: c.dangerSoft,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 19,
    },
    dividerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    dividerLine: {
      flex: 1,
      height: 2,
      backgroundColor: c.borderColor,
    },
    dividerText: {
      color: c.colorMuted,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 1.5,
      textTransform: "uppercase",
    },
    magicGroup: { gap: 12 },
    magicCopy: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 13,
      lineHeight: 18,
    },
    successCard: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surface,
      padding: 20,
      gap: 12,
      alignItems: "center",
    },
    successText: {
      color: c.color,
      fontFamily: "Montserrat",
      fontSize: 14,
      textAlign: "center",
      lineHeight: 20,
    },
    successEmail: {
      fontFamily: "Montserrat-SemiBold",
      color: c.accentText,
    },
    textLinkButton: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    // Press fills with the CTA orange, so the label takes `onCta` — the one
    // pairing that is AA on both themes' fills (white on Ember's #FF5721 is
    // 3.16:1; ink on Stub's #B93312 is 2.99:1).
    textLinkButtonPressed: {
      backgroundColor: c.ctaFill,
    },
    textLinkButtonDisabled: {
      opacity: 0.5,
    },
    linkText: {
      fontFamily: "Montserrat-Medium",
      color: c.accentText,
      fontSize: 12,
      letterSpacing: 1,
      textTransform: "uppercase",
      textDecorationLine: "underline",
    },
    linkTextPressed: {
      color: c.onCta,
    },
    linkTextDisabled: {
      color: c.colorMuted,
    },
    footer: {
      borderTopWidth: 2,
      borderTopColor: c.borderColor,
      paddingTop: 16,
      gap: 12,
      alignItems: "center",
    },
    footerText: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      fontWeight: "500",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    // 2px border is a GRAPHIC (raw `accent` clears the 3:1 floor); the label
    // inside it is TEXT and deepens to `accentText`.
    createAccountButton: {
      minHeight: 44,
      minWidth: 44,
      borderWidth: 2,
      borderColor: c.accent,
      paddingHorizontal: 16,
      paddingVertical: 11,
      alignItems: "center",
      justifyContent: "center",
    },
    createAccountButtonPressed: {
      backgroundColor: c.ctaFill,
    },
    createAccountButtonDisabled: {
      opacity: 0.5,
    },
    createAccountText: {
      color: c.accentText,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    createAccountTextPressed: {
      color: c.onCta,
    },
    createAccountTextDisabled: {
      color: c.colorMuted,
    },
  });
