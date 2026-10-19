"use client";

import { useEffect, useRef, useState } from "react";

/** Smallest pixel width a column can be dragged down to (web resize). */
const MIN_COL_WIDTH = 32;

/** Drag start width for a column missing from the stored widths. */
const FALLBACK_COL_WIDTH = 120;

/** Current rendered width of every `<th data-col-id>` in `table`. */
function measureColumnWidths(table: HTMLTableElement | null) {
  const widths: Record<string, number> = {};
  table?.querySelectorAll<HTMLTableCellElement>("thead th").forEach((th) => {
    const colId = th.dataset.colId;
    if (colId) widths[colId] = th.getBoundingClientRect().width;
  });
  return widths;
}

/**
 * Resizable-column state (web only; pass `enabled: false` elsewhere).
 *
 * Attach `tableRef` to the `<table>`. Nothing is measured at mount or on
 * press, so the `<col>` widths stay fluid until the user actually drags. The
 * first move of each drag reads the `<th data-col-id>` width of every column
 * that has no stored width yet (all of them on the first drag, any column
 * added since on later ones) into `columnWidths`, then applies the delta to
 * the dragged column. Stored widths are the user's choices and are never
 * re-measured.
 */
export function useDataTableColumnResize(enabled: boolean) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Mirrors `columnWidths` synchronously, so a drag that starts (or moves)
  // before React has re-rendered the previous drag's last move still sees it.
  const widthsRef = useRef<Record<string, number>>({});
  const commitWidths = (next: Record<string, number>) => {
    widthsRef.current = next;
    setColumnWidths(next);
  };
  // Tears down an in-flight drag (document listeners + resize classes).
  // Held in a ref so unmounting mid-drag can run it.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const onResizePointerDown = (e: React.PointerEvent, colId: string) => {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    // A new drag supersedes any drag still in flight.
    dragCleanupRef.current?.();
    const startX = e.clientX;
    // Set on the first move; a press with no move changes no widths.
    let startW: number | null = null;

    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("dt-resizing");
    tableRef.current?.classList.add("dt-resizing");

    // Capture pointer so moves outside the table still track.
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (startW === null) {
        // Pens and touch often report a move at the press point before
        // release; that is still a click, so it must not pin the table.
        if (ev.clientX === startX) return;
        // First real move: pin every column that has no stored width at its
        // current width, so only the dragged one moves.
        const measured = measureColumnWidths(tableRef.current);
        const missing = Object.keys(measured).some(
          (id) => !Object.hasOwn(widthsRef.current, id),
        );
        if (missing) commitWidths({ ...measured, ...widthsRef.current });
        startW = widthsRef.current[colId] ?? FALLBACK_COL_WIDTH;
      }
      const newW = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
      commitWidths({ ...widthsRef.current, [colId]: newW });
    };

    const onUp = () => {
      handle.classList.remove("dt-resizing");
      tableRef.current?.classList.remove("dt-resizing");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (dragCleanupRef.current === onUp) dragCleanupRef.current = null;
    };
    dragCleanupRef.current = onUp;

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    // A cancelled pointer (touch scroll takeover, OS gesture) ends the drag.
    document.addEventListener("pointercancel", onUp);
  };

  return { tableRef, columnWidths, onResizePointerDown };
}
