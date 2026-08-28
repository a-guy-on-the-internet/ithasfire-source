import { View } from "react-native";

// `Embers` legitimately stays on `@th/ui`: it takes an app-supplied
// `iconSource`, which is exactly why it must not move into the package.
import { Embers } from "@th/ui";
import { Text, useColors } from "@th/ui-native";

/**
 * Branded loading state — the animated `<Embers>` flame instead of a stock
 * spinner.
 *
 * ## Why this is app-local rather than in `@th/ui-native`
 *
 * It needs the app's OWN splash icon, and `require("../../assets/…")` is
 * meaningless from inside a package — the path would resolve relative to
 * `packages/ui-native/src`, where no such asset exists. The scanner's icon and
 * the consumer app's icon also differ, so there is no one asset to move.
 * `@th/ui`'s `Embers` already models this correctly by taking `iconSource`
 * from its caller; a package-level wrapper could only re-export that prop,
 * which buys nothing over each app owning these ~15 lines.
 *
 * ## When to use it
 *
 * For a **blocking** wait: the operator is parked on this surface with nothing
 * else to do (bootstrap, permission gate, loading the sell list, collecting a
 * card payment). It is deliberately NOT for small inline waits — inside a
 * button, or in a search-result row — where a 20px animated flame reads as
 * noise rather than progress. Keep `ActivityIndicator` there.
 *
 * `tint` is theme-derived because these render on a normal page surface, unlike
 * the splash (fixed black, so it uses `FIXED.splashTint`) and the scan-resolve
 * overlay (on the camera feed, so `FIXED.viewfinderStroke`).
 */
const SPLASH_ICON = require("../../assets/splash-icon.png");

export const LoadingState = ({
  size = 120,
  label,
  testID,
}: {
  size?: number;
  /** Optional caption. Announced to screen readers as the busy reason. */
  label?: string;
  testID?: string;
}) => {
  const colors = useColors();
  return (
    <View
      style={{ alignItems: "center", justifyContent: "center", gap: 12 }}
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? "Loading"}
      testID={testID}
    >
      <Embers size={size} tint={colors.color} iconSource={SPLASH_ICON} />
      {label ? (
        <Text variant="bodySmall" color={colors.colorMuted}>
          {label}
        </Text>
      ) : null}
    </View>
  );
};
