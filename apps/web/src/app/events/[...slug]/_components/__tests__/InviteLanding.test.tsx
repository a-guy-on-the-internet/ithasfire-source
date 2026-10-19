/**
 * The guest landing for a gated-event invite link (`/events/<slug>?invite=`),
 * docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml FR-004 / FR-005 /
 * FR-010, NFR-002; design "1 · One tap" (owner pick 2026-10-03).
 *
 * Driven through the real `GatedEventShell` + `useInviteLink` + `InviteDoor`;
 * the two gate wrappers are stubs that render the `notice` they are handed,
 * so "dead link → the normal gate, still usable, with one line" is a question
 * about the tree.
 */
import { StrictMode, type ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import superjson from "superjson";

import enMessages from "@/i18n/messages/en";
import type { EventPageData } from "@/server/event-page-data";

// Everything the landing hands to the error tracer, to prove the token is not in it.
let tracedErrors: unknown[] = [];
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        ticketTiersForCard: { invalidate: () => Promise.resolve() },
      },
    }),
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => (err: unknown) => {
    tracedErrors.push(err);
  },
}));

/** The real English copy, with `{var}` filled in: the copy tests read it. */
function translate(key: string, vars?: Record<string, unknown>): string {
  const [ns, name] = key.split(".");
  const raw = (enMessages as Record<string, Record<string, unknown>>)[ns]?.[
    name
  ];
  if (typeof raw !== "string") return key;
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => String(vars?.[v] ?? ""));
}

