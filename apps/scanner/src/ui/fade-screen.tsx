import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Dimensions } from "react-native";

import { useReducedMotion } from "../lib/use-reduced-motion";

const SCREEN_WIDTH = Dimensions.get("window").width;

export const SlideScreen = ({ children }: { children: ReactNode }) => {
  const reducedMotion = useReducedMotion();
  const translateX = useRef(
    new Animated.Value(reducedMotion ? 0 : SCREEN_WIDTH * 0.15),
  ).current;
  const opacity = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      // Skip the slide entirely — jump to final values so screen-reader
      // focus / hit targets land on the resting layout immediately.
      translateX.setValue(0);
      opacity.setValue(1);
      return;
    }
    const anim = Animated.parallel([
      Animated.timing(translateX, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [translateX, opacity, reducedMotion]);

  return (
    <Animated.View style={{ flex: 1, opacity, transform: [{ translateX }] }}>
      {children}
    </Animated.View>
  );
};

/**
 * Crossfade root used at the top of the app to smooth transitions between
 * the bootstrap splash, sign-in, access-denied, and the authed shell. Pure
 * opacity (no slide), so the whole tree dissolves rather than jumping.
 */
export const FadeRoot = ({ children }: { children: ReactNode }) => {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(1);
      return;
    }
    const anim = Animated.timing(opacity, {
      toValue: 1,
      duration: 260,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [opacity, reducedMotion]);

  return <Animated.View style={{ flex: 1, opacity }}>{children}</Animated.View>;
};
