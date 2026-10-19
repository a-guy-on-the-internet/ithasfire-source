import type { ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react-native";
import { XStack, YStack } from "tamagui";

import type { BadgeTone } from "./badge-tone";
import { GeometricBackground } from "./geometric-background";
// One import surface for typography, package-internal too — the DS layer must
// not model an import shape it asks its consumers not to use (FR-009).
import { Text } from "./text";
import { useColors, useStyles } from "./theme";

/**
 * The scanner's primitive component set — Design System v2.
 *
 * This file replaces the former `primitives.tsx` *and* `unified-primitives.tsx`,
 * which had drifted into two parallel systems for the same jobs. Every screen
 * now draws from one set, and every colour resolves through `useColors()` /
 * `useStyles()` so both themes are covered without per-screen branching.
 *
 * See `./styles.ts` for the content-vs-chrome rule these components implement.
 */

const ICON_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/** Full-screen container with the themed canvas + geometric backdrop. */
export const ScreenSurface = ({
  children,
  testID,
  showBackdrop = true,
}: {
  children?: ReactNode;
  testID?: string;
  /** Disable the backdrop — for screens with full-bleed media (camera). */
  showBackdrop?: boolean;
}) => {
  const styles = useStyles();
  return (
    <View style={styles.screen} testID={testID}>
      {showBackdrop ? <GeometricBackground /> : null}
      {/*
        NetworkBanner is rendered once globally by `AppShell`. Don't double up
        here — the audit caught both layers stacking the banner offline.
      */}
      <YStack flex={1} padding="$4" gap="$4" zIndex={1}>
        {children}
      </YStack>
    </View>
  );
};

/** Bordered card — 2px Swiss border on a raised surface. */
export const Panel = ({ children }: { children?: ReactNode }) => {
  const styles = useStyles();
  return <View style={styles.card}>{children}</View>;
};

/** Header row with optional back button. */
export const TopBar = ({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
}) => {
  const colors = useColors();
  const styles = useStyles();
  return (
    <XStack alignItems="center" justifyContent="space-between" gap="$3">
      <XStack alignItems="center" gap="$3" flex={1}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            accessibilityHint="Returns to the previous screen."
            hitSlop={ICON_HIT_SLOP}
            onPress={onBack}
            style={styles.iconButton}
          >
            <ArrowLeft size={20} color={colors.color} />
          </Pressable>
        ) : null}
        <YStack flex={1}>
          <Text
            variant="h3"
            weight="bold"
            color={colors.color}
            textTransform="uppercase"
          >
            {title}
          </Text>
          {subtitle ? (
            <Text variant="bodySmall" color={colors.colorMuted}>
              {subtitle}
            </Text>
          ) : null}
        </YStack>
      </XStack>
    </XStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Buttons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Square, no-radius primary CTA. One per viewport (DS v2 non-negotiable).
 *
 * Press feedback inverts the fill (`ctaFill` ↔ `surface`) per the design spec —
 * no opacity-fade ripple. 52px min-height covers Fitts's-law / WCAG 2.5.8.
 *
 * The label colour is theme-derived and every rung is AA:
 *   - rest   `onCta` on `ctaFill`      — 5.61:1 Ember / 5.92:1 Stub
 *   - press  `accentText` on `surface` — 4.96:1 Ember / 5.68:1 Stub
 *   - inert  `colorMuted` on `surface` — 7.16:1 Ember / 7.14:1 Stub
 *
 * Two non-default states:
 *   - `locked` — primary action gated by role/permission (e.g. volunteer
 *     check-in for a non-OWNER/ADMIN/EDITOR). Keeps the orange border so the
 *     operator still recognises "this is THE primary action, currently locked"
 *     and mutes only the fill + text.
 *   - `disabled` — action not relevant in this context. Full muted surface.
 *
 * Why a custom Pressable rather than `@th/ui`'s `Button`: this control needs
 * (a) the `locked` treatment above and (b) hard colour inversion on press (no
 * Tamagui scale + opacity). Migrating would require adding a `locked` variant
 * there and disabling the default press scale — tracked as a follow-up. Inner
 * copy still renders through `@th/ui`'s `Text`, so the canonical Montserrat
 * font + weight tokens apply.
 */
export const SquarePrimaryButton = ({
  label,
  onPress,
  disabled = false,
  locked = false,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /**
   * Visual treatment for role-gated primary actions. Implies
   * `accessibilityState.disabled = true` and skips `onPress`.
   */
  locked?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) => {
  const colors = useColors();
  const styles = useStyles();
  const isInert = disabled || locked;
  return (
    <Pressable
      onPress={onPress}
      disabled={isInert}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && !isInert ? styles.primaryButtonPressed : null,
        // Locked precedes plain disabled so the orange border survives.
        locked
          ? styles.primaryButtonLocked
          : disabled
            ? styles.buttonDisabled
            : null,
      ]}
    >
      {({ pressed }) => (
        <Text
          variant="body"
          weight="bold"
          letterSpacing={1}
          textTransform="uppercase"
          color={
            isInert
              ? colors.colorMuted
              : pressed
                ? colors.accentText
                : colors.onCta
          }
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
};

/**
 * Square secondary button — neutral outlined, filling with `structure` on press.
 *
 * Contrast (both floors, both themes):
 *   - border `borderColor` on the canvas   — 3.81:1 Ember / 14.89:1 Stub (≥3 non-text)
 *   - label  `color` on the canvas          — 17.14:1 / 14.89:1
 *   - press  `onStructure` on `structure`   — 6.97:1 / 16.22:1
 *
 * This is deliberately neutral rather than accent-outlined: DS v2 allows one
 * primary button per viewport, so a second orange control would blur which
 * action is primary. Pass `listRow` when used as a tappable list row — bumps
 * min-height to 56px per the Ithas Fire lists rule.
 */
export const SquareSecondaryButton = ({
  label,
  onPress,
  disabled = false,
  listRow = false,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  listRow?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) => {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.secondaryButton,
        listRow ? styles.listRowButton : null,
        pressed && !disabled ? styles.secondaryButtonPressed : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      {({ pressed }) => (
        <Text
          variant="body"
          weight="bold"
          letterSpacing={1}
          textTransform="uppercase"
          color={
            disabled
              ? colors.colorMuted
              : pressed
                ? colors.onStructure
                : colors.color
          }
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// NOT here: LoadingState
// ─────────────────────────────────────────────────────────────────────────────
//
// The branded `<Embers>` loading state stays in each app rather than moving
// here, because it needs the app's OWN splash icon — the scanner's and the
// consumer app's differ, and an `require("../../assets/…")` is meaningless once
// the file lives in a package. `@th/ui`'s `Embers` already models this
// correctly by taking `iconSource: ImageSourcePropType` from its caller; a
// package-level wrapper would only be able to re-export that prop, which buys
// nothing over each app owning ~15 lines.
//
// See `apps/scanner/src/ui/loading-state.tsx`.

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Declared in `./badge-tone` — a LEAF module, so the drift guard can import the
 * vocabulary without dragging `tamagui` (and therefore `window.matchMedia`)
 * into a pure token comparison. Re-exported here for existing consumers.
 */
export { BADGE_TONES, type BadgeTone } from "./badge-tone";

const TONE_ICON: Record<BadgeTone, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  neutral: Info,
};

/**
 * Outlined status badge (uppercase, tracked) — colour + icon + text. Required
 * by the DS rule that status states must never be distinguished by colour
 * alone.
 *
 * The icon carries the tone and clears the 3:1 graphic floor on `surface` in
 * both themes (success 6.89/6.84, danger 4.17/6.21, warning-as-accent
 * 4.96/3.89). The LABEL stays `color` at full contrast rather than taking the
 * tone — a tinted label is where status badges usually lose their AA.
 */
export const StatusBadge = ({
  label,
  tone = "neutral",
  testID,
}: {
  label: string;
  tone?: BadgeTone;
  testID?: string;
}) => {
  const colors = useColors();
  const styles = useStyles();
  const Icon = TONE_ICON[tone];
  const toneColor: Record<BadgeTone, string> = {
    success: colors.success,
    warning: colors.accent,
    danger: colors.danger,
    neutral: colors.borderColor,
  };
  const toneStyle: Record<BadgeTone, object> = {
    success: styles.badgeSuccess,
    warning: styles.badgeWarning,
    danger: styles.badgeDanger,
    neutral: styles.badgeNeutral,
  };
  return (
    <View
      style={[styles.badge, toneStyle[tone]]}
      testID={testID}
      accessibilityLabel={label}
    >
      <Icon size={14} color={toneColor[tone]} aria-hidden />
      <Text
        variant="caption"
        weight="bold"
        letterSpacing={1}
        textTransform="uppercase"
        color={colors.color}
      >
        {label}
      </Text>
    </View>
  );
};

/**
 * Tone-aware card surface for results, errors, and informational states.
 *
 * `tone` adds a coloured border and pairs visually with a `<StatusBadge>` +
 * heading icon supplied by the caller (colour + icon + text). Defaults to a
 * plain bordered card.
 */
export const SquareCard = ({
  children,
  muted = false,
  tone,
  testID,
  accessibilityRole,
  accessibilityLiveRegion,
}: {
  children?: ReactNode;
  muted?: boolean;
  tone?: BadgeTone;
  testID?: string;
  accessibilityRole?: "alert" | "summary" | "none";
  accessibilityLiveRegion?: "none" | "polite" | "assertive";
}) => {
  const styles = useStyles();
  const toneStyle =
    tone === "success"
      ? styles.cardSuccess
      : tone === "warning"
        ? styles.cardWarning
        : tone === "danger"
          ? styles.cardDanger
          : null;
  return (
    <View
      style={[muted ? styles.cardMuted : styles.card, toneStyle]}
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLiveRegion={accessibilityLiveRegion}
    >
      {children}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

type BaseInputProps = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  testID?: string;
};

/** Email-optimized TextInput. */
export const EmailInput = ({
  value,
  onChangeText,
  placeholder,
  autoCapitalize = "none",
  testID,
}: BaseInputProps & {
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) => {
  const colors = useColors();
  const styles = useStyles();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      keyboardType="email-address"
      style={styles.input}
      placeholderTextColor={colors.placeholder}
      testID={testID}
    />
  );
};

/** Password TextInput. */
export const PasswordInput = ({
  value,
  onChangeText,
  placeholder,
  testID,
}: BaseInputProps) => {
  const colors = useColors();
  const styles = useStyles();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry
      style={styles.input}
      placeholderTextColor={colors.placeholder}
      testID={testID}
    />
  );
};

/** Plain single-line TextInput. */
export const FieldInput = ({
  value,
  onChangeText,
  placeholder,
  testID,
}: BaseInputProps) => {
  const colors = useColors();
  const styles = useStyles();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      style={styles.input}
      placeholderTextColor={colors.placeholder}
      testID={testID}
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Composite
// ─────────────────────────────────────────────────────────────────────────────

/** Large tap target with icon + title + description for mode selection. */
export const ModeCard = ({
  title,
  description,
  icon,
  onPress,
  testID,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  onPress: () => void;
  testID?: string;
}) => {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={styles.modeCard}
      testID={testID}
    >
      <XStack gap="$3" alignItems="center">
        <View style={styles.modeIcon}>{icon}</View>
        <YStack flex={1} gap="$1">
          <Text variant="h4" weight="bold" color={colors.color}>
            {title}
          </Text>
          <Text variant="bodySmall" color={colors.colorMuted}>
            {description}
          </Text>
        </YStack>
      </XStack>
    </Pressable>
  );
};
