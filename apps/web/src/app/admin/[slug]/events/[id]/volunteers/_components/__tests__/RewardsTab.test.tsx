import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => void;
};

const idle: QueryResult = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
};

let asksResult: QueryResult = { ...idle };
let eventResult: QueryResult = { ...idle };
let ticketTypesResult: QueryResult = { ...idle };
let rolesResult: QueryResult = { ...idle };
let rewardsResult: QueryResult = { ...idle };
let ledgerResult: QueryResult = { ...idle };

// Void-comp wiring spies (shared across the mocked trpc + notify surfaces).
const listInvalidate = vi.fn();
const ledgerInvalidate = vi.fn();
const revokeMutate = vi.fn();
let revokeOnSuccess: (() => void) | undefined;
let revokeOnError: ((err: unknown) => void) | undefined;
const toastSuccess = vi.fn();
const toastDanger = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>;
  return { YStack: passthrough };
});

vi.mock("@th/ui", () => ({
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
  useNotify: () => ({
    toast: { success: toastSuccess, danger: toastDanger },
  }),
}));

vi.mock("lucide-react", () => ({
  ShieldAlert: () => <span data-testid="shield" />,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: {
        rewards: {
          list: { invalidate: listInvalidate },
          ledger: { invalidate: ledgerInvalidate },
        },
      },
    }),
    volunteer: {
      asks: { listBySubject: { useQuery: () => asksResult } },
      roles: { list: { useQuery: () => rolesResult } },
      rewards: {
        list: { useQuery: () => rewardsResult },
        ledger: { useQuery: () => ledgerResult },
        revoke: {
          useMutation: (opts?: {
            onSuccess?: () => void;
            onError?: (err: unknown) => void;
          }) => {
            revokeOnSuccess = opts?.onSuccess;
            revokeOnError = opts?.onError;
            return { mutate: revokeMutate, isPending: false };
          },
        },
      },
    },
    events: {
      getEventForEdit: { useQuery: () => eventResult },
      listTicketTypesForEdit: { useQuery: () => ticketTypesResult },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: () => void;
  }) =>
    open ? (
      <button type="button" data-testid="confirm-void" onClick={onConfirm}>
        confirm
      </button>
    ) : null,
}));

vi.mock("@/components/volunteering/VolunteerRewardForm", () => ({
  VolunteerRewardForm: () => <div data-testid="volunteer-reward-form" />,
}));

vi.mock("@/components/volunteering/RewardLedgerTable", () => ({
  RewardLedgerTable: ({
    onVoid,
  }: {
    onVoid?: (grant: { id: string }) => void;
  }) => (
    <div data-testid="volunteer-reward-ledger">
      <button
        type="button"
        data-testid="trigger-void"
        onClick={() => onVoid?.({ id: "gr1" })}
      >
        void
      </button>
    </div>
  ),
}));

import { RewardsTab } from "../RewardsTab";

