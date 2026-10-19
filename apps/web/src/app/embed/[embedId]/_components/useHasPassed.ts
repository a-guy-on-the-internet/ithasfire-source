import { useEffect, useState } from "react";

/**
 * Whether the moment `until` has passed. False while `until` is null or
 * cannot be read as a date.
 *
 * Checked when it is due, and again whenever the page comes back into view
 * or regains focus: a timer set for 15 minutes does not fire on time on a
 * device that slept through it, and the buyer's first sight of the page after
 * waking must not be a reservation that ended a while ago.
 */
export function useHasPassed(until: string | null): boolean {
  // The `until` that was seen to pass, so a new `until` starts unpassed
  // without waiting for an effect to reset anything.
  const [passed, setPassed] = useState<string | null>(null);

  useEffect(() => {
    if (!until) return;
    const at = new Date(until).getTime();
    if (Number.isNaN(at)) return;

    let timer: number | undefined;
    const check = () => {
      window.clearTimeout(timer);
      const remainingMs = at - Date.now();
      if (remainingMs <= 0) {
        setPassed(until);
        return;
      }
      // Re-armed on every check, so a timer that fired early waits again.
      timer = window.setTimeout(check, remainingMs);
    };

    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [until]);

  return until !== null && passed === until;
}
