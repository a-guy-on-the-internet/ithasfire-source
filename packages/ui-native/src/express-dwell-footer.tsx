import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { Text } from "./text";
import { useColors } from "./theme";
import { toneColors, type VerdictTone } from "./tone";

/**
 * Zone ⑨ — the express-mode dwell indicator.
 *
 * Lives in `ToneResultState`'s `footer` slot. Two channels, always:
 *
 *   1. A 6pt full-bleed rule in the tone's `on<Tone>` colour (7.98:1 on the
 *      PASS fill — well past the 3:1 graphic floor), animating 100% → 0 over
 *      the dwell.
 *   2. A WORD, whenever the rule alone would not explain the state.
 *
 * ## Why the word is not optional decoration
 *
 * Three things stop the countdown — reduced motion, a hold, and an active
 * screen reader — and a frozen bar looks identical to a broken one. Each of
 * those states therefore says what it is in text. With reduced motion the rule
 * is STATIC and the word carries the whole message (`AUTO-ADMITTED ·
 * DISMISSING`); the dwell duration itself does not change, because timing is
 * behaviour, not decoration.
 *
 * ## Restart, not resume
 *
 * The host owns the timer and bumps {@link ExpressDwellFooterProps.cycleKey}
 * every time a dwell (re)starts. An operator who held the state held it because
 * they needed to read it — resuming with 200ms left would be a cruel joke — so
 * a release restarts the animation from full, and a changed `cycleKey` is
 * exactly that signal.
 *
 * `useNativeDriver: false` because `width` is a layout property. This is one
 * view for ~1.2s; the JS-driven-layout objection does not apply at that scale,
 * and the `scaleX` alternative needs a transform-origin RN does not have.
 *
 * Design: docs/records/2026-08-04-scan-screen-design.md §6, §7.
 */

/** Rule thickness (design §6). */
export const EXPRESS_RULE_HEIGHT = 6;

export type ExpressDwellPhase =
  /** Counting down toward auto-dismiss. */
  | "running"
  /** Operator is pressing and holding — frozen, restarts on release. */
  | "holding"
  /**
   * Auto-dismiss suppressed for the whole life of the state (a screen reader is
   * active — NFR-002). The admission already happened; only the dismiss waits.
   */
  | "paused";

export type ExpressDwellFooterProps = {
  /** The state's verdict tone — the rule borrows its legal foreground. */
  tone: VerdictTone;
  phase: ExpressDwellPhase;
  /** Dwell length in ms. Fixed at the call site (design §6: 1.2s, not a pref). */
  durationMs: number;
  /** OS-level Reduce Motion. Static rule + a text state instead. */
  reducedMotion: boolean;
  /** Changes on every (re)start of a dwell. Restarts the animation from full. */
  cycleKey: number;
  testID?: string;
};

const PHASE_LABEL: Record<ExpressDwellPhase, string | null> = {
  // The moving rule IS the message in motion mode; see `label` below for the
  // reduced-motion substitute.
  running: null,
  holding: "HOLDING — RELEASE TO CONTINUE",
  paused: "AUTO-DISMISS PAUSED",
};

const REDUCED_MOTION_RUNNING_LABEL = "AUTO-ADMITTED · DISMISSING";

export const ExpressDwellFooter = ({
  tone,
  phase,
  durationMs,
  reducedMotion,
  cycleKey,
  testID,
}: ExpressDwellFooterProps) => {
  const colors = useColors();
  const { on } = toneColors(colors, tone);
  const progress = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reducedMotion || phase !== "running") {
      // Frozen (hold / paused) or static (reduced motion). `stopAnimation`
      // leaves the current width in place, which is what "frozen" looks like;
      // reduced motion never started one, so the value stays at full.
      progress.stopAnimation();
      if (reducedMotion) progress.setValue(1);
      return;
    }
    progress.setValue(1);
    const animation = Animated.timing(progress, {
      toValue: 0,
      duration: durationMs,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [phase, cycleKey, durationMs, reducedMotion, progress]);

  const label =
    phase === "running" && reducedMotion
      ? REDUCED_MOTION_RUNNING_LABEL
      : PHASE_LABEL[phase];

  return (
    <View style={styles.root} testID={testID}>
      {label ? (
        <Text
          variant="caption"
          weight="bold"
          letterSpacing={1.5}
          textTransform="uppercase"
          color={on}
          numberOfLines={1}
          style={styles.label}
          testID="express-dwell-label"
        >
          {label}
        </Text>
      ) : null}
      <Animated.View
        style={[
          styles.rule,
          {
            backgroundColor: on,
            // Always the animated value (except under reduced motion, where it
            // is pinned to 1). A HOLD must freeze the rule where it is — a
            // hold that snapped the bar back to full would read as "restarted"
            // a beat before the release actually restarts it.
            width: reducedMotion
              ? "100%"
              : progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0%", "100%"],
                }),
          },
        ]}
        // The rule duplicates what the label (or the state announcement)
        // already says; announcing a shrinking bar helps nobody.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="express-dwell-rule"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    width: "100%",
  },
  label: {
    paddingHorizontal: 24,
    paddingBottom: 6,
    textAlign: "right",
  },
  rule: {
    height: EXPRESS_RULE_HEIGHT,
  },
});
