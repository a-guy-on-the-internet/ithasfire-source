"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useTranslations } from "@th/ui";

import {
  labelForSentence,
  type StandardsChecklist,
} from "./booking-standards.helpers";
import styles from "./BookingStandards.module.css";

/** Remembers, per place, that the reader has seen its list once. */
const SEEN_KEY_PREFIX = "th:booking-standards-seen:";

function hasSeen(placeId: string): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY_PREFIX + placeId) === "1";
  } catch {
    return false;
  }
}

function markSeen(placeId: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY_PREFIX + placeId, "1");
  } catch {
    // Private mode / storage disabled: the list just opens unfolded again.
  }
}

/**
 * "What {place} expects" (venue-booking-standards FR-005, board S1): the one
 * "what's left" view. The place's own wording, a live tick per item with a
 * text equivalent in its marker ("Suggested · done"), a count of KNOWN items
 * only (custom lines never count), the custom lines as guidance (V6), and
 * "See an example pitch" (place examples first, then the platform's).
 *
 * Layout is the CSS's job, by container width, so the dialog, the narrow
 * dialog and the in-page block all get the right one without a JS
 * breakpoint:
 *   - wide (≥ 45rem of form): a rail beside the fields, always open; the
 *     fold button is not rendered visually.
 *   - narrow: a real disclosure button above the fields. The first time a
 *     reader meets a place's list it is open; after that it starts folded
 *     ("collapsible after the first view"), its summary naming the count and
 *     the first REQUIRED item still missing.
 */
