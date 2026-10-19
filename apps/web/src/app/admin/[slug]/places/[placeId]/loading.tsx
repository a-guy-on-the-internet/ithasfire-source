"use client";

import { LoadingIndicator } from "@th/ui";

/**
 * Route-segment loading UI for the per-place editor sections (page, edit,
 * layout, calendar, bookings, volunteers). Without this boundary, navigating
 * into a place editor via `router.push` (the places table row-action menu and
 * detail panel both use it, with no pending state) showed nothing while the
 * segment compiled/fetched — the UI felt frozen. This surfaces the shared
 * LoadingIndicator during that wait for every entry point automatically.
 */
export default function PlaceEditorSegmentLoading() {
  return (
    <LoadingIndicator
      label={null}
      size="lg"
      width="100%"
      minHeight={320}
      paddingVertical="$8"
      qaId="place-editor-segment-loading"
      testID="place-editor-segment-loading"
    />
  );
}
