import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { ChevronDown, ChevronUp } from "lucide-react-native";

/**
 * FR-009 sweep, with ONE deliberate exception.
 *
 * `Text` moved to `@th/ui-native` with everything else. `PasswordInput` did
 * NOT: the design's §9c calls it "a duplicate" of `@th/ui-native`'s, but they
 * are not equivalent — the web one carries a show/hide toggle (with its own
 * `toggleLabel` / `visibleStateLabel` / `hiddenStateLabel` a11y strings),
 * `autoComplete="current-password"`/`new-password`, and `id`/`name` for
 * password managers. The native one is a bare secure `TextInput`. Swapping
 * would delete a working affordance from the sign-in screen to satisfy an
 * import-hygiene rule, which is the wrong trade. `Embers` stays for the usual
 * reason (app-supplied `iconSource`).
 */
import { Embers, PasswordInput } from "@th/ui";
import {
  formatAuthErrorMessage,
  isWebAuthnCancel,
  normalizeError,
} from "@th/errors";

import {
  FIXED,
  GeometricBackground,
  SquarePrimaryButton,
  Text,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";
import { scannerPasskey } from "../features/auth/passkey-client";
import { AppleLogo, GoogleLogo } from "../ui/oauth-logos";
import { showErrorToast } from "../lib/toast";

const SPLASH_ICON = require("../../assets/splash-icon.png");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mirrors Better Auth's `username()` plugin server-side regex closely
// enough for a friendly client-side gate. Server is the source of truth.
const usernamePattern = /^[a-z0-9_-]{3,32}$/;

export type OAuthProvider = "google" | "apple";

type Mode = "sign-in" | "sign-up";

export const SignInScreen = ({
  onSignIn,
  onSignUp,
  onSignInWithPasskey,
  onSignInWithOAuth,
}: {
  onSignIn: (identifier: string, password: string) => Promise<void>;
  onSignUp?: (email: string, password: string, name: string) => Promise<void>;
  onSignInWithPasskey?: () => Promise<void>;
  onSignInWithOAuth?: (provider: OAuthProvider) => Promise<void>;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [mode, setMode] = useState<Mode>("sign-in");
  // `identifier` accepts an email *or* a username on sign-in; on sign-up
  // it's locked to email because that's the field Better Auth requires
  // for account creation.
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);

  const passkeySupported = useMemo(() => scannerPasskey.isSupported(), []);
  // Passkey CTA is only meaningful on sign-in — brand-new accounts haven't
  // enrolled one yet (the post-sign-up prompt handles enrolment).
  const showPasskeyCta =
    passkeySupported && !!onSignInWithPasskey && mode === "sign-in";
  const isSignUp = mode === "sign-up";

  // Passkey-first: the default screen is ONE decision. OAuth and the password
  // form collapse behind a disclosure.
  const [showOtherWays, setShowOtherWays] = useState(false);
  // ...but a disclosure only makes sense when there is a primary lane to
  // collapse behind. Force it open when there isn't one, or the operator would
  // face a card with nothing actionable on it:
  //   - sign-up: no passkey exists yet, so the form IS the path
  //   - no passkey support (or no handler wired): same
  const otherWaysExpanded = showOtherWays || isSignUp || !showPasskeyCta;

  // Auto-focus the identity field on mount so the operator can start
  // typing immediately. Re-focus when toggling modes so the cursor lands
  // on the right first field (name on sign-up, identifier on sign-in).
  const identifierRef = useRef<TextInput | null>(null);
  const passwordRef = useRef<TextInput | null>(null);
  const nameRef = useRef<TextInput | null>(null);

  // Only steal focus when the fields are actually on screen. Previously this
  // fired unconditionally, so a passkey-first operator got the keyboard thrown
  // up over a form they weren't using — and it covered the CTA they were.
  useEffect(() => {
    if (!otherWaysExpanded) return;
    const t = setTimeout(() => {
      if (isSignUp) nameRef.current?.focus();
      else identifierRef.current?.focus();
    }, 120);
    return () => clearTimeout(t);
  }, [isSignUp, otherWaysExpanded]);

  /**
   * Switch between SIGN IN and SIGN UP. Clears credentials AND name to
   * avoid a sign-in password getting staged for a new-account
   * `signUp.email` call after a toggle, a previous-mode name leaking
   * into a sign-in submit, and the post-toggle banner showing a
   * validation error from the previous mode.
   */
  const switchMode = (next: Mode) => {
    if (mode === next) return;
    setError(null);
    setMessage(null);
    setPassword("");
    setName("");
    // Returning to sign-in re-collapses the disclosure so the passkey CTA is
    // the single decision again. (Going TO sign-up force-expands it anyway.)
    setShowOtherWays(false);
    setMode(next);
  };

  const normalizedIdentifier = identifier.trim().toLowerCase();
  // Sign-in accepts email OR username. Sign-up is email-only.
  const isIdentifierValid = isSignUp
    ? emailPattern.test(normalizedIdentifier)
    : emailPattern.test(normalizedIdentifier) ||
      usernamePattern.test(normalizedIdentifier);
  const isBusy = submitting || passkeyBusy || oauthBusy != null;

  // Centralised cancel detection: `passkey-client` propagates a typed
  // `code: "user_cancelled"` so we don't have to grep localised messages.
  // We still keep a fuzzy fallback (via the shared `isWebAuthnCancel`
  // resolver) for OAuth/native exceptions that bubble up without the typed
  // shape.
  const isUserCancelError = (err: unknown): boolean => {
    if (!err) return false;
    if (
      typeof err === "object" &&
      err &&
      "code" in err &&
      (err as { code?: unknown }).code === "user_cancelled"
    ) {
      return true;
    }
    return isWebAuthnCancel(err);
  };

  /**
   * Network-class failures (no internet, DNS error, server unreachable, TLS)
   * surface as transient toasts instead of pinning a banner on the card.
   * Validation + auth errors stay inline because the user needs to see them
   * while editing the field that caused them. Detection + copy come from the
   * shared `@th/errors` resolver so it matches web/mobile exactly.
   */
  const reportError = (err: unknown, fallback: string) => {
    if (normalizeError(err).code === "NETWORK") {
      showErrorToast(
        "Couldn't reach the server",
        "Check that your phone has internet, then try again.",
      );
      return;
    }
    setError(formatAuthErrorMessage(err) || fallback);
  };

  const handlePasskeyPress = async () => {
    if (!onSignInWithPasskey) return;
    setError(null);
    setMessage(null);
    setPasskeyBusy(true);
    try {
      await onSignInWithPasskey();
    } catch (err) {
      if (!isUserCancelError(err)) reportError(err, "Passkey sign-in failed.");
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleOAuthPress = async (provider: OAuthProvider) => {
    if (!onSignInWithOAuth) return;
    setError(null);
    setMessage(null);
    setOauthBusy(provider);
    try {
      await onSignInWithOAuth(provider);
    } catch (err) {
      if (!isUserCancelError(err))
        reportError(err, `${provider} sign-in failed.`);
    } finally {
      setOauthBusy(null);
    }
  };

  const handlePasswordSubmit = async () => {
    setError(null);
    setMessage(null);
    if (!isIdentifierValid) {
      setError(
        isSignUp
          ? "Enter a valid email address."
          : "Enter your email or username.",
      );
      return;
    }
    if (isSignUp) {
      if (!onSignUp) {
        setError("Sign-up isn't available on this device.");
        return;
      }
      if (name.trim().length < 1) {
        setError("Enter your name.");
        return;
      }
      if (password.length < 8) {
        setError("Pick a password at least 8 characters long.");
        return;
      }
    } else {
      if (password.length < 1) {
        setError("Enter your password.");
        return;
      }
    }
    setSubmitting(true);
    try {
      if (isSignUp && onSignUp) {
        await onSignUp(normalizedIdentifier, password, name.trim());
      } else {
        await onSignIn(normalizedIdentifier, password);
      }
    } catch (err) {
      // Common sign-up case: the operator already has a Ithas Fire
      // account and meant to sign in. Better Auth returns
      // "USER_ALREADY_EXISTS" / a message mentioning "already exists";
      // the shared resolver maps both shapes to a single code.
      // Auto-flip the toggle, surface a friendly banner, and keep the
      // identifier staged so they can just tap SIGN IN.
      if (isSignUp && normalizeError(err).code === "USER_ALREADY_EXISTS") {
        setMode("sign-in");
        setMessage(
          "Looks like you already have an account — sign in with your password.",
        );
        setPassword("");
        setName("");
        return;
      }
      reportError(err, isSignUp ? "Sign-up failed." : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root} testID="sign-in-screen">
      <GeometricBackground />
      <GoldGridOverlay />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text variant="h4" weight="bold" style={styles.cardTitle}>
              {isSignUp ? "JOIN ITHASFIRE" : "SIGN IN TO ITHASFIRE"}
            </Text>

            {/*
              Passkey-first. This is the one decision the screen asks for on a
              returning operator's device; four stacked auth lanes made the
              fast path compete with three fallbacks it should have outranked.
            */}
            {showPasskeyCta ? (
              <SquarePrimaryButton
                label={passkeyBusy ? "WAITING…" : "CONTINUE WITH PASSKEY"}
                onPress={() => void handlePasskeyPress()}
                disabled={isBusy}
                testID="sign-in-passkey"
              />
            ) : null}

            {/*
              The disclosure trigger. Rendered only when there is a primary lane
              to collapse behind — see `otherWaysExpanded`. Chrome, not content,
              so it takes the soft treatment rather than a Swiss button.
            */}
            {showPasskeyCta && !isSignUp ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: otherWaysExpanded }}
                accessibilityLabel="Other ways to sign in"
                accessibilityHint="Shows Google, Apple and password sign-in."
                onPress={() => setShowOtherWays((v) => !v)}
                hitSlop={8}
                style={styles.otherWaysTrigger}
                testID="sign-in-other-ways-toggle"
              >
                <Text
                  variant="caption"
                  weight="bold"
                  style={styles.otherWaysLabel}
                >
                  OTHER WAYS TO SIGN IN
                </Text>
                {otherWaysExpanded ? (
                  <ChevronUp size={14} color={colors.colorMuted} />
                ) : (
                  <ChevronDown size={14} color={colors.colorMuted} />
                )}
              </Pressable>
            ) : null}

            {otherWaysExpanded && onSignInWithOAuth ? (
              <View style={styles.oauthRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Continue with Google"
                  onPress={() => void handleOAuthPress("google")}
                  disabled={isBusy}
                  style={styles.oauthCta}
                  testID="sign-in-google"
                >
                  {oauthBusy === "google" ? (
                    // FIXED, not `colors.color` — same reason as the Apple mark
                    // below. `colors.color` is INK on Stub (the default theme),
                    // which is 1.24:1 on the black Apple fill and the wrong
                    // polarity on the Google blue.
                    <ActivityIndicator
                      size="small"
                      color={FIXED.onVendorBrand}
                    />
                  ) : (
                    <>
                      <View style={styles.oauthIcon}>
                        <GoogleLogo size={18} />
                      </View>
                      <Text
                        variant="body"
                        weight="bold"
                        style={styles.oauthCtaText}
                      >
                        GOOGLE
                      </Text>
                    </>
                  )}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Continue with Apple"
                  onPress={() => void handleOAuthPress("apple")}
                  disabled={isBusy}
                  style={styles.oauthCtaApple}
                  testID="sign-in-apple"
                >
                  {oauthBusy === "apple" ? (
                    <ActivityIndicator
                      size="small"
                      color={FIXED.onVendorBrand}
                    />
                  ) : (
                    <>
                      <View style={styles.oauthIcon}>
                        {/*
                          FIXED, not `colors.color`: this mark sits on the
                          vendor-black Apple button, which does not follow the
                          theme. `colors.color` is white on Ember but INK on
                          Stub — the mark would have gone near-invisible on
                          black in daylight mode.
                        */}
                        <AppleLogo size={18} color={FIXED.onVendorBrand} />
                      </View>
                      <Text
                        variant="body"
                        weight="bold"
                        style={styles.oauthCtaTextApple}
                      >
                        APPLE
                      </Text>
                    </>
                  )}
                </Pressable>
              </View>
            ) : null}

            {otherWaysExpanded ? (
              <>
                <View style={styles.dividerRow}>
                  <View style={styles.dividerLine} />
                  <Text
                    variant="caption"
                    weight="bold"
                    style={styles.dividerText}
                  >
                    PASSWORD
                  </Text>
                  <View style={styles.dividerLine} />
                </View>

                {isSignUp ? (
                  <View style={styles.field}>
                    <Text variant="caption" weight="bold" style={styles.label}>
                      NAME
                    </Text>
                    <TextInput
                      ref={nameRef}
                      value={name}
                      onChangeText={setName}
                      placeholder="Your name"
                      placeholderTextColor={colors.placeholder}
                      autoCapitalize="words"
                      autoCorrect={false}
                      textContentType="name"
                      accessibilityLabel="Name"
                      maxLength={200}
                      returnKeyType="next"
                      onSubmitEditing={() => identifierRef.current?.focus()}
                      style={styles.nameInput}
                      testID="sign-up-name-input"
                    />
                  </View>
                ) : null}
                <View style={styles.field}>
                  <Text variant="caption" weight="bold" style={styles.label}>
                    {isSignUp ? "EMAIL" : "EMAIL OR USERNAME"}
                  </Text>
                  <TextInput
                    ref={identifierRef}
                    value={identifier}
                    onChangeText={setIdentifier}
                    placeholder={
                      isSignUp
                        ? "you@example.com"
                        : "you@example.com or username"
                    }
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    // Sign-up locks to email so the email keyboard is right.
                    // Sign-in accepts either, so default keyboard prevents
                    // forcing a layout that hides letters useful for
                    // usernames. textContentType still helps autofill.
                    keyboardType={isSignUp ? "email-address" : "default"}
                    textContentType={isSignUp ? "emailAddress" : "username"}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                    style={styles.nameInput}
                    testID="sign-in-identifier-input"
                    accessibilityLabel={
                      isSignUp ? "Email" : "Email or username"
                    }
                  />
                </View>
                <View style={styles.field}>
                  <Text variant="caption" weight="bold" style={styles.label}>
                    PASSWORD
                  </Text>
                  <PasswordInput
                    id="password"
                    name="password"
                    value={password}
                    onChangeText={setPassword}
                    placeholder={
                      isSignUp ? "At least 8 characters" : "Enter your password"
                    }
                    autoCapitalize="none"
                    autoComplete={
                      isSignUp ? "new-password" : "current-password"
                    }
                    testId="sign-in-password-input"
                    toggleTestId="sign-in-password-toggle"
                    toggleLabel="Toggle password visibility"
                    visibleStateLabel="Password visible"
                    hiddenStateLabel="Password hidden"
                    fullWidth
                    height={52}
                    paddingHorizontal={16}
                    fontSize={16}
                    lineHeight={22}
                    borderWidth={2}
                    borderColor={colors.borderColor}
                    backgroundColor={colors.surfaceRaised}
                    color={colors.color}
                    placeholderTextColor={colors.placeholder}
                    ref={passwordRef}
                    returnKeyType="go"
                    onSubmitEditing={() => void handlePasswordSubmit()}
                  />
                  {isSignUp ? (
                    <Text
                      variant="caption"
                      style={styles.helperText}
                      testID="sign-up-password-hint"
                    >
                      At least 8 characters.
                    </Text>
                  ) : null}
                </View>
                {/*
              The shared primitive, not a hand-rolled Pressable + `opacity: 0.5`.
              That opacity was the disabled affordance here, and it measured
              1.64:1 on-device for the label against its own washed-out fill —
              blending BOTH the fill and the white label toward the canvas
              collapses the pair. It fails in Ember too (2.20:1); the light
              canvas just made it visible. `SquarePrimaryButton` carries the
              token disabled state instead (`colorMuted` on `surfaceMuted`,
              6.05:1 Stub / 6.11:1 Ember).
            */}
                <SquarePrimaryButton
                  label={
                    submitting
                      ? isSignUp
                        ? "CREATING…"
                        : "SIGNING IN…"
                      : isSignUp
                        ? "CREATE ACCOUNT"
                        : "SIGN IN"
                  }
                  onPress={() => void handlePasswordSubmit()}
                  disabled={
                    isBusy ||
                    !isIdentifierValid ||
                    password.length < (isSignUp ? 8 : 1) ||
                    (isSignUp && name.trim().length < 1)
                  }
                  testID={isSignUp ? "sign-up-button" : "sign-in-button"}
                />
              </>
            ) : null}

            {/* Mode switch stays OUTSIDE the disclosure: a brand-new operator
                needs a route to account creation without first having to guess
                that it lives behind "other ways to sign in". */}
            {onSignUp ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => switchMode(isSignUp ? "sign-in" : "sign-up")}
                style={styles.modeSwitchInline}
                testID="sign-in-mode-switch-inline"
              >
                <Text variant="caption" weight="bold" style={styles.toggleText}>
                  {isSignUp
                    ? "ALREADY HAVE AN ACCOUNT? SIGN IN"
                    : "NEW HERE? CREATE AN ACCOUNT"}
                </Text>
              </Pressable>
            ) : null}

            {message ? (
              <View style={styles.messageBox} testID="sign-in-success-message">
                <Text variant="bodySmall" color={colors.color}>
                  {message}
                </Text>
              </View>
            ) : null}
            {error ? (
              <View style={styles.errorBox} testID="sign-in-error-message">
                <Text variant="bodySmall" color={colors.dangerSoft}>
                  {error}
                </Text>
              </View>
            ) : null}

            {submitting || passkeyBusy || oauthBusy ? (
              <View style={styles.spinner}>
                <Embers
                  size={120}
                  tint={colors.accent}
                  iconSource={SPLASH_ICON}
                />
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
};

// memo'd: re-rendering 63+ lines on every keystroke is real jank fuel.
const GoldGridOverlay = memo(function GoldGridOverlay() {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const lines: React.ReactNode[] = [];
  for (let i = 1; i < 40; i += 1) {
    lines.push(
      <View
        key={`h${i}`}
        pointerEvents="none"
        style={[
          styles.gridLine,
          { top: i * 32, left: 0, right: 0, height: StyleSheet.hairlineWidth },
        ]}
      />,
    );
  }
  for (let i = 1; i < 24; i += 1) {
    lines.push(
      <View
        key={`v${i}`}
        pointerEvents="none"
        style={[
          styles.gridLine,
          { left: i * 32, top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
        ]}
      />,
    );
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {lines}
    </View>
  );
});

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    scrollContent: {
      flexGrow: 1,
      justifyContent: "center",
      paddingVertical: 48,
      paddingHorizontal: 16,
      gap: 24,
    },
    gridLine: {
      position: "absolute",
      backgroundColor: colors.signInGridLine,
    },
    /**
     * Follows the sanctioned EVENT CARD pattern rather than inventing a
     * one-off — see `EventCardSurface` in
     * `packages/ui/src/ui/tamagui/components/event-grid/EventCard.tsx`.
     *
     * That component is `CardSurface` (radius 0, 2px border) with exactly three
     * deliberate overrides, and all three are what this card was getting wrong:
     *
     *   1. **Fill is `surface`, not the page.** The web comment is explicit
     *      about why: when the card matched the page colour, "the frame read as
     *      a bare border with no panel". This card was `transparent` on the
     *      canvas — the same failure, one step worse.
     *   2. **Border is `borderColorSoft`, not the structural `borderColor`.**
     *      "Cards recede; section rules are the heavy lines." The 2px ink
     *      rectangle here was competing with the content it framed.
     *   3. **Elevation is per-theme.** Stub gets a hard offset print shadow (no
     *      blur — the ticket-stub paper look); Ember is flat, because borders
     *      carry structure in the dark theme.
     *
     * The shadow needs RN >= 0.76 + New Architecture for `boxShadow` to render
     * on Android; this app is on 0.81.6 with `newArchEnabled: true`. Ember's
     * token is the literal string "none" (matching the web's `elevationTokens`
     * shape), which RN's parser does NOT accept — hence the conditional spread
     * rather than passing it through.
     */
    card: {
      maxWidth: 480,
      width: "100%",
      alignSelf: "center",
      borderRadius: 0,
      borderWidth: 2,
      borderColor: colors.borderColorSoft,
      backgroundColor: colors.surface,
      padding: 24,
      gap: 16,
      ...(colors.cardShadow !== "none"
        ? { boxShadow: colors.cardShadow }
        : null),
    },
    cardTitle: {
      color: colors.color,
      fontSize: 22,
      letterSpacing: -0.5,
      textTransform: "uppercase",
    },
    field: { gap: 6 },
    label: {
      color: colors.colorMuted,
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    oauthRow: {
      flexDirection: "row",
      gap: 10,
    },
    /**
     * Disclosure trigger for the collapsed auth lanes. CHROME, so soft: a pill
     * with a hairline rather than a Swiss button. It must not read as the
     * primary action — the passkey CTA above it is.
     */
    otherWaysTrigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.borderColorSoft,
      backgroundColor: "transparent",
    },
    otherWaysLabel: {
      color: colors.colorMuted,
      fontSize: 11,
      letterSpacing: 1.5,
    },
    oauthCta: {
      flex: 1,
      backgroundColor: FIXED.googleBrand,
      borderWidth: 2,
      borderColor: FIXED.googleBrand,
      paddingVertical: 14,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      minHeight: 48,
    },
    // 19px/700 is load-bearing, not styling: white on the Google blue is
    // 3.56:1, which only clears WCAG at the large-text 3:1 floor — and that
    // floor needs >=14pt bold == 18.66px. At 14px this was a plain AA failure.
    // See `FIXED.onVendorBrand`.
    oauthCtaText: {
      color: FIXED.onVendorBrand,
      fontSize: 19,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    oauthCtaApple: {
      flex: 1,
      backgroundColor: FIXED.appleBrand,
      borderWidth: 2,
      borderColor: FIXED.appleBrand,
      paddingVertical: 14,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      minHeight: 48,
    },
    oauthCtaTextApple: {
      color: FIXED.onVendorBrand,
      fontSize: 19,
      fontWeight: "700",
      letterSpacing: 0.5,
    },
    oauthIcon: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    // NOTE: there is deliberately no `disabled`/opacity style here any more.
    // The vendor buttons are inert only for the sub-second handoff to the
    // browser, and dimming them put the white label at 1.86:1 on the Google
    // blue (2.36:1 on Ember) — below floor, on a fill we are contractually
    // barred from restyling. `disabled` on the Pressable still blocks the
    // double-tap; it just no longer costs legibility to say so.
    dividerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    dividerLine: {
      flex: 1,
      height: 2,
      backgroundColor: colors.borderColorSoft,
    },
    dividerText: {
      color: colors.colorMuted,
      fontSize: 11,
      letterSpacing: 1.5,
    },
    toggleText: {
      color: colors.colorMuted,
      fontSize: 11,
      letterSpacing: 1.5,
    },
    messageBox: {
      borderWidth: 1,
      borderColor: colors.borderColor,
      padding: 12,
    },
    errorBox: {
      borderWidth: 2,
      borderColor: colors.danger,
      padding: 12,
    },
    spinner: { alignItems: "center", marginTop: 4 },
    nameInput: {
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surfaceRaised,
      color: colors.color,
      paddingHorizontal: 16,
      paddingVertical: 0,
      fontSize: 16,
      height: 52,
    },
    helperText: {
      color: colors.colorMuted,
      fontSize: 11,
      letterSpacing: 0.5,
      marginTop: 6,
    },
    modeSwitchInline: {
      paddingVertical: 12,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
  });
