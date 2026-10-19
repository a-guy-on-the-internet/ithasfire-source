/**
 * "Visual state change always; vibration where the platform allows."
 *
 * PURE and injectable, so the four signatures are asserted in vitest rather
 * than felt by hand on one phone.
 *
 * ## Why there are still FOUR signatures under a TWO-tone visual system
 *
 * The verdict fills collapsed from four families to the Design System's `pass`
 * and `fail`. These did not, and the reason is the whole argument:
 *
 * **In a dark room an operator must be able to tell "seen this pass" from
 * "wrong show" without reading** — and the visual system no longer carries that
 * distinction, because both are now `fail`. The haptic is the only channel left
 * that separates them. Collapsing to two signatures would delete it.
 *
 * RECORDED DEVIATION from the DS: `ScanResult.prompt.md` specifies a pass/fail
 * pair — a single tone for pass and a double pulse for fail. Four signatures
 * ship, kept by owner ruling on 2026-10-06, because the haptic is the only
 * channel left that separates "already used" from "wrong event" (both are the
 * `fail` tone). The deviation is logged in the DS DECISIONS.md.
 *
 * ## What is deliberately NOT here
 *
 * Audio. iOS Safari does not permit autoplay without a user gesture, and every
 * workaround (a silent unlock element, a hidden looping buffer) either fails
 * silently or plays at the wrong moment — an outcome cue that lies is worse
 * than one that is absent. The app has real audio; the browser page does not
 * pretend to.
 *
 * `navigator.vibrate` is Android Chrome (and a few others). iOS Safari has no
 * vibration API at all, which is exactly why the visual channel is the only
 * REQUIRED one and this is additive.
 */
import {
  VERDICT_FEEDBACK,
  type ScanFeedbackKind,
  type ScanVerdictKey,
} from "@th/types";

/**
 * The four outcome signatures and the verdict key → signature table are SHARED
 * from `@th/types` (`verdict.ts`, beside `SCAN_VERDICTS`) — the same module
 * `apps/scanner`'s `feedback-signatures.ts` reads, so an operator who uses both
 * surfaces gets one vocabulary by construction rather than by two hand-copied
 * tables. The web has no audio assets, so only the vibration half lives here.
 * Re-exported so existing imports keep working.
 */
export { VERDICT_FEEDBACK };
export type { ScanFeedbackKind };

/**
 * One pattern per signature. In the dark, "seen this pass" (a double pulse)
 * must not feel like "wrong show" (a stutter) or "do not admit" (two long
 * buzzes).
 *
 * Millisecond arrays are `[vibrate, pause, vibrate, …]` per the Vibration API.
 */
export const SCAN_VIBRATION_PATTERNS: Record<ScanFeedbackKind, number[]> = {
  /** One short confirm. */
  valid: [35],
  /** Double pulse — "I have seen this one before". */
  already_scanned: [30, 70, 30],
  /** Stutter — "nothing is wrong, but you need a different path". */
  wrong_event: [20, 50, 20, 50, 20],
  /** Two long buzzes — unmistakably a stop. */
  rejected: [120, 70, 120],
};

/** Every key resolves; exported so the guard can iterate without transcribing. */
export const scanFeedbackKind = (key: ScanVerdictKey): ScanFeedbackKind =>
  VERDICT_FEEDBACK[key];

export type VibrateOutcome = "vibrated" | "unsupported" | "failed";

type VibrateDeps = {
  /** Injected for tests; defaults to the real `navigator`. */
  navigatorRef?: { vibrate?: (pattern: number | number[]) => boolean } | null;
  /**
   * NFR-006 — this is a catch-and-degrade branch, so it reports. Never a bare
   * swallow and never a `console.warn` (which nothing watches).
   */
  reportError?: (error: unknown) => void;
};

/**
 * Fire the verdict's vibration signature. Absence of the API is NOT an error —
 * it is the majority case (every iPhone), so it returns `"unsupported"`
 * quietly. A throw from a present API is a real failure and is reported.
 */
export function vibrateForVerdict(
  key: ScanVerdictKey,
  deps: VibrateDeps = {},
): VibrateOutcome {
  const nav =
    deps.navigatorRef !== undefined
      ? deps.navigatorRef
      : typeof navigator === "undefined"
        ? null
        : (navigator as unknown as {
            vibrate?: (pattern: number | number[]) => boolean;
          });

  if (!nav || typeof nav.vibrate !== "function") return "unsupported";

  try {
    nav.vibrate(SCAN_VIBRATION_PATTERNS[VERDICT_FEEDBACK[key]]);
    return "vibrated";
  } catch (err) {
    deps.reportError?.(err);
    return "failed";
  }
}
