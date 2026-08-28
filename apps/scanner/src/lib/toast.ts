/**
 * Native toast wrapper around `burnt`. Used for ephemeral feedback that
 * doesn't fit a dedicated UI surface — primarily errors that bubble up
 * from background work (manifest sync, auth invalidation, mutations
 * fired from a screen the operator has already moved away from).
 *
 * Loaded lazily so a missing native module (web preview, very old dev
 * client) degrades to a console.warn instead of crashing.
 */

type BurntToastOptions = {
  title: string;
  message?: string;
  preset?: "done" | "error" | "none";
  haptic?: "success" | "warning" | "error" | "none";
  duration?: number;
};

let cached: { toast: (opts: BurntToastOptions) => void } | null | undefined;

const loadBurnt = () => {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("burnt");
    cached = mod && typeof mod.toast === "function" ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
};

// Haptics are owned by `triggerFeedback` (./feedback) so user
// preferences (sound/haptics toggles) are honoured in one place.
// Burnt's own haptic option ignores those preferences — pass "none"
// here and let callers fire `triggerFeedback` separately.

import { friendlyError } from "./error-messages";

export function showErrorToast(title: string, message?: string): void {
  const burnt = loadBurnt();
  if (!burnt) {
    if (__DEV__)
      console.warn(`[toast] ${title}${message ? ` — ${message}` : ""}`);
    return;
  }
  burnt.toast({
    title,
    message,
    preset: "error",
    haptic: "none",
    duration: 4,
  });
}

/**
 * Resolve a thrown value to operator-friendly copy and toast it.
 * Prefer this over `showErrorToast(title, message)` when the source
 * is a server / mutation error — keeps raw codes like `forbidden`
 * out of the operator's face.
 */
export function showErrorToastFromError(err: unknown): {
  title: string;
  message: string;
} {
  const friendly = friendlyError(err);
  showErrorToast(friendly.title, friendly.message);
  return friendly;
}

export function showSuccessToast(title: string, message?: string): void {
  const burnt = loadBurnt();
  if (!burnt) return;
  burnt.toast({
    title,
    message,
    preset: "done",
    haptic: "none",
    duration: 2,
  });
}
