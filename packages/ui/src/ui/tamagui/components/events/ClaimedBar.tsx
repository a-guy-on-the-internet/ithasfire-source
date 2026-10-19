import { memo } from "react";
import { Platform } from "react-native";
import { XStack, styled, type GetProps } from "tamagui";

import { ProgressBar } from "../feedback/ProgressBar";
import { Text } from "../typography/Text";

/**
 * ClaimedBar — Design System v2 molecule (promoted "claimed bar" atom).
 *
 * Social proof and urgency in 5px: uppercase tracked 600 "NN% claimed" label
 * (tabular digits) leading
 * a 1px-bordered 5px track. Fill is accent below the hot threshold (80%) and
 * flips to the amber support fill at/above it.
 *
 * Rules (v2 section 04): label always leads · never rendered at 0% (returns
 * null) · never animated on scroll — the only motion is the width transition
 * on value change (filter changes), which the generic ProgressBar provides.
 */
const ClaimedBarFrame = styled(XStack, {
  name: "ClaimedBar",
  alignItems: "center",
  gap: "$3",
  width: "100%",
});

export const CLAIMED_BAR_HOT_THRESHOLD = 80;

export interface ClaimedBarProps extends Omit<
  GetProps<typeof ClaimedBarFrame>,
  "children"
> {
  /** Percent claimed, 0–100. Values ≤ 0 render nothing (v2 rule). */
  percent: number;
  /**
   * Visible label. Defaults to "NN% claimed" — pass the localized string
   * when the surface has i18n (no shared catalog key exists yet).
   */
  label?: string;
  testId?: string;
  qaId?: string;
}

const isWeb = Platform.OS === "web";

const clampPercent = (value: number) => {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
};

export const ClaimedBar = memo<ClaimedBarProps>(
  ({ percent, label, testId, qaId, ...rest }) => {
    const clamped = clampPercent(percent);

    // v2: a claimed bar is never shown at 0% — no signal, no bar. Gate at the
    // label's rounding granularity so a fractional 0.4% never renders a bar
    // captioned "0% claimed" (anti-social-proof).
    if (Math.round(clamped) <= 0) {
      return null;
    }

    const hot = clamped >= CLAIMED_BAR_HOT_THRESHOLD;
    const resolvedLabel = label ?? `${Math.round(clamped)}% claimed`;
    const resolvedTestId = testId ?? "claimed-bar";

    return (
      <ClaimedBarFrame
        {...(isWeb
          ? { "data-testid": resolvedTestId, ...(qaId ? { "data-qa": qaId } : {}) }
          : { testID: resolvedTestId })}
        {...rest}
      >
        {/* v2 .claimed .pct — 600 / 9.5px / +1.5 tracking / uppercase /
            muted; tabular digits so the percent doesn't jitter as it ticks */}
        <Text
          variant="span"
          weight="semibold"
          fontSize={9.5}
          lineHeight={12}
          letterSpacing={1.5}
          textTransform="uppercase"
          tone="muted"
          minWidth={82}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {resolvedLabel}
        </Text>
        <ProgressBar
          flex={1}
          value={clamped}
          min={0}
          max={100}
          height={5}
          borderWidth={1}
          borderColor="$borderColorSoft"
          trackColor="$surfaceRaised"
          fillColor={hot ? "$support" : "$accent"}
          testID={`${resolvedTestId}-track`}
          qaId={`${resolvedTestId}-track`}
        />
      </ClaimedBarFrame>
    );
  },
);

ClaimedBar.displayName = "ClaimedBar";
