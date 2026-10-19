// Pure helpers behind the series edit-scope dialog (recurring-series redesign
// Phase 3). Kept free of React/Tamagui so the unit suite imports the REAL
// functions — no mirrored local copies (same discipline as
// recurrence-helpers.ts / series-dates-helpers.ts).

/** The three choices in the "Apply changes to" dialog. */
export type SeriesEditScope = "this" | "following" | "all";

export const SERIES_EDIT_SCOPES: readonly SeriesEditScope[] = [
  "this",
  "following",
  "all",
];

/**
 * Dialog choice → `series.syncSeriesDrafts` `scope` argument.
 * `null` = no sync call at all ("This show only" — the normal save path).
 */
export function syncScopeForChoice(
  scope: SeriesEditScope,
): "future" | "all" | null {
  switch (scope) {
    case "this":
      return null;
    case "following":
      return "future";
    case "all":
      return "all";
  }
}

/**
 * Whether the scope dialog offers "Also replace parking and drop-off areas on
 * these shows" (owner ruling Q13, arrival areas): only when the save will sync
 * sibling drafts at all ("following" / "all"), and only with the
 * `arrivalAreas` gate on.
 */
export function offersArrivalAreaSync(
  scope: SeriesEditScope,
  arrivalAreasGateOn: boolean,
): boolean {
  return arrivalAreasGateOn && syncScopeForChoice(scope) !== null;
}

/**
 * The `includeArrivalAreas` flag a save sends to `series.syncSeriesDrafts`.
 * True only when the box was offered AND ticked; it is unticked by default,
 * so a sync never replaces a sibling's areas unless the organiser asked.
 */
export function includeArrivalAreasForSave(params: {
  scope: SeriesEditScope;
  arrivalAreasGateOn: boolean;
  ticked: boolean;
}): boolean {
  return (
    params.ticked &&
    offersArrivalAreaSync(params.scope, params.arrivalAreasGateOn)
  );
}

/**
 * The `includeArrivalAreas` part of a `series.syncSeriesDrafts` input: the key
 * is present only when it is true. An unticked save sends no key at all, so a
 * web build that is ahead of the API (a web-first deploy, an API rollback)
 * keeps syncing drafts against a strict input schema that predates the field;
 * only the opt-in itself needs the newer API.
 */
export function arrivalAreasSyncField(
  includeArrivalAreas: boolean,
): { includeArrivalAreas?: true } {
  return includeArrivalAreas ? { includeArrivalAreas: true } : {};
}

/**
 * Whether the pre-save scope dialog applies. Only events that ALREADY belong
 * to a series ask; non-series events and the convert flow (recurrence enabled
 * on a non-series event) save without asking — there are no sibling drafts to
 * propagate onto until after the first generate. (The builder is always in
 * edit mode since FR-302 — the old `isEditMode` input is gone.)
 */
export function shouldOfferScopeDialog(params: {
  seriesId: string | null | undefined;
}): boolean {
  return Boolean(params.seriesId);
}

/** Result counts of series.syncSeriesDrafts (structural mirror). */
export type SyncSeriesDraftsResultCounts = {
  updatedDraftCount: number;
  skippedPublishedCount: number;
  skippedPastCount: number;
};

/**
 * Composes the post-sync success toast: "Updated N draft shows." plus — only
 * when published dates were skipped — "M published dates unchanged — edit
 * them individually." The translate function is injected so this stays pure
 * (tests assert key/param wiring without a locale provider).
 */
export function composeSyncToastMessage(
  translate: (key: string, params?: Record<string, number>) => string,
  result: SyncSeriesDraftsResultCounts,
): string {
  const base = translate("admin.ebScopeSyncedMessage", {
    count: result.updatedDraftCount,
  });
  if (result.skippedPublishedCount > 0) {
    return `${base} ${translate("admin.ebScopeSyncedPublishedNote", {
      count: result.skippedPublishedCount,
    })}`;
  }
  return base;
}
