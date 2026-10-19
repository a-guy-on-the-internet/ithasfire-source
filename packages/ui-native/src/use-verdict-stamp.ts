import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing } from "react-native";

/**
 * Stamp C — the door verdict's entry, on native. The web twin is
 * `apps/web/.../scan/_components/tone-result-stamp.module.css`; the numbers
 * below are the same numbers, and a change to one is a change to both.
 *
 * Owner override of DS D-125 (owner, 2026-10-06; recorded as D-150). See the
 * `## Motion` section of `tone-result-state.tsx` for what moves and what does
 * not.
 */

/** Whole glyph drop, ms. */
export const STAMP_GLYPH_MS = 180;
/** The overshoot keyframe, as a fraction of {@link STAMP_GLYPH_MS}. */
export const STAMP_KNEE = 0.7;
/** The word starts this long after the glyph does, ms. */
export const STAMP_WORD_DELAY_MS = 120;
/** The word's fade, ms. Linear. */
export const STAMP_WORD_MS = 120;

/** Keyframes 0% / 70% / 100%. Opacity holds at 1 from the knee on. */
export const STAMP_SCALE = [1.9, 0.94, 1] as const;
export const STAMP_OPACITY = [0, 1, 1] as const;

/**
 * The web scales about `50% 60%`; RN scales about the centre. RN does have a
 * `transformOrigin` style (0.73+), but whether native-driven transform updates
 * honour it on both platforms is a device question nobody here has measured,
 * and this needs no such question answered. Scaling about a point `d` below
 * centre is the same as scaling about the
 * centre and then translating by `(1 - s) · d`, so a `translateY` driven off
 * the same progress reproduces the web's origin exactly (it is linear in `s`,
 * and `s` is piecewise linear in progress). At 96pt `d` is 9.6pt — at the 1.9
 * peak that is ~8.6pt of drift, enough to make the glyph land "from above"
 * instead of pulsing in place, which is what the 60% was for.
 */
export const STAMP_ORIGIN_OFFSET = 0.1;

const STAMP_BEZIER = Easing.bezier(0.3, 0, 0.2, 1);

/**
 * CSS applies `animation-timing-function` to EACH keyframe segment, not to the
 * whole run. So the web's drop is two eased legs (0→70%, 70→100%), and a single
 * bezier over a three-stop interpolation would land the overshoot at the wrong
 * moment. This composes the two legs into ONE curve, so `progress` still
 * crosses {@link STAMP_KNEE} exactly at the knee.
 *
 * One curve and not two chained timings, because a native-driven timing is
 * pre-sampled: RN evaluates this JS easing into a frame list at start and hands
 * the list to the UI thread. `Animated.sequence` starts leg 2 from a JS
 * completion callback, and the stamp starts in the same commit as the
 * announcement, a SQLite read and the rail effects — a busy JS thread would
 * hold the glyph at 0.94x past the knee.
 */
export const composeKeyframeEasing =
  (curve: (t: number) => number, knee: number) =>
  (t: number): number =>
    t < knee
      ? knee * curve(t / knee)
      : knee + (1 - knee) * curve((t - knee) / (1 - knee));

/** The glyph's curve: {@link composeKeyframeEasing} over the DS bezier. */
export const stampGlyphEasing = composeKeyframeEasing(STAMP_BEZIER, STAMP_KNEE);

/** Total length of the word's timing: its delay is part of the curve. */
export const STAMP_WORD_TOTAL_MS = STAMP_WORD_DELAY_MS + STAMP_WORD_MS;
const WORD_HOLD = STAMP_WORD_DELAY_MS / STAMP_WORD_TOTAL_MS;

/**
 * The word's delay, folded INTO its curve: flat at 0 for the first 120ms, then
 * linear to 1. Neither `Animated.delay` nor timing's own `delay` option will do
 * — in RN 0.81 both are a JS `setTimeout` before the native animation is even
 * sent (`TimingAnimation.start`), the same JS-thread dependency as above. A
 * pre-sampled curve has none.
 */
