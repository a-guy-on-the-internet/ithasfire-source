/**
 * The password gate's Turnstile step. The unlock route answers 403
 * `event_password_challenge_required` after repeated wrong passwords, and from
 * then on only accepts attempts carrying a (single-use) Turnstile token.
 *
 * Contract under test:
 *   - no widget until the server asks for it;
 *   - a challenge 403 shows the widget, announces through #password-error in
 *     a NEUTRAL tone without `aria-invalid` (the challenge is decided before
 *     the password is checked), keeps the typed password and disables submit
 *     until a token exists;
 *   - a token-less submit that drew the challenge resubmits ONCE when the
 *     token lands; a 403 on a tokened submit does not re-arm that;
 *   - every tokened submit resets the widget and drops the token, whatever
 *     the outcome — and the widget is mounted once, never re-created;
 *   - no site key, a blocked script, a config error, repeated errors, an
 *     unsupported browser or a widget that never loads → "try again later",
 *     never an empty box with a dead button;
 *   - 401 / 429 / success behave as before.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role)$/;
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return React.createElement("div", domProps, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

const toastSuccess = vi.fn();

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    CardSurface: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
    // `tone` surfaces as data-tone so the neutral-vs-error split is testable.
    Text: ({
      children,
      id,
      role,
      tone,
    }: {
      children?: ReactNode;
      id?: string;
      role?: string;
      tone?: string;
    }) =>
      React.createElement("span", { id, role, "data-tone": tone }, children),
    PasswordInput: ({
      value,
      onChangeText,
      onSubmitEditing,
      autoFocus,
      ...rest
    }: {
      value: string;
      onChangeText: (v: string) => void;
      onSubmitEditing?: () => void;
      autoFocus?: boolean;
      [key: string]: unknown;
    }) =>
      React.createElement("input", {
        type: "password",
        value,
        autoFocus,
        onChange: (e: ChangeEvent<HTMLInputElement>) =>
          onChangeText(e.target.value),
        onKeyDown: (e: { key: string }) => {
          if (e.key === "Enter") onSubmitEditing?.();
        },
        "aria-label": rest["aria-label"],
        "aria-invalid": rest["aria-invalid"],
        "aria-describedby": rest["aria-describedby"],
      }),
    Button: ({
      children,
      disabled,
      onPress,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      React.createElement(
        "button",
        { type: "button", disabled, onClick: onPress },
        children,
      ),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
    useNotify: () => ({ toast: { success: toastSuccess, danger: vi.fn() } }),
  };
});

// Turnstile stand-in: records the latest props so a test can drive the
// widget's callbacks, counts real mounts, and exposes a spyable `reset`.
type TurnstileMockProps = {
  id?: string;
  siteKey: string;
  options?: { theme?: string; size?: string; action?: string };
  scriptOptions?: { onError?: () => void };
  onWidgetLoad?: (widgetId: string) => void;
  onSuccess?: (token: string) => void;
  onExpire?: () => void;
  onError?: (code: string) => unknown;
  onUnsupported?: () => void;
};
const turnstileReset = vi.fn();
let turnstileProps: TurnstileMockProps | null = null;
let turnstileMounts = 0;

vi.mock("@marsidev/react-turnstile", () => ({
  Turnstile: forwardRef(function TurnstileMock(props: TurnstileMockProps, ref) {
    turnstileProps = props;
    useImperativeHandle(ref, () => ({ reset: turnstileReset }));
    useEffect(() => {
      turnstileMounts += 1;
    }, []);
    return <div data-testid="turnstile" id={props.id} />;
  }),
}));

let siteKey = "test-site-key";
vi.mock("@/app/embed/[embedId]/_components/embed-helpers", () => ({
  get TURNSTILE_SITE_KEY() {
    return siteKey;
  },
}));

const traced: Array<{ label: string; err: unknown }> = [];
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) => {
    traced.push({ label, err });
  },
}));

const routerRefresh = vi.fn();
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
}));
vi.mock("@/components/events/WaitlistJoinForm", () => ({
  WaitlistJoinForm: () => null,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: undefined, isLoading: false }),
}));

import { EventPasswordGateWrapper } from "../EventPasswordGateWrapper";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

type Reply = { status: number; body?: unknown };
const reply = ({ status, body }: Reply) => ({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body ?? {}),
});
const CHALLENGE: Reply = {
  status: 403,
  body: { error: "event_password_challenge_required" },
};
const WRONG: Reply = { status: 401, body: { error: "event_password_invalid" } };
const OK: Reply = { status: 200, body: { unlocked: true, bypassed: false } };
const LIMITED: Reply = { status: 429, body: { error: "too_many_attempts" } };

let fetchMock: ReturnType<typeof vi.fn>;
/** Queue replies in call order. */
const replies = (...rs: Reply[]) => {
  for (const r of rs) fetchMock.mockResolvedValueOnce(reply(r));
};
const sentBodies = () =>
  fetchMock.mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as unknown,
  );

