import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  token: vi.fn(),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: mocks.useSession, token: mocks.token },
}));
vi.mock("@/config/env.public", () => ({
  publicRuntimeEnv: { apiBaseUrl: "https://api.example.test" },
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => {},
}));
vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      releaseCartHold: { useMutation: mocks.useMutation },
      getActiveCartHolds: { useQuery: mocks.useQuery },
    },
  },
}));

import { useCartRecovery } from "../useCartRecovery";

const enabledFlag = () => mocks.useQuery.mock.calls.at(-1)?.[1]?.enabled;

describe("useCartRecovery — when the active-holds query runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReturnValue({ mutateAsync: vi.fn() });
    mocks.useQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch: vi.fn(),
    });
    mocks.token.mockResolvedValue({ data: { token: "t" }, error: null });
  });

  it("signed in and settled: enabled on first render, no token mint of its own", () => {
    mocks.useSession.mockReturnValue({
      data: { user: { id: "u1" } },
      isPending: false,
    });
    renderHook(() => useCartRecovery());
    expect(mocks.useQuery.mock.calls[0]?.[1]?.enabled).toBe(true);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("signed out: disabled", () => {
    mocks.useSession.mockReturnValue({ data: null, isPending: false });
    renderHook(() => useCartRecovery());
    expect(enabledFlag()).toBe(false);
  });

  it("session still pending: disabled", () => {
    mocks.useSession.mockReturnValue({
      data: { user: { id: "u1" } },
      isPending: true,
    });
    renderHook(() => useCartRecovery());
    expect(enabledFlag()).toBe(false);
  });

  it("checkOnMount false: disabled", () => {
    mocks.useSession.mockReturnValue({
      data: { user: { id: "u1" } },
      isPending: false,
    });
    renderHook(() => useCartRecovery({ checkOnMount: false }));
    expect(enabledFlag()).toBe(false);
  });
});
