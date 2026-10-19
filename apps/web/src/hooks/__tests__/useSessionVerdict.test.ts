import { StrictMode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  useSessionVerdict,
  SESSION_RECHECK_DELAY_MS,
} from "../useSessionVerdict";

// ── Better Auth session stub ────────────────────────────────────────────────
// Faithful to `better-auth/dist/client/query.mjs`: a refetch flips `isPending`
// back to true whenever `data === null` (its `onRequest` sets
// `isPending: currentValue.data === null`), which is the exact quirk this hook
// is written around. Tests drive each settle by hand.
//
// `vi.hoisted` so the mock factory — hoisted above the imports — can reach the
// stub without tripping a TDZ error on the hook's first import.

type StubUser = { id: string; name: string };

type StubSession = {
  data: { user: StubUser } | null;
  error: unknown;
  isPending: boolean;
  refetch: (() => void) | undefined;
};

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  session: undefined as unknown,
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => mocks.session },
}));

const USER: StubUser = { id: "human_1", name: "Dev Attendee" };

function session(): StubSession {
  return mocks.session as StubSession;
}

function setSession(next: Partial<StubSession>) {
  mocks.session = { ...session(), ...next };
}

describe("useSessionVerdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.refetch.mockReset();
    mocks.session = {
      data: null,
      error: null,
      isPending: true,
      refetch: () => mocks.refetch(),
    } satisfies StubSession;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unknown while the first lookup is in flight", () => {
    const { result } = renderHook(() => useSessionVerdict());
    expect(result.current.verdict).toBe("unknown");
    expect(result.current.user).toBeUndefined();
  });

  it("says signed in as soon as a user is observed, and never re-checks", () => {
    setSession({ data: { user: USER }, isPending: false });
    const { result } = renderHook(() => useSessionVerdict());

    expect(result.current.verdict).toBe("signedIn");
    expect(result.current.user).toEqual(USER);

    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 5));
    expect(result.current.verdict).toBe("signedIn");
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("does NOT conclude signed out when the re-check finds a user", () => {
    // First lookup settles with nobody — the race this hook exists for.
    setSession({ data: null, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());

    expect(result.current.verdict).toBe("unknown");
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(result.current.isRechecking).toBe(true);

    // The re-check goes out (`isPending` flips true because `data === null`)…
    act(() => {
      setSession({ isPending: true });
      rerender();
    });
    expect(result.current.verdict).toBe("unknown");

    // …and this time the cookie is readable.
    act(() => {
      setSession({ data: { user: USER }, isPending: false });
      rerender();
    });
    expect(result.current.verdict).toBe("signedIn");

    // The deadline firing afterwards must not undo that.
    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 2));
    expect(result.current.verdict).toBe("signedIn");
  });

  it("concludes signed out as soon as the re-check also finds nobody", () => {
    setSession({ data: null, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());

    expect(result.current.verdict).toBe("unknown");
    expect(result.current.isRechecking).toBe(true);

    // The re-check goes out…
    act(() => {
      setSession({ isPending: true });
      rerender();
    });
    expect(result.current.verdict).toBe("unknown");

    // …and answers. No reason to sit out the rest of the window: the navbar
    // uses this too, and a signed-out visitor should not wait a fixed second
    // to be shown where sign-in is.
    act(() => {
      setSession({ isPending: false });
      rerender();
    });
    expect(result.current.verdict).toBe("signedOut");
    expect(result.current.user).toBeUndefined();
    expect(result.current.isRechecking).toBe(false);
  });

  it("falls back to the deadline when the re-check never goes out", () => {
    // No `refetch` on the session at all — the arming effect has nothing to
    // call, so `isPending` never flips and only the timer can close the window.
    setSession({ data: null, isPending: false, refetch: undefined });
    const { result } = renderHook(() => useSessionVerdict());

    expect(result.current.verdict).toBe("unknown");
    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS - 1));
    expect(result.current.verdict).toBe("unknown");

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.verdict).toBe("signedOut");
  });

  it("stays unknown past the deadline while the re-check is still in flight", () => {
    setSession({ data: null, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());

    act(() => {
      setSession({ isPending: true });
      rerender();
    });
    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 3));
    expect(result.current.verdict).toBe("unknown");

    act(() => {
      setSession({ isPending: false });
      rerender();
    });
    expect(result.current.verdict).toBe("signedOut");
  });

  it("fires the re-check at most once, across re-renders and settles", () => {
    setSession({ data: null, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());

    for (let i = 0; i < 4; i += 1) {
      act(() => {
        setSession({ isPending: true });
        rerender();
      });
      act(() => {
        setSession({ isPending: false });
        rerender();
      });
    }
    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 4));

    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(result.current.verdict).toBe("signedOut");
  });

  it("does not loop when the client hands back a fresh object every render", () => {
    // Better Auth returns a new `data` object per fetch, and a caller (or a test
    // mock returning a literal) can return a new one per RENDER. Latching the
    // seen user in state, keyed on that identity, was an infinite
    // effect→setState→render loop that hung a whole suite before any test ran.
    let renders = 0;
    // A getter, so every read is a distinct object.
    Object.defineProperty(mocks, "session", {
      configurable: true,
      get: () => ({
        data: { user: { ...USER } },
        error: null,
        isPending: false,
        refetch: () => mocks.refetch(),
      }),
    });

    // Throwing beats asserting a count afterwards: a render loop is
    // synchronous, so `--testTimeout` cannot interrupt it and the suite HANGS
    // rather than failing. Verified by planting the regression.
    const { result } = renderHook(() => {
      renders += 1;
      if (renders > 30) throw new Error(`render loop: ${renders} renders`);
      return useSessionVerdict();
    });

    expect(result.current.verdict).toBe("signedIn");
    expect(renders).toBeLessThan(10);

    // Restore a plain writable property for the remaining tests.
    Object.defineProperty(mocks, "session", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("survives React's dev-mode double-invoke: one refetch, deadline intact", () => {
    setSession({ data: null, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict(), {
      wrapper: StrictMode,
    });

    // The double-invoke must not turn "once" into twice…
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(result.current.verdict).toBe("unknown");

    // …nor may its teardown swallow the deadline, leaving the page spinning.
    act(() => {
      setSession({ isPending: true });
      rerender();
    });
    act(() => {
      setSession({ isPending: false });
      rerender();
    });
    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS));

    expect(result.current.verdict).toBe("signedOut");
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a signed-in verdict through a transient null", () => {
    setSession({ data: { user: USER }, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());
    expect(result.current.verdict).toBe("signedIn");

    act(() => {
      setSession({ data: null, isPending: false });
      rerender();
    });
    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 3));

    expect(result.current.verdict).toBe("signedIn");
    expect(result.current.user).toEqual(USER);
    // The re-check still goes out once — it just cannot change the verdict.
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("treats a lookup error as unknown, not as signed out", () => {
    setSession({ data: null, isPending: false, error: { status: 500 } });
    const { result, rerender } = renderHook(() => useSessionVerdict());

    act(() => void vi.advanceTimersByTime(SESSION_RECHECK_DELAY_MS * 3));
    expect(result.current.verdict).toBe("unknown");
    // The failure still earns its one retry.
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    // Once a lookup answers cleanly with nobody, signed-out is honest.
    act(() => {
      setSession({ error: null });
      rerender();
    });
    expect(result.current.verdict).toBe("signedOut");
  });

  it("downgrades on an explicit sign-out — no re-check window, no latch", () => {
    vi.useFakeTimers();
    setSession({ data: { user: USER }, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());
    expect(result.current.verdict).toBe("signedIn");

    // The real sequence: `authClient.signOut()` clears the store, then the page
    // disarms the latch. Without the second step the latch would keep the
    // account chrome up for the whole mount.
    act(() => {
      setSession({ data: null });
      rerender();
    });
    act(() => result.current.markSignedOut());

    expect(result.current.verdict).toBe("signedOut");
    expect(result.current.user).toBeUndefined();
    // No bounded wait here: a sign-out the user asked for is not a race.
    expect(result.current.isRechecking).toBe(false);
  });

  it("lets a live session outrank a stale sign-out flag", () => {
    // `markSignedOut` disarms the LATCH; it is not a veto over what
    // /get-session currently reports. Signing back in without a remount works.
    setSession({ data: { user: USER }, isPending: false });
    const { result, rerender } = renderHook(() => useSessionVerdict());

    act(() => {
      setSession({ data: null });
      rerender();
    });
    act(() => result.current.markSignedOut());
    expect(result.current.verdict).toBe("signedOut");

    const other: StubUser = { id: "human_2", name: "Someone Else" };
    act(() => {
      setSession({ data: { user: other } });
      rerender();
    });
    expect(result.current.verdict).toBe("signedIn");
    expect(result.current.user).toEqual(other);
  });
});
