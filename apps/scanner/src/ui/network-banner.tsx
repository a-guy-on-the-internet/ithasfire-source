import { View } from "react-native";
import { CloudOff, WifiOff } from "lucide-react-native";

import { useNetworkState } from "../features/network/use-network-state";
import { Text, useColors, useStyles } from "@th/ui-native";

/**
 * Global connectivity banner for the scanner shell.
 *
 * Renders nothing when the device is online so operators only see chrome when
 * there's something they need to act on (per scanner-foundation FR-010).
 *
 * ## Retokened for v2
 *
 * This previously hardcoded a pair of Tailwind-ish cream/pink chips
 * (`#fef3c7` / `#fee2e2` with `#78350f` / `#7f1d1d` copy) and shipped them
 * into a navy app — light-on-light islands that belonged to no theme. It now
 * uses the same outlined-tone pattern as `StatusBadge` and `SquareCard`: a
 * theme `surface` fill, a 4px tone rule on the leading edge, and tone-coloured
 * copy at the `*Soft` rung that is AA as TEXT (danger 5.68:1 Ember / 6.21:1
 * Stub; support 9.41:1 / 6.80:1 on `surface`).
 *
 * The icon is not decoration: per the DS rule, status must be conveyed by
 * colour AND icon AND text, and this banner is the one piece of chrome an
 * operator may need to read at a glance across a dark room.
 */
export const NetworkBanner = () => {
  const state = useNetworkState();
  const colors = useColors();
  const styles = useStyles();

  if (state === "online") {
    return null;
  }

  const copy =
    state === "degraded"
      ? {
          label: "Limited connectivity — scans may be slow.",
          tone: colors.warningSoft,
          toneStyle: styles.bannerSupport,
          Icon: CloudOff,
        }
      : {
          label: "Offline — scans will fail until connectivity returns.",
          tone: colors.dangerSoft,
          toneStyle: styles.bannerDanger,
          Icon: WifiOff,
        };

  return (
    <View
      style={[styles.banner, copy.toneStyle]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <copy.Icon size={16} color={copy.tone} aria-hidden />
      <Text variant="bodySmall" weight="bold" color={copy.tone} flex={1}>
        {copy.label}
      </Text>
    </View>
  );
};
