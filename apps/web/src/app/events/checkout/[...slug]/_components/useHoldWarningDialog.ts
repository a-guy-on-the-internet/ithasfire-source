import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";

import { CONFIRMATION_HEADING_ID } from "./confirmation-heading";

/**
 * How long a dialog closed BY the confirmation waits for the confirmation's
 * heading to mount (the order's totals can still be loading) before giving up.
 */
const HEADING_WAIT_MS = 10_000;

/**
 * Focus the confirmation's heading now, or as soon as it mounts. Stops early
 * if the buyer moves focus themselves meanwhile. Returns a cancel function.
 */
function focusConfirmationHeadingWhenMounted(): () => void {
  const focusHeading = () => {
    const heading = document.getElementById(CONFIRMATION_HEADING_ID);
    if (!heading) return false;
    heading.focus();
    return true;
  };
  if (focusHeading()) return () => {};
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (active && active !== document.body) {
      stop();
      return;
    }
    if (focusHeading()) stop();
  });
  const timer = window.setTimeout(() => stop(), HEADING_WAIT_MS);
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  return stop;
}

export type UseHoldWarningDialogResult = {
  showHoldWarning: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  cancelButtonRef: RefObject<HTMLButtonElement | null>;
  openHoldWarning: () => void;
  closeHoldWarning: (options?: { restoreFocus?: boolean }) => void;
  handleHoldWarningKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * State + a11y plumbing for the "release my hold?" confirmation dialog.
 * Owns:
 *   • show/hide state
 *   • return-focus tracking so the buyer lands back on the element they
 *     opened the dialog from (e.g. the "Change tickets" button)
 *   • focus-trap key handling (Tab cycles, Escape closes)
 *   • auto-focus the Cancel button on open
 *
 * Pulled out of Checkout.tsx so the 60-line setup doesn't sit in the
 * render body and so it can be reused if the dialog ever fires from a
 * second entry point.
 */
export function useHoldWarningDialog(
  options: {
    /**
     * Close (and stay closed) while true — the purchase is confirmed: a
     * "release your tickets?" dialog left open over the confirmation offered
     * to release tickets the buyer now owns.
     */
    forceClosed?: boolean;
  } = {},
): UseHoldWarningDialogResult {
  const { forceClosed = false } = options;
  const [showHoldWarning, setShowHoldWarning] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const cancelHeadingWaitRef = useRef<(() => void) | null>(null);

  const openHoldWarning = useCallback(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setShowHoldWarning(true);
  }, []);

  const closeHoldWarning = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      setShowHoldWarning(false);
      if (options?.restoreFocus === false) return;
      window.setTimeout(() => returnFocusRef.current?.focus(), 0);
    },
    [],
  );

  useEffect(() => {
    if (!showHoldWarning) return;
    window.setTimeout(() => {
      cancelButtonRef.current?.focus();
    }, 0);
  }, [showHoldWarning]);

  const handleHoldWarningKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHoldWarning();
        return;
      }

      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    },
    [closeHoldWarning],
  );

  useEffect(() => {
    if (!forceClosed || !showHoldWarning) return;
    // Closed BY the confirmation, not by the buyer: hand focus back to where
    // they opened it from, rather than leaving it on a removed dialog
    // (<body>, where screen readers lose their place).
    setShowHoldWarning(false);
    window.setTimeout(() => {
      const opener = returnFocusRef.current;
      // The opener ("Change tickets", the stepper) has usually unmounted
      // with the step: then the confirmation's heading takes focus. While
      // the order's totals load ("loading") there is no heading yet, so
      // wait for it to mount.
      if (opener?.isConnected) {
        opener.focus();
      } else {
        cancelHeadingWaitRef.current?.();
        cancelHeadingWaitRef.current = focusConfirmationHeadingWhenMounted();
      }
    }, 0);
  }, [forceClosed, showHoldWarning]);

  useEffect(() => () => cancelHeadingWaitRef.current?.(), []);

  return {
    showHoldWarning: showHoldWarning && !forceClosed,
    dialogRef,
    cancelButtonRef,
    openHoldWarning,
    closeHoldWarning,
    handleHoldWarningKeyDown,
  };
}
