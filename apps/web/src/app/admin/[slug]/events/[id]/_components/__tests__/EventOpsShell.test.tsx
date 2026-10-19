import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("tamagui", () => ({
  XStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@th/ui", () => ({
  Text: ({ children, tag }: { children?: ReactNode; tag?: string }) => {
    const Tag = (tag ?? "span") as "span";
    return <Tag>{children}</Tag>;
  },
}));

import { EventOpsShell } from "../EventOpsShell";

describe("EventOpsShell", () => {
  // The five ops surfaces previously shipped an h3, two h4s, an h2, a
  // visually-hidden h2 and (on attendees) no heading at all. The shell owning
  // exactly one h1 is the point of the component.
  it("renders the surface title as the only h1", () => {
    render(<EventOpsShell title="Attendees">body</EventOpsShell>);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Attendees");
  });

  it("renders the purpose line and the action + filter slots", () => {
    render(
      <EventOpsShell
        title="Comp tickets"
        purpose="Issue complimentary tickets and see who already has one."
        actions={<button type="button">Issue comps</button>}
        filters={<div data-testid="filters" />}
      >
        <div data-testid="body" />
      </EventOpsShell>,
    );

    expect(
      screen.getByText(
        "Issue complimentary tickets and see who already has one.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Issue comps" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("filters")).toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  // Both slots are optional — suggestions and feedback have no surface-level
  // action, and comps has no filter row.
  it("omits the optional slots cleanly", () => {
    render(
      <EventOpsShell title="Attendee feedback">
        <div data-testid="body" />
      </EventOpsShell>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });
});
