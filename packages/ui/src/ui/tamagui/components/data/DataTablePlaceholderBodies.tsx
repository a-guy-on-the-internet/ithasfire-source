import type { ReactNode } from "react";
import { YStack } from "tamagui";

import { bodyCellPadding } from "./DataTableStyles";
import type { DataTableColumn, DataTableDensity } from "./DataTableTypes";
import { DT_BORDER_SOFT, DT_SURFACE_MUTED } from "./tokens";

function SkeletonBlock({ widthPercent = 70 }: { widthPercent?: number }) {
  // A tiny, dependency-free skeleton that looks reasonable in both themes.
  return (
    <div
      aria-hidden="true"
      style={{
        height: 12,
        width: `${widthPercent}%`,
        borderRadius: 0,
        background: DT_SURFACE_MUTED,
      }}
    />
  );
}

/** Loading-state `<tbody>`: placeholder rows shaped like the real columns. */
export function DataTableSkeletonBody<TRow>({
  columns,
  density,
  rowCount,
}: {
  columns: Array<DataTableColumn<TRow>>;
  density: DataTableDensity;
  rowCount: number;
}) {
  return (
    <tbody>
      {Array.from({ length: rowCount }).map((_, rowIndex) => (
        <tr key={`skeleton-${rowIndex}`}>
          {columns.map((col, colIndex) => (
            <td
              key={col.id}
              style={{
                textAlign: col.align ?? "left",
                padding: bodyCellPadding(density),
                borderBottom: `1px solid ${DT_BORDER_SOFT}`,
                verticalAlign: "middle",
              }}
            >
              <SkeletonBlock widthPercent={((colIndex * 17 + 35) % 60) + 30} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * Empty-state `<tbody>`: one full-width cell so the empty state sits visually
 * *inside* the table container, under the same header as the data.
 */
export function DataTableEmptyBody({
  columnCount,
  children,
}: {
  columnCount: number;
  children: ReactNode;
}) {
  return (
    <tbody>
      <tr>
        {/* Opt out of the fixed-layout `word-break: break-word` cell rule
            (DataTableStyles): it lets a centred empty state shrink to its
            min-content width, wrapping the heading a few letters per line. */}
        <td
          colSpan={columnCount}
          style={{ padding: 0, wordBreak: "inherit", overflowWrap: "inherit" }}
        >
          <YStack
            padding="$6"
            alignItems="center"
            justifyContent="center"
            gap="$3"
          >
            {children}
          </YStack>
        </td>
      </tr>
    </tbody>
  );
}