vi.mock("next/image", async () => {
  const React = await import("react");
  return {
    default: ({ src, alt }: { src: string; alt: string }) =>
      React.createElement("img", { src, alt }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Spinner: () => React.createElement("div", { "data-testid": "spinner" }),
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    Button: ({
      children,
      disabled,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          disabled,
          onClick: onPress,
          "aria-label": rest["aria-label"],
          "aria-busy": rest["aria-busy"],
        },
        children,
      ),
    useTranslations: () => translate,
    useLocale: () => "en",
  };
});

vi.mock("../EventPageBody", async () => {
  const React = await import("react");
  return {
    EventPageBody: ({ data }: { data: EventPageData }) =>
      React.createElement(
        "div",
        { "data-testid": "event-page-body" },
        data.event.name,
      ),
  };
});

vi.mock("../EventPasswordGateWrapper", async () => {
  const React = await import("react");
  return {
    EventPasswordGateWrapper: ({ notice }: { notice?: ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": "password-gate" },
        notice,
        React.createElement("input", {
          "aria-label": "Event password",
          type: "password",
        }),
      ),
  };
});

vi.mock("../EventApplicationGateWrapper", async () => {
  const React = await import("react");
  return {
    EventApplicationGateWrapper: ({ notice }: { notice?: ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": "application-gate" },
        notice,
        React.createElement("button", { type: "button" }, "Apply"),
      ),
  };
});

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const PATH = "/events/night-owl/us/nashville/founders-dinner";

const shellProps = {
  eventId: EVENT_ID,
  slug: "night-owl/us/nashville/founders-dinner",
  title: "Founders & Friends Dinner",
  heroImageUrl: null,
  gateDate: "2026-10-18",
  waitlistOpen: false,
  waitlistDescription: null,
} as const;

const unlockedPayload = () =>
  superjson.serialize({
    eventId: EVENT_ID,
    slug: shellProps.slug,
    event: { name: "Founders & Friends Dinner — revealed" },
  } as unknown as EventPageData);

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

type Routes = {
  probe: () => Response;
  peek: () => Response;
  redeem: () => Response;
};

let routes: Routes;
let calls: string[];
let fetchMock: Mock<[string, RequestInit?], Promise<Response>>;
let replaceSpy: MockInstance<Parameters<History["replaceState"]>, void>;

const LIVE_PERSONAL = {
  ok: true,
  kind: "PERSONAL",
  inviteeShortName: "Maya R.",
  organizerName: "Night Owl Collective",
};

beforeEach(() => {
  tracedErrors = [];
  sessionStorage.clear();
  calls = [];
  routes = {
    probe: () => jsonResponse({ access: "locked" }),
    peek: () => jsonResponse(LIVE_PERSONAL),
    redeem: () =>
      jsonResponse({ ok: true, grant: "INVITE_GRANT", slug: shellProps.slug }),
  };
  // The landing URL, set BEFORE the spy so only the component's strip counts.
  window.history.replaceState(null, "", `${PATH}?invite=${TOKEN}&utm=mail#x`);
  replaceSpy = vi.spyOn(window.history, "replaceState");
  replaceSpy.mockImplementation(function (
    this: History,
    ...args: Parameters<History["replaceState"]>
  ) {
    calls.push(`replaceState:${String(args[2])}`);
    return History.prototype.replaceState.apply(this, args);
  });
  fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    calls.push(`fetch:${url}`);
    if (url.endsWith("/unlocked-view")) return Promise.resolve(routes.probe());
    if (url.endsWith("/invite/peek")) return Promise.resolve(routes.peek());
    if (url.endsWith("/invite")) return Promise.resolve(routes.redeem());
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  replaceSpy.mockRestore();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const bodiesOf = (url: string) =>
  fetchMock.mock.calls
    .filter(([u]) => u === url)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

const PEEK_URL = `/api/events/${EVENT_ID}/invite/peek`;
const REDEEM_URL = `/api/events/${EVENT_ID}/invite`;

/** The dead line once its text has arrived (it mounts empty: see InviteDeadNotice). */
async function deadLine(): Promise<HTMLElement> {
  const notice = await screen.findByTestId("invite-dead-notice");
  await waitFor(() => expect(notice.textContent).not.toBe(""));
  return notice;
}

/** What page.tsx computes from the request: presence of a non-empty value. */
const serverSawInvite = () =>
  (new URL(window.location.href).searchParams.get("invite") ?? "").trim() !==
  "";

async function renderShell(gateType: "PASSWORD" | "APPLICATION" = "PASSWORD") {
  const { GatedEventShell } = await import("../GatedEventShell");
  return render(
    <GatedEventShell
      {...shellProps}
      gateType={gateType}
      inviteParamPresent={serverSawInvite()}
    />,
  );
}

const STASH_KEY = `th:invite:${EVENT_ID}`;

describe("invite landing: the token", () => {
  it("is stripped from the address bar before the first fetch, keeping the rest of the URL", async () => {
    await renderShell();
    await screen.findByTestId("invite-door");

    expect(calls[0]).toBe(`replaceState:${PATH}?utm=mail#x`);
    expect(calls.filter((c) => c.startsWith("fetch:"))).toEqual([
      `fetch:/api/events/${EVENT_ID}/unlocked-view`,
      `fetch:${PEEK_URL}`,
    ]);
    expect(window.location.search).toBe("?utm=mail");
    expect(window.location.hash).toBe("#x");
    expect(bodiesOf(PEEK_URL)).toEqual([{ token: TOKEN }]);
  });

  it("never rides a URL, and never reaches a log line or an error report", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    routes.redeem = () => jsonResponse({ ok: false, error: "redeem_failed" }, 502);
    routes.peek = () => jsonResponse(LIVE_PERSONAL);
    await renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open the event" }));
    await screen.findByTestId("invite-door-error");

    // Peek 5xx on a second landing: traced, by status only.
    window.history.replaceState(null, "", `${PATH}?invite=${TOKEN}`);
    routes.peek = () => jsonResponse({ ok: false, error: "peek_failed" }, 503);
    const { GatedEventShell } = await import("../GatedEventShell");
    render(<GatedEventShell {...shellProps} gateType="PASSWORD" key="again" />);
    await waitFor(() => expect(tracedErrors.length).toBeGreaterThan(0), {
      timeout: 3000,
    });

    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
    }
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(TOKEN);
    expect(
      JSON.stringify(tracedErrors.map((e) => (e as Error).message)),
    ).not.toContain(TOKEN);
    for (const s of spies) s.mockRestore();
  });

  it("an already-unlocked viewer gets the event: no Door, no peek, no redeem, token still stripped", async () => {
    routes.probe = () =>
      jsonResponse({ access: "unlocked", data: unlockedPayload() });
    await renderShell();

    await screen.findByTestId("event-page-body");
    expect(screen.queryByTestId("invite-door")).toBeNull();
    expect(window.location.search).toBe("?utm=mail");
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      `/api/events/${EVENT_ID}/unlocked-view`,
    ]);
  });

  it("no ?invite= → the plain gate, and the invite routes are never called", async () => {
    window.history.replaceState(null, "", PATH);
    replaceSpy.mockClear();
    await renderShell();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("password-gate")).toBeTruthy();
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe("invite landing: the one-tap Door copy", () => {
  it("PERSONAL: names the invitee and the organizer", async () => {
    await renderShell();
    const door = await screen.findByTestId("invite-door");

    expect(screen.getByTestId("invite-door-kicker").textContent).toBe(
      "Invite for Maya R. · Sun, Oct 18",
    );
    expect(
      door.querySelector("h1")?.textContent,
    ).toBe("Founders & Friends Dinner");
    expect(screen.getByTestId("invite-door-lede").textContent).toBe(
      "Night Owl Collective invited you. This link is yours; it works on any device until the night is over.",
    );
    expect(screen.getByRole("button", { name: "Open the event" })).toBeTruthy();
    // In place of the gate, not beside it.
    expect(screen.queryByTestId("password-gate")).toBeNull();
  });

  it("SHARED: you’re invited, sent by the organizer", async () => {
    routes.peek = () =>
      jsonResponse({
        ok: true,
        kind: "SHARED",
        inviteeShortName: null,
        organizerName: "Night Owl Collective",
      });
    await renderShell("APPLICATION");
    await screen.findByTestId("invite-door");

    expect(screen.getByTestId("invite-door-kicker").textContent).toBe(
      "You’re invited · Sun, Oct 18",
    );
    expect(screen.getByTestId("invite-door-lede").textContent).toBe(
      "Night Owl Collective sent you this link. Tap once to come in.",
    );
    expect(screen.queryByTestId("application-gate")).toBeNull();
  });

  it("null names: “Your invite”, “You were invited”, “Someone sent you this link”", async () => {
    routes.peek = () =>
      jsonResponse({
        ok: true,
        kind: "PERSONAL",
        inviteeShortName: null,
        organizerName: null,
      });
    const first = await renderShell();
    await screen.findByTestId("invite-door");
    expect(screen.getByTestId("invite-door-kicker").textContent).toBe(
      "Your invite · Sun, Oct 18",
    );
    expect(screen.getByTestId("invite-door-lede").textContent).toBe(
      "You were invited. This link is yours; it works on any device until the night is over.",
    );
    first.unmount();

    window.history.replaceState(null, "", `${PATH}?invite=${TOKEN}`);
    routes.peek = () =>
      jsonResponse({
        ok: true,
        kind: "SHARED",
        inviteeShortName: null,
        organizerName: null,
      });
    await renderShell();
    await screen.findByTestId("invite-door");
    expect(screen.getByTestId("invite-door-lede").textContent).toBe(
      "Someone sent you this link. Tap once to come in.",
    );
  });
});

describe("invite landing: dead links", () => {
  it.each([
    "INVALID",
    "REVOKED",
    "EVENT_ENDED",
    "EVENT_CANCELLED",
    "EVENT_UNAVAILABLE",
    "NOT_GATED",
  ])("peek %s → the password gate, usable, with the one line", async (reason) => {
    routes.peek = () => jsonResponse({ ok: false, reason });
    await renderShell();

    const notice = await deadLine();
    expect(notice.textContent).toBe(
      "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or enter the password.",
    );
    const gate = screen.getByTestId("password-gate");
    expect(gate.contains(notice)).toBe(true);
    expect(screen.getByLabelText("Event password")).toBeTruthy();
    expect(screen.queryByTestId("invite-door")).toBeNull();
    // Not veiled: the gate is interactive.
    expect(gate.parentElement?.getAttribute("aria-busy")).toBeNull();
    expect(gate.parentElement?.style.pointerEvents).not.toBe("none");
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain(REDEEM_URL);
  });

  it("on an APPLICATION event the line says “or apply.”", async () => {
    routes.peek = () => jsonResponse({ ok: false, reason: "REVOKED" });
    await renderShell("APPLICATION");
    const notice = await deadLine();
    expect(notice.textContent).toBe(
      "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or apply.",
    );
    expect(screen.getByTestId("application-gate").contains(notice)).toBe(true);
  });

  it("peek event_mismatch (400) → dead", async () => {
    routes.peek = () =>
      jsonResponse({ ok: false, error: "event_mismatch" }, 400);
    await renderShell();
    expect(await screen.findByTestId("invite-dead-notice")).toBeTruthy();
  });

  it.each([403, 429, 500, 503])(
    "peek %s twice → the plain gate, no invite UI at all",
    async (status) => {
      routes.peek = () => jsonResponse({ ok: false, error: "x" }, status);
      await renderShell();
      await waitFor(() =>
        expect(fetchMock.mock.calls.map(([u]) => u)).toContain(PEEK_URL),
      );
      await waitFor(
        () =>
          expect(
            screen.getByTestId("password-gate").parentElement?.style
              .pointerEvents,
          ).not.toBe("none"),
        { timeout: 3000 },
      );
      // One automatic retry, then it stops asking.
      expect(bodiesOf(PEEK_URL)).toHaveLength(2);
      expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
      expect(screen.queryByTestId("invite-door")).toBeNull();
    },
  );

  it("a tap answered {ok:false} → the dead line, focused, over a usable gate", async () => {
    routes.redeem = () =>
      jsonResponse({ ok: false, reason: "REVOKED", slug: shellProps.slug });
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    const notice = await deadLine();
    expect(document.activeElement).toBe(notice);
    expect(screen.getByLabelText("Event password")).toBeTruthy();
  });

  it("a tap answered event_mismatch → dead", async () => {
    routes.redeem = () =>
      jsonResponse({ ok: false, error: "event_mismatch" }, 400);
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    expect(await screen.findByTestId("invite-dead-notice")).toBeTruthy();
  });
});

describe("invite landing: Open the event", () => {
  it("redeems with the token in the body, then reveals the event like a password unlock", async () => {
    let unlocked = false;
    routes.probe = () =>
      unlocked
        ? jsonResponse({ access: "unlocked", data: unlockedPayload() })
        : jsonResponse({ access: "locked" });
    routes.redeem = () => {
      unlocked = true;
      return jsonResponse({
        ok: true,
        grant: "INVITE_GRANT",
        slug: shellProps.slug,
      });
    };
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );

    await screen.findByTestId("event-page-body");
    expect(bodiesOf(REDEEM_URL)).toEqual([{ token: TOKEN }]);
    // The flag EventDetail reads to animate the reveal and move focus to h1.
    // (EventDetail is stubbed here, so nothing clears it.)
    expect(sessionStorage.getItem(`th-event-just-unlocked:${EVENT_ID}`)).toBe(
      "1",
    );
  });

  it("busy while in flight: announced, and a second tap sends nothing", async () => {
    let release: (r: Response) => void = () => {};
    routes.redeem = () =>
      new Promise<Response>((r) => {
        release = r;
      }) as unknown as Response;
    await renderShell();
    const button = await screen.findByRole("button", {
      name: "Open the event",
    });
    fireEvent.click(button);

    const busy = await screen.findByRole("button", {
      name: "Opening the event…",
    });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Opening the event…");
    fireEvent.click(busy);
    expect(bodiesOf(REDEEM_URL)).toHaveLength(1);

    await act(() => {
      release(jsonResponse({ ok: false, error: "redeem_failed" }, 502));
      return Promise.resolve();
    });
  });

  it("429 keeps the Door, says so, and the retry redeems again", async () => {
    let n = 0;
    routes.redeem = () => {
      n += 1;
      return n === 1
        ? jsonResponse({ ok: false, error: "too_many_attempts" }, 429)
        : jsonResponse({ ok: false, reason: "EVENT_ENDED", slug: null });
    };
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );

    const err = await screen.findByRole("alert");
    expect(err.textContent).toBe(
      "Too many attempts. Please wait a minute and try again.",
    );
    expect(screen.getByTestId("invite-door")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open the event" }));
    await screen.findByTestId("invite-dead-notice");
    expect(bodiesOf(REDEEM_URL)).toEqual([{ token: TOKEN }, { token: TOKEN }]);
  });

  it("5xx keeps the Door with the generic error", async () => {
    routes.redeem = () =>
      jsonResponse({ ok: false, error: "redeem_failed" }, 502);
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Something went wrong. Please try again.",
    );
    expect(
      screen.getByRole("button", { name: "Open the event" }),
    ).toBeTruthy();
  });

  it("redeemed but the probe stays locked → the Door says so and can retry", async () => {
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Something went wrong. Please try again.",
    );
    expect(sessionStorage.getItem(`th-event-just-unlocked:${EVENT_ID}`)).toBe(
      null,
    );
    expect(
      screen.getByRole("button", { name: "Open the event" }),
    ).toBeTruthy();
  });
});

describe("invite landing: the App Router's history entry (Back, refresh)", () => {
  it("the strip keeps Next's history state; the router sync after it keeps it too", async () => {
    const nextState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { t: 1 } };
    History.prototype.replaceState.call(
      window.history,
      nextState,
      "",
      `${PATH}?invite=${TOKEN}`,
    );
    replaceSpy.mockClear();
    calls = [];
    await renderShell();
    await screen.findByTestId("invite-door");

    // Step 1 (layout effect): the current state passed straight through.
    expect(replaceSpy.mock.calls[0]?.[0]).toEqual(nextState);
    // Step 2 (a macrotask after the passive flush): `null`, which Next's
    // patch turns into ACTION_RESTORE with the clean URL. jsdom has no patch,
    // so the belt puts Next's state back.
    await waitFor(() =>
      expect(replaceSpy.mock.calls.some(([data]) => data === null)).toBe(true),
    );
    expect(window.history.state).toEqual(nextState);
    expect(window.location.search).toBe("");
  });
});

