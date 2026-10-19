import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Regression: Better Auth refetches `/get-session` on every
 * `visibilitychange` → visible (tab / app switch). While signed out its
 * `useAuthQuery` sets `isPending: currentValue.data === null` on request, so
 * the refetch flips `isPending` back to `true`. The page used to gate its
 * render on raw `isPending`, which unmounted the auth card and wiped whatever
 * the user had typed the moment they came back from a password manager.
 *
 * Regression 2 (bounce): a client can hold a session the SERVER can't see —
 * a host-only cookie bound to the api host is never sent to the apex origin,
 * so the middleware fails closed and 307s back to `/sign-in`. That bounce
 * lands on the same route segment, so this component keeps its state, the
 * `redirecting` latch stays true, and the page renders `null` forever. The
 * page now stops rendering `null` on a timer and renders the form.
 *
 * Regression 3 (the timer is not evidence): surviving that timer was treated
 * as proof of a bounce and used to authorise `signOut()`. It is not — the
 * component also survives it while the navigation is merely still in flight
 * (cold route, slow network, heavy admin shell). That signed users out ~2.5s
 * after a SUCCESSFUL login and told them their session was stale.
 *
 * Regression 4 (`200 + null` is not evidence either): re-checking the session
 * before signing out looks like it fixes regression 3, but the check cannot
 * carry that weight. The API registers `customSession(...)`, whose handler
 * overrides core `/get-session` and does
 * `await getSession()({...}).catch(() => null)` → `ctx.json(null)`, while core
 * `getSession` THROWS `INTERNAL_SERVER_ERROR` on an internal failure. So a DB
 * blip reaches the client as `{ data: null, error: null }` — indistinguishable
 * from a real sign-out. The component therefore no longer signs anything out
 * on ANY path; that is now a structural property, asserted below.
 */

const sessionState = {
  data: null as { user?: unknown } | null,
  isPending: true,
};
let notifySessionChange: () => void = () => {};

const useSessionMock = () => {
  const [, force] = useState(0);
  notifySessionChange = () => force((n) => n + 1);
  return sessionState;
};

const replaceMock = vi.fn();
const signOutMock = vi.fn(() => Promise.resolve());
const captureMessageMock = vi.fn();
const captureExceptionMock = vi.fn();

// Real module, mocked transport: `traceIgnoredError` imports Sentry directly,
// so mocking `@sentry/nextjs` covers both the page's own `captureMessage` and
// the traced swallows in the re-check.
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

type ServerSessionResult = {
  data?: { user?: unknown } | null;
  error?: unknown;
};

// Stands in for the server's answer to "can you still use this session?".
// Default: the server accepts it — i.e. the common case this page kept getting
// wrong, where the login worked and only the navigation was slow.
const getSessionMock = vi.fn(
  (_args?: unknown): Promise<ServerSessionResult> =>
    Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
);

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => useSessionMock(),
    signOut: () => signOutMock(),
    getSession: (args?: unknown) => getSessionMock(args),
  },
}));

// Mutable so the `?error=` tests can set the query string; reset per test.
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearchParams,
}));

// Stable identity on purpose: the real `useRouter` returns a memoized object,
// and a fresh one per render would re-run the redirect effect and mask how
// many times `replace` is actually issued.
//
// Held in a mutable binding so one test can deliberately swap it — a changed
// `router` identity is the realistic way the re-check effect re-runs after
// `bounced` has already latched, which is precisely what the retry ref
// guards. (StrictMode does NOT cover that case: its double-invoke happens at
// mount, when that effect still early-returns on `!bounced`.)
let currentRouter = { replace: replaceMock, push: vi.fn() };

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => currentRouter,
}));

// Stand-in for the real shell: holds form state so we can assert it survives
// a session refetch instead of being destroyed by an unmount, and echoes the
// session-notice value so the bounce path is observable. The notice is echoed
// as the raw three-state value rather than rendered copy — which STRING each
// state maps to is the shell's job (and is asserted there); which STATE the
// page picks is this file's.
vi.mock("@/components/auth/StandaloneAuthPageShell", () => ({
  StandaloneAuthPageShell: ({
    sessionNotice = "none",
  }: {
    sessionNotice?: string;
  }) => {
    const [value, setValue] = useState("");
    return (
      <>
        {sessionNotice !== "none" ? (
          <p data-testid="session-notice">{sessionNotice}</p>
        ) : null}
        <input
          aria-label="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </>
    );
  },
}));

