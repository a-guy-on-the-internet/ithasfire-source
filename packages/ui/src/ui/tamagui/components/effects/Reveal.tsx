"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Reveal — animated show/hide with CSS grid row collapse
//
// Uses `grid-template-rows: 0fr → 1fr` so the transition always matches the
// actual content height — no overshoot or jitter from a fixed max-height.
// ---------------------------------------------------------------------------

const REVEAL_DURATION = 280; // ms — matches design system spec

export interface RevealProps {
  /** Whether the content is visible. */
  show: boolean;
  children: ReactNode;
  /** Override the animation duration in ms. Default 280. */
  durationMs?: number;
  /** Test automation base id. */
  testIdBase?: string;
}

export function Reveal({
  show,
  children,
  durationMs = REVEAL_DURATION,
  testIdBase,
}: RevealProps) {
  const [mounted, setMounted] = useState(show);
  const [visible, setVisible] = useState(show);
  // Resolve reduced-motion AFTER mount so SSR and the first client paint agree
  // (both assume motion is OK); a reduced-motion client then drops the
  // transition on the next tick — no hydration style mismatch.
  const [motionOk, setMotionOk] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return undefined;
    const sync = () => setMotionOk(!mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  // After the reveal animation completes, switch overflow to visible so that
  // absolutely-positioned children (e.g. combobox dropdowns) are not clipped.
  // Reset to hidden immediately whenever we start collapsing.
  const [overflowVisible, setOverflowVisible] = useState(show);
  const raf = useRef<number>(0);
  const raf2 = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overflowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(overflowTimer.current);
    if (show) {
      setMounted(true);
      // Enter transition: the element mounts at `0fr`, and we flip to `1fr`
      // only AFTER the browser has painted that `0fr` frame — otherwise the
      // grid-template-rows transition has no start keyframe and the row snaps
      // open with no animation (while close, starting from an already-painted
      // `1fr`, looked smooth). A single rAF runs before the pending paint, so
      // it isn't enough; the nested rAF lands on the following frame.
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(raf2.current);
      raf.current = requestAnimationFrame(() => {
        raf2.current = requestAnimationFrame(() => setVisible(true));
      });
      // Unlock overflow once the expand animation finishes.
      overflowTimer.current = setTimeout(
        () => setOverflowVisible(true),
        durationMs + 20,
      );
    } else {
      // Re-clip before the collapse animation begins.
      setOverflowVisible(false);
      setVisible(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMounted(false), durationMs);
    }
    return () => {
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(raf2.current);
      clearTimeout(timer.current);
      clearTimeout(overflowTimer.current);
    };
  }, [show, durationMs]);

  if (!mounted) return null;

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-reveal` } : {})}
      style={{
        display: "grid",
        gridTemplateRows: visible ? "1fr" : "0fr",
        opacity: visible ? 1 : 0,
        transition: motionOk
          ? `grid-template-rows ${durationMs}ms ease-out, opacity ${durationMs}ms ease-out`
          : `opacity ${durationMs}ms ease-out`,
      }}
    >
      <div
        style={{
          overflow: overflowVisible ? "visible" : "hidden",
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