describe("RewardsTab finance gate", () => {
  beforeEach(() => {
    asksResult = { ...idle };
    eventResult = { ...idle };
    ticketTypesResult = { ...idle };
    rolesResult = { ...idle };
    rewardsResult = { ...idle };
    ledgerResult = { ...idle };
    listInvalidate.mockClear();
    ledgerInvalidate.mockClear();
    revokeMutate.mockClear();
    toastSuccess.mockClear();
    toastDanger.mockClear();
    revokeOnSuccess = undefined;
    revokeOnError = undefined;
  });

  const resolvedFinance = () => {
    asksResult = { ...idle, data: [{ id: "ask1" }] };
    eventResult = { ...idle, data: { currency: "usd" } };
    ticketTypesResult = { ...idle, data: { ticketTypes: [] } };
    rolesResult = { ...idle, data: [] };
    rewardsResult = { ...idle, data: { rewards: [] } };
    ledgerResult = {
      ...idle,
      data: {
        counts: { granted: 1, redeemed: 0, revoked: 0, total: 1 },
        remainingBudget: null,
        faceValueCents: 0,
        grants: [],
      },
    };
  };

  it("hides the config form and shows a finance-required notice for non-finance actors", () => {
    render(<RewardsTab eventId="e1" canFinance={false} />);
    expect(
      screen.getByTestId("volunteer-reward-finance-required"),
    ).toBeTruthy();
    expect(screen.queryByTestId("volunteer-reward-form")).toBeNull();
  });

  it("degrades to the finance-required notice when a reward query returns FORBIDDEN", () => {
    ledgerResult = {
      ...idle,
      isError: true,
      error: { data: { code: "FORBIDDEN" } },
    };
    render(<RewardsTab eventId="e1" canFinance />);
    expect(
      screen.getByTestId("volunteer-reward-finance-required"),
    ).toBeTruthy();
    expect(screen.queryByTestId("volunteer-reward-form")).toBeNull();
  });

  it("renders the config form + ledger once the ask and data resolve for finance actors", () => {
    asksResult = { ...idle, data: [{ id: "ask1" }] };
    eventResult = { ...idle, data: { currency: "usd" } };
    ticketTypesResult = { ...idle, data: { ticketTypes: [] } };
    rolesResult = { ...idle, data: [] };
    rewardsResult = { ...idle, data: { rewards: [] } };
    ledgerResult = {
      ...idle,
      data: {
        counts: { granted: 0, redeemed: 0, revoked: 0, total: 0 },
        remainingBudget: null,
        faceValueCents: 0,
        grants: [],
      },
    };
    render(<RewardsTab eventId="e1" canFinance />);
    expect(screen.getByTestId("volunteer-reward-form")).toBeTruthy();
    expect(screen.getByTestId("volunteer-reward-ledger")).toBeTruthy();
  });

  it("shows the no-ask notice when the event has no EVENT-subject ask yet", () => {
    asksResult = { ...idle, data: [] };
    eventResult = { ...idle, data: { currency: "usd" } };
    ticketTypesResult = { ...idle, data: { ticketTypes: [] } };
    rolesResult = { ...idle, data: [] };
    render(<RewardsTab eventId="e1" canFinance />);
    expect(screen.getByTestId("volunteer-reward-no-ask")).toBeTruthy();
    expect(screen.queryByTestId("volunteer-reward-form")).toBeNull();
  });

  it("does not open the void confirm dialog until the ledger's Void action fires", () => {
    resolvedFinance();
    render(<RewardsTab eventId="e1" canFinance />);
    expect(screen.queryByTestId("confirm-void")).toBeNull();
  });

  it("confirming a void calls rewards.revoke with the grant id + audit reason", () => {
    resolvedFinance();
    render(<RewardsTab eventId="e1" canFinance />);

    // Ledger's Void action opens the destructive confirm dialog.
    fireEvent.click(screen.getByTestId("trigger-void"));
    fireEvent.click(screen.getByTestId("confirm-void"));

    expect(revokeMutate).toHaveBeenCalledTimes(1);
    expect(revokeMutate).toHaveBeenCalledWith({
      grantId: "gr1",
      reason: "manually_voided",
    });
  });

  it("invalidates the ledger + rewards list on a successful void", () => {
    resolvedFinance();
    render(<RewardsTab eventId="e1" canFinance />);

    fireEvent.click(screen.getByTestId("trigger-void"));
    fireEvent.click(screen.getByTestId("confirm-void"));

    // Simulate the server acking the void.
    act(() => {
      revokeOnSuccess?.();
    });

    expect(ledgerInvalidate).toHaveBeenCalledWith({ askId: "ask1" });
    expect(listInvalidate).toHaveBeenCalledWith({ askId: "ask1" });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("refreshes the ledger when a raced redemption blocks the void", () => {
    resolvedFinance();
    render(<RewardsTab eventId="e1" canFinance />);

    fireEvent.click(screen.getByTestId("trigger-void"));
    fireEvent.click(screen.getByTestId("confirm-void"));

    // Server refuses: the comp was scanned between load and click.
    act(() => {
      revokeOnError?.({
        data: { meta: { reason: "reward_already_redeemed" } },
      });
    });

    expect(toastDanger).toHaveBeenCalledTimes(1);
    // Stale ledger refreshed so the row flips to "Comp used".
    expect(ledgerInvalidate).toHaveBeenCalledWith({ askId: "ask1" });
  });
});
