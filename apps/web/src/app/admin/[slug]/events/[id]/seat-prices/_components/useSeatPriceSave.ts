"use client";

import { useCallback, useRef, useState, type Dispatch } from "react";

import { formatErrorMessage } from "@/lib/format-error-message";

import {
  forgetUnsent,
  saveInChunks,
  type SaveAction,
  type SaveCounts,
  type SaveOutcome,
} from "./seat-price-save";
import type { SelectionAction } from "./seat-price-selection";

/** One call to `events.setSeatPriceOverrides`, for at most 500 seats. */
export type SeatPriceWrite = (input: {
  seatIds: string[];
  priceOverride: { priceCents: number; reason?: string } | null;
}) => Promise<SaveCounts>;

export type UseSeatPriceSaveOptions = {
  write: SeatPriceWrite;
  /** Refetch the read. Called after every save, whatever happened. */
  refresh: () => Promise<unknown>;
  /** The page translator: `formatErrorMessage` needs it for refusal codes. */
  translate: (key: string) => string;
  dispatch: Dispatch<SelectionAction>;
};

export type SeatPriceSaveState = {
  saving: boolean;
  /** The last save's result, until dismissed or until the next save starts. */
  outcome: SaveOutcome | null;
  /**
   * Counts finished saves. It changes only when a SAVE produces a result,
   * never when `forgetFailure` trims one, so the editor moves focus to the
   * result for a save and not for a seat picked afterwards.
   */
  savedCount: number;
  dismiss: () => void;
  /** Drops the "not saved, still selected" part of a failed result. */
  forgetFailure: () => void;
  save: (
    seatIds: readonly string[],
    action: SaveAction,
    note: string | null,
  ) => Promise<SaveOutcome | null>;
};

/**
 * The save: chunks of 500 sent one after another, the result kept for the
 * banner, the selection left holding exactly what was not sent, and the read
 * refetched. Kept out of the editor so it can be tested without the page.
 */
export function useSeatPriceSave({
  write,
  refresh,
  translate,
  dispatch,
}: UseSeatPriceSaveOptions): SeatPriceSaveState {
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  // Closes the gap before `saving` re-renders: two presses in one tick must
  // not send the same seats twice.
  const savingRef = useRef(false);

  const save = useCallback<SeatPriceSaveState["save"]>(
    async (seatIds, action, note) => {
      if (savingRef.current || seatIds.length === 0) return null;
      savingRef.current = true;
      setSaving(true);
      // The old result describes the old save. It goes as this one starts,
      // so a retry never sits under the error it is retrying.
      setOutcome(null);
      try {
        const result = await saveInChunks(seatIds, (chunk) =>
          write({
            seatIds: chunk,
            priceOverride:
              action.kind === "set"
                ? {
                    priceCents: action.priceCents,
                    ...(note ? { reason: note } : {}),
                  }
                : null,
          }),
        );
        const failed = result.error !== null;
        const next: SaveOutcome = {
          action,
          counts: result.counts,
          unsentCount: result.unsentSeatIds.length,
          // Always with the translator: the refusal codes have no inline
          // fallback, and without it the organizer reads "Something went wrong".
          errorMessage: failed ? formatErrorMessage(result.error, translate) : null,
        };
        setOutcome(next);
        setSavedCount((count) => count + 1);
        // What was not sent stays selected, ready for another try.
        dispatch(
          failed
            ? { type: "keepOnly", seatIds: result.unsentSeatIds }
            : { type: "clear" },
        );
        // Refetch whatever happened: a partly failed save changed seats too.
        // A failed refetch shows on the page from the query's own state.
        await refresh().catch(() => undefined);
        return next;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [dispatch, refresh, translate, write],
  );

  const dismiss = useCallback(() => setOutcome(null), []);
  const forgetFailure = useCallback(
    () => setOutcome((current) => (current ? forgetUnsent(current) : current)),
    [],
  );

  return { saving, outcome, savedCount, dismiss, forgetFailure, save };
}
