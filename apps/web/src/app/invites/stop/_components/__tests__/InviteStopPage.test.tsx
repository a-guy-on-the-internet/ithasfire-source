/**
 * `/invites/stop?token=` — "Stop invites from this organiser" (invite opt-out
 * board, owner ruling 2026-10-06). The copy tests read the real English
 * catalog, so a copy change shows up here.
 */
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import enMessages from "@/i18n/messages/en";
import { sessionHoldsInviteToken } from "@/components/analytics/analytics-url-guard";

/** The real English copy, with `{var}` filled in. */
function translate(key: string, vars?: Record<string, unknown>): string {
  const [ns, name] = key.split(".");
  const raw = (enMessages as Record<string, Record<string, unknown>>)[ns]?.[
    name
  ];
  if (typeof raw !== "string") return key;
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => String(vars?.[v] ?? ""));
}

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Button: ({
      children,
      disabled,
      onPress,
      testID,
      ...rest
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      testID?: string;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          disabled,
          onClick: onPress,
          "data-testid": testID,
          "aria-label": rest["aria-label"],
          "aria-busy": rest["aria-busy"],
        },
        children,
      ),
    useTranslations: () => translate,
    useLocale: () => "en",
  };
});

type Out =
  | {
      ok: true;
      organiserName: string | null;
      alreadyStopped?: "ORGANISER" | "ALL" | null;
      organiserGone?: boolean;
    }
  | { ok: false; reason: "INVALID" };

const api = vi.hoisted(() => ({
  peek: vi.fn(),
  stop: vi.fn(),
  stopAll: vi.fn(),
  mutationOptions: [] as unknown[],
}));

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      peekInviteOptOut: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push(opts);
          return { mutateAsync: api.peek };
        },
      },
      stopOrganiserInvites: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push(opts);
          return { mutateAsync: api.stop };
        },
      },
      stopAllInvites: {
        useMutation: (opts?: unknown) => {
          api.mutationOptions.push(opts);
          return { mutateAsync: api.stopAll };
        },
      },
    },
  },
}));

import { InviteStopPage } from "../InviteStopPage";

const TOKEN = "optout.v1.Tk9-secret-7f3a";
const NAME = "Northside Collective";

function visit(search: string) {
  window.history.replaceState(null, "", `/invites/stop${search}`);
}

async function renderPage() {
  const utils = render(<InviteStopPage />);
  // Let the peek promise settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

const title = () => screen.getByRole("heading", { level: 1 });
const liveRegion = () =>
  document.querySelector<HTMLElement>('.th-invite-sr[role="status"]');

beforeEach(() => {
  vi.clearAllMocks();
  api.peek.mockResolvedValue({ ok: true, organiserName: NAME } satisfies Out);
  api.stop.mockResolvedValue({ ok: true, organiserName: NAME } satisfies Out);
  api.stopAll.mockResolvedValue({
    ok: true,
    organiserName: NAME,
    alreadyStopped: null,
    organiserGone: false,
  } satisfies Out);
  visit(`?token=${encodeURIComponent(TOKEN)}`);
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

/** Only timers: the page's promises still settle as microtasks. */
function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** The page writes "busy" to the live region only after 300ms. */
function passBusyDelay(ms = 300) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const STASH_KEY = "th:invite:stop";

describe("InviteStopPage — opening the link", () => {
  it("only reads: the peek runs once with the token, the stop never does", async () => {
    await renderPage();
    expect(api.peek).toHaveBeenCalledTimes(1);
    expect(api.peek).toHaveBeenCalledWith({ token: TOKEN });
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.stopAll).not.toHaveBeenCalled();
  });

  it("takes the token out of the address bar and keeps the rest", async () => {
    visit(`?token=${encodeURIComponent(TOKEN)}&utm_source=email#top`);
    await renderPage();
    expect(window.location.search).not.toContain("token=");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.search).toBe("?utm_source=email");
    expect(window.location.hash).toBe("#top");
  });

  it("asks once, naming the organiser in the kicker and lede, not the title", async () => {
    await renderPage();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      `Event invites · ${NAME}`,
    );
    expect(title().textContent).toBe("Stop invites?");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      `You’ll stop getting event invites from ${NAME}. This only affects them: other organisers can still invite you, and invites you already have keep working.`,
    );
    const button = screen.getByTestId("invite-stop-button");
    expect(button.getAttribute("aria-label")).toBe("Stop invites");
    expect(button.textContent).toBe("Stop invites");
    // The live region exists, empty, before anything is announced.
    expect(liveRegion()?.textContent).toBe("");
  });

  it("says 'this organiser' when the organiser has no name", async () => {
    api.peek.mockResolvedValue({ ok: true, organiserName: null });
    await renderPage();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(screen.getByTestId("invite-stop-lede").textContent).toContain(
      "event invites from this organiser.",
    );
  });

  it("still asks, about 'this organiser', when the peek itself fails", async () => {
    api.peek.mockRejectedValue(new Error("network"));
    await renderPage();
    expect(title().textContent).toBe("Stop invites?");
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(screen.getByTestId("invite-stop-button")).toBeTruthy();
  });
});

