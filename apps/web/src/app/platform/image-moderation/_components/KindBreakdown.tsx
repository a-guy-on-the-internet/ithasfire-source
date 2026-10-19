"use client";

import { useId, useMemo, type CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import { Button, DataTable, Text, type DataTableColumn } from "@th/ui";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  QUEUE_SIGNALS,
  breakdownRows,
  formatCount,
  signalTitle,
  type BreakdownRow,
  type QueueCounts,
} from "./image-moderation-ops.helpers";

/**
 * The same five counts, split by image kind.
 *
 * `EVENT_HERO` failing while `AVATAR` is fine points straight at a code path —
 * one upload route, one resizer, one bucket prefix — which a single number
 * never can. That makes it the first question after "how bad", and the second
 * thing on the page, never the first.
 *
 * COLLAPSED BY DEFAULT, AND THE QUERY IS GATED ON THE DISCLOSURE. It is
 * supporting evidence; expanding it is the operator saying they have a
 * hypothesis. Keeping it shut also keeps a per-kind aggregate off every page
 * load.
 *
 * IT IS COMPUTED FROM THE SNAPSHOT'S OWN CUTOFFS, passed back verbatim, exactly
 * like the drill-down — so the columns provably sum to the tiles above them
 * rather than to a window derived forty seconds later.
 */

const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };

const PANEL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  width: "100%",
  minWidth: 0,
};

export type KindBreakdownProps = {
  expanded: boolean;
  onToggle: () => void;
  data:
    | {
        byKind: Record<
          "EVENT_HERO" | "AVATAR" | "BANNER" | "PAGE_MEDIA",
          QueueCounts
        >;
        unrecognizedKinds: QueueCounts;
      }
    | undefined;
  isLoading: boolean;
  errorMessage?: string;
  onRetry: () => void;
};