const onUnlocked = vi.fn();

const renderGate = () =>
  render(
    <EventPasswordGateWrapper
      eventId={EVENT_ID}
      slug="secret-show"
      title="Secret Show"
      heroImageUrl={null}
      onUnlocked={onUnlocked}
    />,
  );

const input = () => screen.getByLabelText("eventDetail.pwAriaLabel");
const submitButton = () =>
  screen.getByRole("button", {
    name: /eventDetail\.pwDoorEnter|eventDetail\.pwChecking/,
  });
const messageLine = () => document.getElementById("password-error");
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });
const solve = (token: string) =>
  act(() => {
    turnstileProps?.onSuccess?.(token);
  });
const flushEffects = () => act(async () => {});
const widgetLoads = () =>
  act(() => {
    turnstileProps?.onWidgetLoad?.("widget-1");
  });

/** Type, press submit, and wait for the challenge to come back. */
const drawChallenge = async (pw = "hunter2") => {
  type(pw);
  fireEvent.click(submitButton());
  await screen.findByTestId("turnstile");
};

const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  siteKey = "test-site-key";
  turnstileProps = null;
  turnstileMounts = 0;
  traced.length = 0;
  turnstileReset.mockClear();
  toastSuccess.mockClear();
  onUnlocked.mockClear();
  routerRefresh.mockClear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalInnerWidth,
  });
});

