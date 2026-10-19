"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { useTranslations } from "@th/ui";

import {
  DEFAULT_CALENDAR_LABELS,
  resolveCalendarLabels,
  type CalendarLabels,
} from "./labels";

const CalendarLabelsContext = createContext<CalendarLabels>(DEFAULT_CALENDAR_LABELS);
CalendarLabelsContext.displayName = "CalendarLabelsContext";

export const CalendarLabelsProvider = CalendarLabelsContext.Provider;

/** The engine's resolved labels; English defaults outside an engine. */
export function useCalendarLabels(): CalendarLabels {
  return useContext(CalendarLabelsContext);
}

/**
 * Catalog (`useTranslations`) + a mount's overrides → labels, memoised on the
 * translator and the overrides object.
 */
export function useResolvedCalendarLabels(
  overrides?: Partial<CalendarLabels>,
): CalendarLabels {
  const t = useTranslations();
  return useMemo(() => resolveCalendarLabels(t, overrides), [t, overrides]);
}

/**
 * A translator with a PER-KEY English fallback — the same contract
 * `resolveCalendarLabels` uses, exported for the MOUNTS.
 *
 * The app translator hands a missing key back verbatim, so a mount that calls
 * `t("admin.calAllCalendars")` before the key lands in the catalog renders the
 * raw key into the DOM. Every mount-owned string on a calendar surface goes
 * through this instead, so a catalog gap degrades to readable English rather
 * than to `admin.calAllCalendars`.
 *
 * The fallback carries the same `{name}` placeholders as the catalog entry and
 * is interpolated from `values` on a miss, so a parameterised string does not
 * degrade to a template with the braces still in it.
 */
export function useCalendarText(): (
  key: string,
  fallback: string,
  values?: Record<string, string | number>,
) => string {
  const t = useTranslations();
  return useCallback(
    (key, fallback, values) => {
      const value = String(t(key, values));
      if (value !== key) return value;
      if (!values) return fallback;
      return fallback.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      );
    },
    [t],
  );
}

/** The translated strings the browser-side .ics export writes into files. */
export function useIcsTexts(): {
  untitledTitle: string;
  viewEventText: (url: string) => string;
} {
  const ct = useCalendarText();
  return useMemo(
    () => ({
      untitledTitle: ct("admin.calUntitledEvent", "Untitled event"),
      viewEventText: (url: string) =>
        ct("admin.calIcsViewEvent", "View event: {url}", { url }),
    }),
    [ct],
  );
}
