/**
 * EventStatusBadge has two readings: the framed chip every table/card uses
 * (default — untouched by the 2026-09-15 header rework) and `inline`, a
 * square + overline label with no fill, for running beside a title.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(style)$/;
  const makeStack =
    (name?: string) =>
    ({
      children,
      backgroundColor,
      ...rest
    }: {
      children?: ReactNode;
      backgroundColor?: string;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (name) domProps["data-name"] = name;
      if (backgroundColor) domProps["data-bg"] = backgroundColor;
      return React.createElement("div", domProps, children);
    };
  return {
    XStack: makeStack(),
    Stack: makeStack(),
    styled: (_base: unknown, config?: { name?: string }) =>
      makeStack(config?.name),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({
      children,
      variant,
      color,
      style,
    }: {
      children?: ReactNode;
      variant?: string;
      color?: string;
      style?: Record<string, unknown>;
    }) =>
      React.createElement(
        "span",
        { "data-variant": variant, "data-color": color, style },
        children,
      ),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("../event-status-labels", () => ({
  EVENT_STATUS_LABEL_KEYS: {
    DRAFT: "status.draft",
    PUBLISHED: "status.published",
    COMPLETED: "status.completed",
    CANCELLED: "status.cancelled",
    ARCHIVED: "status.archived",
  },
}));

import { EventStatusBadge } from "../EventStatusBadge";

describe("EventStatusBadge", () => {
  it("defaults to the chip: fill + edge bar", () => {
    const { container } = render(<EventStatusBadge status="PUBLISHED" />);

    const chip = container.querySelector('[data-name="EventStatusBadge"]');
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute("aria-label", "Status: status.published");
    expect(chip).toHaveAttribute("data-bg", "$surfaceMuted");
    expect(
      container.querySelector('[data-name="EventStatusBar"]'),
    ).toHaveAttribute("data-bg", "$success");
    expect(container.querySelector('[data-name="EventStatusInline"]')).toBeNull();
  });

  it("inline: square + overline label, no chip fill, same accessible name", () => {
    const { container } = render(
      <EventStatusBadge status="DRAFT" appearance="inline" />,
    );

    const frame = container.querySelector('[data-name="EventStatusInline"]');
    expect(frame).not.toBeNull();
    expect(frame).toHaveAttribute("aria-label", "Status: status.draft");
    // No fill on the frame, no edge bar.
    expect(frame).not.toHaveAttribute("data-bg");
    expect(container.querySelector('[data-name="EventStatusBar"]')).toBeNull();
    expect(container.querySelector('[data-name="EventStatusBadge"]')).toBeNull();

    // The square carries the status's bar colour and is decorative.
    const square = container.querySelector('[data-name="EventStatusSquare"]');
    expect(square).toHaveAttribute("data-bg", "$colorMuted");
    expect(square).toHaveAttribute("aria-hidden");

    // The label is the mono overline idiom in the status's fg, never wrapping.
    const label = screen.getByText("status.draft");
    expect(label).toHaveAttribute("data-variant", "overline");
    expect(label).toHaveAttribute("data-color", "$colorMuted");
    expect(label).toHaveStyle({ whiteSpace: "nowrap" });
  });
});
