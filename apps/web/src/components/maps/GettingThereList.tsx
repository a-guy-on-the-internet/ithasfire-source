"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Flag } from "lucide-react";
import { useTranslations } from "@th/ui";

import { DirectionsDropdown } from "@/components/actions/DirectionsDropdown";
import { ReportEntityDialog } from "@/components/community/ReportEntityDialog";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { authClient } from "@/lib/auth/auth-client";

import { ArrivalAreaSwatch } from "./ArrivalAreasLayer";
import {
  COST_LABEL_KEY,
  KIND_LABEL_KEY,
  legendKeyFor,
  type VisibleArrivalArea,
} from "./arrival-areas";
import styles from "./arrival-areas.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// "Getting there": the text twin of the arrival-areas map (arrival-areas
// FR-006, FR-007, FR-011, NFR-003, NFR-005). Board option A (owner R4).
//
// SEMANTICS. A list of disclosure buttons (`aria-expanded` + `aria-controls`),
// not a listbox: the open card holds real controls (Directions, Report), and
// an `option` may not contain interactive children. Every row is its own Tab
// stop, so a keyboard user reaches every area with Tab alone:
//   · focusing a row SELECTS it: the map highlights that shape
//     (acceptance: "tabbing through the list selects each area on the map");
//   · Enter / Space / click opens or closes its card;
//   · tapping a shape on the map selects the row and opens its card.
//
// The card opens under its row, not as a popover on the map (the board's
// sketch): the map frame clips overflow, which would cut off the Directions
// menu, and under the row it is the next Tab stop after the row.
//
// Labels and notes render as authored, untranslated (NFR-005). No booking
// links, no reverse geocoding (FR-007). NFR-002: nothing here logs a shape or
// a Directions point.
// ─────────────────────────────────────────────────────────────────────────────

type SelectionState = {
  id: string | null;
  open: boolean;
  /** Where the last change came from: a map tap scrolls its row into view. */
  from: "list" | "map";
};

export type ArrivalAreaSelection = {
  selectedId: string | null;
  openId: string | null;
  from: SelectionState["from"];
  /** A row got focus: highlight it on the map, close any other card. */
  focusRow: (id: string) => void;
  /** A row was activated: toggle its card. */
  activateRow: (id: string) => void;
  /** A shape was tapped: select it and open its card. */
  selectFromMap: (id: string) => void;
};

/**
 * One selection shared by the map layer and the list. Held by whichever
 * component renders both (the place logistics card, the event page), so the
 * two halves can live in different columns.
 */
export function useArrivalAreaSelection(
  areas: readonly VisibleArrivalArea[],
): ArrivalAreaSelection {
  const [state, setState] = useState<SelectionState>({
    id: null,
    open: false,
    from: "list",
  });

  const focusRow = useCallback((id: string) => {
    setState((prev) =>
      prev.id === id ? prev : { id, open: false, from: "list" },
    );
  }, []);
  const activateRow = useCallback((id: string) => {
    setState((prev) =>
      prev.id === id
        ? { id, open: !prev.open, from: "list" }
        : { id, open: true, from: "list" },
    );
  }, []);
  const selectFromMap = useCallback((id: string) => {
    setState({ id, open: true, from: "map" });
  }, []);

  // An area that left the list (the viewer state replaced it) is no longer
  // selectable; drop it rather than highlight a ghost.
  const present = state.id !== null && areas.some((a) => a.id === state.id);
  const selectedId = present ? state.id : null;

  return {
    selectedId,
    openId: present && state.open ? state.id : null,
    from: state.from,
    focusRow,
    activateRow,
    selectFromMap,
  };
}

export type GettingThereListProps = {
  areas: readonly VisibleArrivalArea[];
  selection: ArrivalAreaSelection;
  /**
   * The event page the areas are shown on. Sent with every report from an
   * event page (FR-011): the server checks the reporter's gate pass against
   * it.
   */
  seenOnEventId?: string;
};

