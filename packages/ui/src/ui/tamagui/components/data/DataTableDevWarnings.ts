// Dev-only, once-per-module warnings. Same idiom as `Button`'s icon-only
// a11y warning: production builds skip them, and a re-rendering table can't
// flood the console.

let warnedNativeRemoved = false;
let warnedSelectionSearchWithoutRowKey = false;

/** `DataTable` renders nothing on native: the native renderer was removed. */
export function warnNativeRendererRemoved() {
  if (process.env.NODE_ENV !== "production" && !warnedNativeRemoved) {
    warnedNativeRemoved = true;
    console.warn(
      "[@th/ui DataTable] rendered on native, where it renders nothing: the native renderer was removed on 2026-10-06. Rebuild it if an Expo screen needs a table. (Further occurrences suppressed.)",
    );
  }
}

/**
 * Without `getRowKey` a row's key is its index, so a selection made under a
 * search pins to the row's POSITION and lands on a different row once the
 * search clears.
 */
export function warnSelectionWithSearchNeedsRowKey() {
  if (
    process.env.NODE_ENV !== "production" &&
    !warnedSelectionSearchWithoutRowKey
  ) {
    warnedSelectionSearchWithoutRowKey = true;
    console.warn(
      "[@th/ui DataTable] `selectable` and `clientSearch` are used without `getRowKey`. Row keys fall back to the row index, so a selection made while a search is active moves to a different row when the search clears. Pass a stable `getRowKey`. (Further occurrences suppressed.)",
    );
  }
}