export const stampWordEasing = (t: number): number =>
  t <= WORD_HOLD ? 0 : (t - WORD_HOLD) / (1 - WORD_HOLD);

const KEYS = [0, STAMP_KNEE, 1];

export type VerdictStampOptions = {
  /** Identity of the verdict on screen. Absent → static, always. */
  stampKey?: string;
  /** Only an explicit `false` animates; `undefined` counts as reduced. */
  reducedMotion?: boolean;
  /** Glyph box height, for the origin offset. */
  glyphSize: number;
};

export const useVerdictStamp = ({
  stampKey,
  reducedMotion,
  glyphSize,
}: VerdictStampOptions) => {
  const animate = stampKey != null && reducedMotion === false;

  // Seeded from the FIRST render, so a mount that will stamp paints its first
  // frame at the 0% keyframe and a static mount paints the final frame — no
  // one-frame flash either way.
  // Lazy (`useState` initialiser), so a re-render does not allocate a value
  // only to throw it away.
  const [progress] = useState(() => new Animated.Value(animate ? 0 : 1));
  const [wordOpacity] = useState(() => new Animated.Value(animate ? 0 : 1));
  /** The key last stamped OR shown static. Guards against replays. */
  const shownKeyRef = useRef<string | null>(null);

  // Layout effect, not a plain effect: when the key changes on a mounted
  // instance (a cross-ticket scan from inside a verdict) the reset to the 0%
  // keyframe must land before paint, or the new verdict flashes at full size
  // for a frame and then jumps back to start its stamp.
  useLayoutEffect(() => {
    if (!animate) {
      // Static: the final frame. This is also the mid-flight exit — if the OS
      // reduce-motion flag resolves `true` while a stamp is running (it starts
      // `false` and resolves async), the cleanup below has already stopped it
      // and this jumps it to rest.
      progress.stopAnimation();
      wordOpacity.stopAnimation();
      progress.setValue(1);
      wordOpacity.setValue(1);
      // Recorded so turning reduce-motion OFF later does not replay a verdict
      // the operator has already read.
      shownKeyRef.current = stampKey ?? null;
      return;
    }
    if (shownKeyRef.current === stampKey) return;
    shownKeyRef.current = stampKey;

    progress.setValue(0);
    wordOpacity.setValue(0);
    // `parallel` starts both synchronously (one `forEach`); only its
    // completion callback, which nothing here uses, runs on JS.
    // Sampling rounds to whole 60fps frames (`round(duration / 16.67)`), so the
    // glyph plays in ~183ms and the word as ~117ms held + ~117ms fade.
    const stamp = Animated.parallel([
      Animated.timing(progress, {
        toValue: 1,
        duration: STAMP_GLYPH_MS,
        easing: stampGlyphEasing,
        useNativeDriver: true,
      }),
      Animated.timing(wordOpacity, {
        toValue: 1,
        duration: STAMP_WORD_TOTAL_MS,
        easing: stampWordEasing,
        useNativeDriver: true,
      }),
    ]);
    stamp.start();
    return () => {
      stamp.stop();
      // Forget the key: an interrupted stamp (key change, StrictMode's
      // mount-unmount-mount) must be free to start again. The static branch
      // re-records it when reduce-motion is what interrupted.
      shownKeyRef.current = null;
    };
  }, [animate, stampKey, progress, wordOpacity]);

  const glyphStyle = useMemo(() => {
    const d = glyphSize * STAMP_ORIGIN_OFFSET;
    const range = (outputRange: readonly number[]) =>
      progress.interpolate({
        inputRange: KEYS,
        outputRange: [...outputRange],
        extrapolate: "clamp",
      });
    return {
      opacity: range(STAMP_OPACITY),
      // translateY FIRST: RN composes left to right like CSS, so this
      // translation is not itself scaled.
      transform: [
        { translateY: range(STAMP_SCALE.map((s) => (1 - s) * d)) },
        { scale: range(STAMP_SCALE) },
      ],
    };
  }, [progress, glyphSize]);

  const wordStyle = useMemo(() => ({ opacity: wordOpacity }), [wordOpacity]);

  return { glyphStyle, wordStyle };
};