export function GettingThereList({
  areas,
  selection,
  seenOnEventId,
}: GettingThereListProps) {
  const t = useTranslations();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [reportTarget, setReportTarget] = useState<VisibleArrivalArea | null>(
    null,
  );

  const { selectedId, openId, from } = selection;

  // A tap on the map brings its row into view (the list may sit in another
  // column, or below the fold on a phone). Never moves focus.
  useEffect(() => {
    if (from !== "map" || !selectedId) return;
    const row = rowRefs.current.get(selectedId);
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [from, selectedId]);

  if (areas.length === 0) return null;

  return (
    <section
      className={styles.root}
      aria-labelledby={headingId}
      data-testid="getting-there"
      // Hook for the sticky place sidebar / event rail: a column carrying
      // this list stops pinning, since it outgrows a laptop viewport.
      data-arrival-areas-list=""
    >
      <h3 id={headingId} className={styles.heading}>
        {String(t("arrivalAreas.heading"))}
      </h3>
      <ul className={styles.list}>
        {areas.map((area) => {
          const selected = area.id === selectedId;
          const open = area.id === openId;
          const cardId = `${baseId}-card-${area.id}`;
          return (
            <li key={area.id} className={styles.item}>
              <button
                type="button"
                ref={(node) => {
                  if (node) rowRefs.current.set(area.id, node);
                  else rowRefs.current.delete(area.id);
                }}
                className={styles.row}
                data-selected={selected ? "true" : undefined}
                data-testid="getting-there-row"
                aria-expanded={open}
                aria-controls={cardId}
                onFocus={() => selection.focusRow(area.id)}
                onClick={() => selection.activateRow(area.id)}
              >
                <ArrivalAreaSwatch kind={legendKeyFor(area)} />
                <span className={styles.rowMain}>
                  <span className={styles.rowLabel}>{area.label}</span>
                  <span className={styles.rowMeta}>{metaLine(area, t)}</span>
                </span>
              </button>
              <div
                id={cardId}
                className={styles.card}
                hidden={!open}
                data-testid="getting-there-card"
              >
                {open && (
                  <AreaCard
                    area={area}
                    onReport={() => setReportTarget(area)}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {reportTarget && (
        <ArrivalAreaReport
          area={reportTarget}
          seenOnEventId={seenOnEventId}
          onDone={() => setReportTarget(null)}
        />
      )}
    </section>
  );
}

type T = ReturnType<typeof useTranslations>;

/** "Parking · Paid · $10 after 6pm · Accessible spots" */
function metaLine(area: VisibleArrivalArea, t: T): string {
  const parts = [String(t(KIND_LABEL_KEY[area.kind]))];
  // Load-in has no price to speak of; say nothing rather than "Cost unknown".
  if (area.kind !== "LOAD_IN" || area.cost !== "UNKNOWN") {
    parts.push(String(t(COST_LABEL_KEY[area.cost])));
  }
  if (area.priceText) parts.push(area.priceText);
  if (area.accessibleSpots) parts.push(String(t("arrivalAreas.accessibleSpots")));
  return parts.join(" · ");
}

function AreaCard({
  area,
  onReport,
}: {
  area: VisibleArrivalArea;
  onReport: () => void;
}) {
  const t = useTranslations();
  const directionsLabel = String(t("arrivalAreas.directions"));
  return (
    <>
      {area.note && <p className={styles.note}>{area.note}</p>}
      <div className={styles.actions}>
        {area.directions && (
          <DirectionsDropdown
            // No label: the dropdown's "copy address" row copies its label,
            // and an area has no address to copy.
            coords={{
              latitude: area.directions.lat,
              longitude: area.directions.lng,
            }}
            labels={{
              trigger: directionsLabel,
              triggerAriaLabel: String(
                t("arrivalAreas.directionsTo", { label: area.label }),
              ),
              google: String(t("eventDetail.directionsGoogle")),
              apple: String(t("eventDetail.directionsApple")),
              waze: String(t("eventDetail.directionsWaze")),
            }}
          />
        )}
        <button
          type="button"
          className={styles.reportButton}
          onClick={onReport}
          aria-label={String(t("arrivalAreas.reportArea", { label: area.label }))}
        >
          <Flag size={14} aria-hidden="true" />
          {String(t("arrivalAreas.report"))}
        </button>
      </div>
    </>
  );
}

/**
 * The FR-011 report: the shared report dialog for a signed-in viewer, the
 * sign-in overlay for everyone else (the place hero's report pattern).
 */
function ArrivalAreaReport({
  area,
  seenOnEventId,
  onDone,
}: {
  area: VisibleArrivalArea;
  seenOnEventId?: string;
  onDone: () => void;
}) {
  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const sessionPending = session.isPending;
  const { showSignInOverlay } = useAppOverlay();
  const pathname = usePathname();

  useEffect(() => {
    if (sessionPending || isSignedIn) return;
    showSignInOverlay({ redirect: pathname ?? "/" });
    onDone();
  }, [sessionPending, isSignedIn, showSignInOverlay, pathname, onDone]);

  if (!isSignedIn) return null;
  return (
    <ReportEntityDialog
      subjectType="ARRIVAL_AREA"
      subjectId={area.id}
      subjectName={area.label}
      {...(seenOnEventId ? { seenOnEventId } : {})}
      open
      onOpenChange={(next) => {
        if (!next) onDone();
      }}
    />
  );
}
