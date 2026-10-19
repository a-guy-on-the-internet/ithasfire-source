"use client";

import { useRef, useEffect, useMemo } from "react";
import { YStack, XStack, styled } from "tamagui";
import { Text } from "@th/ui";
import * as d3 from "d3";

import { formatCurrency } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectionPoint {
  ticketPrice: number;
  platformFee: number;
  processorFee: number;
  monthlyRevenue: number;
  /** Pass-through: what the buyer actually pays. */
  passThroughBuyerTotal: number;
}

interface Props {
  data: ProjectionPoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const ChartContainer = styled(YStack, {
  name: "ChartContainer",
  gap: "$3",
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MARGIN = { top: 24, right: 24, bottom: 56, left: 72 };
const FULL_WIDTH = 780;
const FULL_HEIGHT = 320;

const COLORS = {
  platformFee: "#6366f1",
  processorFee: "#a1a1aa",
  monthlyRevenue: "#22c55e",
  grid: "#e4e4e7",
  text: "#71717a",
  tooltip: "#18181b",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtAxis(cents: number): string {
  if (cents >= 10_000) return formatCurrency(cents, "usd");
  if (cents >= 100) return formatCurrency(cents, "usd");
  return `${cents}c`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FeeProjectionChart({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const chartW = FULL_WIDTH - MARGIN.left - MARGIN.right;
  const chartH = FULL_HEIGHT - MARGIN.top - MARGIN.bottom;

  const { xScale, yFeeScale, yRevScale, bandW } = useMemo(() => {
    const x = d3
      .scaleBand<number>()
      .domain(data.map((d) => d.ticketPrice))
      .range([0, chartW])
      .padding(0.35);

    const maxFee = d3.max(data, (d) => d.platformFee + d.processorFee) ?? 1;
    const maxRev = d3.max(data, (d) => d.monthlyRevenue) ?? 1;

    return {
      xScale: x,
      yFeeScale: d3
        .scaleLinear()
        .domain([0, maxFee * 1.25])
        .nice()
        .range([chartH, 0]),
      yRevScale: d3
        .scaleLinear()
        .domain([0, maxRev * 1.15])
        .nice()
        .range([chartH, 0]),
      bandW: x.bandwidth(),
    };
  }, [data, chartW, chartH]);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    if (!svg.node() || !data.length) return;

    svg.selectAll("*").remove();

    const g = svg
      .attr("viewBox", `0 0 ${FULL_WIDTH} ${FULL_HEIGHT}`)
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    // Grid lines (revenue scale)
    g.selectAll(".grid")
      .data(yRevScale.ticks(5))
      .join("line")
      .attr("x1", 0)
      .attr("x2", chartW)
      .attr("y1", (d) => yRevScale(d))
      .attr("y2", (d) => yRevScale(d))
      .attr("stroke", COLORS.grid)
      .attr("stroke-dasharray", "4 4")
      .attr("stroke-width", 0.5);

    // Y axis (revenue, left)
    g.append("g")
      .call(
        d3
          .axisLeft(yRevScale)
          .ticks(5)
          .tickFormat((d) => fmtAxis(d as number)),
      )
      .call((s) => s.select(".domain").remove())
      .call((s) => s.selectAll(".tick line").attr("stroke", COLORS.grid))
      .call((s) =>
        s
          .selectAll(".tick text")
          .attr("fill", COLORS.text)
          .attr("font-size", 11),
      );

    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -chartH / 2)
      .attr("y", -52)
      .attr("text-anchor", "middle")
      .attr("fill", COLORS.text)
      .attr("font-size", 11)
      .text("Monthly Revenue");

    // X axis
    g.append("g")
      .attr("transform", `translate(0,${chartH})`)
      .call(
        d3.axisBottom(xScale).tickFormat((d) => formatCurrency(d as number)),
      )
      .call((s) => s.select(".domain").attr("stroke", COLORS.grid))
      .call((s) => s.selectAll(".tick line").remove())
      .call((s) =>
        s
          .selectAll(".tick text")
          .attr("fill", COLORS.text)
          .attr("font-size", 11),
      );

    g.append("text")
      .attr("x", chartW / 2)
      .attr("y", chartH + 44)
      .attr("text-anchor", "middle")
      .attr("fill", COLORS.text)
      .attr("font-size", 11)
      .text("Ticket Face Value");

    // Bars
    const halfBand = bandW / 2;
    const barW = Math.max(halfBand * 0.85, 4);
    const gap = 2;

    const groups = g
      .selectAll<SVGGElement, ProjectionPoint>(".bar-group")
      .data(data)
      .join("g")
      .attr("class", "bar-group")
      .attr("transform", (d) => `translate(${xScale(d.ticketPrice) ?? 0},0)`);

    // Platform fee (top of left stacked bar)
    groups
      .append("rect")
      .attr("x", halfBand / 2 - barW - gap / 2)
      .attr("y", (d) => yFeeScale(d.platformFee + d.processorFee))
      .attr("width", barW)
      .attr("height", (d) => Math.max(chartH - yFeeScale(d.platformFee), 0))
      .attr("rx", 3)
      .attr("fill", COLORS.platformFee)
      .attr("opacity", 0.85);

    // Processor fee (bottom of left stacked bar)
    groups
      .append("rect")
      .attr("x", halfBand / 2 - barW - gap / 2)
      .attr("y", (d) => yFeeScale(d.processorFee))
      .attr("width", barW)
      .attr("height", (d) => Math.max(chartH - yFeeScale(d.processorFee), 0))
      .attr("rx", 3)
      .attr("fill", COLORS.processorFee)
      .attr("opacity", 0.7);

    // Revenue bar (right)
    groups
      .append("rect")
      .attr("x", halfBand / 2 + gap / 2)
      .attr("y", (d) => yRevScale(d.monthlyRevenue))
      .attr("width", barW)
      .attr("height", (d) => Math.max(chartH - yRevScale(d.monthlyRevenue), 0))
      .attr("rx", 3)
      .attr("fill", COLORS.monthlyRevenue)
      .attr("opacity", 0.85);

    // Revenue label
    groups
      .append("text")
      .attr("x", halfBand / 2 + gap / 2 + barW / 2)
      .attr("y", (d) => yRevScale(d.monthlyRevenue) - 5)
      .attr("text-anchor", "middle")
      .attr("font-size", 9)
      .attr("font-weight", 600)
      .attr("fill", COLORS.monthlyRevenue)
      .text((d) => fmtAxis(d.monthlyRevenue));

    // Tooltip hover zones
    const tooltip = d3.select(tooltipRef.current);

    groups
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", bandW)
      .attr("height", chartH)
      .attr("fill", "transparent")
      .style("cursor", "crosshair")
      .on("mouseenter", (_event, d) => {
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${formatCurrency(d.ticketPrice)} ticket</strong><br/>` +
              `Platform fee: ${formatCurrency(d.platformFee)}<br/>` +
              `Processor fee: ${formatCurrency(d.processorFee)}<br/>` +
              `Monthly rev: ${formatCurrency(d.monthlyRevenue)}<br/>` +
              `<span style="color:#6366f1">Pass-through buyer total: ${formatCurrency(d.passThroughBuyerTotal)}</span>`,
          );
      })
      .on("mousemove", (event) => {
        const [mx, my] = d3.pointer(event, svgRef.current);
        tooltip.style("left", `${mx + 16}px`).style("top", `${my - 12}px`);
      })
      .on("mouseleave", () => {
        tooltip.style("opacity", "0");
      });
  }, [data, xScale, yFeeScale, yRevScale, bandW, chartW, chartH]);

  if (!data.length) {
    return (
      <YStack alignItems="center" padding="$4">
        <Text variant="body" tone="muted">
          No data
        </Text>
      </YStack>
    );
  }

  return (
    <ChartContainer>
      {/* Legend */}
      <XStack gap="$4" flexWrap="wrap" justifyContent="center">
        {[
          { color: COLORS.platformFee, label: "Platform Fee / ticket" },
          { color: COLORS.monthlyRevenue, label: "Monthly Revenue" },
          { color: COLORS.processorFee, label: "Processor Fee / ticket" },
        ].map(({ color, label }) => (
          <XStack key={label} alignItems="center" gap="$2">
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 0,
                backgroundColor: color,
              }}
            />
            <Text variant="caption" tone="muted">
              {label}
            </Text>
          </XStack>
        ))}
      </XStack>

      {/* D3 chart */}
      <YStack alignItems="center" position="relative">
        <svg
          ref={svgRef}
          width="100%"
          height={FULL_HEIGHT}
          style={{ maxWidth: FULL_WIDTH, overflow: "visible" }}
        />
        <div
          ref={tooltipRef}
          style={{
            position: "absolute",
            pointerEvents: "none",
            opacity: 0,
            transition: "opacity 0.15s",
            background: COLORS.tooltip,
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 0,
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        />
      </YStack>

      {/* Data table */}
      <YStack gap="$1" paddingTop="$2">
        <XStack paddingHorizontal="$2" paddingVertical="$1">
          <Text variant="caption" weight="bold" flex={1}>
            Ticket Price
          </Text>
          <Text variant="caption" weight="bold" flex={1} textAlign="right">
            Platform Fee
          </Text>
          <Text variant="caption" weight="bold" flex={1} textAlign="right">
            Processor Fee
          </Text>
          <Text variant="caption" weight="bold" flex={1} textAlign="right">
            Monthly Rev.
          </Text>
        </XStack>
        {data.map((d) => (
          <XStack
            key={d.ticketPrice}
            paddingHorizontal="$2"
            paddingVertical="$1"
            borderTopWidth={1}
            borderColor="$borderColor"
          >
            <Text variant="caption" flex={1}>
              {formatCurrency(d.ticketPrice)}
            </Text>
            <Text variant="caption" flex={1} textAlign="right">
              {formatCurrency(d.platformFee)}
            </Text>
            <Text variant="caption" flex={1} textAlign="right" tone="muted">
              {formatCurrency(d.processorFee)}
            </Text>
            <Text variant="caption" flex={1} textAlign="right" weight="bold">
              {formatCurrency(d.monthlyRevenue)}
            </Text>
          </XStack>
        ))}
      </YStack>
    </ChartContainer>
  );
}
