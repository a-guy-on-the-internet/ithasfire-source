import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeMode } from "@/lib/theme-mode";

const useSessionMock = vi.fn();
const mutateMock = vi.fn();
let currentMode: ThemeMode = "light";

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => useSessionMock(),
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    humans: {
      setThemePreference: {
        useMutation: () => ({ mutate: mutateMock }),
      },
    },
  },
}));

vi.mock("@/components/theme/AppThemeProvider", () => ({
  useAppTheme: () => ({ mode: currentMode }),
}));

// Imported AFTER the mocks so it picks up the mocked deps.
import { ThemeAccountSyncer } from "@/components/theme/ThemeAccountSyncer";

const signedIn = () =>
  useSessionMock.mockReturnValue({ data: { user: { id: "h1" } } });
const signedOut = () => useSessionMock.mockReturnValue({ data: null });
// Session still resolving — Better Auth returns no user yet.
const sessionPending = () => useSessionMock.mockReturnValue({ data: undefined });

describe("ThemeAccountSyncer", () => {
  beforeEach(() => {
    useSessionMock.mockReset();
    mutateMock.mockReset();
    currentMode = "light";
  });

  it("does not persist on the initial mount (no echo of SSR-resolved mode)", () => {
    signedIn();
    render(<ThemeAccountSyncer />);
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("persists the new mode when a signed-in user toggles", () => {
    signedIn();
    const { rerender } = render(<ThemeAccountSyncer />);
    expect(mutateMock).not.toHaveBeenCalled();

    currentMode = "dark";
    rerender(<ThemeAccountSyncer />);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({ mode: "dark" });
  });

  it("does not persist when the user is signed out", () => {
    signedOut();
    const { rerender } = render(<ThemeAccountSyncer />);

    currentMode = "dark";
    rerender(<ThemeAccountSyncer />);

    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("flushes a toggle made while the session was still loading, once it resolves", () => {
    // Session still loading on mount; the user toggles to dark before it resolves.
    sessionPending();
    const { rerender } = render(<ThemeAccountSyncer />);

    currentMode = "dark";
    rerender(<ThemeAccountSyncer />);
    expect(mutateMock).not.toHaveBeenCalled(); // not signed in yet

    // Session resolves → the pending dark toggle is flushed to the account
    // (regression guard: the previous ref-advance logic swallowed it).
    signedIn();
    rerender(<ThemeAccountSyncer />);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({ mode: "dark" });
  });

  it("persists again on a subsequent change back", () => {
    signedIn();
    const { rerender } = render(<ThemeAccountSyncer />);

    currentMode = "dark";
    rerender(<ThemeAccountSyncer />);
    currentMode = "light";
    rerender(<ThemeAccountSyncer />);

    expect(mutateMock).toHaveBeenCalledTimes(2);
    expect(mutateMock).toHaveBeenLastCalledWith({ mode: "light" });
  });
});
