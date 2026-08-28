import * as SecureStore from "expo-secure-store";

export interface ScannerPreferences {
  eventId: string | null;
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  /**
   * Set to true once the operator has either enrolled a passkey via the
   * post-sign-in prompt or explicitly skipped it. Lets us nudge passkey
   * adoption without re-prompting on every magic-link / OAuth / password
   * sign-in. The prompt is also skipped automatically when the operator
   * signed in via passkey to begin with.
   */
  passkeyPromptDismissed: boolean;
  /**
   * FR-004 — "Auto-admit valid tickets" (express mode).
   *
   * **Defaults false, and stays per-device.** This is the one preference in the
   * app that changes who gets through a door without an operator touching the
   * screen, so the default is the safe one and the toggle lives in Settings
   * rather than on the scan surface. An operator opts in for their shift; it
   * does not follow their account onto someone else's phone.
   *
   * Additive: the tolerant loader below reads old payloads (which have no such
   * key) as `false`, which is also the default — so an upgrade can only ever
   * land in the OFF state, never surprise someone into express mode.
   */
  expressModeEnabled: boolean;
}

const STORAGE_KEY = "th.scanner.preferences.v1";

const defaultPreferences: ScannerPreferences = {
  eventId: null,
  soundEnabled: true,
  hapticsEnabled: true,
  passkeyPromptDismissed: false,
  expressModeEnabled: false,
};

export async function loadScannerPreferences(): Promise<ScannerPreferences> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) {
      return defaultPreferences;
    }

    const parsed = JSON.parse(raw) as Partial<ScannerPreferences>;
    return {
      eventId: typeof parsed.eventId === "string" ? parsed.eventId : null,
      soundEnabled:
        typeof parsed.soundEnabled === "boolean" ? parsed.soundEnabled : true,
      hapticsEnabled:
        typeof parsed.hapticsEnabled === "boolean"
          ? parsed.hapticsEnabled
          : true,
      passkeyPromptDismissed:
        typeof parsed.passkeyPromptDismissed === "boolean"
          ? parsed.passkeyPromptDismissed
          : false,
      // Anything that is not literally `true` — absent (old payload), null,
      // the string "true", a number — reads as OFF. For a preference that
      // admits people with no gesture, "not exactly true" must mean off.
      expressModeEnabled: parsed.expressModeEnabled === true,
    };
  } catch (error) {
    if (__DEV__) {
      console.warn("[scanner-storage] failed to load preferences", error);
    }
    return defaultPreferences;
  }
}

export async function saveScannerPreferences(
  preferences: ScannerPreferences,
): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(preferences), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch (error) {
    if (__DEV__) {
      console.warn("[scanner-storage] failed to save preferences", error);
    }
  }
}
