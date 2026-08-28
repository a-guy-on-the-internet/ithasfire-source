/**
 * Combined sound + haptic feedback for scan outcomes.
 *
 * Four distinct outcome signatures (FR-002): `valid`, `already_scanned`,
 * `wrong_event`, `rejected`. The mapping from outcome to (haptic pattern,
 * tone asset) lives in `./feedback-signatures` — pure and unit-tested. This
 * module only executes it.
 *
 * Both channels are gated on user preferences (`setFeedbackPrefs`, pushed
 * from `scanner-app.tsx` on preference load/change) and degrade silently
 * when native modules are unavailable (e.g. web preview).
 *
 * ## The OS mute switch still wins — deliberately
 *
 * We never call `setAudioModeAsync({ playsInSilentMode: true })`. expo-audio
 * defaults to respecting the iOS silent switch, and that is the behaviour we
 * want: an operator who silenced the phone silenced the scanner. Sound is a
 * convenience channel; haptics and the on-screen state are the load-bearing
 * ones.
 *
 * ## Why players are cached
 *
 * `createAudioPlayer` is synchronous but the asset loads asynchronously, so
 * creating a player per scan would put decode latency on the hot path
 * (NFR-001 budgets feedback at ≤150ms from decode). We create one player per
 * tone on first use and thereafter `seekTo(0)` + `play()`. `release()` tears
 * them down on sign-out.
 */
import * as Sentry from "@sentry/react-native";

import {
  type FeedbackKind,
  type HapticPattern,
  type ToneId,
} from "./feedback-signatures";
import { TONE_ASSETS } from "./feedback-tones";
import { playHapticPattern } from "./haptics";
import { safeReport } from "./report";
import { type FeedbackPrefs, planFeedback } from "./scan-feedback-plan";

export type { FeedbackKind } from "./feedback-signatures";
export {
  FEEDBACK_SIGNATURES,
  feedbackKindForOutcome,
  type ScanOutcomeDescriptor,
} from "./feedback-signatures";

let prefs: FeedbackPrefs = { soundEnabled: true, hapticsEnabled: true };

export function setFeedbackPrefs(next: FeedbackPrefs) {
  prefs = next;
}

/**
 * A cue that failed to play is a degrade, not a scan failure — the verdict is
 * still on screen — so it is swallowed. It is also the kind of swallow that
 * turns "the scanner went quiet tonight" into a four-day mystery, so it is
 * reported (CLAUDE.md: deliberate swallows report). Isolated by `safeReport`
 * so a mis-configured reporter cannot reach the scan flow either.
 */
const reportFeedbackFailure = (
  error: unknown,
  branch: "audio_create" | "audio_play" | "haptic_play",
  tone?: ToneId,
): void => {
  safeReport(() => {
    Sentry.captureException(
      error instanceof Error ? error : new Error(branch),
      { tags: { feature: "scan", branch: `feedback_${branch}`, tone } },
    );
  });
};

// ── expo-audio (lazy, null-degrading) ───────────────────────────────────────

type AudioPlayer = {
  play: () => void;
  seekTo: (seconds: number) => Promise<void> | void;
  remove: () => void;
  volume?: number;
};

type AudioModule = {
  createAudioPlayer: (source: unknown, options?: unknown) => AudioPlayer;
};

let cachedAudio: AudioModule | null | undefined;

const loadAudio = (): AudioModule | null => {
  if (cachedAudio !== undefined) return cachedAudio;
  try {
    // Lazy `require` (not a static import) so a build without the native
    // module — web preview, a CI shell, a stripped test host — still boots.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-audio") as AudioModule | null;
    cachedAudio =
      mod && typeof mod.createAudioPlayer === "function" ? mod : null;
  } catch {
    cachedAudio = null;
  }
  return cachedAudio;
};

/** Playback level for the cue tones. Loud enough to cut, short enough to not annoy. */
const TONE_VOLUME = 0.85;

const players = new Map<ToneId, AudioPlayer | null>();

const getPlayer = (tone: ToneId): AudioPlayer | null => {
  const existing = players.get(tone);
  if (existing !== undefined) return existing;

  const mod = loadAudio();
  if (!mod) {
    players.set(tone, null);
    return null;
  }
  try {
    const player = mod.createAudioPlayer(TONE_ASSETS[tone]);
    try {
      player.volume = TONE_VOLUME;
    } catch {
      // Older/partial player implementations — volume is optional.
    }
    players.set(tone, player);
    return player;
  } catch (error) {
    reportFeedbackFailure(error, "audio_create", tone);
    players.set(tone, null);
    return null;
  }
};

const playTone = async (tone: ToneId): Promise<void> => {
  const player = getPlayer(tone);
  if (!player) return;
  try {
    // Rewind first so a rapid second scan retriggers the cue instead of
    // being swallowed by a player still sitting at its end position.
    await player.seekTo(0);
    player.play();
  } catch (error) {
    reportFeedbackFailure(error, "audio_play", tone);
  }
};

/**
 * Tear down cached players. Called on sign-out alongside the local-DB purge
 * so nothing holds a decoded buffer for a session that has ended.
 */
export const releaseFeedbackAudio = (): void => {
  for (const player of players.values()) {
    try {
      player?.remove();
    } catch {
      // best-effort
    }
  }
  players.clear();
};

// ── Public API ──────────────────────────────────────────────────────────────

type FeedbackChannels = {
  playTone: (tone: ToneId) => Promise<void>;
  playHaptic: (pattern: HapticPattern) => Promise<void>;
};

const defaultChannels: FeedbackChannels = {
  playTone,
  playHaptic: playHapticPattern,
};

let channels: FeedbackChannels = defaultChannels;

/**
 * Test seam. `expo-audio` and `expo-haptics` are reached through lazy
 * `require`, which `vi.mock` does not intercept, so the "disabled means
 * nothing fires" property is asserted by swapping the channels rather than
 * the native modules. Pass `null` to restore the real ones.
 */
export const __setFeedbackChannelsForTests = (
  next: Partial<FeedbackChannels> | null,
): void => {
  channels = next ? { ...defaultChannels, ...next } : defaultChannels;
};

/**
 * Fire the haptic + tone for an outcome signature — or neither, when the
 * operator has the rail switch off. The decision is `planFeedback` (pure,
 * node-tested); this only executes it.
 *
 * Haptics are awaited (composed patterns are sequential by nature); audio is
 * dispatched without awaiting so a slow decode never delays the vibration or
 * the caller. Neither channel can reject into the scan flow: `playTone`
 * catches internally and `playHapticPattern` never rejects, but the haptic
 * await is guarded anyway — a buzzing motor must not be able to break an
 * admission, whatever a future channel implementation does.
 */
export const triggerFeedback = async (kind: FeedbackKind): Promise<void> => {
  const plan = planFeedback(kind, prefs);
  if (plan.tone) void channels.playTone(plan.tone);
  if (plan.haptic) {
    try {
      await channels.playHaptic(plan.haptic);
    } catch (error) {
      reportFeedbackFailure(error, "haptic_play");
    }
  }
};