describe("EventPasswordGateWrapper — before any challenge", () => {
  it("renders no widget and sends no token", async () => {
    replies(WRONG);
    renderGate();
    expect(screen.queryByTestId("turnstile")).not.toBeInTheDocument();

    type("hunter2");
    fireEvent.click(submitButton());
    await screen.findByText("eventDetail.pwIncorrect");

    expect(sentBodies()).toEqual([{ password: "hunter2" }]);
    expect(screen.queryByTestId("turnstile")).not.toBeInTheDocument();
  });

  it("401 is an INVALID message: error tone, aria-invalid, #password-error", async () => {
    replies(WRONG);
    renderGate();
    type("hunter2");
    fireEvent.click(submitButton());

    const err = await screen.findByText("eventDetail.pwIncorrect");
    expect(err).toHaveAttribute("id", "password-error");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveAttribute("data-tone", "error");
    expect(input()).toHaveAttribute("aria-describedby", "password-error");
    expect(input()).toHaveAttribute("aria-invalid", "true");
  });

  it("an empty password (Enter) is an INVALID message", () => {
    renderGate();
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(messageLine()).toHaveTextContent("eventDetail.pwEnterPassword");
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("429 shows the too-many-attempts copy in the error tone, without aria-invalid", async () => {
    replies(LIMITED);
    renderGate();
    type("hunter2");
    fireEvent.click(submitButton());

    const err = await screen.findByText("eventDetail.pwTooManyAttempts");
    expect(err).toHaveAttribute("data-tone", "error");
    expect(input()).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByTestId("turnstile")).not.toBeInTheDocument();
  });

  it("a 403 that is not the challenge is a generic error, not a widget", async () => {
    replies({ status: 403, body: { error: "invalid_origin" } });
    renderGate();
    type("hunter2");
    fireEvent.click(submitButton());

    await screen.findByText("eventDetail.pwError");
    expect(screen.queryByTestId("turnstile")).not.toBeInTheDocument();
  });

  it("success sets the sessionStorage flag and calls onUnlocked, with NO toast (the reveal confirms it)", async () => {
    replies(OK);
    renderGate();
    type("hunter2");
    fireEvent.click(submitButton());

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`th-event-just-unlocked:${EVENT_ID}`)).toBe(
      "1",
    );
    expect(routerRefresh).not.toHaveBeenCalled();
    // No token rode that request, so there was nothing to reset.
    expect(turnstileReset).not.toHaveBeenCalled();
  });

  it("unmounting mid-request logs nothing when the response lands", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const consoleError = vi.spyOn(console, "error");
    const { unmount } = renderGate();
    type("hunter2");
    fireEvent.click(submitButton());
    unmount();

    await act(async () => {
      resolveFetch(reply(WRONG));
      await Promise.resolve();
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("EventPasswordGateWrapper — challenge required", () => {
  it("shows the widget with a NEUTRAL prompt, keeps the password and disables submit", async () => {
    replies(CHALLENGE);
    renderGate();
    // The mocks forward autoFocus, so this is a real starting point.
    expect(input()).toHaveFocus();
    await drawChallenge();

    expect(turnstileProps?.siteKey).toBe("test-site-key");
    expect(turnstileProps?.id).toBe("event-password-turnstile");
    expect(turnstileProps?.options).toEqual({
      theme: "light",
      size: "normal",
      action: "event-password",
    });

    const prompt = screen.getByText("eventDetail.pwChallengeRequired");
    expect(prompt).toHaveAttribute("id", "password-error");
    expect(prompt).toHaveAttribute("role", "alert");
    // Neutral: the challenge says nothing about whether the password is wrong.
    expect(prompt).toHaveAttribute("data-tone", "default");
    expect(input()).toHaveAttribute("aria-invalid", "false");
    expect(input()).toHaveAttribute("aria-describedby", "password-error");

    expect(input()).toHaveValue("hunter2");
    expect(
      screen.getByText("eventDetail.pwChallengeCaption"),
    ).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    // The widget's arrival must not pull focus out of the password field.
    expect(input()).toHaveFocus();
  });

  it("picks the compact widget on a narrow viewport, once, and keeps it", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 320,
    });
    replies(CHALLENGE, WRONG);
    renderGate();
    await drawChallenge();
    expect(turnstileProps?.options?.size).toBe("compact");

    // Widening afterwards must not flip `size` (that would re-render the
    // widget and drop its token).
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    solve("tok-1");
    await screen.findByText("eventDetail.pwIncorrect");
    expect(turnstileProps?.options?.size).toBe("compact");
    expect(turnstileMounts).toBe(1);
  });

  it("auto-resubmits once with the entered password when the token lands", async () => {
    replies(CHALLENGE, OK);
    renderGate();
    await drawChallenge();

    solve("tok-1");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));

    expect(sentBodies()).toEqual([
      { password: "hunter2" },
      { password: "hunter2", turnstileToken: "tok-1" },
    ]);
    expect(turnstileReset).toHaveBeenCalledTimes(1);
  });

  it("a second token while the resubmit is in flight does not submit again", async () => {
    replies(CHALLENGE, OK);
    renderGate();
    await drawChallenge();

    solve("tok-1");
    solve("tok-2");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Enter in the same tick as the auto-resubmit neither double-submits nor re-arms", async () => {
    replies(CHALLENGE, WRONG);
    renderGate();
    await drawChallenge();

    // No render between these two: the Enter handler still sees the old
    // `submitting=false` / no-token closure. Only the synchronous in-flight
    // guard stops it from re-arming auto-resubmit for the NEXT token.
    act(() => {
      turnstileProps?.onSuccess?.("tok-1");
      fireEvent.keyDown(input(), { key: "Enter" });
    });
    await screen.findByText("eventDetail.pwIncorrect");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // After a wrong password the next token must NOT fire the same password.
    solve("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(submitButton()).toBeEnabled();
  });

  it("editing the password cancels auto-resubmit; the token enables submit and rides the body", async () => {
    replies(CHALLENGE, OK);
    renderGate();
    await drawChallenge();

    type("hunter3");
    solve("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(submitButton()).toBeEnabled();
    expect(
      screen.queryByText("eventDetail.pwChallengeCaption"),
    ).not.toBeInTheDocument();

    fireEvent.click(submitButton());
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(sentBodies()[1]).toEqual({
      password: "hunter3",
      turnstileToken: "tok-1",
    });
  });

  it("challenge → 401 → fresh token: reset each time, ONE widget mount, invalid tone", async () => {
    replies(CHALLENGE, WRONG, OK);
    renderGate();
    await drawChallenge();

    solve("tok-1");
    const err = await screen.findByText("eventDetail.pwIncorrect");
    expect(err).toHaveAttribute("data-tone", "error");
    expect(input()).toHaveAttribute("aria-invalid", "true");

    expect(turnstileReset).toHaveBeenCalledTimes(1);
    expect(input()).toHaveValue("hunter2");
    expect(submitButton()).toBeDisabled();
    expect(
      screen.getByText("eventDetail.pwChallengeCaption"),
    ).toBeInTheDocument();

    type("hunter3");
    solve("tok-2");
    fireEvent.click(submitButton());
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(sentBodies()[2]).toEqual({
      password: "hunter3",
      turnstileToken: "tok-2",
    });
    expect(turnstileReset).toHaveBeenCalledTimes(2);
    expect(turnstileMounts).toBe(1);
  });

  it("a rejected token (403 again) says so, resets, and does NOT auto-resubmit on the next token", async () => {
    replies(CHALLENGE, CHALLENGE, OK);
    renderGate();
    await drawChallenge();

    solve("tok-1");
    const failed = await screen.findByText("eventDetail.pwChallengeFailed");
    expect(failed).toHaveAttribute("data-tone", "default");
    expect(input()).toHaveAttribute("aria-invalid", "false");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(turnstileReset).toHaveBeenCalledTimes(1);
    expect(submitButton()).toBeDisabled();

    solve("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(submitButton()).toBeEnabled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(sentBodies()[2]).toEqual({
      password: "hunter2",
      turnstileToken: "tok-2",
    });
    expect(turnstileReset).toHaveBeenCalledTimes(2);
  });

  it("429 after a tokened submit keeps its copy and still resets the widget", async () => {
    replies(CHALLENGE, LIMITED);
    renderGate();
    await drawChallenge();

    solve("tok-1");
    await screen.findByText("eventDetail.pwTooManyAttempts");
    expect(turnstileReset).toHaveBeenCalledTimes(1);
  });

  it("Enter while waiting for a token sends nothing, then submits when it lands", async () => {
    replies(CHALLENGE, OK);
    renderGate();
    await drawChallenge();

    type("hunter3");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("eventDetail.pwChallengeRequired"),
    ).toBeInTheDocument();

    solve("tok-1");
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(sentBodies()[1]).toEqual({
      password: "hunter3",
      turnstileToken: "tok-1",
    });
  });

  it("an expired token disables submit again", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();

    // An edit cancels auto-resubmit, so the token just sits there.
    type("hunter3");
    solve("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(submitButton()).toBeEnabled();
    act(() => {
      turnstileProps?.onExpire?.();
    });
    expect(submitButton()).toBeDisabled();
  });
});

