/**
 * Native stub for Switch.
 *
 * The web Switch uses raw HTML <button> and <span> which are not available
 * on React Native. On native, use React Native's built-in Switch component.
 *
 * This stub wraps RN's Switch with the same props interface.
 */
import { useId } from "react";
import { Switch as RNSwitch } from "react-native";
import { Label, XStack, styled, useTheme } from "tamagui";

import { stubTheme } from "../../tokens/colors";
import type { SwitchProps } from "./Switch";

export type { SwitchProps } from "./Switch";

const SwitchRow = styled(XStack, {
  name: "THSwitchRow",
  alignItems: "center",
  // Integers only ($0–$8); see the same note in Switch.tsx. A fractional token
  // renders as 0 gap, and it fails silently.
  gap: "$3",
});

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  saving = false,
  label,
  "aria-label": ariaLabel,
  id: idProp,
  testId,
}: SwitchProps) {
  const autoId = useId();
  const theme = useTheme();
  const switchId = idProp ?? testId ?? autoId;
  const isDisabled = disabled || saving;

  // Native can't read CSS vars, so resolve through the theme (Stub values as
  // the fallback — Stub is the shipped default). Mirrors the web Switch: the
  // thumb inverts against its track rather than being white in both states,
  // which is invisible on Stub's cream `surfaceMuted` off-track.
  const offTrack = theme.surfaceMuted?.val ?? stubTheme.surfaceMuted;
  const onTrack = theme.brandSecondary?.val ?? stubTheme.brandSecondary;
  const thumb = checked
    ? (theme.onBrandSecondary?.val ?? stubTheme.onBrandSecondary)
    : (theme.color?.val ?? stubTheme.color);

  const switchEl = (
    <RNSwitch
      value={checked}
      onValueChange={onCheckedChange}
      disabled={isDisabled}
      trackColor={{ false: offTrack, true: onTrack }}
      thumbColor={thumb}
      accessibilityLabel={ariaLabel ?? label}
      testID={testId ? `${testId}-track` : undefined}
      style={{ opacity: saving ? 0.55 : isDisabled ? 0.5 : 1 }}
    />
  );

  if (!label) return switchEl;

  return (
    <SwitchRow>
      {switchEl}
      <Label
        nativeID={switchId}
        fontFamily="$body"
        fontSize="$3"
        color="$color"
        opacity={isDisabled ? 0.55 : 1}
      >
        {label}
      </Label>
    </SwitchRow>
  );
}
