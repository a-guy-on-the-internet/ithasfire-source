"use client";

import { useEffect, useRef } from "react";

import type { RestoredConfirmationVerdict } from "./restored-confirmation";

/**
 * Acts on a restored confirmation's verdict ONCE it is an answer: "confirm"
 * or "fallback" (definitive). "pending" waits, and "unavailable" (transient)
 * deliberately does nothing — the page stays on the confirmation step, so
 * the URL sync keeps `step=confirmed&order=` and a retry can still land
 * either answer. Before this, a 5xx on the first reload dropped the buyer to
 * the picker with "We can't show that order here" and rewrote the URL to
 * `?step=selecting`, erasing the confirmation link.
 */
export function useApplyRestoreVerdict(
  verdict: RestoredConfirmationVerdict | null,
  onAnswer: (verdict: "confirm" | "fallback") => void,
): void {
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  useEffect(() => {
    if (verdict !== "confirm" && verdict !== "fallback") return;
    onAnswerRef.current(verdict);
  }, [verdict]);
}
