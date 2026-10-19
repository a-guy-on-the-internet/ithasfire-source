"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

import { useFocusTrap } from "./useFocusTrap";

/**
 * The phone sheet, with the clear-confirm dialog able to open over it.
 *
 * While the confirm is open it owns the keyboard:
 * - the sheet's Tab trap is off, so it does not pull focus back into the
 *   sheet the dialog has made inert;
 * - a close request for the sheet is ignored, and so is the one Escape that
 *   closes the confirm. `BottomSheet` and `Modal` both listen for Escape on
 *   `window`, so without this one key press closes both.
 *
 * Returns the guarded close to hand to `BottomSheet`'s `onClose`.
 */
export function useSheetUnderConfirm({
  scopeRef,
  sheetOpen,
  confirmOpen,
  closeSheet,
}: {
  scopeRef: RefObject<HTMLElement | null>;
  sheetOpen: boolean;
  confirmOpen: boolean;
  closeSheet: () => void;
}): () => void {
  const confirmOpenRef = useRef(confirmOpen);
  // Set by the Escape that closes the confirm, before any bubble listener
  // runs, and cleared once that key press has been handled everywhere.
  const escapeTakenRef = useRef(false);

  useEffect(() => {
    confirmOpenRef.current = confirmOpen;
    if (!confirmOpen) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      escapeTakenRef.current = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        escapeTakenRef.current = false;
      }, 0);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [confirmOpen]);

  useFocusTrap(scopeRef, sheetOpen && !confirmOpen);

  return useCallback(() => {
    if (confirmOpenRef.current || escapeTakenRef.current) return;
    closeSheet();
  }, [closeSheet]);
}