describe("invite landing: a peek or redeem that does not answer", () => {
  it("an unanswered peek is asked once more, and a live answer still shows the Door", async () => {
    let n = 0;
    routes.peek = () => {
      n += 1;
      return n === 1
        ? jsonResponse({ ok: false, error: "peek_failed" }, 503)
        : jsonResponse(LIVE_PERSONAL);
    };
    await renderShell();
    expect(
      await screen.findByTestId("invite-door", undefined, { timeout: 3000 }),
    ).toBeTruthy();
    expect(bodiesOf(PEEK_URL)).toEqual([{ token: TOKEN }, { token: TOKEN }]);
  });

  /** `AbortSignal.timeout` handed out as signals the test aborts by hand. */
  function controlTimeouts() {
    const controllers: AbortController[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(8000);
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    });
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "TimeoutError")),
        );
      });
    return { controllers, spy, hang };
  }

  it("a peek that hangs times out, is retried, and then falls back to the plain, usable gate", async () => {
    const { controllers, spy, hang } = controlTimeouts();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push(`fetch:${url}`);
      if (url.endsWith("/unlocked-view")) {
        return Promise.resolve(routes.probe());
      }
      return hang(init);
    });
    await renderShell();
    await waitFor(() => expect(bodiesOf(PEEK_URL)).toHaveLength(1));
    // Veiled while it waits.
    expect(
      screen.getByTestId("password-gate").parentElement?.style.pointerEvents,
    ).toBe("none");

    act(() => controllers.at(-1)?.abort());
    await waitFor(() => expect(bodiesOf(PEEK_URL)).toHaveLength(2), {
      timeout: 3000,
    });
    act(() => controllers.at(-1)?.abort());

    await waitFor(() =>
      expect(
        screen.getByTestId("password-gate").parentElement?.style.pointerEvents,
      ).not.toBe("none"),
    );
    expect(screen.queryByTestId("invite-door")).toBeNull();
    expect(screen.getByLabelText("Event password")).toBeTruthy();
    spy.mockRestore();
  });

  it("a redeem that hangs times out and keeps the Door with a retry", async () => {
    const { controllers, spy, hang } = controlTimeouts();
    await renderShell();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push(`fetch:${url}`);
      if (url.endsWith("/invite")) return hang(init);
      if (url.endsWith("/invite/peek")) return Promise.resolve(routes.peek());
      return Promise.resolve(routes.probe());
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    await screen.findByRole("button", { name: "Opening the event…" });

    act(() => controllers.at(-1)?.abort());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Something went wrong. Please try again.",
    );
    expect(
      screen.getByRole("button", { name: "Open the event" }),
    ).toBeTruthy();
    spy.mockRestore();
  });
});

