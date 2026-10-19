import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AttendeeReviewIneligibilityReason } from "../../_lib/reasons";
import { IneligibleScreen } from "../IneligibleScreen";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => React.createElement("div", { "data-testid": testId }, children);
  return { YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/design-tokens", () => ({ ACCENT: "#FF5721" }));

vi.mock("lucide-react", () => ({
  CalendarClock: () => null,
  CheckCircle2: () => null,
  Clock: () => null,
  Ticket: () => null,
  XCircle: () => null,
}));

// Key-passthrough translator: renders the i18n key so we can assert the exact
// reason-specific copy path was chosen.
const t = (key: string) => key;

const REASONS: AttendeeReviewIneligibilityReason[] = [
  "event_not_found",
  "event_cancelled",
  "event_not_ended",
  "window_closed",
  "no_scanned_ticket",
  "already_reviewed",
];

describe("IneligibleScreen", () => {
  it.each(REASONS)("renders the reason-specific copy for %s", (reason) => {
    render(<IneligibleScreen reason={reason} t={t} />);

    expect(
      screen.getByTestId(`attendee-ineligible-${reason}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`attendeeReview.ineligible.${reason}.title`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`attendeeReview.ineligible.${reason}.body`),
    ).toBeInTheDocument();
    expect(
      screen.getByText("attendeeReview.ineligible.backToTickets"),
    ).toBeInTheDocument();
  });
});
