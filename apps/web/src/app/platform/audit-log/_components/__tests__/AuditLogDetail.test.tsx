import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "aria-label"?: string;
  }) => (
    <button aria-label={ariaLabel} onClick={onPress}>
      {children}
    </button>
  ),
  useFormatters: () => ({
    dateTime: (d: Date) => d.toISOString(),
    number: (n: number) => String(n),
    currency: (n: number) => String(n),
  }),
}));

import { AuditLogDetail, type AuditLogRow } from "../AuditLogDetail";

const FMT = {
  dateTime: (d: Date) => d.toISOString(),
} as any;

function makeRow(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    entity: "event",
    entityId: "22222222-2222-4222-8222-222222222222",
    action: "created",
    data: { actorHumanId: "33333333-3333-4333-8333-333333333333", foo: "bar" },
    actorHumanId: "33333333-3333-4333-8333-333333333333",
    at: new Date("2026-07-06T12:00:00.000Z"),
    ...overrides,
  };
}

describe("AuditLogDetail", () => {
  it("renders entity, action, entityId, and actor", () => {
    render(<AuditLogDetail row={makeRow()} onClose={vi.fn()} fmt={FMT} />);

    expect(screen.getByText("event")).toBeInTheDocument();
    expect(screen.getByText("created")).toBeInTheDocument();
    expect(
      screen.getByText("22222222-2222-4222-8222-222222222222"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("33333333-3333-4333-8333-333333333333"),
    ).toBeInTheDocument();
  });

  it("renders an em-dash for a missing entityId/actor instead of crashing", () => {
    render(
      <AuditLogDetail
        row={makeRow({ entityId: null, actorHumanId: null, data: {} })}
        onClose={vi.fn()}
        fmt={FMT}
      />,
    );

    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("pretty-prints the raw data JSON blob (never hand-formatted)", () => {
    render(<AuditLogDetail row={makeRow()} onClose={vi.fn()} fmt={FMT} />);

    expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
  });

  it("tolerates a null data blob without throwing", () => {
    expect(() =>
      render(
        <AuditLogDetail
          row={makeRow({ data: null })}
          onClose={vi.fn()}
          fmt={FMT}
        />,
      ),
    ).not.toThrow();
  });

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(<AuditLogDetail row={makeRow()} onClose={onClose} fmt={FMT} />);

    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
