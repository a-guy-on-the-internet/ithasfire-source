import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  GeometricBackground,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

/**
 * Mobile-only primitives.
 *
 * Everything shared with `apps/scanner` now lives in `@th/ui-native`
 * (`ScreenSurface`'s sibling set: `Panel`, `TopBar`, `SquarePrimaryButton`,
 * `SquareSecondaryButton`, `StatusBadge`, `SquareCard`, the inputs,
 * `ModeCard`, `GeometricBackground`). This file keeps ONLY the three things
 * the package deliberately does not ship:
 *
 *   1. `ScreenSurface` — the package's version wraps children in a padded,
 *      gapped `YStack`, which is right for the scanner's card-stack screens
 *      but wrong here: every consumer screen owns its own insets and hosts a
 *      full-bleed `FlatList` (Discover, Tickets, Profile) that must reach the
 *      screen edge. Mobile's variant is the same canvas + backdrop with no
 *      layout opinion. Same name, same props — only the padding differs.
 *   2. `SectionNum` / `ScreenHeading` — the consumer app's `00. OVERVIEW`
 *      section lockup. The scanner has no equivalent, so it stays local until
 *      a second surface needs it.
 *   3. `SquareDangerButton` — destructive CTA (sign out). The package
 *      deliberately ships only primary/secondary, since DS v2 allows one
 *      primary per viewport and the scanner has no destructive action.
 *
 * `Panel` and `TopBar` were dropped outright: both were unused here and both
 * exist in the package.
 */

/**
 * Full-screen container: themed canvas + the shared geometric backdrop.
 *
 * Pass `showBackdrop={false}` for screens with full-bleed media (none today,
 * kept for parity with the package's signature).
 */
export const ScreenSurface = ({
  children,
  testID,
  showBackdrop = true,
}: {
  children?: ReactNode;
  testID?: string;
  showBackdrop?: boolean;
}) => {
  const styles = useStyles();
  return (
    <View style={styles.screen} testID={testID}>
      {showBackdrop ? <GeometricBackground /> : null}
      <View style={geometry.body}>{children}</View>
    </View>
  );
};

/**
 * Section number prefix — accent digit + trailing label, matching the web
 * admin dashboard's `00. overview` pattern.
 *
 * The label takes `accentText`, not `accent`: this is copy, and Stub's raw
 * accent (#E2481D) measures 3.57:1 on the cream canvas. `accentText` deepens
 * to #B93312 (5.22:1) on Stub and stays #FF5721 (5.42:1) on Ember.
 */
export const SectionNum = ({
  index,
  label,
}: {
  /** Two-digit zero-padded number, e.g. "00", "01". Formatting is the
   *  caller's, so pass it as a string. */
  index: string;
  label: string;
}) => {
  const colors = useColors();
  return (
    <Text style={[geometry.sectionNum, { color: colors.accentText }]}>
      {index}. {label.toUpperCase()}
    </Text>
  );
};

/** In-screen title — uppercase, tightly tracked, full-contrast `color`. */
export const ScreenHeading = ({ children }: { children: string }) => {
  const colors = useColors();
  return (
    <Text style={[geometry.screenHeading, { color: colors.color }]}>
      {children}
    </Text>
  );
};

/**
 * Square destructive button — outlined at rest, filling with `danger` on press.
 *
 * Contrast, both themes:
 *   - border `danger` on the canvas         — 4.94:1 Ember / 6.16:1 Stub (≥3 non-text)
 *   - label  `dangerSoft` on the canvas     — 5.71:1 Ember / 6.16:1 Stub
 *   - press  `colorInverted` on `danger`    — 5.58:1 Ember / 6.96:1 Stub
 *
 * That last rung is why the pressed label is `colorInverted` rather than a
 * fixed white: no single foreground clears AA on both themes' danger fills
 * (white is 3.76:1 on Ember's #EF4444, ink is 2.93:1 on Stub's #B91C1C). The
 * theme-aware inverted ink is AA on both.
 */
export const SquareDangerButton = ({
  label,
  onPress,
  disabled = false,
  testID,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityHint?: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeDangerSheet);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.button,
        pressed && !disabled ? styles.buttonPressed : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      {({ pressed }) => (
        <Text
          style={[
            geometry.buttonLabel,
            {
              color: disabled
                ? colors.colorMuted
                : pressed
                  ? colors.colorInverted
                  : colors.dangerSoft,
            },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
};

const makeDangerSheet = (c: NativePalette) =>
  StyleSheet.create({
    button: {
      minHeight: 52,
      minWidth: 44,
      paddingHorizontal: 24,
      paddingVertical: 14,
      backgroundColor: c.background,
      borderWidth: 2,
      borderColor: c.danger,
      borderRadius: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonPressed: {
      backgroundColor: c.danger,
      borderColor: c.danger,
    },
    buttonDisabled: {
      backgroundColor: c.surfaceMuted,
      borderColor: c.borderColorSoft,
    },
  });

/** Colourless geometry — safe at module scope, shared by both themes. */
const geometry = StyleSheet.create({
  body: {
    flex: 1,
    zIndex: 1,
  },
  sectionNum: {
    fontFamily: "Montserrat-SemiBold",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.8,
    textTransform: "uppercase",
  },
  screenHeading: {
    fontFamily: "Montserrat-SemiBold",
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: -1,
    textTransform: "uppercase",
    lineHeight: 32,
  },
  buttonLabel: {
    fontFamily: "Montserrat-SemiBold",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
