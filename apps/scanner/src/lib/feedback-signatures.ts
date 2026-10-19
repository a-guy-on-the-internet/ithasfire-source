/**
 * Scan-outcome feedback SIGNATURES — the pure, node-testable half of
 * FR-002 (docs/specs/2026-08-04/completed/scan-ticket-redesign.spec.yaml).
 *
 * This module is deliberately free of `expo-*` imports (same testability
 * split as `people-search-tokens.ts` vs `local-db.ts`) so the
 * outcome → (haptic pattern, tone asset) mapping can be asserted in vitest's
 * node environment. The impure execution lives in `./feedback` (audio) and
 * `./haptics` (vibration); the asset `require()`s live in `./feedback-tones`.
 *
 * ## What changed and why
 *
 * The scanner previously had THREE kinds (success | warning | error), so
 * "already scanned" and "wrong event" both fired the same `warning`
 * notification haptic and the same click-at-1.0x-rate. In a dark room, over a
 * PA, the operator could not tell "I've already seen this ticket" from "this is
 * a ticket for a different show" without reading the screen. Those are opposite
 * recoveries — one is "they're already in", the other is "this person is at the
 * wrong venue" — so collapsing them was the bug. There are now four.
 *
 * ## Why there are still FOUR signatures under a TWO-tone visual system
 *
 * The verdict fills collapsed from four families to the Design System's `pass`
 * and `fail`. These did not, and the reason is written down here because it is
 * the whole argument:
 *
 * **In a dark room an operator must be able to tell "seen this ticket" from
 * "wrong show" without reading** — and the visual system no longer carries that
 * distinction, because both are now `fail`. The haptic and the tone are the
 * only channel left that separates them. Collapsing to two signatures would
 * delete it.
 *
 * RECORDED DEVIATION from the DS: `ScanResult.prompt.md` specifies a pass/fail
 * pair — a single tone for pass and a double pulse for fail. Four signatures
 * ship, kept by owner ruling on 2026-10-06, because the haptic is the only
 * channel left that separates "already used" from "wrong event" (both are the
 * `fail` tone). The deviation is logged in the DS DECISIONS.md.
 *
 * ## Haptics: why patterns and not just notification types
 *
 * `expo-haptics` offers exactly three notification types (Success / Warning /
 * Error). Four distinct signatures therefore require composing `impactAsync`
 * sequences for at least one of them. See {@link HapticPattern}.
 */

import {
  SCAN_FEEDBACK_KINDS,
  VERDICT_FEEDBACK,
  type ScanFeedbackKind,
} from "@th/types";

/**
 * The four outcome signatures — the SHARED names from `@th/types`, so the web
 * page's vibration patterns and this app's haptics + tones are keyed by one
 * vocabulary.
 */
export type FeedbackKind = ScanFeedbackKind;

export const FEEDBACK_KINDS: readonly FeedbackKind[] = SCAN_FEEDBACK_KINDS;

/** Identifier for a bundled tone asset (see `./feedback-tones`). */
export type ToneId = FeedbackKind;

export type NotificationFeedback = "success" | "warning" | "error";
export type ImpactFeedback = "light" | "medium" | "heavy" | "rigid" | "soft";

export type HapticStep =
  | { type: "notification"; notification: NotificationFeedback }
  | { type: "impact"; impact: ImpactFeedback }
  | { type: "delay"; ms: number };

export type HapticPattern = {
  /**
   * Played on devices with a rich haptic engine (`impactAsync` available and
   * not throwing).
   */
  rich: readonly HapticStep[];
  /**
   * Degrade target for devices without rich haptics — the pre-FR-002
   * notification types.
   *
   * Three types cannot express four signatures, so ONE collision is
   * unavoidable in degraded mode. We deliberately collide `wrong_event` with
   * `rejected` (both mean "do not admit; something is off with this pass")
   * rather than re-colliding `already_scanned` with `wrong_event`, which is
   * the exact confusion FR-002 exists to remove. Audio stays fully distinct
   * in all four cases regardless of haptic hardware.
   */
  fallbackNotification: NotificationFeedback;
};

export type FeedbackSignature = {
  kind: FeedbackKind;
  haptic: HapticPattern;
  tone: ToneId;
  /**
   * Short description used in the announce/telemetry path and in tests as a
   * human-readable handle for the signature.
   */
  description: string;
};

/**
 * Pulse gap inside a composed haptic pattern. Long enough that an operator
 * feels two separate taps rather than one smeared buzz, short enough that
 * the whole signature lands inside the NFR-001 150ms feedback budget's
 * perceptual window.
 */
export const HAPTIC_PULSE_GAP_MS = 120;

export const FEEDBACK_SIGNATURES: Record<FeedbackKind, FeedbackSignature> = {
  // Admit. One crisp success notification — unchanged from before, because
  // it is the signature operators already have muscle memory for.
  valid: {
    kind: "valid",
    haptic: {
      rich: [{ type: "notification", notification: "success" }],
      fallbackNotification: "success",
    },
    tone: "valid",
    description: "Valid — single success pulse, rising two-note tone",
  },
  // Already scanned. DOUBLE pulse — the tactile analogue of "again".
  already_scanned: {
    kind: "already_scanned",
    haptic: {
      rich: [
        { type: "impact", impact: "medium" },
        { type: "delay", ms: HAPTIC_PULSE_GAP_MS },
        { type: "impact", impact: "medium" },
      ],
      fallbackNotification: "warning",
    },
    tone: "already_scanned",
    description: "Already scanned — double medium pulse, repeated mid tone",
  },
  // Wrong event. ONE heavy thud: unmistakably not the double pulse, and
  // heavier than the success tap.
  wrong_event: {
    kind: "wrong_event",
    haptic: {
      rich: [{ type: "impact", impact: "heavy" }],
      fallbackNotification: "error",
    },
    tone: "wrong_event",
    description: "Wrong event — single heavy pulse, long low-mid tone",
  },
  // Rejected / unreadable / server error.
  rejected: {
    kind: "rejected",
    haptic: {
      rich: [{ type: "notification", notification: "error" }],
      fallbackNotification: "error",
    },
    tone: "rejected",
    description: "Rejected — error notification, descending three-note tone",
  },
};

