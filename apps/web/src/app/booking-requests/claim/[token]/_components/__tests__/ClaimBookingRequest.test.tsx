import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testMocks = vi.hoisted(() => ({
  claimMutate: vi.fn(),
  setModeMutate: vi.fn(),
}));

// Mutable per-test state read by the mocked hooks.
let sessionState: { data: unknown; isPending: boolean };
let statusData:
  | {
      human: {
        ownerId: string;
        enabled: boolean;
        enabledAt: Date | null;
        statsEligible: boolean;
      };
      orgs: { ownerId: string; enabled: boolean; enabledAt: Date | null }[];
    }
  | undefined;
let sendersData:
  | {
      senders: {
        ownerType: "human" | "org";
        ownerId: string;
        displayName: string;
        isDefault: boolean;
      }[];
    }
  | undefined;
let claimState: {
  isPending: boolean;
  isSuccess: boolean;
  data?: { bookingRequestId: string; agreementId: string };
};

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => sessionState,
  },
}));

// Branch on the CONTRACT (`data.appCode`) independent of the canonical code
// registry (same rationale as DangerZone.test.tsx).
vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (error: unknown) =>
    (error as { data?: { appCode?: string } } | null)?.data?.appCode ?? null,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      performers: {
        getMyStatus: {
          getData: () => statusData,
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
      },
    }),
    performers: {
      getMyStatus: {
        useQuery: () => ({
          data: statusData,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      setMode: {
        useMutation: () => ({
          mutate: testMocks.setModeMutate,
          isPending: false,
        }),
      },
    },
    bookingRequests: {
      listMySenders: {
        useQuery: () => ({
          data: sendersData,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      claim: {
        useMutation: () => ({
          mutate: testMocks.claimMutate,
          isPending: claimState.isPending,
          isSuccess: claimState.isSuccess,
          data: claimState.data,
        }),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => {
  let groupOnValueChange: ((value: string) => void) | undefined;
  return {
    NextLinkAnchor: ({
      href,
      children,
    }: {
      href: string;
      children?: ReactNode;
    }) => <a href={href}>{children}</a>,
    Button: ({
      children,
      disabled,
      onPress,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      tag?: string;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    Spinner: () => <span>loading…</span>,
    Text: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    useTranslations: () => (key: string) => key,
    RadioGroupField: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      onValueChange?: (value: string) => void;
    }) => {
      groupOnValueChange = onValueChange;
      return <div role="radiogroup">{children}</div>;
    },
    Radio: ({ value, label }: { value: string; label: ReactNode }) => (
      <button type="button" onClick={() => groupOnValueChange?.(value)}>
        {label}
      </button>
    ),
  };
});

import { ClaimBookingRequest } from "../ClaimBookingRequest";

const TOKEN = "test-claim-token-abcdefghijklmnopqrstuvwxyz0123";

function seedReadyState() {
  sessionState = { data: { user: { id: "u1" } }, isPending: false };
  statusData = {
    human: {
      ownerId: "h1",
      enabled: true,
      enabledAt: new Date(),
      statsEligible: false,
    },
    orgs: [],
  };
  sendersData = {
    senders: [
      { ownerType: "human", ownerId: "h1", displayName: "Me", isDefault: true },
      {
        ownerType: "org",
        ownerId: "o1",
        displayName: "The Band",
        isDefault: false,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionState = { data: null, isPending: false };
  statusData = undefined;
  sendersData = undefined;
  claimState = { isPending: false, isSuccess: false };
});

describe("ClaimBookingRequest", () => {
  it("signed out → sign-in CTA carrying the claim path as redirect", () => {
    render(<ClaimBookingRequest token={TOKEN} />);

    expect(
      screen.getByText(/sign in to claim your booking/i),
    ).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      `/sign-in?redirect=${encodeURIComponent(`/booking-requests/claim/${TOKEN}`)}`,
    );
  });

  it("performer mode off everywhere → one-click enable gate", () => {
    sessionState = { data: { user: { id: "u1" } }, isPending: false };
    statusData = {
      human: {
        ownerId: "h1",
        enabled: false,
        enabledAt: null,
        statsEligible: false,
      },
      orgs: [{ ownerId: "o1", enabled: false, enabledAt: null }],
    };
    sendersData = { senders: [] };

    render(<ClaimBookingRequest token={TOKEN} />);

    expect(
      screen.getByText("admin.bkPerformerModeRequiredTitle"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("admin.bkEnablePerformerMode"));
    expect(testMocks.setModeMutate).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: "h1",
      enabled: true,
    });
  });

  it("claims with the default sender, passing the raw token through", () => {
    seedReadyState();

    render(<ClaimBookingRequest token={TOKEN} />);

    expect(
      screen.getByText(/been invited to finalize a booking/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^claim booking$/i));

    expect(testMocks.claimMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.claimMutate.mock.calls[0]![0]).toEqual({
      rawToken: TOKEN,
      performerOwnerType: "human",
      performerOwnerId: "h1",
    });
  });

  it("claims as a selected org sender", () => {
    seedReadyState();

    render(<ClaimBookingRequest token={TOKEN} />);

    fireEvent.click(screen.getByText("The Band"));
    fireEvent.click(screen.getByText(/^claim booking$/i));

    expect(testMocks.claimMutate.mock.calls[0]![0]).toEqual({
      rawToken: TOKEN,
      performerOwnerType: "org",
      performerOwnerId: "o1",
    });
  });

  it("TOKEN_EXPIRED → terminal expired state", () => {
    seedReadyState();
    testMocks.claimMutate.mockImplementation(
      (_input: unknown, opts: { onError: (err: unknown) => void }) => {
        opts.onError({ data: { appCode: "TOKEN_EXPIRED" } });
      },
    );

    render(<ClaimBookingRequest token={TOKEN} />);
    fireEvent.click(screen.getByText(/^claim booking$/i));

    expect(screen.getByText(/this link has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/resend the invite/i)).toBeInTheDocument();
  });

  it("TOKEN_INVALID → terminal already-used state", () => {
    seedReadyState();
    testMocks.claimMutate.mockImplementation(
      (_input: unknown, opts: { onError: (err: unknown) => void }) => {
        opts.onError({ data: { appCode: "TOKEN_INVALID" } });
      },
    );

    render(<ClaimBookingRequest token={TOKEN} />);
    fireEvent.click(screen.getByText(/^claim booking$/i));

    expect(
      screen.getByText(/this link is no longer active/i),
    ).toBeInTheDocument();
  });

  it("PERFORMER_MODE_REQUIRED → inline error, form stays", () => {
    seedReadyState();
    testMocks.claimMutate.mockImplementation(
      (_input: unknown, opts: { onError: (err: unknown) => void }) => {
        opts.onError({ data: { appCode: "PERFORMER_MODE_REQUIRED" } });
      },
    );

    render(<ClaimBookingRequest token={TOKEN} />);
    fireEvent.click(screen.getByText(/^claim booking$/i));

    expect(
      screen.getByText(/doesn't have performer mode turned on/i),
    ).toBeInTheDocument();
    // Form still present (not a terminal state).
    expect(
      screen.getByText(/been invited to finalize a booking/i),
    ).toBeInTheDocument();
  });

  it("success → agreement link and sent-requests link", () => {
    seedReadyState();
    claimState = {
      isPending: false,
      isSuccess: true,
      data: { bookingRequestId: "b1", agreementId: "a1" },
    };

    render(<ClaimBookingRequest token={TOKEN} />);

    expect(screen.getByText(/booking claimed/i)).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(
      expect.arrayContaining(["/agreements/a1", "/account/settings"]),
    );
  });
});
