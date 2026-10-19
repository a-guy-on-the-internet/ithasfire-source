"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import type { BookingIntent } from "./request-to-play-form.helpers";
import { readStandardsUnmet } from "./request-to-play-form.helpers";
import {
  buildStandardsChecklist,
  labelForSentence,
  unmetRequiredFields,
  type BookingStandardField,
  type BookingStandardsList,
  type BookingStandardsPayload,
  type StandardsChecklist,
  type StandardsChecklistItem,
} from "./booking-standards.helpers";
import styles from "./BookingStandards.module.css";
import formStyles from "./RequestToPlayBlock.module.css";

/**
 * The per-field half of the standards panel (board S2, combined with the S1
 * rail): each field the place lists carries a marker beside its label
 * ("Required" / "Suggested" / "Done") and the place's line under it, and the
 * REQUIRED ones turn into inline errors when Send is refused (V1).
 *
 * Validation timing follows the design system (§6a): nothing is flagged while
 * the reader types; a refused submit flags every unmet REQUIRED item and
 * focuses the first one in form order; editing a flagged field clears its
 * error; the next submit re-checks all of them.
 *
 * Markers and lines are not controls, so a rail item and a field marker for
 * the same field never compete for an accessible name. The marker and the
 * line are wired to the control with `aria-describedby`.
 */
