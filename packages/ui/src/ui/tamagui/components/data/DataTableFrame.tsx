import type { ReactNode, Ref } from "react";

import type { DataTableColumnLayout } from "./DataTableColumns";
import { tableWrapperStyle } from "./DataTableStyles";
import type { DataTableDensity } from "./DataTableTypes";

interface DataTableFrameProps {
  testId: string;
  qaId: string;
  density: DataTableDensity;
  resizable: boolean;
  scrollContainer: boolean;
  caption: string | undefined;
  tableRef: Ref<HTMLTableElement>;
  columnLayouts: DataTableColumnLayout[];
  /**
   * Pixel widths by column id, set from the first resize drag onwards. Empty
   * until then, so the `<col>`s keep their % layout (the checkbox column its
   * fixed px) and the table stays fluid.
   */
  columnWidths: Record<string, number>;
  /** The `<thead>`, or null when `showHeader` is off. */
  header: ReactNode;
  /** The `<tbody>` for the current state (loading, empty or data). */
  children: ReactNode;
}

/**
 * Everything around a table body: automation wrapper, `<table>`, caption,
 * `<colgroup>` and header. The loading, empty and data states all render
 * through this one frame, so the header geometry cannot drift between them
 * and the layout does not jump as data arrives.
 */
export function DataTableFrame({
  testId,
  qaId,
  density,
  resizable,
  scrollContainer,
  caption,
  tableRef,
  columnLayouts,
  columnWidths,
  header,
  children,
}: DataTableFrameProps) {
  return (
    <div
      data-testid={testId}
      data-qa={qaId}
      // No overflow here by default: an inner `overflow` wrapper would
      // become the scroll container and defeat the sticky <thead> —
      // scrolling belongs to the nearest scrolling ancestor (e.g. the
      // admin TableContainer). `scrollContainer` restores a single
      // overflow wrapper for standalone usages.
      style={tableWrapperStyle(scrollContainer)}
    >
      <table
        ref={tableRef}
        data-density={density}
        style={{
          width: "100%",
          borderCollapse: "separate",
          borderSpacing: 0,
          tableLayout: resizable ? "fixed" : undefined,
        }}
      >
        {caption ? (
          <caption style={{ textAlign: "left" }}>{caption}</caption>
        ) : null}

        <colgroup>
          {columnLayouts.map((col) => {
            const pxW = columnWidths[col.id] ?? col.fixedPx;
            return (
              <col
                key={col.id}
                style={
                  pxW
                    ? { width: pxW, minWidth: pxW, maxWidth: pxW }
                    : col.width
                      ? { width: `${col.width}%` }
                      : undefined
                }
              />
            );
          })}
        </colgroup>

        {header}
        {children}
      </table>
    </div>
  );
}
