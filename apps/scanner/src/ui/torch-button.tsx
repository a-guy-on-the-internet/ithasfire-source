import { Pressable, StyleSheet } from "react-native";
import { Flashlight, FlashlightOff } from "lucide-react-native";

import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

/**
 * Torch (flashlight) toggle — now a RAIL control, not a camera overlay.
 *
 * ## Why it is themed now (a deliberate deviation from FR-007)
 *
 * FR-007 says "torch keeps its FIXED camera-chrome colours". Do not do that
 * any more. The `FIXED` values exist because this button painted on the
 * *camera feed*, which is black in Stub exactly as in Ember. The palette's own
 * rule is that a literal is judged "by the SURFACE IT PAINTS ON, never by the
 * theme it happens to sit inside" — and after FR-007 moves it into the bottom
 * rail it paints on `surface`: warm paper on Stub. Keeping `FIXED` there would
 * be judging it by its history, which is precisely the bug class the rule was
 * written to prevent.
 *
 * ## Why it is icon-only, and why that is load-bearing
 *
 * The first draft put the ON state on an `accentSoft` plate with a label.
 * `accentText` on `accentSoft` measures **4.05:1** on Ember — fine for a glyph
 * (3:1 floor), a FAIL for a label (4.5:1). Dropping the plate and the label
 * puts both channels comfortably clear on plain `surface` (4.96 Ember / 5.68
 * Stub). Accessibility is unaffected: the switch role, checked state and label
 * carry it.
 *
 * Geometry matches the keypad button exactly (52×52) so the rail has one
 * button height; the whole square is the hit area, so no `hitSlop` is needed.
 */
export const TorchButton = ({
  enabled,
  onToggle,
  accessibilityLabel = "Flashlight",
  testID,
}: {
  enabled: boolean;
  onToggle: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: enabled }}
      onPress={onToggle}
      style={[styles.button, enabled ? styles.buttonOn : null]}
      testID={testID}
    >
      {enabled ? (
        <Flashlight size={20} color={colors.accentText} />
      ) : (
        <FlashlightOff size={20} color={colors.colorMuted} />
      )}
    </Pressable>
  );
};

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    button: {
      width: 52,
      // minHeight, not height: the rail row is `alignItems: "stretch"` and its
      // keypad/Search neighbours resolve to 56pt, so a fixed 52 left this square
      // 4pt short at the bottom edge (measured on the iOS simulator, 2026-08-26).
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      // Content, not floating chrome, now that it lives in the rail: strict
      // Swiss radius 0 and a 2px structural border.
      borderRadius: 0,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
    },
    buttonOn: {
      borderColor: colors.accentText,
    },
  });
