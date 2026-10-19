"use client";

import { useTranslations } from "@th/ui";

import {
  ViewModeToggle,
  type EditorViewMode,
} from "@/components/editor/ViewModeToggle";

/** Builder main-column mode: the authoring form or the in-place preview. */
export type EventViewMode = EditorViewMode;

export type EventViewModeToggleProps = {
  value: EventViewMode;
  onChange: (mode: EventViewMode) => void;
};

/**
 * Edit | Preview segmented control for the event builder header (D4
 * reversed, 2026-07-28): Preview swaps the builder's main column to the
 * in-place EventPreview fed with the CURRENT in-memory form state, so
 * unsaved edits preview live — the property the old Preview tab had and the
 * new-tab link (which only shows saved state) lost.
 *
 * Thin wrapper over the shared {@link ViewModeToggle} (the entity page editor
 * ships the same control): this file owns only the builder's i18n keys and
 * test ids.
 */
export function EventViewModeToggle({
  value,
  onChange,
}: EventViewModeToggleProps) {
  const t = useTranslations();

  return (
    <ViewModeToggle
      value={value}
      onChange={onChange}
      groupLabel={String(t("admin.ebViewModeLabel"))}
      testId="event-view-mode-toggle"
      segments={[
        {
          value: "edit",
          label: String(t("admin.ebTabEdit")),
          testId: "view-mode-edit",
        },
        {
          value: "preview",
          label: String(t("admin.ebTabPreview")),
          testId: "view-mode-preview",
          keyShortcuts: "Meta+Shift+P Control+Shift+P",
        },
      ]}
    />
  );
}