describe("EventPasswordGateWrapper — challenge cannot run", () => {
  /** The widget is gone, the neutral unavailable line is up, submit works. */
  const expectUnavailable = () => {
    expect(screen.queryByTestId("turnstile")).not.toBeInTheDocument();
    const line = messageLine();
    expect(line).toHaveTextContent("eventDetail.pwChallengeUnavailable");
    expect(line).toHaveAttribute("role", "alert");
    expect(line).toHaveAttribute("data-tone", "default");
    expect(input()).toHaveAttribute("aria-invalid", "false");
    expect(input()).toHaveAttribute("aria-describedby", "password-error");
    expect(input()).toHaveValue("hunter2");
    // Nothing to wait for, so "try again later" must stay possible.
    expect(submitButton()).toBeEnabled();
  };

  it("no site key: unavailable line, no widget, traced ONCE per mount", async () => {
    siteKey = "";
    replies(CHALLENGE, CHALLENGE);
    renderGate();
    type("hunter2");
    fireEvent.click(submitButton());

    await screen.findByText("eventDetail.pwChallengeUnavailable");
    expectUnavailable();
    expect(traced.map((x) => x.label)).toEqual([
      "event.gate.challengeUnavailable",
    ]);

    // Typing doesn't clear it: there is still nothing else to explain.
    type("hunter22");
    expect(messageLine()).toHaveTextContent(
      "eventDetail.pwChallengeUnavailable",
    );

    // A retry that meets the same answer re-shows it (re-mounted → the alert
    // re-announces) and does not trace again.
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByText("eventDetail.pwChallengeUnavailable");
    expect(sentBodies()[1]).toEqual({ password: "hunter22" });
    expect(traced).toHaveLength(1);
  });

  it("the Turnstile script fails to load (scriptOptions.onError)", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();
    expect(typeof turnstileProps?.scriptOptions?.onError).toBe("function");

    act(() => {
      turnstileProps?.scriptOptions?.onError?.();
    });
    expectUnavailable();
    // A blocked script is the guest's network, not our config.
    expect(traced).toHaveLength(0);
  });

  it("a config error code fails at once and is traced", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();

    act(() => {
      turnstileProps?.onError?.("110200");
    });
    expectUnavailable();
    expect(traced.map((x) => x.label)).toEqual([
      "event.gate.challengeUnavailable",
    ]);
  });

  it("transient errors let Turnstile retry; the third in a row gives up", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();

    let handled: unknown;
    act(() => {
      handled = turnstileProps?.onError?.("300010");
    });
    expect(handled).toBe(true);
    act(() => {
      turnstileProps?.onError?.("300010");
    });
    expect(screen.getByTestId("turnstile")).toBeInTheDocument();

    act(() => {
      turnstileProps?.onError?.("300010");
    });
    expectUnavailable();
    expect(traced).toHaveLength(0);
  });

  it("a success in between resets the error count", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();
    type("hunter3"); // cancel auto-resubmit so the token just sits

    act(() => {
      turnstileProps?.onError?.("300010");
      turnstileProps?.onError?.("300010");
    });
    solve("tok-1");
    act(() => {
      turnstileProps?.onError?.("300010");
      turnstileProps?.onError?.("300010");
    });
    expect(screen.getByTestId("turnstile")).toBeInTheDocument();
  });

  it("an unsupported browser gives up", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();

    act(() => {
      turnstileProps?.onUnsupported?.();
    });
    expectUnavailable();
  });

  it("a widget that never loads gives up after the 20s timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();
    // `findBy` can resolve after the commit but before the passive effect
    // that arms the timer; flush it so the clock starts where we think.
    await flushEffects();

    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(screen.getByTestId("turnstile")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expectUnavailable();
  });

  it("onWidgetLoad cancels the load timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();
    await flushEffects();

    widgetLoads();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("turnstile")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("after the widget fails, a retry meeting another challenge stays 'unavailable' and the line drops while in flight", async () => {
    replies(CHALLENGE);
    renderGate();
    await drawChallenge();
    act(() => {
      turnstileProps?.scriptOptions?.onError?.();
    });
    expectUnavailable();

    let resolveFetch: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    fireEvent.click(submitButton());
    // In flight: the line is gone, so its return is a fresh alert.
    expect(messageLine()).toBeNull();

    await act(async () => {
      resolveFetch(reply(CHALLENGE));
      await Promise.resolve();
    });
    await waitFor(() => expect(submitButton()).toBeEnabled());
    // No widget to point at, so never "complete the check below".
    expect(
      screen.queryByText("eventDetail.pwChallengeRequired"),
    ).not.toBeInTheDocument();
    expectUnavailable();
    expect(sentBodies()[1]).toEqual({ password: "hunter2" });
  });

  it("a failure replaces a pending 'complete the check below' prompt and stops auto-resubmit", async () => {
    replies(CHALLENGE, OK);
    renderGate();
    await drawChallenge();
    expect(
      screen.getByText("eventDetail.pwChallengeRequired"),
    ).toBeInTheDocument();

    act(() => {
      turnstileProps?.scriptOptions?.onError?.();
    });
    expect(
      screen.queryByText("eventDetail.pwChallengeRequired"),
    ).not.toBeInTheDocument();
    expectUnavailable();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