describe("invite landing: focus when the peek finds the link dead", () => {
  // Checks the dead line's own rule (never pull focus out of a field) in
  // isolation: jsdom ignores `inert`, so `field.focus()` lands here while the
  // veil is up, which a browser would refuse. The real veiled landing is
  // "a peek that finds the link dead from a veiled start" below.
  it("stays in the (empty) password field the guest is in; the line is announced, not focused", async () => {
    let answer: (r: Response) => void = () => {};
    routes.peek = () =>
      new Promise<Response>((r) => {
        answer = r;
      }) as unknown as Response;
    await renderShell();
    await waitFor(() => expect(bodiesOf(PEEK_URL)).toHaveLength(1));

    const field = screen.getByLabelText("Event password");
    field.focus();
    expect(document.activeElement).toBe(field);

    await act(async () => {
      answer(jsonResponse({ ok: false, reason: "REVOKED" }));
      await Promise.resolve();
    });
    const notice = await deadLine();
    expect(notice.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(field);
  });
});

describe("InviteParamScrubber (ungated event, 404)", () => {
  it("strips ?invite= keeping the rest of the URL and Next's history state", async () => {
    const nextState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { t: 2 } };
    History.prototype.replaceState.call(
      window.history,
      nextState,
      "",
      `${PATH}?a=1&invite=${TOKEN}#h`,
    );
    replaceSpy.mockClear();
    const { InviteParamScrubber } = await import("../InviteParamScrubber");
    render(<InviteParamScrubber />);

    expect(window.location.search).toBe("?a=1");
    expect(window.location.hash).toBe("#h");
    expect(replaceSpy.mock.calls[0]?.[0]).toEqual(nextState);
    await waitFor(() =>
      expect(replaceSpy.mock.calls.some(([data]) => data === null)).toBe(true),
    );
    expect(window.history.state).toEqual(nextState);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing without the param", async () => {
    window.history.replaceState(null, "", `${PATH}?invited=1`);
    replaceSpy.mockClear();
    const { InviteParamScrubber } = await import("../InviteParamScrubber");
    render(<InviteParamScrubber />);
    await new Promise((r) => setTimeout(r, 10));
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?invited=1");
  });
});

