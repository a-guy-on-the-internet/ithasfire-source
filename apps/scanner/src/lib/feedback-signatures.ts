/**
 * Scan-outcome feedback SIGNATURES — the pure, node-testable half of
 * FR-002 (docs/specs/2026-08-04/scan-ticket-redesign.spec.yaml).
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
 * notification haptic and the same click-at-1.0x-rate
 * (unified-scan-screen.tsx:119-130, feedback.ts:57-63). In a dark room, over
 * a PA, the operator could not tell "I've already seen this ticket" from
 * "this is a ticket for a different show" without reading the screen. Those
 * are opposite recoveries — one is "let them in, they're already admitted",
 * the other is "this person is at the wrong venue" — so collapsing them was
 * the bug. There are now four.
 *
 * ## Haptics: why patterns and not just notification types
 *
 * `expo-haptics` offers exactly three notification types (Success / Warning /
 * Error). Four distinct signatures therefore require composing `impactAsync`
 * sequences for at least one of them. See {@link HapticPattern}.
 */

import type { ToneFamily } from "@th/ui-native/tone";

/** The four outcome signatures. */
export type FeedbackKind =
  | "valid"
  | "already_scanned"
  | "wrong_event"
  | "rejected";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  "valid",
  "already_scanned",
  "wrong_event",
  "rejected",
] as const;

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
 * The design's central premise, written down: the four TONE FAMILIES and the
 * four FEEDBACK SIGNATURES are the same four things (design §0). Colour, fill
 * lightness, glyph, verdict word, haptic and audio all say the same one of
 * four at the same moment; an operator learns four responses, not eight.
 *
 * This constant is NOT consulted by {@link feedbackKindForOutcome} — that
 * would make the guard test tautological. It exists so
 * `__tests__/tone-feedback-bijection.test.ts` can assert that the two
 * independently-authored tables (`presentScanResult`'s tone column and
 * `feedbackKindForOutcome`'s signature column) still agree across EVERY
 * descriptor. They drifted once already: `volunteer_needs_connection`
 * rendered REDIRECT while buzzing `rejected`.
 */
export const TONE_FAMILY_FEEDBACK: Record<ToneFamily, FeedbackKind> = {
  admit: "valid",
  alreadyIn: "already_scanned",
  redirect: "wrong_event",
  stop: "rejected",
};

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
       * FR-004's re-admit guard fired (this device admitted this ticket
       * minutes ago). `presentScanResult` renders that as the ALREADY IN
       * family, so the signature has to follow — design §0's premise is that
       * colour, glyph, word, haptic and audio say the SAME one of four, and an
       * operator who acts on the buzz before reading would otherwise hear
       * "admit" on the one outcome the guard exists to interrupt.
       */
      admittedHereRecently?: boolean;
    }
  | { kind: "wrong_event" }
  | { kind: "unknown" }
  | { kind: "offline_unverifiable" }
  | { kind: "volunteer_needs_connection" };

/**
 * The single place an outcome becomes a signature. Screens must call this
 * rather than re-deriving `status === "VALID" ? … : …` inline — that
 * duplication is how already-scanned and wrong-event ended up sharing a
 * haptic in the first place.
 *
 * Note `admittable` is NOT consulted here: only a literal `VALID` gets the
 * success signature, and every non-VALID / unrecognised status gets
 * `rejected`. Failing closed on an unknown status matters more in the
 * feedback channel than anywhere else, because the operator may act on the
 * buzz before reading the screen.
 */
export function feedbackKindForOutcome(
  outcome: ScanOutcomeDescriptor,
): FeedbackKind {
  switch (outcome.kind) {
    case "volunteer":
      return "valid";
    case "ticket":
      if (outcome.status === "VALID") {
        return outcome.admittedHereRecently ? "already_scanned" : "valid";
      }
      if (outcome.status === "SCANNED") return "already_scanned";
      return "rejected";
    case "wrong_event":
      return "wrong_event";
    case "volunteer_needs_connection":
      // REDIRECT, not STOP — and the signature must agree with the pixels.
      // `scan-result-presentation.ts` renders this state as NEEDS SIGNAL on
      // the `redirect` fill; mapping it to `rejected` made the haptic and the
      // tone say "do not admit" while the screen said "reconnect". A volunteer
      // JWT offline is a known capability gap of OURS with a clear next
      // action, not a verdict about the person at the door.
      return "wrong_event";
    case "unknown":
    case "offline_unverifiable":
      return "rejected";
    default: {
      // Exhaustiveness guard — a new outcome kind must choose a signature.
      const _never: never = outcome;
      void _never;
      return "rejected";
    }
  }
}
