"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

import {
  SEVERITY_WINDOW_DAYS,
  describeOutOfRange,
  describeSeveritySummary,
  formatThreshold,
  severityAriaLabel,
  severityBars,
  severityThresholdIndex,
  type SeverityBucket,
} from "./image-moderation-ops.helpers";

/**
 * The justification for the number the provider band prints.
 *
 * `REVIEW THRESHOLD 4` sitting alone is a number an operator has to take on
 * faith. The distribution is the evidence, and the ONE question it has to
 * answer is "how much is sitting just under the line" — because that is what
 * moving the threshold would sweep into the review queue. So the chart is
 * small, unlabelled, and carries exactly one mark: the threshold rule.
 *
 * IT LIVES INSIDE THE PROVIDER BAND, not in a section of its own. It is
 * evidence for a claim the band already makes; a separate "Severity" section
 * would make it a sixth thing on the page competing with the tiles.
 *
 * NO NUMBERS ON THE BARS. A five-digit count under a 28px column is the
 * overflow that drags a 320px document sideways, and this page has shipped that
 * bug before. Exact figures live in the summary line beneath (which wraps) and
 * in the chart's `aria-label` (which is read whole). The bars are a shape.
 *
 * NO ROW LINK. The backend returns aggregate counts and nothing else — no
 * record id, no key, not even a sample — because a "show me the 4s" affordance
 * here would route around the drill-down, which is the surface that carries the
 * withholding rules.
 */

/** Ink and flame, via the injector so the chart tracks the live theme. */
const INK = "var(--color, #211C16)";
const FLAME = "var(--accent, #E2481D)";

const PLOT_HEIGHT = 80;

const PLOT: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  width: "100%",
  minWidth: 0,
  height: PLOT_HEIGHT,
  // The DS gives charts an ink axis and nothing else as chrome. There is no
  // y-scale here, so there is no grid either — a grid without labels to read
  // against is decoration.
  borderBottom: `1px solid ${INK}`,
};

const FIGURE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
};

const AXIS: CSSProperties = {
  display: "flex",
  width: "100%",
  minWidth: 0,
  paddingTop: 4,
};

const CELL: CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  height: "100%",
  display: "flex",
  alignItems: "flex-end",
  // Padding, not gap: the cells must tile exactly so the axis row below lines
  // up with the plot above it, rule included.
  paddingLeft: 2,
  paddingRight: 2,
};

const AXIS_CELL: CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  textAlign: "center",
};

/**
 * The threshold mark. Two pixels of ink in the 4px gutter between two bars,
 * carried through the axis row so it reads as one line rather than two marks.
 */
const RULE: CSSProperties = {
  flex: "0 0 2px",
  width: 2,
  alignSelf: "stretch",
  backgroundColor: INK,
};

const RULE_AXIS: CSSProperties = { ...RULE, alignSelf: "auto", height: 14 };

export type SeverityHistogramProps = {
  data:
    | {
        buckets: SeverityBucket[];
        outOfRange: SeverityBucket[];
        scanned: number;
      }
    | undefined;
  /** `config.reviewThreshold`, or null when the scanner config is unreadable. */
  threshold: number | null;
  isLoading: boolean;
  errorMessage?: string;
};

