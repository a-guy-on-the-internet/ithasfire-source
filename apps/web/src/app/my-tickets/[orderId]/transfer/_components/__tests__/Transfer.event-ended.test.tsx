import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * Owner rule 2026-09-28: a past event's ticket cannot be transferred. Core
 * refuses it (TICKET_TRANSFER_EVENT_PAST); the page reached by URL says so
 * instead of offering a form that can only fail.
 */

const testState = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    Search: Icon,
    Send: Icon,
    User: Icon,
    CheckCircle: Icon,
    Mail: Icon,
    AlertCircle: Icon,
    Calendar: Icon,
  };
});

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => React.createElement("div", { "data-testid": testId }, children);
  return {
    XStack: Stack,
    YStack: Stack,
    Card: Stack,
    Spinner: () => <span>Loading</span>,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Text: Passthrough,
    Button: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    Input: () => <input />,
    useFormatters: () => ({ dateTime: () => "date" }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => {
  const mutation = () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    error: null,
  });
  return {
    trpc: {
      useUtils: () => ({
        orders: {
          getMyOrder: { invalidate: vi.fn() },
          listMyOrderTickets: { invalidate: vi.fn() },
          listMyOrders: { invalidate: vi.fn() },
        },
      }),
      orders: {
        getMyOrder: {
          useQuery: () => ({
            data: testState.order,
            isLoading: false,
            error: null,
          }),
        },
        listMyOrderTickets: {
          useQuery: () => ({
            data: {
              tickets: [
                { id: "t-1", code: "ABC123", status: "VALID", ticketTypeId: null },
              ],
            },
            isLoading: false,
          }),
        },
      },
      humans: {
        searchTransferRecipients: {
          useQuery: () => ({ data: undefined, isError: false }),
        },
      },
      tickets: {
        transferTicket: { useMutation: mutation },
        initiateEmailTransfer: { useMutation: mutation },
      },
    },
  };
});

import { Transfer } from "../Transfer";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function order(eventEnded: boolean) {
  return {
    id: ORDER_ID,
    eventName: "Test Event",
    eventStartsAt: "2026-12-01T19:00:00.000Z",
    eventEnded,
  };
}

describe("Transfer — past event", () => {
  it("shows the form while the event is not over", () => {
    testState.order = order(false);
    render(<Transfer orderId={ORDER_ID} />);
    expect(screen.queryByTestId("transfer-event-ended")).toBeNull();
    expect(screen.getByText("transfer.step1SelectTicket")).toBeInTheDocument();
  });

  it("replaces the form with the reason once the event has ended", () => {
    testState.order = order(true);
    render(<Transfer orderId={ORDER_ID} />);
    expect(screen.getByTestId("transfer-event-ended")).toBeInTheDocument();
    expect(screen.getByText("transfer.eventEndedTitle")).toBeInTheDocument();
    expect(screen.getByText("transfer.eventEndedDesc")).toBeInTheDocument();
    expect(screen.queryByText("transfer.step1SelectTicket")).toBeNull();
    expect(
      document.querySelector(`a[href="/my-tickets/${ORDER_ID}"]`),
    ).not.toBeNull();
  });
});
