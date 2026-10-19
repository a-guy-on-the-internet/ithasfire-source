"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type ViewStyle,
} from "react-native";

/**
 * Branded ember loader. Renders an icon (typically a logo / flame mark)
 * with two flame-shaped halos behind it that pulse in sync with a slow
 * breath, plus 1–4 small embers emitting on randomized intervals,
 * rising, drifting, and fading. Pure RN Animated — no Reanimated, no
 * SVG, no native deps. Honours OS reduce-motion.
 *
 * Designed to be reused across apps as a splash / bootstrap loader.
 * Each app passes its own `iconSource` (the splash icon) and a `tint`
 * appropriate for the surface it sits on.
 */
export function Embers({
  size = 160,
  tint,
  iconSource,
}: {
  size?: number;
  /** Color of icon, halos, and embers. */
  tint: string;
  /** Image source for the breathing icon and its halos. */
  iconSource: ImageSourcePropType;
}) {
  const reducedMotion = useReducedMotion();
  const breath = useRef(new Animated.Value(0)).current;

  // Slow inhale/exhale loop drives both the icon's gentle scale-pulse
  // and the radial glow behind it. Without this the composition reads
  // as a static logo with garnish — with it, it reads as "alive,
  // working." Honours reduce-motion: held at 0 (no breath, no glow
  // pulse) when the OS toggle is on.
  useEffect(() => {
    if (reducedMotion) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, reducedMotion]);

  const iconSize = Math.round(size * 0.55);
  const iconScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.04],
  });
  // Halos pulse *as the same icon shape*, not circles — copies of the
  // icon at increasing scale & lower opacity make the glow follow the
  // icon's contour and falloff naturally outward. Two layers: an inner
  // halo (brighter, tighter) and an outer halo (darker, wider) for a
  // soft two-stop falloff.
  const haloScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.15, 1.35],
  });
  const haloOpacity = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [0.12, 0.32],
  });
  const outerHaloScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.45, 1.75],
  });
  const outerHaloOpacity = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [0.05, 0.15],
  });
  // Spawn box — embers originate from random points inside a small
  // square biased toward the upper portion of the icon, where the
  // bright body of a flame-shaped logo typically sits (the asset is
  // usually top-weighted with empty padding below).
  const spawnBox = iconSize * 0.32;
  const spawnAnchorY = -iconSize * 0.18;

  // Per-ember config. Pseudo-random spawn coords from deterministic
  // hashes so the layout is stable across renders.
  const embers = useMemo(() => {
    const count = 4;
    const hash = (n: number) => {
      const x = Math.sin(n) * 10000;
      return x - Math.floor(x); // 0..1
    };
    return Array.from({ length: count }, (_, i) => ({
      spawnX: (hash(i + 1) - 0.5) * spawnBox,
      spawnY: spawnAnchorY + (hash(i + 13) - 0.5) * spawnBox,
      jitterX: (hash(i + 31) - 0.5) * 18,
      phaseOffset: i * 700,
      duration: 3200 + Math.round(hash(i + 47) * 800),
      rise: iconSize * 0.85 + hash(i + 71) * iconSize * 0.3,
      baseSize: 5 + (i % 2) * 2,
    }));
  }, [iconSize, spawnBox, spawnAnchorY]);

  return (
    <View
      style={[styles.root, { width: size, height: size }]}
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      pointerEvents="none"
    >
      <Animated.Image
        source={iconSource}
        resizeMode="contain"
        style={{
          position: "absolute",
          width: iconSize,
          height: iconSize,
          top: (size - iconSize) / 2,
          left: (size - iconSize) / 2,
          tintColor: tint,
          opacity: outerHaloOpacity,
          transform: [{ scale: outerHaloScale }],
        }}
      />
      <Animated.Image
        source={iconSource}
        resizeMode="contain"
        style={{
          position: "absolute",
          width: iconSize,
          height: iconSize,
          top: (size - iconSize) / 2,
          left: (size - iconSize) / 2,
          tintColor: tint,
          opacity: haloOpacity,
          transform: [{ scale: haloScale }],
        }}
      />
      {!reducedMotion
        ? embers.map((e, i) => (
            <Ember
              key={i}
              centerX={size / 2}
              centerY={size / 2}
              spawnX={e.spawnX}
              spawnY={e.spawnY}
              jitterX={e.jitterX}
              rise={e.rise}
              phaseOffset={e.phaseOffset}
              duration={e.duration}
              baseSize={e.baseSize}
              tint={tint}
            />
          ))
        : null}
      <Animated.Image
        source={iconSource}
        style={[
          styles.icon,
          {
            width: iconSize,
            height: iconSize,
            tintColor: tint,
            transform: [{ scale: iconScale }],
          },
        ]}
        resizeMode="contain"
      />
    </View>
  );
}

function Ember({
  centerX,
  centerY,
  spawnX,
  spawnY,
  jitterX,
  rise,
  phaseOffset,
  duration,
  baseSize,
  tint,
}: {
  centerX: number;
  centerY: number;
  spawnX: number;
  spawnY: number;
  jitterX: number;
  rise: number;
  phaseOffset: number;
  duration: number;
  baseSize: number;
  tint: string;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: Animated.CompositeAnimation | null = null;

    // One ember-fire = animate progress 0→1 once, then sleep a *random*
    // gap (300–2200ms) before re-emitting. Avoids the regular-stream
    // "burst" cadence of Animated.loop.
    const fire = () => {
      if (stopped) return;
      progress.setValue(0);
      current = Animated.timing(progress, {
        toValue: 1,
        duration,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
      current.start(({ finished }) => {
        if (!finished || stopped) return;
        const gap = 300 + Math.random() * 1900;
        timer = setTimeout(fire, gap);
      });
    };

    timer = setTimeout(fire, phaseOffset);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (current) current.stop();
    };
  }, [progress, phaseOffset, duration]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [spawnY, spawnY - rise],
  });
  const translateX = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [spawnX, spawnX + jitterX * 0.6, spawnX + jitterX],
  });
  const opacity = progress.interpolate({
    inputRange: [0, 0.08, 0.4, 1],
    outputRange: [0, 1, 0.7, 0],
  });
  const scale = progress.interpolate({
    inputRange: [0, 0.15, 1],
    outputRange: [0.6, 1.1, 0.35],
  });

  const emberH = baseSize * 1.6;
  const flameShape: ViewStyle = {
    width: baseSize,
    height: emberH,
    top: centerY - emberH / 2,
    left: centerX - baseSize / 2,
    backgroundColor: tint,
    borderTopLeftRadius: baseSize * 0.35,
    borderTopRightRadius: baseSize * 0.35,
    borderBottomLeftRadius: baseSize,
    borderBottomRightRadius: baseSize,
  };

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ember,
        flameShape,
        { opacity, transform: [{ translateX }, { translateY }, { scale }] },
      ]}
    />
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return reduced;
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
    // Embers translateY off the top of this View as they rise. Without
    // explicit overflow:visible, Android clips them at the parent edge.
    overflow: "visible",
  },
  icon: {
    // Sit on top of any embers that are still mid-rise.
    zIndex: 1,
  },
  ember: {
    position: "absolute",
  },
});
