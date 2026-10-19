import React from "react";
import { XStack, styled, useTheme } from "tamagui";
import { Upload, Link2 } from "lucide-react";
import { Text } from "../typography";

export type UploadMode = "file" | "url";

export interface UploadModeToggleProps {
  /** Current active mode. */
  mode: UploadMode;
  /** Called when the user taps the other segment. */
  onChange: (mode: UploadMode) => void;
  /** Label for the "file" segment.  Defaults to "Upload File". */
  fileLabel?: string;
  /** Label for the "url" segment.  Defaults to "Image URL". */
  urlLabel?: string;
  "data-testid"?: string;
}

const Root = styled(XStack, {
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  overflow: "hidden",
});

const Segment = styled(XStack, {
  flex: 1,
  paddingVertical: 8,
  justifyContent: "center",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
});

export const UploadModeToggle: React.FC<UploadModeToggleProps> = ({
  mode,
  onChange,
  fileLabel = "Upload File",
  urlLabel = "Image URL",
  ...rest
}) => {
  const theme = useTheme();
  return (
    <Root {...rest}>
      {/* Selected = the v2 "chip.on" wash: `$accentSoft` (a ~10% orange tint) + an ink label + an
          accent icon — NOT a full `$accent` fill. The full-fill selected toggle was retired in
          dfd8185b because its label (white on #E2481D = 4.06:1, or ink 4.38:1) failed AA; on the
          wash, the ink label is ~15:1 and the accent icon ≥3:1. Same treatment as SegmentedControl.
          (Kept as its own component rather than migrated because SegmentedControl has no per-option
          icon yet — a future dedupe.) */}
      <Segment
        backgroundColor={mode === "file" ? "$accentSoft" : "$surface"}
        onPress={() => onChange("file")}
        hoverStyle={{
          backgroundColor: mode === "file" ? "$accentSoft" : "$surfaceMuted",
        }}
      >
        <Upload
          size={14}
          color={mode === "file" ? theme.accent?.val : theme.color?.val}
        />
        <Text variant="bodySmall" weight="bold" color="$color">
          {fileLabel}
        </Text>
      </Segment>
      <XStack width={1} backgroundColor="$borderColorStrong" />
      <Segment
        backgroundColor={mode === "url" ? "$accentSoft" : "$surface"}
        onPress={() => onChange("url")}
        hoverStyle={{
          backgroundColor: mode === "url" ? "$accentSoft" : "$surfaceMuted",
        }}
      >
        <Link2
          size={14}
          color={mode === "url" ? theme.accent?.val : theme.color?.val}
        />
        <Text variant="bodySmall" weight="bold" color="$color">
          {urlLabel}
        </Text>
      </Segment>
    </Root>
  );
};

UploadModeToggle.displayName = "UploadModeToggle";