describe("invite landing: follow-ups (fix round 3)", () => {
  const NEXT_STATE = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { t: 3 } };

  it("gives up after the retry with ONE kind-only trace: no token, no URL", async () => {
    routes.peek = () => jsonResponse({ ok: false, error: "x" }, 429);
    await renderShell();
    await waitFor(() => expect(tracedErrors).toHaveLength(1), {
      timeout: 3000,
    });
    const message = (tracedErrors[0] as Error).message;
    expect(message).toBe("invite peek unavailable after retry: 429");
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("/api/");
  });

  it("names a timeout as a timeout in that trace", async () => {
    fetchMock.mockImplementation((url: string, _init?: RequestInit) => {
      calls.push(`fetch:${url}`);
      if (url.endsWith("/unlocked-view")) {
        return Promise.resolve(routes.probe());
      }
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    });
    await renderShell();
    await waitFor(() => expect(tracedErrors).toHaveLength(1), {
      timeout: 3000,
    });
    expect((tracedErrors[0] as Error).message).toBe(
      "invite peek unavailable after retry: timeout",
    );
  });

  it("a live peek is never traced", async () => {
    await renderShell();
    await screen.findByTestId("invite-door");
    expect(tracedErrors).toEqual([]);
  });

  it("under StrictMode: the Door appears and the token is peeked exactly once", async () => {
    const { GatedEventShell } = await import("../GatedEventShell");
    render(
      <StrictMode>
        <GatedEventShell {...shellProps} gateType="PASSWORD" />
      </StrictMode>,
    );
    await screen.findByTestId("invite-door");
    // Settle any queued work, then count.
    await new Promise((r) => setTimeout(r, 20));
    expect(bodiesOf(PEEK_URL)).toEqual([{ token: TOKEN }]);
    expect(window.location.search).toBe("?utm=mail");
  });

  it("the scrubber under StrictMode: one strip, exactly one router sync", async () => {
    History.prototype.replaceState.call(
      window.history,
      NEXT_STATE,
      "",
      `${PATH}?invite=${TOKEN}`,
    );
    replaceSpy.mockClear();
    const { InviteParamScrubber } = await import("../InviteParamScrubber");
    render(
      <StrictMode>
        <InviteParamScrubber />
      </StrictMode>,
    );
    expect(window.location.search).toBe("");
    await new Promise((r) => setTimeout(r, 20));
    const nullSyncs = replaceSpy.mock.calls.filter(([data]) => data === null);
    expect(nullSyncs).toHaveLength(1);
    // One strip (carrying Next's state), before that one sync.
    expect(replaceSpy.mock.calls[0]?.[0]).toEqual(NEXT_STATE);
    expect(
      replaceSpy.mock.calls.filter(([data]) => data !== null && data !== undefined)
        .length,
    ).toBeLessThanOrEqual(2); // the strip + jsdom's belt restore of __NA
  });

  it.each([
    ["the scrubber", "scrubber"],
    ["the gated shell", "shell"],
  ] as const)(
    "an EMPTY ?invite= is stripped and still syncs the router (%s)",
    async (_label, which) => {
      History.prototype.replaceState.call(
        window.history,
        NEXT_STATE,
        "",
        `${PATH}?invite=&a=1`,
      );
      replaceSpy.mockClear();
      if (which === "scrubber") {
        const { InviteParamScrubber } = await import("../InviteParamScrubber");
        render(<InviteParamScrubber />);
      } else {
        await renderShell();
      }
      expect(window.location.search).toBe("?a=1");
      expect(replaceSpy.mock.calls[0]?.[0]).toEqual(NEXT_STATE);
      await waitFor(() =>
        expect(replaceSpy.mock.calls.some(([data]) => data === null)).toBe(
          true,
        ),
      );
      // No token: no invite UI and no peek.
      expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain(PEEK_URL);
    },
  );

  it("an unmounted landing does not retry: first peek 503, unmount, 800ms later still one peek", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      routes.peek = () => jsonResponse({ ok: false, error: "x" }, 503);
      const view = await renderShell();
      await waitFor(() => expect(bodiesOf(PEEK_URL)).toHaveLength(1));
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(bodiesOf(PEEK_URL)).toHaveLength(1);
      expect(tracedErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the dead line's region mounts empty, then the text arrives", async () => {
    routes.peek = () => jsonResponse({ ok: false, reason: "REVOKED" });
    await renderShell();
    const notice = await screen.findByTestId("invite-dead-notice");
    const seenEmpty = notice.textContent === "";
    const filled = await deadLine();
    expect(filled).toBe(notice); // the same node: a change, not a new region
    expect(seenEmpty).toBe(true);
    expect(filled.getAttribute("role")).toBe("status");
  });
});

