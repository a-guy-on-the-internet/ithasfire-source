import { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { AlertTriangle, Users, WifiOff, Zap } from "lucide-react-native";

import { MetaChip } from "./meta-chip";
import { Text } from "./text";
import { useColors } from "./theme";
import {
  capacityBand,
  planStatsStrip,
  type CapacityBand,
} from "./stats-strip-plan";

/**
 * FR-005 — the persistent scan-screen stats strip.
 *
 * One line, 44pt + a hairline rule. It stays visible UNDER the full-bleed
 * result state: the count is the one number an operator is asked for mid-shift,
 * and hiding it behind a verdict means they cannot answer without dismissing.
 *
 * ## Why 44 and not the design's 36
 *
 * The WHOLE strip is the tap target (it opens the counter detail), so 36pt is
 * a sub-minimum control, not a compact readout. The two alternatives both
 * fail here: `hitSlop` would extend the target UP into the TopBar and DOWN
 * into the scan region — where the full-bleed result state is itself
 * tap-to-dismiss, so a near-miss on the counter would dismiss a verdict — and
 * a discrete 44pt affordance cannot fit inside a 36pt row without overflowing
 * it. The 8pt is bought back in the verdict block (the status badge folds
 * beside the ticket type, and the below-fold hint moved out of the padded
 * verdict stack).
 *
 * ## Capacity colours mirror Home — with two deliberate deviations
 *
 * The app already teaches 90%/100% = amber/red on Home. Inventing a second,
 * neutral capacity language on the surface where the operator actually stands
 * would mean two vocabularies for one fact. So: mirror it, except
 *
 *   1. **No pulse.** Home pulses its capacity glyph. Here a looping animation
 *      would sit centimetres from the result states whose entire job is to be
 *      the thing that changed, and compete with them. Static tint only — which
 *      also removes a reduced-motion branch from this surface entirely.
 *   2. **`warningSoft`, not `support`, for the 90% rule.** `support` (#F59E0B)
 *      on Stub `surface` measures **2.06:1** and fails the 3:1 graphic floor.
 *      `warningSoft` is 6.80 Stub / 9.41 Ember. The rule is: **`support` is a
 *      FILL (it carries `onSupport`), `warningSoft` is a rule/glyph/label.**
 *
 * ## Announcements
 *
 * The design asks for `accessibilityLiveRegion="polite"` AND "announce only on
 * state changes". Those conflict on Android: the count refreshes on the
 * existing 5s interval, and a polite live region re-announces the whole strip
 * every tick, which makes it unusable with TalkBack on. The stated INTENT wins
 * — this component announces explicitly on capacity-band flips, connectivity
 * flips and failed-count increases, and leaves the container out of the live
 * region.
 *
 * Design: docs/records/2026-08-04-scan-screen-design.md §4.
 */
export const StatsStrip = ({
  scanned,
  total,
  offline,
  queueDepth,
  failedCount = 0,
  expressEnabled = false,
  onPress,
  testID,
}: {
  scanned: number;
  total: number;
  offline: boolean;
  queueDepth: number;
  /** FR-010, wired in build step 4. */
  failedCount?: number;
  /** FR-004, wired in build step 4. */
  expressEnabled?: boolean;
  onPress?: () => void;
  testID?: string;
}) => {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const band = capacityBand(scanned, total);

  const plan = planStatsStrip({
    width,
    scanned,
    total,
    band,
    offline,
    queueDepth,
    failedCount,
    expressEnabled,
  });

  const label = [
    `${plan.counter.word} ${scanned} of ${total} admitted`,
    offline ? "Offline" : null,
    queueDepth > 0 ? `${queueDepth} scans queued` : null,
    failedCount > 0 ? `${failedCount} scans failed to sync` : null,
  ]
    .filter(Boolean)
    .join(". ");

  // Announce only on the flips that matter (see the docblock).
  const prev = useRef({ band, offline, failedCount });
  useEffect(() => {
    const before = prev.current;
    const changed =
      before.band !== band ||
      before.offline !== offline ||
      failedCount > before.failedCount;
    prev.current = { band, offline, failedCount };
    if (changed) AccessibilityInfo.announceForAccessibility(label);
  }, [band, offline, failedCount, label]);

  const ruleColor: Record<CapacityBand, string> = {
    normal: colors.borderColorSoft,
    // The contrast fix. NOT `support` — see the docblock.
    near: colors.warningSoft,
    at: colors.danger,
  };
  const tintColor: Record<CapacityBand, string | undefined> = {
    normal: undefined,
    near: colors.supportTint,
    at: colors.dangerTint,
  };

  const body = (
    <View
      style={[
        styles.strip,
        {
          backgroundColor: colors.surface,
          borderBottomColor: ruleColor[band],
          borderBottomWidth: band === "normal" ? StyleSheet.hairlineWidth : 2,
        },
      ]}
    >
      {/* Capacity tint sits OVER `surface`, matching Home's counter card. */}
      {tintColor[band] ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: tintColor[band] },
          ]}
          pointerEvents="none"
        />
      ) : null}

      <View style={styles.counter}>
        {plan.counter.showWord ? null : (
          <Users size={12} color={colors.colorMuted} aria-hidden />
        )}
        <Text
          variant="caption"
          weight="bold"
          letterSpacing={1.5}
          color={colors.color}
          numberOfLines={1}
          ellipsizeMode="tail"
          style={styles.counterText}
          testID="stats-strip-counter"
        >
          {plan.counter.showWord
            ? `${plan.counter.word} ${plan.counter.value}`
            : plan.counter.value}
        </Text>
      </View>

      {plan.showExpress ? (
        <Zap
          size={12}
          color={colors.accentText}
          accessibilityLabel="Express mode on"
        />
      ) : null}

      {plan.chips.map((chip) =>
        chip.id === "failed" ? (
          <MetaChip
            key="failed"
            on="surface"
            glyph={AlertTriangle}
            surfaceLabelColor={colors.dangerSoft}
            surfacePlateColor={colors.dangerTint}
            label={chip.label ? `${chip.count} ${chip.label}` : `${chip.count}`}
            accessibilityLabel={`${chip.count} scans failed to sync`}
            testID="stats-strip-failed-chip"
          />
        ) : (
          <MetaChip
            key="sync"
            on="surface"
            glyph={WifiOff}
            surfaceLabelColor={colors.accentText}
            surfacePlateColor={colors.accentTint}
            label={
              chip.label
                ? chip.count > 0
                  ? `${chip.label} ${chip.count}`
                  : chip.label
                : `${chip.count}`
            }
            accessibilityLabel={
              offline
                ? `Offline. ${queueDepth} scans queued.`
                : `${queueDepth} scans queued`
            }
            testID="stats-strip-sync-chip"
          />
        ),
      )}
    </View>
  );

  if (!onPress) {
    return (
      <View accessibilityLabel={label} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the admitted counter and sync detail."
      testID={testID}
    >
      {body}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  strip: {
    // ≥44pt: the strip IS the control (see the docblock). Do not drop this to
    // reclaim vertical budget — take it out of the verdict block instead.
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    overflow: "hidden",
  },
  counter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  counterText: {
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
});