export function BookingStandardsRail({
  idBase,
  placeId,
  placeName,
  calendarName,
  checklist,
}: {
  idBase: string;
  placeId: string;
  placeName: string | null;
  /** The routed calendar ("For Weeknight shows"); null when unrouted. */
  calendarName: string | null;
  checklist: StandardsChecklist;
}) {
  const t = useTranslations();
  const ids = {
    title: `${idBase}-std-title`,
    body: `${idBase}-std-body`,
    examples: `${idBase}-std-examples`,
    examplesHeading: `${idBase}-std-examples-heading`,
  };

  const [expanded, setExpanded] = useState(() => !hasSeen(placeId));
  useEffect(() => {
    markSeen(placeId);
  }, [placeId]);

  const [examplesOpen, setExamplesOpen] = useState(false);
  const examplesHeadingRef = useRef<HTMLParagraphElement>(null);
  const focusExamplesOnOpen = useRef(false);
  useEffect(() => {
    if (examplesOpen && focusExamplesOnOpen.current) {
      focusExamplesOnOpen.current = false;
      examplesHeadingRef.current?.focus();
    }
  }, [examplesOpen]);

  const withPlace = (
    keyWithName: string,
    keyNoName: string,
    values: Record<string, string | number> = {},
  ) =>
    placeName
      ? String(t(keyWithName, { place: placeName, ...values }))
      : String(t(keyNoName, values));

  const title = withPlace("admin.bkStdRailTitle", "admin.bkStdRailTitleNoName");
  const { items, customLines, done, total, unmetRequired, examples } = checklist;

  const progress = String(t("admin.bkStdProgress", { done, total }));
  const foldSummary =
    total === 0
      ? String(t("admin.bkStdFoldNotesOnly", { count: customLines.length }))
      : unmetRequired.length === 1
        ? String(
            t("admin.bkStdFoldOneRequired", {
              done,
              total,
              item: labelForSentence(unmetRequired[0]!.label),
            }),
          )
        : unmetRequired.length > 1
          ? String(
              t("admin.bkStdFoldManyRequired", {
                done,
                total,
                count: unmetRequired.length,
              }),
            )
          : progress;

  return (
    <section className={styles.rail} aria-labelledby={ids.title}>
      <div className={styles.railHead}>
        <p className={styles.railTitle} id={ids.title}>
          {title}
        </p>
        {calendarName && (
          <p className={styles.railKicker}>
            {String(t("admin.bkStdForCalendar", { calendar: calendarName }))}
          </p>
        )}
      </div>

      <button
        type="button"
        className={styles.foldButton}
        aria-expanded={expanded}
        aria-controls={ids.body}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className={styles.foldText}>
          <span className={styles.foldTitle}>{title}</span>
          <span className={styles.foldSummary}>{foldSummary}</span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden
          className={expanded ? styles.chevronOpen : styles.chevron}
        />
      </button>

      <div
        id={ids.body}
        className={expanded ? styles.railBody : `${styles.railBody} ${styles.railBodyFolded}`}
      >
        {calendarName && (
          <p className={`${styles.railKicker} ${styles.railKickerNarrow}`}>
            {String(t("admin.bkStdForCalendar", { calendar: calendarName }))}
          </p>
        )}

        {total > 0 && (
          <div className={styles.progress}>
            <p className={styles.progressCount}>{progress}</p>
            <div className={styles.progressBar} aria-hidden>
              {items.map((item) => (
                <span
                  key={item.field}
                  className={
                    item.satisfied ? styles.progressSegmentDone : styles.progressSegment
                  }
                />
              ))}
            </div>
          </div>
        )}

        {items.length > 0 && (
          <ul className={styles.items}>
            {items.map((item) => (
              <li key={item.field} className={styles.item}>
                <span
                  className={item.satisfied ? styles.tickDone : styles.tick}
                  aria-hidden
                >
                  {item.satisfied && <Check size={12} strokeWidth={3} />}
                </span>
                <span className={styles.itemText}>
                  <span
                    className={
                      item.satisfied ? styles.itemLabelDone : styles.itemLabel
                    }
                  >
                    {item.label}
                  </span>
                  <span
                    className={`${styles.marker} ${
                      item.required && !item.satisfied
                        ? styles.markerRequired
                        : styles.markerSuggested
                    }`}
                  >
                    {String(
                      t(
                        item.required
                          ? item.satisfied
                            ? "admin.bkStdMarkerRequiredDone"
                            : "admin.bkStdMarkerRequired"
                          : item.satisfied
                            ? "admin.bkStdMarkerSuggestedDone"
                            : "admin.bkStdMarkerSuggested",
                      ),
                    )}
                  </span>
                  {item.hint && <span className={styles.itemHint}>{item.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        {customLines.length > 0 && (
          <div className={styles.custom}>
            <p className={styles.customKicker}>
              {withPlace("admin.bkStdFromPlace", "admin.bkStdFromPlaceNoName")}
            </p>
            <ul className={styles.customList}>
              {customLines.map((line, index) => (
                <li key={index} className={styles.customLine}>
                  <span className={styles.customLabel}>{line.label}</span>
                  {line.hint && (
                    <span className={styles.itemHint}>{line.hint}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {examples.length > 0 && (
          <>
            <button
              type="button"
              className={styles.railButton}
              aria-expanded={examplesOpen}
              aria-controls={ids.examples}
              onClick={() => {
                focusExamplesOnOpen.current = !examplesOpen;
                setExamplesOpen((open) => !open);
              }}
            >
              {String(t("admin.bkStdSeeExample"))}
            </button>
            <div
              id={ids.examples}
              className={styles.examples}
              hidden={!examplesOpen}
              role="group"
              aria-labelledby={ids.examplesHeading}
            >
              <p
                id={ids.examplesHeading}
                ref={examplesHeadingRef}
                tabIndex={-1}
                className={styles.examplesHeading}
              >
                {String(t("admin.bkStdExamplesHeading"))}
              </p>
              {examples.map((example) => (
                <article key={example.key} className={styles.example}>
                  <p className={styles.exampleSource}>
                    {example.source === "place"
                      ? withPlace(
                          "admin.bkStdFromPlace",
                          "admin.bkStdFromPlaceNoName",
                        )
                      : String(t("admin.bkStdExampleFromPlatform"))}
                  </p>
                  <p className={styles.exampleTitle}>{example.title}</p>
                  <p className={styles.exampleBody}>{example.body}</p>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
