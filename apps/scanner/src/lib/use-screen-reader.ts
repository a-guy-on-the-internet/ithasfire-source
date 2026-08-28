import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import * as Sentry from "@sentry/react-native";

import { safeReport } from "./report";

/**
 * Is VoiceOver / TalkBack currently running?
 *
 * ## Why this is ENABLED and not FOCUS (NFR-002)
 *
 * NFR-002 asks that express auto-dismiss be paused "while VoiceOver/TalkBack
 * focus is inside the result state". React Native does not expose a reliable
 * cross-platform way to observe screen-reader focus ENTERING and LEAVING an
 * arbitrary subtree: `onAccessibilityTap` fires on activation, not focus;
 * `accessibilityFocus` events are iOS-only and have no paired blur; and
 * TalkBack's focus is not surfaced to JS at all. A half-implementation would be
 * worse than none — "paused, and we think focus left, so resume" is a state
 * that dismisses a verdict mid-sentence.
 *
 * So the coarser, safer reading wins: if a screen reader is ACTIVE at all,
 * express never auto-dismisses; the operator dismisses explicitly, exactly as
 * they do for every non-VALID outcome. The state says `AUTO-DISMISS PAUSED` in
 * zone ⑨ so a sighted operator handing the phone over understands why the
 * cycling stopped. The admit itself is unaffected — express still admits with
 * zero taps.
 *
 * Reachable in the wild: an operator with Switch Control or VoiceOver on, or a
 * sighted operator handing the device to a colleague who uses one.
 */
export const useScreenReaderEnabled = (): boolean => {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch((err: unknown) => {
        // Degrade to "no screen reader" — the pre-existing behaviour, and never
        // a crash on the scan path. But NFR-006: this was a bare
        // `.catch(() => {})`, and it gates an NFR-002 acceptance criterion. If
        // this probe fails on a build, express keeps auto-DISMISSING for a
        // VoiceOver/TalkBack operator and the state vanishes mid-sentence —
        // with nothing anywhere saying why.
        //
        // `captureMessage`, not `captureException`: this is expected on
        // platforms that do not implement the API, and a per-mount exception
        // would manufacture an incident out of that.
        safeReport(() => {
          Sentry.captureMessage("screen_reader_probe_failed", {
            level: "warning",
            tags: { feature: "scan", branch: "screen_reader_probe_failed" },
            extra: { error: err instanceof Error ? err.message : String(err) },
          });
        });
      });

    const sub = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      (value: boolean) => setEnabled(value),
    );

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return enabled;
};