export function SeverityHistogram({
  data,
  threshold,
  isLoading,
  errorMessage,
}: SeverityHistogramProps) {
  const thresholdIndex = severityThresholdIndex(threshold);

  const bars = useMemo(
    () => severityBars(data?.buckets ?? [], thresholdIndex),
    [data?.buckets, thresholdIndex],
  );

  /**
   * The legend is a KEY TO A MARK ON THE CHART. With no chart it annotates
   * nothing, so it is suppressed together with the plot — a "HELD ≥ 4" label
   * floating over an empty framed box reads as a render that failed, which is
   * exactly what it looked like.
   */
  const renderHeading = (withLegend: boolean) => (
    <XStack
      gap="$2"
      alignItems="baseline"
      justifyContent="space-between"
      flexWrap="wrap"
      flexShrink={1}
      minWidth={0}
    >
      <Text variant="overline" tone="muted">
        Severity · last {SEVERITY_WINDOW_DAYS} days
      </Text>
      {withLegend && threshold !== null && thresholdIndex !== null ? (
        <Text variant="overline" tone="muted">
          Held ≥ {formatThreshold(threshold)}
        </Text>
      ) : null}
    </XStack>
  );

  if (errorMessage) {
    return (
      <YStack gap="$2" flexShrink={1} minWidth={0}>
        {renderHeading(false)}
        <Text variant="caption" color="$danger">
          {errorMessage}
        </Text>
      </YStack>
    );
  }

  if (isLoading || !data) {
    return (
      <YStack gap="$2" flexShrink={1} minWidth={0}>
        {renderHeading(false)}
        <Text variant="caption" tone="muted">
          {isLoading
            ? "Reading the severity distribution…"
            : "Severity distribution not read."}
        </Text>
      </YStack>
    );
  }

  const outOfRangeLine = describeOutOfRange(data.outOfRange);
  const summary = describeSeveritySummary({
    scanned: data.scanned,
    bars,
    threshold,
  });

  // One loop builds BOTH rows so the rule cannot land in different places in
  // each. `thresholdIndex === bars.length` (a threshold above the scale) draws
  // the rule after the last column rather than dropping it.
  const withRule = (
    cell: (index: number) => ReactNode,
    rule: CSSProperties,
  ): ReactNode[] => {
    const out: ReactNode[] = [];
    bars.forEach((_bar, index) => {
      if (thresholdIndex === index) {
        out.push(
          <div key={`rule-${index}`} style={rule} data-threshold-rule={index} />,
        );
      }
      out.push(cell(index));
    });
    if (thresholdIndex === bars.length) {
      // The ONLY branch a threshold above the scale reaches. Kept so the rule
      // lands at the far edge rather than silently disappearing.
      out.push(
        <div
          key="rule-end"
          style={rule}
          data-threshold-rule={bars.length}
        />,
      );
    }
    return out;
  };

  return (
    <YStack gap="$2" flexShrink={1} minWidth={0}>
      {renderHeading(data.scanned > 0)}

      {data.scanned === 0 ? (
        // NO CHART CHROME AT ALL. An 80px empty box above a baseline rule is
        // indistinguishable from a chart that failed to draw; the sentence is
        // the whole empty state.
        <Text variant="caption" tone="muted">
          Nothing was scored in the last {SEVERITY_WINDOW_DAYS} days, so there
          is no distribution to judge the threshold against.
        </Text>
      ) : (
        /* `role` + `aria-label` ride a PLAIN div, never a Tamagui stack.
           They are the ENTIRE accessible representation of this data — the
           bars deliberately carry no numeric labels — so they must not depend
           on a styled component forwarding two web-only attributes. A DOM test
           pins both. */
        <div
          style={FIGURE}
          role="img"
          aria-label={severityAriaLabel({
            scanned: data.scanned,
            bars,
            threshold,
          })}
        >
          <div style={PLOT} data-testid="severity-plot">
            {withRule(
              (index) => {
                const bar = bars[index];
                if (!bar) return null;
                return (
                  <div
                    key={`bar-${bar.severity}`}
                    style={CELL}
                    data-severity={bar.severity}
                  >
                    <div
                      data-bar={bar.severity}
                      data-held={bar.held ? "true" : "false"}
                      style={{
                        width: "100%",
                        height: `${bar.heightPct}%`,
                        // Flame is the held set — the operative one on this
                        // page — and ink is everything that auto-approved.
                        // Both are the dataviz palette's first two ordinal
                        // series, taken through the theme rather than as hex.
                        backgroundColor: bar.held ? FLAME : INK,
                      }}
                    />
                  </div>
                );
              },
              RULE,
            )}
          </div>
          <div style={AXIS} aria-hidden data-testid="severity-axis">
            {withRule((index) => {
              const bar = bars[index];
              if (!bar) return null;
              return (
                <div key={`axis-${bar.severity}`} style={AXIS_CELL}>
                  <Text
                    variant="overline"
                    tone={bar.held ? "default" : "muted"}
                  >
                    {bar.severity}
                  </Text>
                </div>
              );
            }, RULE_AXIS)}
          </div>
        </div>
      )}

      <Text variant="caption" tone="muted">
        {summary}
      </Text>

      {outOfRangeLine ? (
        <Text variant="caption" color="$warning">
          {outOfRangeLine}
        </Text>
      ) : null}
    </YStack>
  );
}
