import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * DOM tests for the ONE piece of this page that is raw geometry rather than a
 * design-system component.
 *
 * A `@th/ui` stand-in cannot honestly prove anything about a `@th/ui` control —
 * mocks on this page have lied before. But the plot, the bars, the threshold
 * rule and the figure's `role`/`aria-label` are all plain `div`s with inline
 * styles written in this file, so the mocks below never touch the thing under
 * test. That is the whole reason `role="img"` was moved off a Tamagui stack:
 * it made the accessible representation of this chart testable AND stopped it
 * depending on a styled component forwarding two web-only attributes.
 *
 * This matters more than usual because the bars deliberately carry no numeric
 * labels (a five-digit count under a 28px column is what dragged this page to
 * `scrollWidth 604`), so the `aria-label` IS the data for anyone not looking at
 * the shape.
 */

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => React.createElement("div", pickDomProps(rest), children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => <span {...pickDomProps(rest)}>{children}</span>,
}));

const { SeverityHistogram } = await import("../SeverityHistogram");

const dense = (counts: number[]) =>
  counts.map((count, severity) => ({ severity, count }));

/**
 * 1,200 clean · nothing at 1 · a half-height mid bucket · a tail · exactly one
 * row sitting ON the threshold, which is the case the chart exists for.
 */
const COUNTS = [1200, 0, 600, 12, 1, 0, 0];
const SCANNED = COUNTS.reduce((a, b) => a + b, 0); // 1,813

const renderChart = (
  overrides: Partial<React.ComponentProps<typeof SeverityHistogram>> = {},
) =>
  render(
    <SeverityHistogram
      data={{
        buckets: dense(COUNTS),
        outOfRange: [],
        scanned: SCANNED,
      }}
      threshold={4}
      isLoading={false}
      {...overrides}
    />,
  );

const plotBars = () =>
  Array.from(
    screen.getByTestId("severity-plot").querySelectorAll("[data-bar]"),
  ) as HTMLElement[];

const plotChildren = () =>
  Array.from(screen.getByTestId("severity-plot").children) as HTMLElement[];