export function feedbackSignature(kind: FeedbackKind): FeedbackSignature {
  return FEEDBACK_SIGNATURES[kind];
}

/**
 * Verdict key → signature. **The canonical mapping**, and it lives in
 * `@th/types` (`VERDICT_FEEDBACK`) beside `SCAN_VERDICTS`, so the web scan page
 * and this app read ONE table instead of two hand-copied ones. Re-exported here
 * so existing imports keep working.
 *
 * This constant is NOT consulted by {@link feedbackKindForOutcome} — that would
 * make the guard tautological. The descriptor → signature switch below stays
 * independently authored so `__tests__/verdict-feedback-agreement.test.ts` has
 * something to compare it against (total; stable for every descriptor the app
 * can produce; `valid` if and only if the tone is `pass`). They drifted once
 * already: `volunteer_needs_connection` rendered a "reconnect" screen while
 * buzzing `rejected`, which told the operator "do not admit".
 */
export { VERDICT_FEEDBACK };

// ── Outcome → signature ─────────────────────────────────────────────────────

/**
 * Minimal structural description of a resolve outcome. Structural (not the
 * full `UnifiedResolveResult`) so this module stays independent of the
 * screen's inline router-output duplicates and can also classify the
 * offline-resolve outcomes from `./offline-resolve`.
 */
export type ScanOutcomeDescriptor =
  | { kind: "volunteer" }
  | {
      kind: "ticket";
      status: string;
      /**
       * THIS operator just admitted this ticket. Honoured ONLY on `SCANNED` —
       * the status the server-confirmed admission produces — exactly as
       * `presentScanResult` (and the web) honour it. On any other status the
       * flag is evidence of a TAP, not of an admission: an admit the server
       * answered REJECTED or REPLAY must not buzz "admit".
       */
      admitted?: boolean;
      /**
       * The re-admit guard fired (this device admitted this ticket minutes
       * ago). Honoured ONLY on `VALID`, where it is the halt the guard exists
       * to raise; on any other status the real status is the stronger fact and
       * its signature stands (`presentScanResult` agrees).
       */
      admittedHereRecently?: boolean;
    }
  | { kind: "wrong_event" }
  | { kind: "unknown" }
  | { kind: "offline_unverifiable" }
  | { kind: "volunteer_needs_connection" }
  /**
   * A settled `scanTicket` that the screen shows in place of the result —
   * REJECTED with a reason, or REPLAY. Mirrors `presentScanResult`'s
   * `admit_settled`.
   */
  | {
      kind: "admit_settled";
      outcome: { outcome: string; reason?: string | null };
    }
  /** A round trip that threw — lookup or record. Never a pass. */
  | { kind: "failure" };

/**
 * The single place an outcome becomes a signature. Screens must call this
 * rather than re-deriving `status === "VALID" ? … : …` inline — that
 * duplication is how already-scanned and wrong-event ended up sharing a
 * haptic in the first place.
 *
 * Note `admittable` is NOT consulted here: only a literal `VALID` (or a `SCANNED` ticket whose admit this operator
 * just had accepted) gets the success signature, and every other /
 * unrecognised status gets `rejected`. Failing closed on an unknown status
 * matters more in the feedback channel than anywhere else, because the operator
 * may act on the buzz before reading the screen.
 */
export function feedbackKindForOutcome(
  outcome: ScanOutcomeDescriptor,
): FeedbackKind {
  switch (outcome.kind) {
    case "volunteer":
      return "valid";
    case "ticket":
      // Order mirrors `presentScanResult`. On VALID a PRIOR admission this
      // status does not corroborate outranks the pass; on SCANNED only a
      // fresh, server-accepted admission turns "again" into "done".
      if (outcome.status === "VALID") {
        return outcome.admittedHereRecently ? "already_scanned" : "valid";
      }
      if (outcome.status === "SCANNED") {
        return outcome.admitted ? "valid" : "already_scanned";
      }
      return "rejected";
    case "wrong_event":
      return "wrong_event";
    case "volunteer_needs_connection":
      // "Nothing is wrong with the pass; you need a different path" — and the
      // signature must agree with the pixels. The screen says NEEDS SIGNAL /
      // USE SEARCH; mapping this to `rejected` made the haptic and the tone say
      // "do not admit" while the screen said "reconnect". A volunteer JWT
      // offline is a known capability gap of OURS with a clear next action, not
      // a verdict about the person at the door.
      return "wrong_event";
    case "admit_settled":
      // Authored independently of the shared reason → key table on purpose
      // (see `VERDICT_FEEDBACK`); the agreement test compares the two.
      switch (outcome.outcome.outcome) {
        case "ACCEPTED":
          return "valid";
        case "REPLAY":
          // Someone else already let this person in — the tactile "again".
          return "already_scanned";
        case "REJECTED":
          // Nothing wrong with the pass, wrong path: wrong show, doors shut.
          return outcome.outcome.reason === "event_mismatch" ||
            outcome.outcome.reason === "event_not_active"
            ? "wrong_event"
            : "rejected";
        default:
          return "rejected";
      }
    case "unknown":
    case "offline_unverifiable":
    case "failure":
      return "rejected";
    default: {
      // Exhaustiveness guard — a new outcome kind must choose a signature.
      const _never: never = outcome;
      void _never;
      return "rejected";
    }
  }
}