export function KindBreakdown({
  expanded,
  onToggle,
  data,
  isLoading,
  errorMessage,
  onRetry,
}: KindBreakdownProps) {
  const panelId = useId();

  const rows = useMemo<BreakdownRow[]>(
    () => (data ? breakdownRows(data) : []),
    [data],
  );

  const columns = useMemo<DataTableColumn<BreakdownRow>[]>(
    () => [
      {
        id: "kind",
        header: "Image kind",
        width: 22,
        truncate: false,
        cell: (row) => (
          <YStack gap={2} minWidth={0}>
            <Text variant="bodySmall" weight="bold">
              {row.label}
            </Text>
            {/* A kind the app does not recognise is a DATA-QUALITY finding, not
                a category. Said out loud, because without this row the columns
                visibly fail to sum to the tiles. */}
            {row.unrecognized ? (
              <Text variant="caption" tone="muted">
                Not one of the four known kinds — a typo'd or retired value.
              </Text>
            ) : null}
          </YStack>
        ),
      },
      ...QUEUE_SIGNALS.map<DataTableColumn<BreakdownRow>>((signal) => ({
        id: signal,
        header: signalTitle(signal),
        width: 13,
        align: "right" as const,
        noWrap: true,
        sortValue: (row: BreakdownRow) => row.counts[signal],
        cell: (row: BreakdownRow) => {
          const count = row.counts[signal];
          return (
            <Text
              variant="bodySmall"
              tone={count > 0 ? "default" : "muted"}
              weight={count > 0 ? "bold" : "regular"}
              style={TABULAR}
            >
              {formatCount(count)}
            </Text>
          );
        },
      })),
    ],
    [],
  );

  const renderMobileCard = useMemo(
    () => (row: BreakdownRow) => (
      <YStack gap="$2" flexShrink={1} minWidth={0}>
        <Text variant="bodySmall" weight="bold">
          {row.label}
        </Text>
        {QUEUE_SIGNALS.map((signal) => (
          <XStack
            key={signal}
            gap="$2"
            justifyContent="space-between"
            flexWrap="wrap"
            minWidth={0}
          >
            <Text variant="caption" tone="muted">
              {signalTitle(signal)}
            </Text>
            <Text
              variant="caption"
              tone={row.counts[signal] > 0 ? "default" : "muted"}
              style={TABULAR}
            >
              {formatCount(row.counts[signal])}
            </Text>
          </XStack>
        ))}
      </YStack>
    ),
    [],
  );

  return (
    <YStack gap="$2" flexShrink={1} minWidth={0}>
      {/* THE LABEL IS ONE WORD, AND THAT IS A 320px FIX, NOT A STYLE CHOICE.
          `Button` is a fixed-height single-line control: its label span is
          `white-space: nowrap` and the frame computes `flex-shrink: 0`, so it
          demands its content width no matter what the parent can give it.
          "BREAKDOWN BY IMAGE KIND" measured 270.57px inside a 190px box and
          pushed the whole document to `scrollWidth 336`. Shrink props on the
          button or its ancestors cannot fix that — only the content width can.
          The full phrase moves to the `aria-label` (so the accessible name is
          unchanged and still unique) and to the caption below (which wraps
          freely, because it is Text and not a control). */}
      <XStack flexShrink={1} minWidth={0}>
        <Button
          variant="ghost"
          size="$2"
          flexShrink={1}
          minWidth={0}
          aria-expanded={expanded}
          // Dangling `aria-controls` is an axe `aria-valid-attr-value`
          // failure: the panel is UNMOUNTED while collapsed, so there is no
          // element with this id to point at. Same conditional form as
          // `PlacePicker`.
          aria-controls={expanded ? panelId : undefined}
          aria-label={
            expanded
              ? "Hide the breakdown by image kind"
              : "Show the breakdown by image kind"
          }
          onPress={onToggle}
        >
          Breakdown
          {/* Trailing, because a disclosure chevron is progression, not the
              object the button is about. */}
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2.5} aria-hidden />
          ) : (
            <ChevronRight size={14} strokeWidth={2.5} aria-hidden />
          )}
        </Button>
      </XStack>

      {/* Carries the meaning the one-word label drops. Text wraps; a button
          label does not. */}
      <Text variant="caption" tone="muted">
        The five counts above, split by image kind.
      </Text>

      {/* The panel is unmounted when shut rather than hidden: its query is
          gated on the same flag, so there is nothing to keep mounted. */}
      {expanded ? (
        // A plain `div` carries the id, not the Tamagui stack: `aria-controls`
        // pointing at an element whose id got filtered out is worse than no
        // `aria-controls` at all. (The panel is unmounted when collapsed, so
        // the attribute is conditional on the button above — the same shape
        // `PlacePicker` uses. `CommunityDateList` solves it the other way, by
        // keeping the panel mounted and `hidden`; this query is gated on the
        // disclosure, so there is nothing worth keeping mounted.)
        <div id={panelId} style={PANEL}>
          {errorMessage ? (
            <YStack gap="$2" flexShrink={1} minWidth={0}>
              <Text variant="caption" color="$danger">
                {errorMessage}
              </Text>
              <XStack>
                <Button
                  variant="secondary"
                  size="$2"
                  // Scoped: the page can be rendering its own "Retry" for the
                  // counts at the same time, and two buttons with one
                  // accessible name doing different things is a defect this
                  // repo has shipped before.
                  aria-label="Retry loading the breakdown by image kind"
                  onPress={onRetry}
                >
                  Retry
                </Button>
              </XStack>
            </YStack>
          ) : (
            <>
              <DataTable<BreakdownRow>
                columns={columns}
                rows={rows}
                isLoading={isLoading}
                getRowKey={(row) => row.id}
                renderMobileCard={renderMobileCard}
                scrollContainer
                /* Safe here in a way it is NOT in the drill-down: this table is
                   always four or five rows and every one of them is in hand, so
                   sorting cannot answer the question against a partial list. */
                clientSort
                emptyState={
                  <YStack
                    alignItems="center"
                    justifyContent="center"
                    padding="$4"
                    minWidth={0}
                  >
                    <Text variant="bodySmall" tone="muted" textAlign="center">
                      No breakdown to show.
                    </Text>
                  </YStack>
                }
              />
              <Text variant="caption" tone="muted">
                Columns sum to the tiles above, computed against the same
                window.
              </Text>
            </>
          )}
        </div>
      ) : null}
    </YStack>
  );
}
