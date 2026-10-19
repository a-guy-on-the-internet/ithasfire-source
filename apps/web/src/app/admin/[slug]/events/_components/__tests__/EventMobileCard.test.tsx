import { render, screen } from "@testing-library/react";
import type { CSSProperties, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  // Forward `style` so the title's clamp/ellipsis treatment is assertable.
  Text: ({
    children,
    style,
  }: {
    children?: ReactNode;
    style?: CSSProperties;
  }) => <span style={style}>{children}</span>,
  useFormatters: () => ({}),
  useTranslations: () => (key: string) =>
    key === "admin.untitledEvent" ? "Untitled Event" : key,
}));

vi.mock("@/lib/format", () => ({
  fmtDate: (_fmt: unknown, date: Date | null) =>
    date ? "Jun 12, 2026" : "—",
}));

vi.mock("../EventStatusBadge", () => ({
  EventStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { EventMobileCard, type EventMobileCardRow } from "../EventMobileCard";

const baseRow: EventMobileCardRow = {
  title: "Solstice Bonfire",
  status: "PUBLISHED",
  startsAt: new Date("2026-06-12T19:00:00Z"),
  ticketsSold: 42,
  placeName: "The Velvet Room",
  addressText: "123 Main St",
};

describe("EventMobileCard", () => {
  it("renders title, status badge, date, attendee count, and venue", () => {
    render(<EventMobileCard row={baseRow} />);

    expect(screen.getByText("Solstice Bonfire")).toBeInTheDocument();
    expect(screen.getByText("PUBLISHED")).toBeInTheDocument();
    expect(screen.getByText("Jun 12, 2026")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    // placeName wins over addressText, like the table column.
    expect(screen.getByText("The Velvet Room")).toBeInTheDocument();
    expect(screen.queryByText("123 Main St")).not.toBeInTheDocument();
  });

  it("falls back to the untitled label and hides empty attendee/venue lines", () => {
    render(
      <EventMobileCard
        row={{
          ...baseRow,
          title: null,
          status: "DRAFT",
          startsAt: null,
          ticketsSold: 0,
          placeName: null,
          addressText: null,
        }}
      />,
    );

    expect(screen.getByText("Untitled Event")).toBeInTheDocument();
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("puts the status badge on its own line above the title", () => {
    render(<EventMobileCard row={baseRow} />);

    const badge = screen.getByText("PUBLISHED");
    const title = screen.getByText("Solstice Bonfire");
    // Badge first in reading order...
    expect(
      badge.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ...and not sharing the title's row: the badge's wrapper does not
    // contain the title.
    expect(badge.parentElement?.contains(title)).toBe(false);
  });

  it("lets a long title wrap to two lines instead of single-line truncation", () => {
    render(
      <EventMobileCard
        row={{ ...baseRow, title: "Minneapolis Winter Solstice Bonfire" }}
      />,
    );

    const title = screen.getByText("Minneapolis Winter Solstice Bonfire");
    expect(title.style.whiteSpace).not.toBe("nowrap");
    expect(title.style.overflow).toBe("hidden");
    expect(title.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
  });
});