describe("invite landing: no plain-gate flash while hydrating", () => {
  async function serverHtml(inviteParamPresent: boolean) {
    const { renderToString } = await import("react-dom/server");
    const { GatedEventShell } = await import("../GatedEventShell");
    return renderToString(
      <GatedEventShell
        {...shellProps}
        gateType="PASSWORD"
        inviteParamPresent={inviteParamPresent}
      />,
    );
  }

  it("with ?invite= the SERVER html is the veiled pending look: dimmed, pointer-events off, inert", async () => {
    const html = await serverHtml(true);
    const host = document.createElement("div");
    host.innerHTML = html;
    const gate = host.querySelector('[data-testid="password-gate"]');
    const veil = gate?.parentElement as HTMLElement;
    expect(veil.style.pointerEvents).toBe("none");
    expect(veil.style.opacity).toBe("0.5");
    expect(veil.hasAttribute("inert")).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Checking...",
    );
    // The token's value is never in the server output (it never gets there).
    expect(html).not.toContain(TOKEN);
  });

  it("without it the server html is the plain, interactive gate (unchanged)", async () => {
    const html = await serverHtml(false);
    const host = document.createElement("div");
    host.innerHTML = html;
    const veil = host.querySelector('[data-testid="password-gate"]')
      ?.parentElement as HTMLElement;
    expect(veil.style.pointerEvents).toBe("");
    expect(veil.hasAttribute("inert")).toBe(false);
  });

  it("hydrates over that html with no mismatch, then shows the Door", async () => {
    const html = await serverHtml(true);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { hydrateRoot } = await import("react-dom/client");
    const { GatedEventShell } = await import("../GatedEventShell");
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(
        container,
        <GatedEventShell
          {...shellProps}
          gateType="PASSWORD"
          inviteParamPresent
        />,
        { onRecoverableError: (err) => recoverable.push(err) },
      );
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="invite-door"]')).not.toBe(
        null,
      ),
    );
    expect(recoverable).toEqual([]);
    expect(
      JSON.stringify(errors.mock.calls).toLowerCase(),
    ).not.toContain("hydrat");
    expect(window.location.search).toBe("?utm=mail");
    act(() => root?.unmount());
    container.remove();
    errors.mockRestore();
  });

  it("server guessed pending but the param was empty: the layout effect un-veils", async () => {
    window.history.replaceState(null, "", `${PATH}?invite=%20`);
    const { GatedEventShell } = await import("../GatedEventShell");
    render(
      <GatedEventShell {...shellProps} gateType="PASSWORD" inviteParamPresent />,
    );
    const veil = screen.getByTestId("password-gate").parentElement!;
    await waitFor(() => expect(veil.hasAttribute("inert")).toBe(false));
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain(PEEK_URL);
  });

  it("the give-up fallback un-veils a landing that started veiled", async () => {
    routes.peek = () => jsonResponse({ ok: false, error: "x" }, 503);
    await renderShell(); // inviteParamPresent=true from the URL
    const veil = screen.getByTestId("password-gate").parentElement!;
    expect(veil.hasAttribute("inert")).toBe(true);
    await waitFor(
      () => {
        expect(veil.hasAttribute("inert")).toBe(false);
        expect(veil.style.pointerEvents).not.toBe("none");
      },
      { timeout: 3000 },
    );
  });
});

