import { Platform } from "react-native";
import type { ComponentProps } from "react";
import { XStack, YStack } from "tamagui";

import { Text, type TextVariant } from "../typography/Text";
import { PasswordInput, type PasswordInputProps } from "./PasswordInput";

export type LabeledPasswordInputProps = PasswordInputProps & {
  /** Label text displayed above (or beside) the input. */
  label: string;
  /**
   * Layout rule for the label + control.
   * - "above" (default): label stacked above the input.
   * - "beside": label to the left, input to the right.
   */
  labelPlacement?: "above" | "beside";
  /**
   * Type variant for the label.
   *
   * Mirrors `LabeledTextInput.labelVariant` prop-for-prop, and exists because
   * the two were NOT mirrors: `LabeledTextInput` gained the variant in the
   * auth rebuild while this component kept only the hand-rolled
   * `caption` + bold + 1.2px-tracking label. A form that used both therefore
   * rendered two different label idioms on adjacent fields — a mono `overline`
   * above the email box and a sans caption above the password box.
   *
   * Defaults to `undefined`, which keeps the historical appearance every other
   * form in the product renders today. Passing a variant swaps it in WHOLE and
   * drops the hand-rolled overrides: `overline` already carries its own size,
   * tracking and weight, and layering the old overrides on top would
   * half-apply the idiom.
   *
   * Strictly additive on purpose.
   */
  labelVariant?: TextVariant;
  /** Optional helper text beneath the input. */
  helperText?: string;
  /** Props for the layout container (YStack/XStack). */
  containerProps?: ComponentProps<typeof YStack>;
  /**
   * Web-only test id applied to the underlying input.
   *
   * By default this attaches to the *input* so migrating from
   * `<LabeledTextInput testId="..." />` to `<LabeledPasswordInput testId="..." />`
   * keeps selectors stable.
   */
  testId?: string;
};

const isWeb = Platform.OS === "web";

const buildDataTestIdProps = (id?: string) =>
  isWeb && id ? { "data-testid": id } : {};

/**
 * A `LabeledTextInput`-shaped wrapper around `PasswordInput`.
 *
 * Drop-in replacement for the old "absolutely-positioned toggle over a
 * `LabeledTextInput`" pattern — here the toggle lives in the input's right
 * padding, so it can never float on top of the text. (The standalone
 * `PasswordToggle` module that pattern used was deleted in the 2026-09 auth
 * redesign; it had no consumers left.)
 */
export const LabeledPasswordInput = ({
  label,
  labelPlacement = "above",
  labelVariant,
  helperText,
  containerProps,
  testId,
  id,
  name,
  ...inputProps
}: LabeledPasswordInputProps) => {
  const resolvedId = id ?? name;

  const Wrapper = labelPlacement === "beside" ? XStack : YStack;

  // Mirrors `LabeledTextInput`: the helper text is wired to the input via
  // `aria-describedby` and announces itself in the error state, so a screen
  // reader gets the REASON the field is invalid and not just the fact.
  // `PasswordInput`'s own `aria-describedby` lives on the eye TOGGLE (it
  // points at the visible/hidden live region), so the two never collide.
  // Derived from `resolvedId`, not `useId` — see the matching note in
  // `labeledtextinput.tsx`: a hook here would force this pass-through wrapper
  // to become a `"use client"` RSC boundary.
  const helperId = resolvedId ? `${resolvedId}-helper-text` : undefined;
  const callerDescribedBy = (
    inputProps as { "aria-describedby"?: string }
  )["aria-describedby"];
  const describedBy =
    [callerDescribedBy, helperText ? helperId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  const labelContent = labelVariant ? (
    <Text variant={labelVariant} color="$colorMuted">
      {label}
    </Text>
  ) : (
    <Text
      variant="caption"
      weight="bold"
      color="$colorMuted"
      letterSpacing={1.2}
      style={{ fontSize: 11 }}
    >
      {label}
    </Text>
  );

  const renderedLabel =
    isWeb && resolvedId ? (
      <label htmlFor={resolvedId} style={{ display: "contents" }}>
        {labelContent}
      </label>
    ) : (
      labelContent
    );

  return (
    <Wrapper
      gap="$2"
      alignItems={labelPlacement === "beside" ? "center" : undefined}
      {...containerProps}
    >
      {renderedLabel}

      <PasswordInput
        {...inputProps}
        aria-describedby={describedBy}
        id={resolvedId}
        name={name}
        fullWidth
        testId={testId}
      />

      {helperText ? (
        <Text
          id={helperId}
          variant="bodySmall"
          tone={inputProps.status === "error" ? "error" : "muted"}
          role={inputProps.status === "error" ? "alert" : undefined}
          // Explicit positioning so the PasswordInput's absolutely-positioned
          // eye toggle (zIndex 2 over the input) can't visually overlap the
          // helper text on viewports where the YStack gap collapses.
          style={{ position: "relative", zIndex: 0, paddingRight: 52 }}
        >
          {helperText}
        </Text>
      ) : null}
    </Wrapper>
  );
};

LabeledPasswordInput.displayName = "LabeledPasswordInput";