describe("InviteStopPage — stopping", () => {
  it("shows the four blocks while it runs, then the done state with focus on the title", async () => {
    fakeTimers();
    let finish: (out: Out) => void = () => {};
    api.stop.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledWith({ token: TOKEN });
    const button = screen.getByTestId("invite-stop-button");
    expect(button.getAttribute("aria-label")).toBe("Stopping invites…");
    // No aria-busy on the focused control: the live region carries "busy".
    expect(button.hasAttribute("aria-busy")).toBe(false);
    // The label stays in the button (hidden by CSS) so it keeps its size.
    expect(button.textContent).toBe("Stop invites");
    expect(screen.getByTestId("invite-stop-spinner").children).toHaveLength(4);
    // The button says it at once; the live region only once it has run 300ms.
    expect(liveRegion()?.textContent).toBe("");
    passBusyDelay();
    expect(liveRegion()?.textContent).toBe("Stopping invites…");

    // A second press while busy does nothing.
    fireEvent.click(button);
    expect(api.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ ok: true, organiserName: NAME });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
    expect(document.activeElement).toBe(title());
    expect(screen.queryByTestId("invite-stop-button")).toBeNull();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      `Event invites · ${NAME}`,
    );
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      `You won’t get event invites from ${NAME} any more.`,
    );
    expect(liveRegion()?.textContent).toBe(
      `You won’t get event invites from ${NAME} any more.`,
    );
    expect(screen.getByTestId("invite-stop-undo").textContent).toBe(
      "Changed your mind? Contact us and we’ll turn them back on.",
    );
    expect(
      screen.getByTestId("invite-stop-contact").getAttribute("href"),
    ).toBe("/contact");
  });

  it("shows the Door's error strip on a failure and lets the guest try again", async () => {
    api.stop.mockRejectedValueOnce(new Error("network"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    const error = screen.getByTestId("invite-stop-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.getAttribute("data-tone")).toBe("error");
    expect(error.textContent).toBe("Something went wrong. Please try again.");
    const button = screen.getByTestId("invite-stop-button");
    expect(button.getAttribute("aria-label")).toBe("Stop invites");

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledTimes(2);
    expect(title().textContent).toBe("Invites stopped");
    expect(screen.queryByTestId("invite-stop-error")).toBeNull();
  });

  it("lands on the broken-link state when the stop says INVALID and a second peek agrees", async () => {
    api.stop.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    api.peek.mockResolvedValue({ ok: false, reason: "INVALID" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(api.peek).toHaveBeenCalledTimes(2);
    expect(title().textContent).toBe("This link doesn’t work");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    expect(document.activeElement).toBe(title());
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
  });
});

describe("InviteStopPage — broken link", () => {
  it("names no organiser and uses the dead-link strip", async () => {
    api.peek.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(title().textContent).toBe("This link doesn’t work");
    const strip = screen.getByTestId("invite-stop-invalid");
    expect(strip.className).toBe("th-invite-dead");
    expect(strip.getAttribute("data-surface")).toBe("door");
    expect(strip.textContent).toBe(
      "It may have been cut short when it was copied. Open the invite email again and use the link at the bottom. If that doesn’t work either, contact us.",
    );
    expect(
      screen.getByTestId("invite-stop-contact").getAttribute("href"),
    ).toBe("/contact");
    expect(screen.queryByTestId("invite-stop-button")).toBeNull();
    expect(document.body.textContent).not.toContain(NAME);
  });

  it("asks the server nothing when the link has no token", async () => {
    visit("");
    await renderPage();
    expect(api.peek).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(title().textContent).toBe("This link doesn’t work");
  });
});

describe("InviteStopPage — surviving a reload", () => {
  it("keeps a same-tab copy of the token after taking it out of the URL", async () => {
    await renderPage();
    expect(window.location.search).not.toContain("token=");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("a reload (clean URL, stash present) still asks, and peeks once with the stashed token", async () => {
    visit("");
    window.sessionStorage.setItem(STASH_KEY, TOKEN);
    await renderPage();
    expect(api.peek).toHaveBeenCalledTimes(1);
    expect(api.peek).toHaveBeenCalledWith({ token: TOKEN });
    expect(title().textContent).toBe("Stop invites?");
    expect(screen.getByTestId("invite-stop-button")).toBeTruthy();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it("keeps the stash once this organiser is stopped, while 'every organiser' is still on offer", async () => {
    visit("");
    window.sessionStorage.setItem(STASH_KEY, TOKEN);
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledWith({ token: TOKEN });
    expect(title().textContent).toBe("Invites stopped");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("clears the stash once every organiser is stopped", async () => {
    visit("");
    window.sessionStorage.setItem(STASH_KEY, TOKEN);
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-all-link"));
      await Promise.resolve();
    });
    expect(api.stopAll).toHaveBeenCalledWith({ token: TOKEN });
    expect(title().textContent).toBe("Invites stopped");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("clears the stash when the peek says every organiser is already stopped", async () => {
    api.peek.mockResolvedValue({
      ok: true,
      organiserName: NAME,
      alreadyStopped: "ALL",
      organiserGone: false,
    } satisfies Out);
    await renderPage();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("clears the stash when the link turns out to be invalid", async () => {
    api.peek.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    expect(title().textContent).toBe("This link doesn’t work");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("keeps the stash after a failed stop, so a reload can try again", async () => {
    api.stop.mockRejectedValueOnce(new Error("network"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("invite-stop-error")).toBeTruthy();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("clears the stash when the page is left", async () => {
    const { unmount } = await renderPage();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
    unmount();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("survives StrictMode's double mount", async () => {
    render(
      <StrictMode>
        <InviteStopPage />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.peek).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
    expect(title().textContent).toBe("Stop invites?");
  });
});

describe("InviteStopPage — one alert, one call", () => {
  it("all three mutations are silent (the page shows its own error strip)", async () => {
    api.mutationOptions.length = 0;
    await renderPage();
    expect(api.mutationOptions.length).toBeGreaterThanOrEqual(3);
    for (const opts of api.mutationOptions) {
      expect(opts).toEqual({ meta: { silent: true } });
    }
  });

  it("two presses in the same tick start one stop", async () => {
    let finish: (out: Out) => void = () => {};
    api.stop.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await renderPage();
    const button = screen.getByTestId("invite-stop-button");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ok: true, organiserName: NAME });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
  });
});

const allLine = () => screen.getByTestId("invite-stop-all");
const allLink = () => screen.getByTestId("invite-stop-all-link");
const DONE_ALL =
  "You won’t get event invites from any organiser on Ithas Fire any more.";
const ALREADY_ALL = "You’d already stopped event invites from every organiser.";
const GONE =
  "The organiser who sent this has left Ithas Fire, so they can’t invite you again. You can still stop event invites from every organiser.";

/** A stop that waits until `resolve` is called. */
function deferred(fn: typeof api.stop) {
  const ctl = { resolve: (_out: Out) => {} };
  fn.mockImplementation(
    () => new Promise<Out>((resolve) => (ctl.resolve = resolve)),
  );
  return ctl;
}

function expectNoTokenInText() {
  expect(document.body.textContent).not.toContain(TOKEN);
  expect(document.body.innerHTML).not.toContain(TOKEN);
}

describe("InviteStopPage — stop invites from every organiser", () => {
  it("offers it as one line under the button: a real button holding the whole sentence", async () => {
    await renderPage();
    const line = allLine();
    expect(line.className).toBe("th-invite-stop__all");
    expect(line.textContent).toBe("Or stop invites from every organiser.");
    // Inside the button row, after the button.
    const cta = screen.getByTestId("invite-stop-button").parentElement!;
    expect(cta.className).toBe("th-door__cta");
    expect(line.parentElement).toBe(cta);
    const link = allLink();
    expect(link.tagName).toBe("BUTTON");
    expect(link.getAttribute("type")).toBe("button");
    expect(link.className).toBe("th-invite-stop__all-button");
    // The whole sentence is inside the button, so it wraps as running text
    // (a button is an atomic box: around the link words alone, "Or" and "."
    // were stranded on lines of their own at 320px).
    expect(link.textContent).toBe("Or stop invites from every organiser.");
    expect(link.parentElement).toBe(line);
    expect(line.childNodes).toHaveLength(1);
    // Only the link words are underlined, and only they name the button.
    const underlined = link.querySelector(".th-invite-stop__all-link");
    expect(underlined?.textContent).toBe("stop invites from every organiser");
    expect(
      screen.getByRole("button", { name: "stop invites from every organiser" }),
    ).toBe(link);
    expect(link.hasAttribute("disabled")).toBe(false);
  });

  it("one tap calls stopAllInvites once, with no second question", async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(api.stopAll).toHaveBeenCalledTimes(1);
    expect(api.stopAll).toHaveBeenCalledWith({ token: TOKEN });
    expect(api.stop).not.toHaveBeenCalled();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(title().textContent).toBe("Invites stopped");
    expect(document.activeElement).toBe(title());
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(DONE_ALL);
    expect(liveRegion()?.textContent).toBe(DONE_ALL);
    expect(screen.getByTestId("invite-stop-undo").textContent).toBe(
      "Changed your mind? Contact us and we’ll turn them back on.",
    );
    expect(screen.queryByTestId("invite-stop-all")).toBeNull();
    expect(screen.queryByTestId("invite-stop-button")).toBeNull();
    expectNoTokenInText();
  });

  it("keeps the line in place while it runs, reading 'Stopping all invites…', and keeps focus on it", async () => {
    fakeTimers();
    const ctl = deferred(api.stopAll);
    await renderPage();
    const link = allLink();
    link.focus();
    await act(async () => {
      fireEvent.click(link);
      await Promise.resolve();
    });
    expect(allLine().textContent).toBe("Stopping all invites…");
    expect(link.textContent).toBe("Stopping all invites…");
    expect(link.querySelector(".th-invite-stop__all-link")).toBeNull();
    // No aria-busy anywhere on the way to the focused control (it can hold
    // a screen reader's updates back); the busy look rides a data attribute.
    expect(allLine().hasAttribute("aria-busy")).toBe(false);
    expect(link.hasAttribute("aria-busy")).toBe(false);
    expect(link.getAttribute("data-busy")).toBe("true");
    expect(document.querySelectorAll("[aria-busy]")).toHaveLength(0);
    // Same node: focus is not dropped.
    expect(allLink()).toBe(link);
    expect(document.activeElement).toBe(link);
    expect(link.hasAttribute("disabled")).toBe(false);
    // VoiceOver rarely re-reads a focused control's changed name, so the
    // live region says it too (a double read on NVDA beats silence), once
    // the stop has run 300ms.
    expect(liveRegion()?.textContent).toBe("");
    passBusyDelay();
    expect(liveRegion()?.textContent).toBe("Stopping all invites…");

    await act(async () => {
      ctl.resolve({
        ok: true,
        organiserName: NAME,
        alreadyStopped: null,
        organiserGone: false,
      });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
    expect(document.activeElement).toBe(title());
  });

  it("refuses a second tap and the organiser button while it runs", async () => {
    const ctl = deferred(api.stopAll);
    await renderPage();
    await act(async () => {
      fireEvent.click(allLink());
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    fireEvent.click(allLink());
    fireEvent.click(screen.getByTestId("invite-stop-button"));
    expect(api.stopAll).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    // The organiser button does not take on the busy look.
    expect(
      screen.getByTestId("invite-stop-button").getAttribute("aria-label"),
    ).toBe("Stop invites");
    expect(screen.queryByTestId("invite-stop-spinner")).toBeNull();
    await act(async () => {
      ctl.resolve({
        ok: true,
        organiserName: NAME,
        alreadyStopped: null,
        organiserGone: false,
      });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
  });

  it("refuses the line while the organiser button runs", async () => {
    const ctl = deferred(api.stop);
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    fireEvent.click(allLink());
    expect(api.stopAll).not.toHaveBeenCalled();
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(allLine().textContent).toBe("Or stop invites from every organiser.");
    await act(async () => {
      ctl.resolve({ ok: true, organiserName: NAME, alreadyStopped: null });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
  });

  it("says 'already' when every organiser was stopped before", async () => {
    api.stopAll.mockResolvedValue({
      ok: true,
      organiserName: NAME,
      alreadyStopped: "ALL",
      organiserGone: false,
    } satisfies Out);
    await renderPage();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      ALREADY_ALL,
    );
    expect(liveRegion()?.textContent).toBe(ALREADY_ALL);
    expect(document.activeElement).toBe(title());
  });

  it("shows the error strip on a failure, keeps the line, and lets the guest try again", async () => {
    api.stopAll.mockRejectedValueOnce(new Error("network"));
    await renderPage();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(screen.getByTestId("invite-stop-error").textContent).toBe(
      "Something went wrong. Please try again.",
    );
    expect(allLine().textContent).toBe("Or stop invites from every organiser.");
    expect(liveRegion()?.textContent).toBe("");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(api.stopAll).toHaveBeenCalledTimes(2);
    expect(title().textContent).toBe("Invites stopped");
    expect(screen.queryByTestId("invite-stop-error")).toBeNull();
  });

  it("lands on the broken-link state when it says INVALID", async () => {
    api.stopAll.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(title().textContent).toBe("This link doesn’t work");
    expect(document.activeElement).toBe(title());
    expect(liveRegion()?.textContent).toBe("");
  });
});

describe("InviteStopPage — after stopping this organiser", () => {
  async function stopOrganiser() {
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
  }

  it("puts the line under the lede, before the undo strip, so the guest can widen it", async () => {
    await renderPage();
    await stopOrganiser();
    const lede = screen.getByTestId("invite-stop-lede");
    expect(lede.textContent).toBe(
      `You won’t get event invites from ${NAME} any more.`,
    );
    expect(lede.nextElementSibling).toBe(allLine());
    expect(allLine().nextElementSibling).toBe(
      screen.getByTestId("invite-stop-undo"),
    );
    expect(allLine().textContent).toBe("Or stop invites from every organiser.");

    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(api.stopAll).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(DONE_ALL);
    expect(liveRegion()?.textContent).toBe(DONE_ALL);
    expect(document.activeElement).toBe(title());
    expect(screen.queryByTestId("invite-stop-all")).toBeNull();
  });

  it("says 'already' when the stop answers ORGANISER", async () => {
    api.stop.mockResolvedValue({
      ok: true,
      organiserName: NAME,
      alreadyStopped: "ORGANISER",
      organiserGone: false,
    } satisfies Out);
    await renderPage();
    await stopOrganiser();
    const already = `You’d already stopped invites from ${NAME}.`;
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(already);
    expect(liveRegion()?.textContent).toBe(already);
    expect(document.activeElement).toBe(title());
    expect(allLine()).toBeTruthy();
    expect(screen.getByTestId("invite-stop-undo")).toBeTruthy();
  });

  it("goes to 'every organiser already stopped' when the stop answers ALL", async () => {
    api.stop.mockResolvedValue({
      ok: true,
      organiserName: NAME,
      alreadyStopped: "ALL",
      organiserGone: false,
    } satisfies Out);
    await renderPage();
    await stopOrganiser();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(title().textContent).toBe("Invites stopped");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      ALREADY_ALL,
    );
    expect(liveRegion()?.textContent).toBe(ALREADY_ALL);
    expect(screen.queryByTestId("invite-stop-all")).toBeNull();
    expect(screen.getByTestId("invite-stop-undo")).toBeTruthy();
  });
});

describe("InviteStopPage — already stopped on open", () => {
  it("this organiser: skips the question and offers only the line, calling no stop", async () => {
    api.peek.mockResolvedValue({
      ok: true,
      organiserName: NAME,
      alreadyStopped: "ORGANISER",
      organiserGone: false,
    } satisfies Out);
    await renderPage();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      `Event invites · ${NAME}`,
    );
    expect(title().textContent).toBe("Invites stopped");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      `You’d already stopped invites from ${NAME}.`,
    );
    expect(screen.queryByTestId("invite-stop-button")).toBeNull();
    expect(allLine().textContent).toBe("Or stop invites from every organiser.");
    expect(screen.getByTestId("invite-stop-undo")).toBeTruthy();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.stopAll).not.toHaveBeenCalled();
    // Nothing happened on open, so nothing is announced or focused.
    expect(liveRegion()?.textContent).toBe("");
    expect(document.activeElement).not.toBe(title());
    expectNoTokenInText();
  });

  it("every organiser: skips the question, offers no stop, and calls none", async () => {
    api.peek.mockResolvedValue({
      ok: true,
      organiserName: NAME,
      alreadyStopped: "ALL",
      organiserGone: false,
    } satisfies Out);
    await renderPage();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(title().textContent).toBe("Invites stopped");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      ALREADY_ALL,
    );
    expect(screen.queryByTestId("invite-stop-button")).toBeNull();
    expect(screen.queryByTestId("invite-stop-all-button")).toBeNull();
    expect(screen.queryByTestId("invite-stop-all")).toBeNull();
    expect(screen.getByTestId("invite-stop-undo")).toBeTruthy();
    expect(api.peek).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.stopAll).not.toHaveBeenCalled();
    expect(liveRegion()?.textContent).toBe("");
    expectNoTokenInText();
  });

  it("every organiser wins over a departed organiser", async () => {
    api.peek.mockResolvedValue({
      ok: true,
      organiserName: null,
      alreadyStopped: "ALL",
      organiserGone: true,
    } satisfies Out);
    await renderPage();
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      ALREADY_ALL,
    );
    expect(screen.queryByTestId("invite-stop-all-button")).toBeNull();
  });
});

describe("InviteStopPage — the organiser has left", () => {
  const gonePeek = {
    ok: true,
    organiserName: null,
    alreadyStopped: null,
    organiserGone: true,
  } satisfies Out;

  it("offers only 'Stop all invites', and opening it calls no stop", async () => {
    api.peek.mockResolvedValue(gonePeek);
    await renderPage();
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(title().textContent).toBe("Stop invites?");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(GONE);
    const button = screen.getByTestId("invite-stop-all-button");
    expect(button.textContent).toBe("Stop all invites");
    expect(button.getAttribute("aria-label")).toBe("Stop all invites");
    expect(button.parentElement?.className).toBe("th-door__cta");
    // No organiser button, no second line: one choice.
    expect(screen.queryByTestId("invite-stop-button")).toBeNull();
    expect(screen.queryByTestId("invite-stop-all")).toBeNull();
    expect(screen.queryByTestId("invite-stop-invalid")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.stopAll).not.toHaveBeenCalled();
    // Nothing happened on open, so nothing is announced or focused.
    expect(liveRegion()?.textContent).toBe("");
    expect(document.activeElement).not.toBe(title());
    // Still the token's to use: the stash stays for a reload.
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("shows the four blocks while it runs, refuses a second press, then lands on 'every organiser'", async () => {
    fakeTimers();
    api.peek.mockResolvedValue(gonePeek);
    const ctl = deferred(api.stopAll);
    await renderPage();
    const button = screen.getByTestId("invite-stop-all-button");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(button.getAttribute("aria-label")).toBe("Stopping all invites…");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(document.querySelectorAll("[aria-busy]")).toHaveLength(0);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.textContent).toBe("Stop all invites");
    expect(screen.getByTestId("invite-stop-spinner").children).toHaveLength(4);
    passBusyDelay();
    expect(liveRegion()?.textContent).toBe("Stopping all invites…");
    fireEvent.click(button);
    expect(api.stopAll).toHaveBeenCalledTimes(1);
    expect(api.stopAll).toHaveBeenCalledWith({ token: TOKEN });
    expect(api.stop).not.toHaveBeenCalled();

    await act(async () => {
      ctl.resolve({
        ok: true,
        organiserName: null,
        alreadyStopped: null,
        organiserGone: true,
      });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
    expect(document.activeElement).toBe(title());
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(DONE_ALL);
    expect(liveRegion()?.textContent).toBe(DONE_ALL);
    expect(screen.queryByTestId("invite-stop-all-button")).toBeNull();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    expectNoTokenInText();
  });
});

describe("InviteStopPage — the token never shows", () => {
  it("is in no rendered text in any state", async () => {
    await renderPage();
    expectNoTokenInText();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expectNoTokenInText();
    api.stopAll.mockResolvedValue({ ok: false, reason: "INVALID" });
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(title().textContent).toBe("This link doesn’t work");
    expectNoTokenInText();
  });
});

describe("InviteStopPage — the organiser leaves after the peek", () => {
  it("a second peek that says 'gone' offers 'Stop all invites' and keeps the stash", async () => {
    api.stop.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    api.peek.mockResolvedValue({
      ok: true,
      organiserName: null,
      alreadyStopped: null,
      organiserGone: true,
    } satisfies Out);
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(api.peek).toHaveBeenCalledTimes(2);
    expect(api.peek).toHaveBeenLastCalledWith({ token: TOKEN });
    expect(api.stopAll).not.toHaveBeenCalled();
    expect(title().textContent).toBe("Stop invites?");
    expect(document.activeElement).toBe(title());
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(GONE);
    expect(liveRegion()?.textContent).toBe(GONE);
    expect(screen.getByTestId("invite-stop-all-button")).toBeTruthy();
    expect(screen.queryByTestId("invite-stop-invalid")).toBeNull();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);

    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-all-button"));
      await Promise.resolve();
    });
    expect(api.stopAll).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(DONE_ALL);
  });

  it("a failed second peek keeps the question and the stash, shows the error strip, and a retry stops again", async () => {
    api.stop.mockResolvedValueOnce({ ok: false, reason: "INVALID" });
    await renderPage();
    api.peek.mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.peek).toHaveBeenCalledTimes(2);
    expect(title().textContent).toBe("Stop invites?");
    expect(document.activeElement).not.toBe(title());
    expect(screen.queryByTestId("invite-stop-invalid")).toBeNull();
    const error = screen.getByTestId("invite-stop-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Something went wrong. Please try again.");
    expect(liveRegion()?.textContent).toBe("");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
    const button = screen.getByTestId("invite-stop-button");
    expect(button.getAttribute("aria-label")).toBe("Stop invites");

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledTimes(2);
    expect(title().textContent).toBe("Invites stopped");
    expect(document.activeElement).toBe(title());
    expect(screen.queryByTestId("invite-stop-error")).toBeNull();
  });

  it("a second peek saying every organiser is already stopped (organiser gone) lands on 'already stopped every organiser'", async () => {
    api.stop.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    api.peek.mockResolvedValue({
      ok: true,
      organiserName: null,
      alreadyStopped: "ALL",
      organiserGone: true,
    } satisfies Out);
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      ALREADY_ALL,
    );
    expect(liveRegion()?.textContent).toBe(ALREADY_ALL);
    expect(document.activeElement).toBe(title());
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    expect(screen.queryByTestId("invite-stop-all")).toBeNull();
    expect(screen.queryByTestId("invite-stop-all-button")).toBeNull();
  });

  it("refuses the line while the second peek runs", async () => {
    api.stop.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    const ctl = { resolve: (_out: Out) => {} };
    api.peek.mockImplementation(
      () => new Promise<Out>((resolve) => (ctl.resolve = resolve)),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    fireEvent.click(allLink());
    expect(api.stopAll).not.toHaveBeenCalled();
    await act(async () => {
      ctl.resolve({ ok: false, reason: "INVALID" });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("This link doesn’t work");
  });
});

describe("InviteStopPage — stop all from the done view", () => {
  it("shows the error strip on a failure, keeps the done view, and a retry succeeds", async () => {
    api.stopAll.mockRejectedValueOnce(new Error("network"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    const error = screen.getByTestId("invite-stop-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Something went wrong. Please try again.");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      `You won’t get event invites from ${NAME} any more.`,
    );
    expect(allLine().textContent).toBe("Or stop invites from every organiser.");
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);

    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(api.stopAll).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(DONE_ALL);
    expect(screen.queryByTestId("invite-stop-error")).toBeNull();
    expect(document.activeElement).toBe(title());
  });
});

describe("InviteStopPage — leaving by the contact link", () => {
  async function doneThisOrganiser() {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  }

  it("a same-tab click clears the stash (a full load runs no unmount cleanup)", async () => {
    await doneThisOrganiser();
    fireEvent.click(screen.getByTestId("invite-stop-contact"), { button: 0 });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("a click that opens a new tab leaves the stash for this page", async () => {
    await doneThisOrganiser();
    fireEvent.click(screen.getByTestId("invite-stop-contact"), {
      button: 0,
      metaKey: true,
    });
    fireEvent.click(screen.getByTestId("invite-stop-contact"), {
      button: 0,
      ctrlKey: true,
    });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("Back from the back/forward cache brings the stash back", async () => {
    await doneThisOrganiser();
    fireEvent.click(screen.getByTestId("invite-stop-contact"), { button: 0 });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    const show = new Event("pageshow") as Event & { persisted?: boolean };
    Object.defineProperty(show, "persisted", { value: true });
    act(() => {
      window.dispatchEvent(show);
    });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBe(TOKEN);
  });

  it("a fresh pageshow (not from the cache) does not restash, nor does any after a final answer", async () => {
    await doneThisOrganiser();
    fireEvent.click(screen.getByTestId("invite-stop-contact"), { button: 0 });
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    const show = new Event("pageshow") as Event & { persisted?: boolean };
    Object.defineProperty(show, "persisted", { value: true });
    act(() => {
      window.dispatchEvent(show);
    });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  it("the broken-link state's contact link clears it too (already cleared)", async () => {
    api.peek.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    fireEvent.click(screen.getByTestId("invite-stop-contact"), { button: 0 });
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
  });
});

describe("InviteStopPage — Back to a page with no token left", () => {
  const original = Object.getOwnPropertyDescriptor(
    performance,
    "getEntriesByType",
  );
  function navigationType(type: string | null) {
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: (kind: string) =>
        kind === "navigation" && type ? [{ type, name: "" }] : [],
    });
  }
  afterEach(() => {
    if (original) {
      Object.defineProperty(performance, "getEntriesByType", original);
    } else {
      delete (performance as { getEntriesByType?: unknown }).getEntriesByType;
    }
  });

  it("says the page has expired, not that the link is broken, and asks the server nothing", async () => {
    navigationType("back_forward");
    visit("");
    await renderPage();
    expect(screen.getByTestId("invite-stop").getAttribute("data-state")).toBe(
      "expired",
    );
    expect(screen.getByTestId("invite-stop-kicker").textContent).toBe(
      "Event invites",
    );
    expect(title().textContent).toBe("This page has expired");
    expect(screen.getByTestId("invite-stop-lede").textContent).toBe(
      "Anything you stopped here is still stopped. To change it, open the link in your email again.",
    );
    expect(screen.queryByTestId("invite-stop-invalid")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(api.peek).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.stopAll).not.toHaveBeenCalled();
    expect(liveRegion()?.textContent).toBe("");
  });

  it("Back with the token still in the URL asks as usual", async () => {
    navigationType("back_forward");
    await renderPage();
    expect(api.peek).toHaveBeenCalledWith({ token: TOKEN });
    expect(title().textContent).toBe("Stop invites?");
  });

  it("Back with a stash restores the page as usual", async () => {
    navigationType("back_forward");
    visit("");
    window.sessionStorage.setItem(STASH_KEY, TOKEN);
    await renderPage();
    expect(api.peek).toHaveBeenCalledWith({ token: TOKEN });
    expect(title().textContent).toBe("Stop invites?");
  });

  it("a plain load with no token is still the broken link", async () => {
    navigationType("navigate");
    visit("");
    await renderPage();
    expect(title().textContent).toBe("This link doesn’t work");
  });

  it("is the broken link when the navigation entry is unavailable", async () => {
    navigationType(null);
    visit("");
    await renderPage();
    expect(title().textContent).toBe("This link doesn’t work");
  });
});

describe("InviteStopPage — Back after a soft navigation away", () => {
  const SEEN_KEY = "th:stop-invites-seen";

  it("marks the tab once a peek finds the link working, with no token in the marker", async () => {
    const { unmount } = await renderPage();
    expect(window.sessionStorage.getItem(SEEN_KEY)).toBe("1");
    // Outside the stash prefix, so it never turns analytics off.
    expect(SEEN_KEY.startsWith("th:invite:")).toBe(false);
    unmount();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    expect(sessionHoldsInviteToken()).toBe(false);
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i)!;
      expect(window.sessionStorage.getItem(key)).not.toContain(TOKEN);
    }
  });

  it("then a clean-URL return with no stash says 'expired', not the dead link", async () => {
    const first = await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    // A Next navigation away (the header logo) unmounts: stash cleared.
    first.unmount();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();

    visit("");
    await renderPage();
    expect(title().textContent).toBe("This page has expired");
    expect(screen.queryByTestId("invite-stop-invalid")).toBeNull();
    expect(api.peek).toHaveBeenCalledTimes(1);
  });

  it("marks the tab when a stop works after a failed peek", async () => {
    api.peek.mockRejectedValue(new Error("network"));
    await renderPage();
    expect(window.sessionStorage.getItem(SEEN_KEY)).toBeNull();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(window.sessionStorage.getItem(SEEN_KEY)).toBe("1");
  });

  it("does not mark the tab for a broken link", async () => {
    api.peek.mockResolvedValue({ ok: false, reason: "INVALID" });
    await renderPage();
    expect(window.sessionStorage.getItem(SEEN_KEY)).toBeNull();
  });

  it("without the marker, a clean URL with no stash is still the dead link", async () => {
    visit("");
    await renderPage();
    expect(title().textContent).toBe("This link doesn’t work");
  });

  it("a token in the URL wins over the marker", async () => {
    window.sessionStorage.setItem(SEEN_KEY, "1");
    await renderPage();
    expect(api.peek).toHaveBeenCalledWith({ token: TOKEN });
    expect(title().textContent).toBe("Stop invites?");
  });
});

describe("InviteStopPage — the busy announcement waits 300ms", () => {
  const spySetTimeout = () => vi.spyOn(window, "setTimeout");
  const spyClearTimeout = () => vi.spyOn(window, "clearTimeout");
  let setTimeoutSpy: ReturnType<typeof spySetTimeout>;
  let clearTimeoutSpy: ReturnType<typeof spyClearTimeout>;
  beforeEach(() => {
    fakeTimers();
    setTimeoutSpy = spySetTimeout();
    clearTimeoutSpy = spyClearTimeout();
  });
  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  /** Every text the live region holds from now on. */
  function recordLive() {
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(liveRegion()?.textContent ?? "");
    });
    observer.observe(liveRegion()!, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return { seen, stop: () => observer.disconnect() };
  }

  it("a stop that answers inside 300ms never writes the busy text", async () => {
    await renderPage();
    const { seen, stop: stopRecording } = recordLive();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
    passBusyDelay(1000);
    await act(async () => {
      await Promise.resolve();
    });
    stopRecording();
    expect(seen).not.toContain("Stopping invites…");
    expect(liveRegion()?.textContent).toBe(
      `You won’t get event invites from ${NAME} any more.`,
    );
  });

  it("a fast failure never writes the busy text, so the error alert is not followed by it", async () => {
    api.stopAll.mockRejectedValueOnce(new Error("offline"));
    await renderPage();
    const { seen, stop: stopRecording } = recordLive();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    expect(screen.getByTestId("invite-stop-error")).toBeTruthy();
    passBusyDelay(1000);
    await act(async () => {
      await Promise.resolve();
    });
    stopRecording();
    expect(seen).not.toContain("Stopping all invites…");
    expect(liveRegion()?.textContent).toBe("");
  });

  it("a slow stop writes it once 300ms have passed, not before", async () => {
    const ctl = deferred(api.stopAll);
    await renderPage();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    passBusyDelay(299);
    expect(liveRegion()?.textContent).toBe("");
    passBusyDelay(1);
    expect(liveRegion()?.textContent).toBe("Stopping all invites…");
    await act(async () => {
      ctl.resolve({
        ok: true,
        organiserName: NAME,
        alreadyStopped: null,
        organiserGone: false,
      });
      await Promise.resolve();
    });
    expect(liveRegion()?.textContent).toBe(DONE_ALL);
  });

  it("a retry after a failure writes the busy text again while the second stop runs", async () => {
    api.stop.mockRejectedValueOnce(new Error("network"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("invite-stop-error")).toBeTruthy();
    expect(liveRegion()?.textContent).toBe("");

    const ctl = deferred(api.stop);
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-stop-button"));
      await Promise.resolve();
    });
    expect(api.stop).toHaveBeenCalledTimes(2);
    passBusyDelay();
    expect(liveRegion()?.textContent).toBe("Stopping invites…");
    await act(async () => {
      ctl.resolve({ ok: true, organiserName: NAME, alreadyStopped: null });
      await Promise.resolve();
    });
    expect(title().textContent).toBe("Invites stopped");
  });

  it("leaving the page while a stop runs cancels the pending announcement", async () => {
    deferred(api.stopAll);
    const { unmount } = await renderPage();
    setTimeoutSpy.mockClear();
    clearTimeoutSpy.mockClear();
    await act(async () => {
      fireEvent.click(allLink());
      await Promise.resolve();
    });
    // The busy announcement: the 300ms timer the tap started.
    const at = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 300);
    expect(at).toBeGreaterThanOrEqual(0);
    const pending = setTimeoutSpy.mock.results[at]?.value;
    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(pending);
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(pending);
  });
});
