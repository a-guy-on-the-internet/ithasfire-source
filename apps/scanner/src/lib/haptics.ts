/**
 * Thin wrapper around `expo-haptics` that plays a {@link HapticPattern}.
 *
 * The module is loaded via `require` so the scanner build can boot in
 * environments where the native haptics module isn't available (web
 * preview, certain CI shells). All calls are best-effort: we NEVER throw out
 * of haptic feedback into the scan flow — a buzzing motor must not be able
 * to break an admission.
 *
 * Reduced-motion does NOT silence haptics (those are independent on iOS &
 * Android), but iOS respects "Reduce Motion → Prefer Cross-Fade Transitions"
 * separately from the global haptics toggle. This wrapper intentionally
 * does no gating and lets the OS-level haptics setting take precedence.
 *
 * ## Rich vs degraded
 *
 * `expo-haptics` exposes exactly three notification types, which is one
 * short of the four signatures FR-002 requires, so the extra distinctions
 * are composed from `impactAsync` sequences. Devices/platforms without a
 * working `impactAsync` fall back to the notification type each pattern
 * declares (see `HapticPattern.fallbackNotification`). The first
 * `impactAsync` failure latches the fallback for the rest of the session so
 * we don't pay a throwing native call on every scan.
 */
import {
  FEEDBACK_SIGNATURES,
  type FeedbackKind,
  type HapticPattern,
  type HapticStep,
  type ImpactFeedback,
  type NotificationFeedback,
} from "./feedback-signatures";

type HapticsModule = {
  notificationAsync: (type: unknown) => Promise<void>;
  NotificationFeedbackType: {
    Success: unknown;
    Warning: unknown;
    Error: unknown;
  };
  impactAsync?: (style: unknown) => Promise<void>;
  ImpactFeedbackStyle?: {
    Light?: unknown;
    Medium?: unknown;
    Heavy?: unknown;
    Rigid?: unknown;
    Soft?: unknown;
  };
};

let cachedModule: HapticsModule | null | undefined;

/**
 * Latched once an `impactAsync` call fails at runtime (older device, web
 * shell, permissions). Subsequent patterns degrade without retrying.
 */
let richHapticsBroken = false;

const loadHaptics = (): HapticsModule | null => {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-haptics") as HapticsModule | null;
    cachedModule =
      mod && typeof mod.notificationAsync === "function" ? mod : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
};

/** Test seam — reset the module + degrade caches. */
export const __resetHapticsCacheForTests = () => {
  cachedModule = undefined;
  richHapticsBroken = false;
};

const supportsRichHaptics = (mod: HapticsModule): boolean =>
  !richHapticsBroken &&
  typeof mod.impactAsync === "function" &&
  !!mod.ImpactFeedbackStyle;

const notificationType = (
  mod: HapticsModule,
  kind: NotificationFeedback,
): unknown =>
  kind === "success"
    ? mod.NotificationFeedbackType.Success
    : kind === "warning"
      ? mod.NotificationFeedbackType.Warning
      : mod.NotificationFeedbackType.Error;

const impactStyle = (
  mod: HapticsModule,
  style: ImpactFeedback,
): unknown | undefined => {
  const styles = mod.ImpactFeedbackStyle ?? {};
  switch (style) {
    case "light":
      return styles.Light;
    case "medium":
      return styles.Medium;
    case "heavy":
      return styles.Heavy;
    // `Rigid` / `Soft` are iOS-only and absent on older SDKs; fall back to
    // the nearest always-present style rather than passing `undefined`.
    case "rigid":
      return styles.Rigid ?? styles.Heavy;
    case "soft":
      return styles.Soft ?? styles.Light;
    default:
      return styles.Medium;
  }
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const runStep = async (
  mod: HapticsModule,
  step: HapticStep,
): Promise<boolean> => {
  if (step.type === "delay") {
    await wait(step.ms);
    return true;
  }
  if (step.type === "notification") {
    await mod.notificationAsync(notificationType(mod, step.notification));
    return true;
  }
  const impact = mod.impactAsync;
  if (!impact) return false;
  await impact(impactStyle(mod, step.impact));
  return true;
};

/**
 * Play a haptic pattern. Resolves once the pattern has been dispatched;
 * never rejects.
 */
export const playHapticPattern = async (
  pattern: HapticPattern,
): Promise<void> => {
  const mod = loadHaptics();
  if (!mod) return;

  if (supportsRichHaptics(mod)) {
    try {
      for (const step of pattern.rich) {
        const ok = await runStep(mod, step);
        if (!ok) {
          richHapticsBroken = true;
          break;
        }
      }
      if (!richHapticsBroken) return;
    } catch {
      // Impact haptics unsupported/failed on this device — latch the
      // degrade and fall through to the notification fallback below.
      richHapticsBroken = true;
    }
  }

  try {
    await mod.notificationAsync(
      notificationType(mod, pattern.fallbackNotification),
    );
  } catch {
    // Swallow — haptics are best-effort.
  }
};

/** Play the haptic half of an outcome signature. */
export const triggerHaptic = async (kind: FeedbackKind): Promise<void> => {
  await playHapticPattern(FEEDBACK_SIGNATURES[kind].haptic);
};
