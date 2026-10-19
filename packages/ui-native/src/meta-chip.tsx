import { StyleSheet, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";

import { Text } from "./text";
import { useColors } from "./theme";
import { toneColors, type VerdictTone } from "./tone";

/**
 * The two — and only two — chip styles allowed on a tone fill.
 *
 *   - `outlined` (resting): transparent plate, 1px `on<Tone>` border + label.
 *   - `inverted` (emphasis): solid `on<Tone>` plate, tone-coloured label.
 *
 * Because the inverted pair is just the tone pair reversed, its contrast is
 * IDENTICAL to the outlined one — PASS 7.98 Ember / 7.87 Stub, FAIL 5.92 in
 * both. Two styles, zero alphas. Do not invent a third: every "just a slightly
 * softer chip" is an alpha, and an alpha-muted foreground on a tone fill is
 * how you get 3.34:1 without noticing.
 *
 * `on="surface"` renders the chip on a normal themed surface instead (the
 * stats-strip chips), where the caller supplies the tint/label colours.
 *
 * Design: the Ithas Fire Design System, `components/tickets/ScanResult.jsx`.
 */
export const MetaChip = ({
  label,
  glyph: Glyph,
  variant = "outlined",
  on,
  surfaceLabelColor,
  surfacePlateColor,
  accessibilityLabel,
  testID,
}: {
  label: string;
  glyph?: LucideIcon;
  variant?: "outlined" | "inverted";
  /** The surface this chip paints ON — a tone fill, or a themed surface. */
  on: VerdictTone | "surface";
  /** Label + border colour when `on="surface"`. Defaults to `colorMuted`. */
  surfaceLabelColor?: string;
  /** Optional plate fill when `on="surface"` (e.g. `dangerTint`). */
  surfacePlateColor?: string;
  /**
   * Screen-reader sentence. The chip's visual string is a telegram
   * (`OFFLINE · 7 MIN OLD`); the announcement should be a sentence.
   */
  accessibilityLabel?: string;
  testID?: string;
}) => {
  const colors = useColors();

  const { plate, ink, border } =
    on === "surface"
      ? {
          plate: surfacePlateColor ?? "transparent",
          ink: surfaceLabelColor ?? colors.colorMuted,
          border: surfaceLabelColor ?? colors.colorMuted,
        }
      : (() => {
          const tone = toneColors(colors, on);
          return variant === "inverted"
            ? { plate: tone.on, ink: tone.fill, border: tone.on }
            : { plate: "transparent", ink: tone.on, border: tone.on };
        })();

  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: plate, borderColor: border },
        variant === "inverted" ? styles.chipInverted : null,
      ]}
      accessible
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
    >
      {Glyph ? <Glyph size={14} color={ink} aria-hidden /> : null}
      <Text
        variant="caption"
        weight="bold"
        letterSpacing={1.5}
        textTransform="uppercase"
        color={ink}
      >
        {label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    // DS v2: content is strict Swiss. No radius, ever.
    borderRadius: 0,
    borderWidth: 1,
  },
  chipInverted: {
    borderWidth: 0,
    // Restore the border box so outlined and inverted chips are the same
    // height side by side.
    paddingVertical: 5,
    paddingHorizontal: 9,
  },
});