describe("SeverityHistogram — with data", () => {
  it("draws exactly seven bars, one per severity, in order", () => {
    renderChart();
    expect(plotBars().map((bar) => bar.dataset.bar)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("scales bar heights to the tallest bucket", () => {
    renderChart();
    const heights = plotBars().map((bar) => bar.style.height);
    // 1,200 is the max → 100%; 600 is half of it → 50%.
    expect(heights[0]).toBe("100%");
    expect(heights[2]).toBe("50%");
  });

  it("floors a non-zero bucket at a VISIBLE height", () => {
    renderChart();
    // 12/1200 is 1% and 1/1200 is 0.083% — both paint nothing at 80px, and
    // "is anything sitting just under the line" is the one question this
    // chart exists to answer. Both floor to 2%.
    expect(plotBars()[3]?.style.height).toBe("2%");
    expect(plotBars()[4]?.style.height).toBe("2%");
  });

  it("leaves an empty bucket at zero height rather than inventing a stub", () => {
    renderChart();
    expect(plotBars()[1]?.style.height).toBe("0%");
    expect(plotBars()[5]?.style.height).toBe("0%");
  });

  it("marks at-or-above the threshold as held and nothing below it", () => {
    renderChart();
    expect(plotBars().map((bar) => bar.dataset.held)).toEqual([
      "false",
      "false",
      "false",
      "false",
      "true",
      "true",
      "true",
    ]);
  });

  it("puts the threshold rule BETWEEN bucket t-1 and bucket t", () => {
    renderChart();
    const rule = screen
      .getByTestId("severity-plot")
      .querySelector("[data-threshold-rule]") as HTMLElement;
    expect(rule).not.toBeNull();
    expect(rule.dataset.thresholdRule).toBe("4");
    expect(
      (rule.previousElementSibling as HTMLElement).dataset.severity,
    ).toBe("3");
    expect((rule.nextElementSibling as HTMLElement).dataset.severity).toBe("4");
  });

  it("draws the rule in the axis row too, so it reads as ONE line", () => {
    renderChart();
    expect(
      screen
        .getByTestId("severity-axis")
        .querySelectorAll("[data-threshold-rule]"),
    ).toHaveLength(1);
  });

  it("exposes the whole distribution through role=img + aria-label", () => {
    renderChart();
    const figure = screen.getByRole("img");
    const label = figure.getAttribute("aria-label") ?? "";
    // Every bucket, spelled out, grouped the same way the summary line groups.
    expect(label).toContain("severity 0, 1,200");
    expect(label).toContain("severity 1, 0");
    expect(label).toContain("severity 2, 600");
    expect(label).toContain("severity 3, 12");
    expect(label).toContain("severity 4, 1");
    expect(label).toContain("severity 5, 0");
    expect(label).toContain("severity 6, 0");
    expect(label).toContain("1,813 scanned");
    expect(label).toContain("Review threshold 4");
    expect(label).toContain("1 at or above it");
  });

  it("renders the HELD legend once there is a chart to annotate", () => {
    renderChart();
    expect(screen.getByText(/Held ≥/)).toBeTruthy();
  });
});

describe("SeverityHistogram — threshold at the edges of the scale", () => {
  it("threshold 0 holds EVERY bucket and draws the rule before the first bar", () => {
    renderChart({ threshold: 0 });
    expect(plotBars().every((bar) => bar.dataset.held === "true")).toBe(true);
    const first = plotChildren()[0];
    expect(first?.dataset.thresholdRule).toBe("0");
  });

  it("threshold 7 holds NOTHING and draws the rule after the last bar", () => {
    // The only input that reaches the `rule-end` branch. A threshold above the
    // scale must park the rule at the edge, never drop it.
    renderChart({ threshold: 7 });
    expect(plotBars().every((bar) => bar.dataset.held === "false")).toBe(true);
    const children = plotChildren();
    expect(children.at(-1)?.dataset.thresholdRule).toBe("7");
    expect(children.at(-2)?.dataset.severity).toBe("6");
  });

  it("draws NO rule at all when the threshold is unknown", () => {
    renderChart({ threshold: null });
    expect(
      screen.getByTestId("severity-plot").querySelector("[data-threshold-rule]"),
    ).toBeNull();
    // …and the legend goes with it, since it would key nothing.
    expect(screen.queryByText(/Held ≥/)).toBeNull();
  });
});

describe("SeverityHistogram — empty, loading and error", () => {
  it("renders NO chart chrome when nothing was scored", () => {
    // Seven dense zero-count buckets is what the API returns on a quiet
    // install. An 80px empty box above a baseline rule read as a chart that
    // failed to draw.
    render(
      <SeverityHistogram
        data={{ buckets: dense([0, 0, 0, 0, 0, 0, 0]), outOfRange: [], scanned: 0 }}
        threshold={4}
        isLoading={false}
      />,
    );
    expect(screen.queryByTestId("severity-plot")).toBeNull();
    expect(screen.queryByTestId("severity-axis")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    // The legend keys a mark that is not there, so it goes too.
    expect(screen.queryByText(/Held ≥/)).toBeNull();
    expect(screen.getByText(/Nothing was scored/)).toBeTruthy();
  });

  it("says it is reading, not that there is nothing", () => {
    render(
      <SeverityHistogram data={undefined} threshold={4} isLoading={true} />,
    );
    expect(screen.getByText(/Reading the severity distribution/)).toBeTruthy();
    expect(screen.queryByTestId("severity-plot")).toBeNull();
  });

  it("shows the error and no chart", () => {
    render(
      <SeverityHistogram
        data={undefined}
        threshold={4}
        isLoading={false}
        errorMessage="window must not exceed 90 days"
      />,
    );
    expect(screen.getByText("window must not exceed 90 days")).toBeTruthy();
    expect(screen.queryByTestId("severity-plot")).toBeNull();
    expect(screen.queryByText(/Held ≥/)).toBeNull();
  });
});

describe("SeverityHistogram — out-of-range severities", () => {
  it("says the seven columns do not sum to `scanned`", () => {
    render(
      <SeverityHistogram
        data={{
          buckets: dense([10, 0, 0, 0, 0, 0, 0]),
          outOfRange: [{ severity: 9, count: 2 }],
          scanned: 12,
        }}
        threshold={4}
        isLoading={false}
      />,
    );
    expect(screen.getByText(/scored outside 0–6/)).toBeTruthy();
    expect(plotBars()).toHaveLength(7);
  });
});
