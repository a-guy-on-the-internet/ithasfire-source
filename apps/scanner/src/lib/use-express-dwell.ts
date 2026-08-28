import { useCallback, useEffect, useRef, useState } from "react";

import type { ExpressDwellPhase } from "@th/ui-native";

/**
 * FR-004 — the express dwell TIMER (the decision lives in `express-mode.ts`).
 *
 * Kept out of the screen because the screen is already a large routing surface,
 * and out of the pure module because this half is genuinely about timers and
 * refs. It owns three facts and nothing else: is a dwell running, is it held,
 * and which cycle is it.
 *
 * ## Hold pauses; RELEASE restarts from full
 *
 * Not "resumes". An operator who held the state held it because they needed to
 * read it — handing them back 200ms would be a cruel joke, and it is the
 * per-scan answer to "let me look at this one longer" that a 1s/2s preference
 * would have answered badly (design §6).
 *
 * ## Why the timer is a ref-managed `setTimeout` and not the animation
 *
 * The visual rule is an `Animated.timing` inside `ExpressDwellFooter`. Driving
 * the DISMISSAL off its completion callback would tie an admission-integrity
 * behaviour to whether an animation ran — and it does not run under reduced
 * motion. Timing is behaviour; the animation is a depiction of it.
 */
export type ExpressDwell = {
  phase: ExpressDwellPhase;
  /** Bumped on every (re)start. The footer restarts its rule when it changes. */
  cycleKey: number;
  /** `onPressIn` for the verdict block. */
  hold: () => void;
  /** `onPressOut` for the verdict block. */
  release: () => void;
};

export function useExpressDwell(args: {
  /** True while an express-admitted state is on screen. */
  active: boolean;
  /**
   * False when a screen reader has suspended auto-dismiss (NFR-002). The state
   * still renders its footer — as `AUTO-DISMISS PAUSED` — so the operator can
   * see WHY nothing is cycling.
   */
  autoDismiss: boolean;
  dwellMs: number;
  /**
   * Identity of the result this dwell belongs to (a scan id / ticket code).
   *
   * The hook already restarts on `active` going false→true, so a timer cannot
   * be inherited across a dismissal today. This makes that unreachable BY
   * CONSTRUCTION rather than by that argument: if two results are ever on
   * screen back-to-back without `active` dropping (an express admit landing
   * while a previous express state is still up), the effect key changes and the
   * countdown restarts from full for the NEW person instead of finishing the
   * previous one's.
   */
  resultKey?: string | null;
  onExpire: () => void;
}): ExpressDwell {
  const { active, autoDismiss, dwellMs, onExpire } = args;
  const resultKey = args.resultKey ?? null;
  const [holding, setHolding] = useState(false);
  const [cycleKey, setCycleKey] = useState(0);
  // React's sanctioned "adjust state when a prop changes" pattern (a queued
  // render-phase setState, safe under double-invocation). Routing the identity
  // change through `cycleKey` means BOTH consumers restart together — the timer
  // effect below and the footer's progress rule, which keys off the same
  // number. A separate dependency would have restarted only the timer, leaving
  // the visible countdown showing the previous scan's remaining sliver.
  const [seenResultKey, setSeenResultKey] = useState(resultKey);
  if (seenResultKey !== resultKey) {
    setSeenResultKey(resultKey);
    setCycleKey((k) => k + 1);
  }
  const holdingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read through a ref so a re-created `onExpire` closure does not restart the
  // dwell — an operator would see the countdown silently reset on any parent
  // re-render.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    clear();
    if (!active) {
      holdingRef.current = false;
      setHolding(false);
      return;
    }
    if (!autoDismiss || holding) return;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onExpireRef.current();
    }, dwellMs);

    return clear;
    // `cycleKey` is a dependency ON PURPOSE: a release bumps it, and so does a
    // change of `resultKey` (above). That is what restarts the timer from full.
  }, [active, autoDismiss, holding, dwellMs, cycleKey]);

  // Belt and braces: a screen unmounting mid-dwell must not fire a dismissal
  // into a torn-down tree.
  useEffect(() => clear, []);

  const hold = useCallback(() => {
    holdingRef.current = true;
    setHolding(true);
  }, []);

  const release = useCallback(() => {
    // Guarded by a REF, not by the state updater: a stray `onPressOut` (RN
    // fires one after a cancelled press) must not restart a dwell that was
    // never paused, and queueing `setCycleKey` from inside a `setHolding`
    // updater would be a side effect in a function React is free to
    // double-invoke.
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    setCycleKey((k) => k + 1);
  }, []);

  const phase: ExpressDwellPhase = holding
    ? "holding"
    : autoDismiss
      ? "running"
      : "paused";

  return { phase, cycleKey, hold, release };
}
