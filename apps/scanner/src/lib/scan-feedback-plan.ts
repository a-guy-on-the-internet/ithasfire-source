/**
 * The pure half of the scan screen's "Sound & haptics" control.
 *
 * Two questions, both answered here so they can be asserted in node without
 * `expo-audio` / `expo-haptics` on the import path (same split as
 * `feedback-signatures.ts` vs `feedback.ts`):
 *
 *   1. Given the persisted preference and a verdict, WHICH channels fire?
 *      ({@link planFeedback}) — the disabled branch is a total silence, not
 *      "a quieter tone".
 *   2. What does the on-page toggle READ and WRITE? ({@link scanFeedbackEnabled},
 *      {@link applyScanFeedbackToggle}). Settings still exposes sound and
 *      haptics as two switches; the door-staff control is ONE switch over both,
 *      because in the moment the question is "is this thing making noise at
 *      me" and nobody at a door wants to answer it twice.
 *
 * ## Toggle semantics
 *
 * The rail control reads ON when EITHER channel is on (a device with sound off
 * and haptics on is still giving feedback, and the glyph must not claim
 * otherwise). Flipping it OFF turns both off; flipping it ON turns both on.
 * That last rule is deliberate: an operator who reaches for this control wants
 * the feedback back, and restoring a remembered half-state ("sound only, like
 * before") would be the surprising outcome at a loud door.
 */
import {
  FEEDBACK_SIGNATURES,
  type FeedbackKind,
  type HapticPattern,
  type ToneId,
} from "./feedback-signatures";

/** The two persisted channels, as `ScannerPreferences` stores them. */
export type FeedbackPrefs = {
  soundEnabled: boolean;
  hapticsEnabled: boolean;
};

export type FeedbackPlan = {
  /** Tone to play, or null when sound is off. */
  tone: ToneId | null;
  /** Haptic pattern to play, or null when haptics are off. */
  haptic: HapticPattern | null;
};

export function planFeedback(
  kind: FeedbackKind,
  prefs: FeedbackPrefs,
): FeedbackPlan {
  const signature = FEEDBACK_SIGNATURES[kind];
  return {
    tone: prefs.soundEnabled ? signature.tone : null,
    haptic: prefs.hapticsEnabled ? signature.haptic : null,
  };
}

/** What the on-page switch shows. ON if anything at all would fire. */
export const scanFeedbackEnabled = (prefs: FeedbackPrefs): boolean =>
  prefs.soundEnabled || prefs.hapticsEnabled;

/**
 * The preference write for a flip of the on-page switch. Returns a NEW
 * object with only the two channel keys changed, so the caller can spread it
 * over the full `ScannerPreferences` without touching anything else.
 */
export const applyScanFeedbackToggle = <P extends FeedbackPrefs>(
  prefs: P,
  next: boolean,
): P => ({ ...prefs, soundEnabled: next, hapticsEnabled: next });