let SignInPage: (typeof import("../[[...index]]/page"))["default"];

const setSession = (next: Partial<typeof sessionState>) => {
  act(() => {
    Object.assign(sessionState, next);
    notifySessionChange();
  });
};

describe("SignInPage", () => {
  beforeAll(async () => {
    ({ default: SignInPage } = await import("../[[...index]]/page"));
  });

  beforeEach(() => {
    sessionState.data = null;
    sessionState.isPending = true;
    currentSearchParams = new URLSearchParams();
    currentRouter = { replace: replaceMock, push: vi.fn() };
    replaceMock.mockClear();
    signOutMock.mockClear();
    getSessionMock.mockClear();
    captureMessageMock.mockClear();
    captureExceptionMock.mockClear();
    getSessionMock.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });

  it("keeps typed form state when the session refetches on tab return", () => {
    render(<SignInPage />);

    // First session lookup settles → the card renders.
    setSession({ isPending: false });
    const input = screen.getByLabelText("email") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "someone@example.com" } });
    expect((screen.getByLabelText("email") as HTMLInputElement).value).toBe(
      "someone@example.com",
    );

    // Tab switch away and back: Better Auth refetches and, while signed out,
    // reports isPending again.
    setSession({ isPending: true });
    expect(screen.queryByLabelText("email")).toBeInTheDocument();

    setSession({ isPending: false });
    expect((screen.getByLabelText("email") as HTMLInputElement).value).toBe(
      "someone@example.com",
    );
  });

  it("renders nothing until the first session lookup settles", () => {
    render(<SignInPage />);
    expect(screen.queryByLabelText("email")).not.toBeInTheDocument();
  });

  it("redirects an already-signed-in user instead of showing the form", () => {
    render(<SignInPage />);

    setSession({ isPending: false, data: { user: { id: "u1" } } });

    expect(replaceMock).toHaveBeenCalledWith("/");
    expect(screen.queryByLabelText("email")).not.toBeInTheDocument();
  });

  describe("redirect bounce", () => {
    beforeEach(() => {
      // Plain fake timers (no `shouldAdvanceTime`): every assertion here is
      // synchronous, so nothing should move the clock except an explicit
      // `advanceTimersByTime` — otherwise wall-clock drift could fire the
      // bounce timer in the tests that assert it does NOT fire.
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // The bounce returns to the SAME route segment, so nothing unmounts — and
    // a slow navigation doesn't unmount us either. Both look identical here,
    // which is the whole point: the timer alone must not decide anything
    // destructive. Well past BOUNCE_DETECT_MS (9s).
    const stayMountedPastBounceWindow = () => {
      act(() => {
        vi.advanceTimersByTime(12_000);
      });
    };

    // Lets the server re-check's promise chain settle. `settle()` awaits the
    // getSession promise before touching state, so plain microtask flushes are
    // enough — fake timers don't stall microtasks.
    const settleServerReCheck = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    const bounceAndSettle = async () => {
      stayMountedPastBounceWindow();
      await settleServerReCheck();
    };

    it("renders the sign-in form instead of staying blank", async () => {
      getSessionMock.mockResolvedValue({ data: null, error: null });
      render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });

      // Still blank while the redirect is believed to be in flight.
      expect(replaceMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByLabelText("email")).not.toBeInTheDocument();

      await bounceAndSettle();

      expect(screen.getByLabelText("email")).toBeInTheDocument();
      expect(screen.getByTestId("session-notice")).toHaveTextContent("expired");
    });

    it("shows the stale-session notice when the server returns no session", async () => {
      getSessionMock.mockResolvedValue({ data: null, error: null });
      render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });

      await bounceAndSettle();

      expect(screen.getByTestId("session-notice")).toHaveTextContent("expired");
    });

    // ── THE STRUCTURAL INVARIANT ─────────────────────────────────────────
    // No path in this component may destroy a session. Not "no path unless
    // the server says so" — the server CANNOT say so: `customSession`
    // swallows internal errors into `200 + null`, so "the session is gone"
    // and "the database is having a moment" arrive identically. Every server
    // answer is enumerated here; none of them may sign anybody out.
    it.each([
      ["a confirmed session", { data: { user: { id: "u1" } }, error: null }],
      ["no session / degraded API (200 + null)", { data: null, error: null }],
      ["an explicit error", { data: null, error: { status: 500 } }],
      ["an unexpected empty resolve", {}],
    ])("never signs out — %s", async (_label, serverAnswer) => {
      getSessionMock.mockResolvedValue(serverAnswer);
      render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });

      await bounceAndSettle();

      // Second pass: swap the router identity so the re-check effect
      // GENUINELY re-runs with `bounced` already latched (deps are
      // [bounced, redirectPath, router]) and hits the server answer a second
      // time. A plain re-render would not do this — by now `redirecting` is
      // false, so the bounce timer is no longer armed and advancing the clock
      // alone is a no-op.
      currentRouter = { replace: replaceMock, push: vi.fn() };
      setSession({ isPending: false, data: { user: { id: "u1" } } });
      await bounceAndSettle();

      expect(getSessionMock.mock.calls.length).toBeGreaterThan(1);
      expect(signOutMock).not.toHaveBeenCalled();
    });

    it("re-checks the session with both caches bypassed", async () => {
      // A POSITIVE answer has to mean "right now", not "as of before the
      // redirect": Better Auth's signed cookie-cache would happily echo a
      // session it hasn't re-read, and the HTTP cache would echo the
      // pre-redirect response. (A negative answer is ambiguous no matter what
      // we send — hence the no-sign-out invariant above.)
      getSessionMock.mockResolvedValue({ data: null, error: null });
      render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });

      await bounceAndSettle();

      expect(getSessionMock).toHaveBeenCalledWith({
        query: { disableCookieCache: true },
        fetchOptions: { cache: "no-store" },
      });
    });

    it("never re-arms the redirect after a bounce", async () => {
      getSessionMock.mockResolvedValue({ data: null, error: null });
      render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });
      await bounceAndSettle();

      // The session object is still "signed in"; without the latch this
      // re-render would kick off the loop all over again.
      setSession({ isPending: false, data: { user: { id: "u1" } } });
      await bounceAndSettle();

      expect(replaceMock).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("email")).toBeInTheDocument();
    });

    it("does not trip the bounce when the redirect succeeds", () => {
      // A successful redirect navigates away, unmounting this component —
      // the effect cleanup must clear the timer so it never fires.
      const { unmount } = render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });
      expect(replaceMock).toHaveBeenCalledWith("/");

      unmount();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });

      expect(signOutMock).not.toHaveBeenCalled();
      expect(getSessionMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("session-notice")).not.toBeInTheDocument();
    });

    it("does not trip the bounce for a signed-out visitor", () => {
      render(<SignInPage />);
      setSession({ isPending: false });

      stayMountedPastBounceWindow();

      expect(replaceMock).not.toHaveBeenCalled();
      expect(signOutMock).not.toHaveBeenCalled();
      expect(getSessionMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("session-notice")).not.toBeInTheDocument();
      expect(screen.getByLabelText("email")).toBeInTheDocument();
    });

    // ── The login-destroying regression ──────────────────────────────────
    // `?error=` and a bounce together: the refusal notice shows while the
    // re-check is out, and the re-check's verdict replaces it once it answers.
    describe("with ?error= in the URL", () => {
      it.each([
        ["a confirmed session", { data: { user: { id: "u1" } }, error: null }, "unverified"],
        ["no session", { data: null, error: null }, "expired"],
      ] as const)(
        "shows the error notice while checking, then the verdict for %s",
        async (_label, answer, verdict) => {
          currentSearchParams = new URLSearchParams({
            error: "TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN",
          });
          let resolveReCheck!: (value: ServerSessionResult) => void;
          getSessionMock.mockReturnValue(
            new Promise<ServerSessionResult>((resolve) => {
              resolveReCheck = resolve;
            }),
          );
          render(<SignInPage />);
          setSession({ isPending: false, data: { user: { id: "u1" } } });

          stayMountedPastBounceWindow();
          await settleServerReCheck();
          expect(screen.getByTestId("session-notice")).toHaveTextContent(
            "twoFactorUsePrimary",
          );

          resolveReCheck(answer);
          await settleServerReCheck();
          expect(screen.getByTestId("session-notice")).toHaveTextContent(
            verdict,
          );
        },
      );
    });

    describe("valid session, slow navigation", () => {
      it("never signs out a session the server still accepts", async () => {
        // Server says the session is fine: the login worked, the destination
        // route is just slow to render. Destroying it here was the bug.
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(signOutMock).not.toHaveBeenCalled();
        // Not the EXPIRY copy — nothing expired. See the dedicated
        // `sessionConfirmed` notice test below for what is shown instead.
        expect(screen.getByTestId("session-notice")).not.toHaveTextContent(
          "expired",
        );
      });

      // ── The production incident's actual branch ────────────────────────
      it("explains itself when the server confirms a session the destination refused", async () => {
        // This is the ghost-cookie admin, exactly: `useSession()` succeeds
        // (browser → api host, where the host-only cookie IS sent), the
        // middleware fails closed (apex, where it is NOT), and the re-check
        // is the same browser → same host call, so it confirms too. Gating
        // the notice on `noSessionReturned` meant this user — the only user
        // who ever hit the bug — got a blank page and then a bare form with
        // no explanation whatsoever.
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(screen.getByTestId("session-notice")).toHaveTextContent(
          "unverified",
        );
        expect(screen.getByLabelText("email")).toBeInTheDocument();
        expect(signOutMock).not.toHaveBeenCalled();
      });

      it("retries the navigation exactly once and never loops", async () => {
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        expect(replaceMock).toHaveBeenCalledTimes(1);

        await bounceAndSettle();

        // One initial replace + one retry. Nothing after that, no matter how
        // many session refetches or timer ticks arrive.
        expect(replaceMock).toHaveBeenCalledTimes(2);
        expect(replaceMock).toHaveBeenLastCalledWith("/");

        setSession({ isPending: false, data: { user: { id: "u1" } } });
        await bounceAndSettle();
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        await bounceAndSettle();

        expect(replaceMock).toHaveBeenCalledTimes(2);
      });

      it("retries exactly once even when the re-check effect re-runs", async () => {
        // THE test for the retry ref. Swapping the `router` identity is how
        // that effect genuinely re-runs after `bounced` has latched (its deps
        // are [bounced, redirectPath, router]); without the ref the second run
        // issues a second retry, and so on for every subsequent re-run.
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();
        expect(replaceMock).toHaveBeenCalledTimes(2);

        // Fresh router identity → the effect re-runs with `bounced` already
        // true → the re-check runs again → the retry must NOT fire again.
        currentRouter = { replace: replaceMock, push: vi.fn() };
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        await bounceAndSettle();

        currentRouter = { replace: replaceMock, push: vi.fn() };
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        await bounceAndSettle();

        expect(getSessionMock.mock.calls.length).toBeGreaterThan(1); // it did re-run
        expect(replaceMock).toHaveBeenCalledTimes(2); // …and still retried once
        expect(signOutMock).not.toHaveBeenCalled();
      });

      it("does not double-fire the initial replace under StrictMode", async () => {
        // Narrower than it looks, and labelled honestly: StrictMode's
        // double-invoke lands at MOUNT, so it exercises the redirect effect
        // (guarded by `redirecting`), not the retry ref. The retry ref is
        // covered by the effect-re-run test above.
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(
          <StrictMode>
            <SignInPage />
          </StrictMode>,
        );
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        expect(replaceMock).toHaveBeenCalledTimes(1);

        await bounceAndSettle();

        expect(replaceMock).toHaveBeenCalledTimes(2);
        expect(signOutMock).not.toHaveBeenCalled();
      });

      it("leaves a usable page rather than a blank one if the retry also stalls", async () => {
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(screen.getByLabelText("email")).toBeInTheDocument();
      });
    });

    // ── The answer that lies ─────────────────────────────────────────────
    describe("degraded API returning 200 + null on a VALID session", () => {
      // `customSession` catches core `getSession`'s INTERNAL_SERVER_ERROR and
      // returns `ctx.json(null)`. So during a DB blip a perfectly valid
      // session re-checks as `{ data: null, error: null }` — the exact shape
      // of a real sign-out. This is why the re-check may not gate anything
      // destructive.
      const degradedApiAnswer = { data: null, error: null };

      it("does not sign out the still-valid session", async () => {
        getSessionMock.mockResolvedValue(degradedApiAnswer);
        render(<SignInPage />);
        // The client's session is genuinely fine — that's what got us here.
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(signOutMock).not.toHaveBeenCalled();
      });

      it("shows the notice and a usable form, and leaves the session intact", async () => {
        // We cannot tell this apart from a real sign-out, so we do the only
        // thing that is safe under both readings: explain, offer the form,
        // touch nothing. The session survives; if it was in fact fine, the
        // user's next navigation still works.
        getSessionMock.mockResolvedValue(degradedApiAnswer);
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(screen.getByTestId("session-notice")).toHaveTextContent(
          "expired",
        );
        expect(screen.getByLabelText("email")).toBeInTheDocument();
        expect(signOutMock).not.toHaveBeenCalled();
      });
    });

    // ── Inconclusive re-check must stay non-destructive ──────────────────
    describe("when the server re-check cannot answer", () => {
      it("does not sign out when the re-check errors", async () => {
        getSessionMock.mockResolvedValue({
          data: null,
          error: { status: 500, message: "boom" },
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(signOutMock).not.toHaveBeenCalled();
        expect(screen.queryByTestId("session-notice")).not.toBeInTheDocument();
        expect(screen.getByLabelText("email")).toBeInTheDocument();
      });

      it("reports the swallowed transport error instead of dropping it", async () => {
        // `if (result?.error) return;` was silent. Control flow is unchanged
        // (an HTTP error still tells us nothing about the session), but the
        // failure has to reach Sentry — a swallow that logs nothing is the
        // exact shape that hid a four-day outage.
        const error = { status: 500, message: "boom" };
        getSessionMock.mockResolvedValue({ data: null, error });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(captureExceptionMock).toHaveBeenCalledWith(
          error,
          expect.objectContaining({
            tags: { traceIgnoredError: "signIn.bounceRecheck" },
          }),
        );
      });

      it("does not sign out when the re-check rejects", async () => {
        getSessionMock.mockRejectedValue(new Error("network down"));
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(signOutMock).not.toHaveBeenCalled();
        expect(screen.getByLabelText("email")).toBeInTheDocument();
      });

      it("reports a rejected re-check instead of dropping it", async () => {
        const err = new Error("network down");
        getSessionMock.mockRejectedValue(err);
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(captureExceptionMock).toHaveBeenCalledWith(
          err,
          expect.objectContaining({
            tags: { traceIgnoredError: "signIn.bounceRecheck" },
          }),
        );
      });

      it("still renders the form while the re-check hangs forever", async () => {
        // The anti-blank-page guarantee may not depend on the network. A
        // never-resolving re-check must not re-introduce the `null` render.
        getSessionMock.mockReturnValue(new Promise<never>(() => {}));
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        expect(screen.queryByLabelText("email")).not.toBeInTheDocument();

        await bounceAndSettle();

        expect(screen.getByLabelText("email")).toBeInTheDocument();
        expect(signOutMock).not.toHaveBeenCalled();
        expect(screen.queryByTestId("session-notice")).not.toBeInTheDocument();
      });
    });

    // ── Telemetry ────────────────────────────────────────────────────────
    // Without an event in Sentry, this fix is unfalsifiable in production:
    // no way to know how often the bounce fires, whether 9s is the right
    // window, or whether the API-side ghost-cookie clearing worked.
    describe("bounce telemetry", () => {
      const captureCalls = () =>
        captureMessageMock.mock.calls.filter(
          (call) => call[0] === "sign_in_bounce_detected",
        );

      it("reports the bounce tagged with the resolved verdict", async () => {
        getSessionMock.mockResolvedValue({ data: null, error: null });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(captureCalls()).toHaveLength(1);
        expect(captureCalls()[0]?.[1]).toMatchObject({
          level: "warning",
          tags: { bounceVerdict: "noSessionReturned" },
        });
      });

      it("distinguishes the ghost-cookie case in the tag", async () => {
        // `sessionConfirmed` and `noSessionReturned` are different incidents —
        // one is a cookie-scoping bug, the other an expiry or a degraded API.
        // A single untagged event would merge them.
        getSessionMock.mockResolvedValue({
          data: { user: { id: "u1" } },
          error: null,
        });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(captureCalls()[0]?.[1]).toMatchObject({
          tags: { bounceVerdict: "sessionConfirmed" },
        });
      });

      it("reports even when the re-check never answers", async () => {
        // The hung case is the one most worth seeing, and it is the one a
        // "report on verdict resolution" design would silently drop.
        getSessionMock.mockReturnValue(new Promise<never>(() => {}));
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();
        expect(captureCalls()).toHaveLength(0); // still waiting on the verdict

        act(() => {
          vi.advanceTimersByTime(12_000);
        });

        expect(captureCalls()).toHaveLength(1);
        expect(captureCalls()[0]?.[1]).toMatchObject({
          tags: { bounceVerdict: "checking" },
        });
      });

      it("reports at most once per mount", async () => {
        getSessionMock.mockResolvedValue({ data: null, error: null });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        await bounceAndSettle();

        // Re-runs of the re-check effect (fresh router identity) must not
        // multiply the event, or its frequency in Sentry is meaningless.
        currentRouter = { replace: replaceMock, push: vi.fn() };
        setSession({ isPending: false, data: { user: { id: "u1" } } });
        await bounceAndSettle();
        act(() => {
          vi.advanceTimersByTime(30_000);
        });

        expect(captureCalls()).toHaveLength(1);
      });

      it("does not report when nothing bounced", () => {
        render(<SignInPage />);
        setSession({ isPending: false });
        stayMountedPastBounceWindow();

        expect(captureCalls()).toHaveLength(0);
      });

      it("never lets a throwing Sentry break the page", async () => {
        captureMessageMock.mockImplementationOnce(() => {
          throw new Error("sentry unavailable");
        });
        getSessionMock.mockResolvedValue({ data: null, error: null });
        render(<SignInPage />);
        setSession({ isPending: false, data: { user: { id: "u1" } } });

        await bounceAndSettle();

        expect(screen.getByLabelText("email")).toBeInTheDocument();
      });
    });

    // ── The remaining route to a permanently blank page ──────────────────
    describe("when the FIRST session lookup never settles", () => {
      it("shows the form rather than rendering null forever", async () => {
        // API down / cold-start timeout / hung fetch: `isPending` never goes
        // false, so `session?.user` never appears, `redirecting` is never
        // set, the bounce timer is never armed — and every anti-blank-page
        // guarantee in the page is downstream of a lookup that ANSWERS.
        render(<SignInPage />);
        expect(screen.queryByLabelText("email")).not.toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(12_000);
        });

        expect(screen.getByLabelText("email")).toBeInTheDocument();
        // Nothing bounced and nothing was re-checked: this is a render gate,
        // not a verdict.
        expect(screen.queryByTestId("session-notice")).not.toBeInTheDocument();
        expect(getSessionMock).not.toHaveBeenCalled();
        expect(signOutMock).not.toHaveBeenCalled();
      });

      it("still redirects a signed-in user whose lookup resolves late", () => {
        // Firing the deadline early must cost at most a flash of the form —
        // the redirect effect keys on `session`, not on the render gate.
        render(<SignInPage />);
        act(() => {
          vi.advanceTimersByTime(12_000);
        });
        expect(screen.getByLabelText("email")).toBeInTheDocument();

        setSession({ isPending: false, data: { user: { id: "u1" } } });

        expect(replaceMock).toHaveBeenCalledWith("/");
      });
    });

    it("settles nothing when the navigation lands mid-re-check", async () => {
      // Unmounting means the destination finally rendered — the session was
      // never stale, so a late-arriving re-check must not act on it.
      let resolveReCheck: (value: ServerSessionResult) => void = () => {};
      getSessionMock.mockReturnValue(
        new Promise<ServerSessionResult>((resolve) => {
          resolveReCheck = resolve;
        }),
      );
      const { unmount } = render(<SignInPage />);
      setSession({ isPending: false, data: { user: { id: "u1" } } });
      stayMountedPastBounceWindow();

      unmount();
      resolveReCheck({ data: null, error: null });
      await settleServerReCheck();

      expect(signOutMock).not.toHaveBeenCalled();
    });
  });

  // The API sends a refused sign-in back here with `?error=`. Only its three
  // codes produce a notice; the raw value never reaches the page.
  describe("?error= from a refused sign-in", () => {
    it.each([
      ["TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN", "twoFactorUsePrimary"],
      ["STAFF_ACCOUNT_USE_PASSKEY", "staffUsePasskey"],
      ["account_not_active", "accountNotActive"],
    ])("shows the notice for %s", (code, notice) => {
      currentSearchParams = new URLSearchParams({ error: code });
      render(<SignInPage />);
      setSession({ isPending: false });
      expect(screen.getByTestId("session-notice")).toHaveTextContent(notice);
      expect(document.body.textContent).not.toContain(code);
    });

    it("ignores an unknown code", () => {
      currentSearchParams = new URLSearchParams({ error: "bogus" });
      render(<SignInPage />);
      setSession({ isPending: false });
      expect(screen.getByLabelText("email")).toBeInTheDocument();
      expect(screen.queryByTestId("session-notice")).toBeNull();
      expect(document.body.textContent).not.toContain("bogus");
    });
  });
});
