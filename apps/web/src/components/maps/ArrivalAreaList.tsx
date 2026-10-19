"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useTranslations } from "@th/ui";

import { ArrivalAreaSwatch } from "./ArrivalAreasLayer";
import {
  COST_LABEL_KEY,
  KIND_LABEL_KEY,
  legendKeyFor,
} from "./arrival-areas";
import {
  toDisplayArea,
  type EditorArrivalArea,
} from "./arrival-areas-editor.helpers";
import styles from "./arrival-areas-editor.module.css";
// The swatch kind colours (`--aa-*`) are declared on the step-7 root.
import kindStyles from "./arrival-areas.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// The editor's area list: the keyboard twin of the map (NFR-003). Each row's
// main button selects the area (and its shape on the map); the move buttons
// reorder it without dragging; Remove asks once, in place.
//
// Flags (FR-014): an area with a point beyond 3 km of the pin is marked for
// the manager to check; an area with no readable shape is listed, not drawn,
// and can be redrawn or removed. Labels render as authored (NFR-005).
// ─────────────────────────────────────────────────────────────────────────────

export type ArrivalAreaListProps = {
  areas: readonly EditorArrivalArea[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: (area: EditorArrivalArea) => void;
  /** Reorder or remove in flight: the controls wait. */
  busy: boolean;
};

export function areaFlagKeys(area: EditorArrivalArea): string[] {
  const keys: string[] = [];
  if (area.geometryWithheld) keys.push("arrivalAreasEditor.flagWithheld");
  else if (!area.geometry) keys.push("arrivalAreasEditor.flagNoShape");
  if (area.outsideEnvelope && area.geometry) {
    keys.push("arrivalAreasEditor.flagOutside");
  }
  if (area.disabledAt) keys.push("arrivalAreasEditor.flagSwitchedOff");
  return keys;
}

export function ArrivalAreaList({
  areas,
  selectedId,
  onSelect,
  onMove,
  onRemove,
  busy,
}: ArrivalAreaListProps) {
  const t = useTranslations();
  const tr = (key: string, values?: Record<string, string | number>) =>
    String(t(key, values));
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The move just asked for, so focus can follow the row. The move buttons
  // are never natively `disabled` (that drops focus to <body> the moment a
  // row reaches an end, or while the reorder is in flight): `aria-disabled`
  // plus a guard in the handler. React also moves the keyed <li>, which
  // blurs the button inside it, so the same button is focused again by
  // area id once the order on screen changes, even at an end.
  const pendingFocus = useRef<{ id: string; dir: "up" | "down" } | null>(null);
  const order = areas.map((a) => a.id).join(",");
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    const root = listRef.current;
    if (!want || !root) return;
    const index = areas.findIndex((a) => a.id === want.id);
    if (index === -1) {
      pendingFocus.current = null;
      return;
    }
    // The SAME button, even at the edge: it is aria-disabled there, not
    // disabled, so it keeps focus and says why. Jumping to the other arrow
    // made a repeated Enter undo the move (measured in the drive).
    const button = root.querySelector<HTMLButtonElement>(
      `[data-move="${CSS.escape(want.id)}:${want.dir}"]`,
    );
    if (button && document.activeElement !== button) button.focus();
    // Keep the request until the move has landed (the id's index changed).
    if (button && document.activeElement === button) pendingFocus.current = null;
  }, [order, areas]);

  const requestMove = (id: string, index: number, delta: -1 | 1) => {
    const atEdge = delta === -1 ? index === 0 : index === areas.length - 1;
    if (busy || atEdge) return;
    pendingFocus.current = { id, dir: delta === -1 ? "up" : "down" };
    onMove(index, delta);
  };

  return (
    <div className={kindStyles.root}>
      <ul
        ref={listRef}
        className={styles.list}
        aria-label={tr("arrivalAreasEditor.listLabel")}
        data-testid="arrival-areas-editor-list"
      >
        {areas.map((area, index) => {
          const selected = area.id === selectedId;
          const meta = [
            tr(KIND_LABEL_KEY[area.kind]),
            area.kind === "LOAD_IN" ? null : tr(COST_LABEL_KEY[area.cost]),
            area.accessibleSpots ? tr("arrivalAreas.accessibleSpots") : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const flags = areaFlagKeys(area);
          return (
            <li
              key={area.id}
              className={styles.row}
              data-selected={selected ? "true" : undefined}
              data-testid="arrival-areas-editor-row"
            >
              <button
                type="button"
                className={styles.rowMain}
                aria-pressed={selected}
                onClick={() => onSelect(area.id)}
              >
                <ArrivalAreaSwatch kind={legendKeyFor(toDisplayArea(area))} />
                <span>
                  <span className={styles.rowLabel}>{area.label}</span>
                  <br />
                  <span className={styles.rowMeta}>{meta}</span>
                  {flags.map((key) => (
                    <span key={key}>
                      <br />
                      <span className={styles.rowFlag}>{tr(key)}</span>
                    </span>
                  ))}
                </span>
              </button>
              <span className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={tr("arrivalAreasEditor.moveUp", { label: area.label })}
                  aria-disabled={busy || index === 0 ? "true" : undefined}
                  data-move={`${area.id}:up`}
                  onClick={() => requestMove(area.id, index, -1)}
                >
                  <ArrowUp size={16} strokeWidth={2.5} aria-hidden />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={tr("arrivalAreasEditor.moveDown", { label: area.label })}
                  aria-disabled={busy || index === areas.length - 1 ? "true" : undefined}
                  data-move={`${area.id}:down`}
                  onClick={() => requestMove(area.id, index, 1)}
                >
                  <ArrowDown size={16} strokeWidth={2.5} aria-hidden />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={tr("arrivalAreasEditor.removeArea", { label: area.label })}
                  aria-expanded={confirmId === area.id}
                  aria-disabled={busy ? "true" : undefined}
                  onClick={() => {
                    if (busy) return;
                    setConfirmId((id) => (id === area.id ? null : area.id));
                  }}
                  data-testid="arrival-areas-editor-row-remove"
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </span>
              {confirmId === area.id ? (
                <div className={`${styles.confirm} ${styles.rowConfirm}`}>
                  <p>{tr("arrivalAreasEditor.removeConfirm", { label: area.label })}</p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={`${styles.textButton} ${styles.danger}`}
                      disabled={busy}
                      onClick={() => {
                        setConfirmId(null);
                        onRemove(area);
                      }}
                      data-testid="arrival-areas-editor-row-remove-confirm"
                    >
                      {tr("arrivalAreasEditor.removeConfirmYes")}
                    </button>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setConfirmId(null)}
                    >
                      {tr("arrivalAreasEditor.removeConfirmNo")}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
