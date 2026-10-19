import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * Owner rule 2026-09-28: an invite opened after the show is refused with
 * TICKET_TRANSFER_EVENT_PAST. Invites are capped at the event end, so this is
 * what every post-show claim hits — it must not read as "expired, ask the
 * sender for a new one", which can no longer work.
 */

const testState = vi.hoisted(() => ({
  error: null as unknown,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { CheckCircle: Icon, AlertTriangle: Icon, LogIn: Icon };
});
vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    XStack: Stack,
    YStack: Stack,
    Card: Stack,
    Spinner: () => <span>Loading</span>,
  };
});
vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "u" } }, isPending: false }),
  },
}));
vi.mock("@/trpc", () => ({
  trpc: {
    tickets: {
      claimPendingTransfer: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
          isSuccess: false,
          isError: testState.error !== null,
          error: testState.error,
        }),
      },
    },
  },
}));

import { ClaimTransfer } from "../ClaimTransfer";

function trpcError(appCode: string) {
  return Object.assign(new Error(appCode), {
    data: { appCode, code: "PRECONDITION_FAILED" },
  });
}

describe("ClaimTransfer — refusal copy", () => {
  it("says the event is over for TICKET_TRANSFER_EVENT_PAST, not 'expired'", () => {
    testState.error = trpcError("TICKET_TRANSFER_EVENT_PAST");
    render(<ClaimTransfer token="tok" />);
    expect(screen.getByText("transfer.eventEndedTitle")).toBeInTheDocument();
    expect(
      screen.getByText("errors.ticketTransferEventPast"),
    ).toBeInTheDocument();
    expect(screen.queryByText("auth.ctTransferExpired")).toBeNull();
    expect(screen.queryByText("auth.ctExpiredDesc")).toBeNull();
  });

  it("keeps the expired copy for an invite that lapsed before the show", () => {
    testState.error = trpcError("PENDING_TRANSFER_EXPIRED");
    render(<ClaimTransfer token="tok" />);
    expect(screen.getByText("auth.ctTransferExpired")).toBeInTheDocument();
    expect(screen.getByText("auth.ctExpiredDesc")).toBeInTheDocument();
    expect(screen.queryByText("transfer.eventEndedTitle")).toBeNull();
  });

  // Owner rule 2026-10-04: a ticket under an open resale claim can't move.
  // The recipient must not see the owner-facing copy, which names the claim.
  it("shows recipient copy for TICKET_UNDER_CLAIM, not the owner's claim copy", () => {
    testState.error = trpcError("TICKET_UNDER_CLAIM");
    render(<ClaimTransfer token="tok" />);
    expect(screen.getByText("auth.ctTransferFailed")).toBeInTheDocument();
    expect(screen.getByText("auth.ctTicketOnHoldDesc")).toBeInTheDocument();
    expect(screen.queryByText("errors.ticketUnderClaim")).toBeNull();
    expect(screen.queryByText("auth.ctAlreadyClaimed")).toBeNull();
  });

  // Owner rule 2026-10-05: nothing moves a ticket while a refund on its order
  // is in flight. The sender's refund is not the recipient's business, so the
  // recipient gets the same neutral on-hold copy as for a claim.
  it("shows the neutral on-hold copy for TICKET_REFUND_IN_PROGRESS", () => {
    testState.error = trpcError("TICKET_REFUND_IN_PROGRESS");
    render(<ClaimTransfer token="tok" />);
    expect(screen.getByText("auth.ctTransferFailed")).toBeInTheDocument();
    expect(screen.getByText("auth.ctTicketOnHoldDesc")).toBeInTheDocument();
    expect(screen.queryByText("errors.ticketRefundInProgress")).toBeNull();
    expect(screen.queryByText("auth.ctAlreadyClaimed")).toBeNull();
  });
});
