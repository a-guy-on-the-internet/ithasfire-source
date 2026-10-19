import { Pressable, StyleSheet } from "react-native";
import { Volume2, VolumeX } from "lucide-react-native";

import { useColors, useThemedSheet, type NativePalette } from "@th/ui-native";

/**
 * "Sound & haptics" — the rail control door staff flip in the moment.
 *
 * Deliberately a twin of `TorchButton`: same 52×52 geometry so the rail keeps
 * ONE button height, same icon-only treatment (a label on an `accentSoft`
 * plate fails 4.5:1 on Ember; a glyph on plain `surface` clears 3:1 on both
 * themes), same `switch` role so a screen reader announces the state. The
 * whole square is the hit area — comfortably over the 44pt floor with no
 * `hitSlop`.
 *
 * ON is the accent-bordered speaker; OFF is the muted crossed speaker. The
 * glyph carries the state on its own because the rail sits under the verdict
 * block and an operator glancing down must read it without a label.
 */
export const ScanFeedbackButton = ({
  enabled,
  onToggle,
  testID,
}: {
  enabled: boolean;
  onToggle: () => void;
  testID?: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Sound & haptics"
      accessibilityHint="Plays a tone and a vibration for each scan result."
      accessibilityState={{ checked: enabled }}
      onPress={onToggle}
      style={[styles.button, enabled ? styles.buttonOn : null]}
      testID={testID}
    >
      {enabled ? (
        <Volume2 size={20} color={colors.accentText} />
      ) : (
        <VolumeX size={20} color={colors.colorMuted} />
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
      borderRadius: 0,
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surface,
    },
    buttonOn: {
      borderColor: colors.accentText,
    },
  });
