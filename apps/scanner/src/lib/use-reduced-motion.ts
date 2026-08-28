import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Reactive hook around `AccessibilityInfo.isReduceMotionEnabled` plus the
 * `reduceMotionChanged` event. Returns `true` when the operator's OS-level
 * Reduce Motion preference is on, so animation can be gated to instant
 * transitions per WCAG 2.3.3 / Ithas Fire motion rules.
 */
export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!cancelled) setReduced(value);
    });

    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value: boolean) => setReduced(value),
    );

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return reduced;
};