describe("invite landing: surviving a reload (sessionStorage stash)", () => {
  it("the landing stashes the token per event", async () => {
    await renderShell();
    await screen.findByTestId("invite-door");
    expect(sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("a reload (clean URL, stashed token) shows the Door and peeks once", async () => {
    sessionStorage.setItem(STASH_KEY, TOKEN);
    window.history.replaceState(null, "", PATH);
    replaceSpy.mockClear();
    await renderShell();
    await screen.findByTestId("invite-door");
    expect(bodiesOf(PEEK_URL)).toEqual([{ token: TOKEN }]);
    // Nothing to strip on a clean URL.
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("another event's stash is not used", async () => {
    sessionStorage.setItem("th:invite:22222222-2222-4222-8222-222222222222", TOKEN);
    window.history.replaceState(null, "", PATH);
    await renderShell();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain(PEEK_URL);
  });

  it("is cleared after a successful redeem", async () => {
    let unlocked = false;
    routes.probe = () =>
      unlocked
        ? jsonResponse({ access: "unlocked", data: unlockedPayload() })
        : jsonResponse({ access: "locked" });
    routes.redeem = () => {
      unlocked = true;
      return jsonResponse({ ok: true, grant: "INVITE_GRANT", slug: "s" });
    };
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    await screen.findByTestId("event-page-body");
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("is cleared after a dead verdict", async () => {
    routes.peek = () => jsonResponse({ ok: false, reason: "REVOKED" });
    await renderShell();
    await deadLine();
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("is cleared when the viewer is already through", async () => {
    sessionStorage.setItem(STASH_KEY, TOKEN);
    routes.probe = () =>
      jsonResponse({ access: "unlocked", data: unlockedPayload() });
    await renderShell();
    await screen.findByTestId("event-page-body");
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("is cleared on the give-up fallback", async () => {
    routes.peek = () => jsonResponse({ ok: false, error: "x" }, 503);
    await renderShell();
    await waitFor(() => expect(tracedErrors).toHaveLength(1), {
      timeout: 3000,
    });
    expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("storage that throws falls back to today's behaviour: the URL landing works, a reload does not recover", async () => {
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const remove = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      const first = await renderShell();
      await screen.findByTestId("invite-door");
      first.unmount();

      window.history.replaceState(null, "", PATH);
      await renderShell();
      await waitFor(() =>
        expect(
          screen.getByTestId("password-gate").parentElement?.hasAttribute(
            "inert",
          ),
        ).toBe(false),
      );
      expect(screen.queryByTestId("invite-door")).toBeNull();
      expect(bodiesOf(PEEK_URL)).toHaveLength(1);
    } finally {
      get.mockRestore();
      set.mockRestore();
      remove.mockRestore();
    }
  });
});

describe("invite landing: focus after a veiled start falls back to the plain gate", () => {
  it("give-up from a veiled start → the password field has focus", async () => {
    routes.peek = () => jsonResponse({ ok: false, error: "x" }, 503);
    await renderShell(); // veiled from the first render (inviteParamPresent)
    const field = screen.getByLabelText("Event password");
    await waitFor(() => expect(document.activeElement).toBe(field), {
      timeout: 3000,
    });
  });

  it("an empty ?invite= (server guessed pending) → the password field has focus", async () => {
    window.history.replaceState(null, "", `${PATH}?invite=%20`);
    const { GatedEventShell } = await import("../GatedEventShell");
    render(
      <GatedEventShell {...shellProps} gateType="PASSWORD" inviteParamPresent />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Event password"),
      ),
    );
  });

  it("a peek that finds the link dead from a veiled start → the password field has focus, the line is announced", async () => {
    routes.peek = () => jsonResponse({ ok: false, reason: "REVOKED" });
    await renderShell(); // veiled from the first render (inviteParamPresent)
    const notice = await deadLine();
    expect(notice.getAttribute("role")).toBe("status");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Event password"),
      ),
    );
  });

  it("the guest focused something else first → focus is not moved", async () => {
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Menu";
    document.body.appendChild(elsewhere);
    try {
      routes.peek = () => jsonResponse({ ok: false, error: "x" }, 503);
      await renderShell();
      elsewhere.focus();
      await waitFor(() => expect(tracedErrors).toHaveLength(1), {
        timeout: 3000,
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("password-gate").parentElement?.hasAttribute(
            "inert",
          ),
        ).toBe(false),
      );
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it("the application gate is left alone (it autofocuses nothing today)", async () => {
    routes.peek = () => jsonResponse({ ok: false, error: "x" }, 503);
    await renderShell("APPLICATION");
    await waitFor(() => expect(tracedErrors).toHaveLength(1), {
      timeout: 3000,
    });
    expect(document.activeElement).toBe(document.body);
  });
});
