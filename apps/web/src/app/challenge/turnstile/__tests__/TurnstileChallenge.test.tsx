/**
 * `/challenge/turnstile` — the native app's Turnstile step.
 *
 * Contract under test:
 *   - a refused `return` renders the error state from the SERVER page: no
 *     widget, no link, no navigation;
 *   - a widget success leaves for `<return>?turnstileToken=…` (`&` when the
 *     deep link already has a query), via `location.replace`;
 *   - every way the check can fail (blocked script, config error, repeated
 *     errors, unsupported browser, a widget that never loads, no site key)
 *     drops the widget and offers `<return>…turnstileError=unavailable`;
 *   - the widget takes the same options as the web gate, sized once.
 */
import {
  forwardRef,
  useEffect,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role)$/;
  const Stack = ({
    children,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return React.createElement(tag ?? "div", domProps, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role)$/;
  return {
    CardSurface: ({
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
    },
    Text: ({
      children,
      tag,
      role,
    }: {
      children?: ReactNode;
      tag?: string;
      role?: string;
    }) => React.createElement(tag ?? "span", { role }, children),
    useTranslations: () => (key: string) => key,
  };
});

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
let turnstileProps: TurnstileMockProps | null = null;
let turnstileMounts = 0;

vi.mock("@marsidev/react-turnstile", () => ({
  Turnstile: forwardRef(function TurnstileMock(props: TurnstileMockProps, _ref) {
    turnstileProps = props;
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

const replaceLocation = vi.fn();
vi.mock("../_lib/navigate", () => ({
  replaceLocation: (url: string) => replaceLocation(url),
}));

vi.mock("@/app/help/_lib/server-i18n", () => ({
  getHelpTranslator: () =>
    Promise.resolve({ locale: "en", t: (k: string) => k }),
}));

import TurnstileChallengePage, { dynamic, generateMetadata } from "../page";
import { TurnstileChallenge } from "../_components/TurnstileChallenge";

const RETURN = "ithasfire://challenge";

const widget = () => screen.queryByTestId("turnstile");
const backLink = () =>
  screen.queryByTestId("challenge-back-link") as HTMLAnchorElement | null;
const returnLink = () =>
  screen.queryByTestId("challenge-return-link") as HTMLAnchorElement | null;
const status = () => screen.getByRole("status");

const renderPage = async (params: Record<string, string | string[]>) =>
  render(await TurnstileChallengePage({ searchParams: Promise.resolve(params) }));

beforeEach(() => {
  siteKey = "test-site-key";
  turnstileProps = null;
  turnstileMounts = 0;
  traced.length = 0;
  replaceLocation.mockReset();
  window.innerWidth = 1024;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("page — refused return", () => {
  it.each([
    ["web URL", { return: "https://evil.example/collect" }],
    ["javascript:", { return: "javascript:alert(1)" }],
    ["protocol-relative", { return: "//evil.example" }],
    ["missing", {}],
    ["repeated", { return: [RETURN, "https://evil.example"] }],
  ])("%s → error state, no widget, no link, no navigation", async (_l, params) => {
    await renderPage(params);

    expect(screen.getByTestId("challenge-invalid")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "challenge.title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("challenge.invalidLink")).toBeInTheDocument();
    expect(widget()).toBeNull();
    expect(backLink()).toBeNull();
    expect(returnLink()).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it("a valid return renders the challenge", async () => {
    await renderPage({ return: RETURN });

    expect(screen.queryByTestId("challenge-invalid")).toBeNull();
    expect(status()).toHaveTextContent("challenge.body");
    expect(widget()).toBeInTheDocument();
  });
});

describe("page — metadata and caching", () => {
  it("is per-request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  // The site's default referrer policy on purpose: Turnstile's iframe may
  // check the embedding hostname, and this URL never carries the token.
  it("is noindex/nofollow and keeps the default referrer policy", async () => {
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta).not.toHaveProperty("referrer");
    expect(meta.title).toBe("challenge.title");
  });
});

describe("widget", () => {
  it("takes the web gate's options and its own container id", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);

    expect(widget()).toHaveAttribute("id", "mobile-challenge-turnstile");
    expect(turnstileProps?.siteKey).toBe("test-site-key");
    expect(turnstileProps?.options).toEqual({
      theme: "light",
      size: "normal",
      action: "event-password",
    });
  });

  it.each([
    [320, "compact"],
    [383, "compact"],
    [384, "normal"],
  ])("at %ipx the widget is %s (300px fits from 384px)", (width, size) => {
    window.innerWidth = width;
    render(<TurnstileChallenge returnUrl={RETURN} />);
    expect(turnstileProps?.options?.size).toBe(size);
  });

  it("goes compact on a narrow screen, and stays as sized on resize", () => {
    window.innerWidth = 320;
    const { rerender } = render(<TurnstileChallenge returnUrl={RETURN} />);
    expect(turnstileProps?.options?.size).toBe("compact");

    window.innerWidth = 1024;
    rerender(<TurnstileChallenge returnUrl={RETURN} />);
    expect(turnstileProps?.options?.size).toBe("compact");
    expect(turnstileMounts).toBe(1);
  });
});

describe("success", () => {
  it("leaves for <return>?turnstileToken=<encoded token>", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);

    act(() => turnstileProps?.onSuccess?.("tok+en/=="));

    expect(replaceLocation).toHaveBeenCalledTimes(1);
    expect(replaceLocation).toHaveBeenCalledWith(
      "ithasfire://challenge?turnstileToken=tok%2Ben%2F%3D%3D",
    );
  });

  it("uses & when the deep link already has a query", () => {
    render(
      <TurnstileChallenge returnUrl="exp://10.0.0.2:8081/--/challenge?eventId=e1" />,
    );

    act(() => turnstileProps?.onSuccess?.("abc"));

    expect(replaceLocation).toHaveBeenCalledWith(
      "exp://10.0.0.2:8081/--/challenge?eventId=e1&turnstileToken=abc",
    );
  });

  it("no Return link before a pass", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    expect(returnLink()).toBeNull();
  });

  // Chrome on Android can refuse the script-initiated hop to an app scheme
  // (no user gesture after an invisible pass): the same URL, as a tap.
  it("ALSO renders a 'Return to the app' link to the same token URL", () => {
    render(<TurnstileChallenge returnUrl={`${RETURN}?eventId=e1`} />);

    act(() => turnstileProps?.onSuccess?.("tok+en"));

    const expected = "ithasfire://challenge?eventId=e1&turnstileToken=tok%2Ben";
    expect(replaceLocation).toHaveBeenCalledWith(expected);
    expect(status()).toHaveTextContent("challenge.returning");
    expect(returnLink()?.tagName).toBe("A");
    expect(returnLink()).toHaveAttribute("href", expected);
    expect(returnLink()).toHaveTextContent("challenge.returnToApp");
    // The only link on the page: no competing "unavailable" back link.
    expect(backLink()).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("a refreshed token updates the link and leaves again", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => turnstileProps?.onSuccess?.("one"));
    act(() => turnstileProps?.onSuccess?.("two"));

    expect(replaceLocation).toHaveBeenLastCalledWith(
      "ithasfire://challenge?turnstileToken=two",
    );
    expect(returnLink()).toHaveAttribute(
      "href",
      "ithasfire://challenge?turnstileToken=two",
    );
  });

  it("an expired token withdraws the link", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => turnstileProps?.onSuccess?.("abc"));

    act(() => turnstileProps?.onExpire?.());

    expect(returnLink()).toBeNull();
    expect(status()).toHaveTextContent("challenge.body");
  });
});

describe("failure → back link with turnstileError=unavailable", () => {
  const expectUnavailable = (href = `${RETURN}?turnstileError=unavailable`) => {
    expect(widget()).toBeNull();
    expect(status()).toHaveTextContent("challenge.unavailable");
    expect(backLink()).toHaveAttribute("href", href);
    expect(backLink()).toHaveTextContent("challenge.backToApp");
    expect(returnLink()).toBeNull();
    expect(replaceLocation).not.toHaveBeenCalled();
  };

  it("no back link while the check can still run", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    expect(backLink()).toBeNull();
  });

  it("blocked script (scriptOptions.onError)", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => turnstileProps?.scriptOptions?.onError?.());
    expectUnavailable();
  });

  it("uses & when the deep link already has a query", () => {
    render(<TurnstileChallenge returnUrl={`${RETURN}?eventId=e1`} />);
    act(() => turnstileProps?.scriptOptions?.onError?.());
    expectUnavailable(`${RETURN}?eventId=e1&turnstileError=unavailable`);
  });

  it("config error code fails at once, and is traced", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => {
      turnstileProps?.onError?.("110100");
    });
    expectUnavailable();
    expect(traced).toHaveLength(1);
    expect(traced[0]?.label).toBe("mobile.challenge.unavailable");
  });

  it("transient errors are retried until the third", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);

    let handled: unknown;
    act(() => {
      handled = turnstileProps?.onError?.("300010");
    });
    expect(handled).toBe(true);
    act(() => {
      turnstileProps?.onError?.("300010");
    });
    expect(widget()).toBeInTheDocument();
    expect(backLink()).toBeNull();

    act(() => {
      turnstileProps?.onError?.("300010");
    });
    expectUnavailable();
  });

  it("a success in between resets the error count", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => {
      turnstileProps?.onError?.("300010");
      turnstileProps?.onError?.("300010");
    });
    act(() => turnstileProps?.onSuccess?.("abc"));
    act(() => {
      turnstileProps?.onError?.("300010");
      turnstileProps?.onError?.("300010");
    });
    expect(widget()).toBeInTheDocument();
  });

  it("unsupported browser", () => {
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => turnstileProps?.onUnsupported?.());
    expectUnavailable();
  });

  it("a widget that never loads gives up after 20s", () => {
    vi.useFakeTimers();
    render(<TurnstileChallenge returnUrl={RETURN} />);

    act(() => {
      vi.advanceTimersByTime(19_999);
    });
    expect(widget()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expectUnavailable();
  });

  it("a widget that loaded is not timed out", () => {
    vi.useFakeTimers();
    render(<TurnstileChallenge returnUrl={RETURN} />);
    act(() => turnstileProps?.onWidgetLoad?.("w1"));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(widget()).toBeInTheDocument();
    expect(backLink()).toBeNull();
  });

  it("no site key: never a widget, traced once", () => {
    siteKey = "";
    const { rerender } = render(<TurnstileChallenge returnUrl={RETURN} />);
    rerender(<TurnstileChallenge returnUrl={RETURN} />);

    expectUnavailable();
    expect(turnstileMounts).toBe(0);
    expect(traced).toHaveLength(1);
  });
});