export function useBookingStandards({
  placeId,
  idBase,
  list,
  intent,
  payload,
  placeName,
  controlIds,
}: {
  /** Keys the booking-options read refetched after a server refusal. */
  placeId: string;
  idBase: string;
  /** The routed (calendar, intent)'s list; null = no panel, no markers. */
  list: BookingStandardsList | null;
  intent: BookingIntent;
  /** The LIVE payload (`pitchStandardsPayload` / `spaceStandardsPayload`). */
  payload: BookingStandardsPayload;
  placeName: string | null;
  /**
   * The control each field's error belongs to, IN FORM ORDER — the first
   * unmet entry is where focus lands on a refused submit.
   */
  controlIds: Partial<Record<BookingStandardField, string>>;
}) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const translate = useCallback((key: string) => String(t(key)), [t]);

  const checklist = useMemo<StandardsChecklist | null>(
    () =>
      list ? buildStandardsChecklist({ list, intent, payload, translate }) : null,
    [list, intent, payload, translate],
  );

  const [flagged, setFlagged] = useState<ReadonlySet<BookingStandardField>>(
    () => new Set(),
  );
  // A calendar or intent switch swaps the list; errors raised against the old
  // one would point at items the reader can no longer see.
  useEffect(() => {
    setFlagged(new Set());
  }, [list]);

  const itemFor = useCallback(
    (field: BookingStandardField): StandardsChecklistItem | undefined =>
      checklist?.items.find((item) => item.field === field),
    [checklist],
  );

  const ids = (field: BookingStandardField) => ({
    marker: `${idBase}-std-${field}-marker`,
    line: `${idBase}-std-${field}-line`,
  });

  const withPlace = (
    keyWithName: string,
    keyNoName: string,
    values: Record<string, string | number>,
  ) =>
    placeName
      ? String(t(keyWithName, { place: placeName, ...values }))
      : String(t(keyNoName, values));

  const isRequired = (field: BookingStandardField) =>
    itemFor(field)?.required === true;

  const isFlagged = (field: BookingStandardField) =>
    flagged.has(field) && isRequired(field);

  const focusFirst = (fields: ReadonlySet<BookingStandardField>) => {
    const first = (Object.keys(controlIds) as BookingStandardField[]).find(
      (field) => fields.has(field),
    );
    const id = first ? controlIds[first] : undefined;
    if (id) document.getElementById(id)?.focus();
  };

  const summaryFor = (labels: readonly string[]) =>
    withPlace("admin.bkStdUnmetSummary", "admin.bkStdUnmetSummaryNoName", {
      items: labels.map(labelForSentence).join(", "),
    });

  return {
    checklist,

    /** Whether the place REQUIRES this field (drops "· Optional", sets aria-required). */
    isRequired,

    /** `aria-invalid` for the control: set only while its error is showing. */
    invalid: (field: BookingStandardField): true | undefined =>
      isFlagged(field) ? true : undefined,

    /** `aria-describedby` for the control: the marker and the line, after `extra`. */
    describedBy: (
      field: BookingStandardField,
      ...extra: (string | null | undefined | false)[]
    ): string | undefined => {
      const own = itemFor(field) ? [ids(field).marker, ids(field).line] : [];
      const all = [...extra.filter((id): id is string => Boolean(id)), ...own];
      return all.length > 0 ? all.join(" ") : undefined;
    },

    /** " · Optional" for the label — gone when the place requires the field. */
    optionalSuffix: (field: BookingStandardField): string =>
      isRequired(field) ? "" : ` · ${String(t("admin.bkFormOptional"))}`,

    /** Editing a flagged field clears its error at once (DS §6a). */
    clear: (field: BookingStandardField) => {
      setFlagged((prev) => {
        if (!prev.has(field)) return prev;
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
    },

    /** The marker beside a field's label, or nothing when the place lists none. */
    marker: (field: BookingStandardField): ReactNode => {
      const item = itemFor(field);
      if (!item) return null;
      const tone = item.satisfied
        ? styles.markerDone
        : isFlagged(field)
          ? styles.markerError
          : item.required
            ? styles.markerRequired
            : styles.markerSuggested;
      const text = item.satisfied
        ? t("admin.bkStdMarkerDone")
        : item.required
          ? t("admin.bkStdMarkerRequired")
          : t("admin.bkStdMarkerSuggested");
      return (
        <span id={ids(field).marker} className={`${styles.marker} ${tone}`}>
          {String(text)}
        </span>
      );
    },

    /** The place's line under a field: its requirement, or its label + hint. */
    line: (field: BookingStandardField): ReactNode => {
      const item = itemFor(field);
      if (!item) return null;
      const text = item.required
        ? withPlace("admin.bkStdFieldRequired", "admin.bkStdFieldRequiredNoName", {
            item: labelForSentence(item.label),
          })
        : item.hint
          ? String(
              t("admin.bkStdFieldSuggestedHint", {
                item: labelForSentence(item.label),
                hint: item.hint,
              }),
            )
          : String(
              t("admin.bkStdFieldSuggested", {
                item: labelForSentence(item.label),
              }),
            );
      return (
        <p
          id={ids(field).line}
          className={
            isFlagged(field)
              ? `${formStyles.errorText} ${styles.fieldLine}`
              : `${formStyles.fieldHint} ${styles.fieldLine}`
          }
        >
          {text}
        </p>
      );
    },

    /**
     * Flags what the LIVE payload leaves unmet — for a submit the builder
     * already refused for another reason, so every problem shows at once.
     * Does not move focus (the builder's own error owns that moment).
     */
    flagLive: () => {
      const fields = new Set(
        (checklist?.unmetRequired ?? []).map((item) => item.field),
      );
      setFlagged(fields);
    },

    /**
     * The submit gate (V1), over the BUILT payload — the same function and
     * the same list the server checks. Returns the summary to show, or null
     * when nothing REQUIRED is missing.
     */
    gate: (built: BookingStandardsPayload): string | null => {
      const fields = new Set(unmetRequiredFields(list, built));
      setFlagged(fields);
      if (fields.size === 0) return null;
      focusFirst(fields);
      const labels = (checklist?.items ?? [])
        .filter((item) => fields.has(item.field))
        .map((item) => item.label);
      return summaryFor(labels);
    },

    /**
     * A server STANDARDS_UNMET (the place changed its list after the form
     * loaded, or the client missed something): flag the items this form
     * knows and name every one the server listed, in the place's words.
     * Refetches the booking options so the rail and markers show the
     * place's current list. Null for any other error.
     */
    serverError: (err: unknown): string | null => {
      const items = readStandardsUnmet(err);
      if (items === null) return null;
      // Partial input: matches the place page's `{ placeId }` entry and any
      // owner-scoped one for the same place.
      void utils.places.getBookingOptions.invalidate({ placeId });
      if (items.length === 0) return String(t("admin.bkErrStandardsUnmet"));
      const fields = new Set(items.map((item) => item.field));
      setFlagged(fields);
      focusFirst(fields);
      return summaryFor(items.map((item) => item.label));
    },
  };
}

export type BookingStandardsUi = ReturnType<typeof useBookingStandards>;
