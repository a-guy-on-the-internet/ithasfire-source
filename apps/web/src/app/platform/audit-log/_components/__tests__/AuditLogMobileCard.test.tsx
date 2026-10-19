import { render, screen } from "@testing-library/react";
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
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({
    dateTime: (d: Date) => d.toISOString(),
  }),
}));

import { AuditLogMobileCard } from "../AuditLogMobileCard";
import type { AuditLogRow } from "../AuditLogDetail";

function makeRow(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    entity: "event",
    entityId: "22222222-2222-4222-8222-222222222222",
    action: "created",
    data: {},
    actorHumanId: "33333333-3333-4333-8333-333333333333",
    at: new Date("2026-07-06T12:00:00.000Z"),
    ...overrides,
  };
}

describe("AuditLogMobileCard", () => {
  it("renders entity, action badge, actor, and timestamp", () => {
    render(<AuditLogMobileCard row={makeRow()} />);

    expect(screen.getByText("event")).toBeInTheDocument();
    expect(screen.getByText("created")).toBeInTheDocument();
    expect(screen.getByText(/Actor:/)).toBeInTheDocument();
  });

  it("omits the actor line when actorHumanId is absent (best-effort, no crash)", () => {
    render(<AuditLogMobileCard row={makeRow({ actorHumanId: null })} />);

    expect(screen.queryByText(/Actor:/)).not.toBeInTheDocument();
  });
});
