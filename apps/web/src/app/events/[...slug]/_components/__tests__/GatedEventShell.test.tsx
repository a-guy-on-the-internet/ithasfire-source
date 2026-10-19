/**
 * `/events/[...slug]` is served `public, s-maxage=120, stale-while-revalidate=300`
 * with a `Vary` that contains no `Cookie`, so its HTML is shared across every
 * viewer behind a colo. `GatedEventShell` is what keeps a gated event's real
 * content OUT of those bytes: the server always renders the wall, and the
 * viewer's standing against the gate is resolved after first paint against an
 * uncacheable same-origin POST.
 *
 * These tests pin the two properties that matter:
 *   - the FIRST render (which is what gets cached) carries the gate and nothing
 *     of the event, whoever the viewer turns out to be;
 *   - the reveal happens only on an explicit `access: "unlocked"`, and every
 *     other outcome — locked, HTTP error, network failure — fails CLOSED.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import superjson from "superjson";

import type { EventPageData } from "@/server/event-page-data";

const traceIgnoredError = vi.fn((_label: string) => vi.fn());
const invalidateCardTiers = vi.fn((_input: { eventId: string }) =>
  Promise.resolve(),
);
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { ticketTiersForCard: { invalidate: invalidateCardTiers } },
    }),
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => traceIgnoredError(label),
}));

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Spinner: () => React.createElement("div", { "data-testid": "spinner" }),
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    useTranslations: () => (key: string) => key,
  };
});

// The three children are exercised by their own suites; here they only need to
// be identifiable, so that "is the content in the tree?" is a precise question.
let capturedBodyData: EventPageData | null = null;
let capturedPasswordProps: Record<string, unknown> = {};
let capturedApplicationProps: Record<string, unknown> = {};

vi.mock("../EventPageBody", async () => {
  const React = await import("react");
  return {
    EventPageBody: ({ data }: { data: EventPageData }) => {
      capturedBodyData = data;
      return React.createElement(
        "div",
        { "data-testid": "event-page-body" },
        data.event.name,
      );
    },
  };
});

vi.mock("../EventPasswordGateWrapper", async () => {
  const React = await import("react");
  return {
    EventPasswordGateWrapper: (props: Record<string, unknown>) => {
      capturedPasswordProps = props;
      return React.createElement(
        "div",
        { "data-testid": "password-gate" },
        "password gate",
      );
    },
  };
});

vi.mock("../EventApplicationGateWrapper", async () => {
  const React = await import("react");
  return {
    EventApplicationGateWrapper: (props: Record<string, unknown>) => {
      capturedApplicationProps = props;
      return React.createElement(
        "div",
        { "data-testid": "application-gate" },
        "application gate",
      );
    },
  };
});

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT_ID = "22222222-2222-4222-8222-222222222222";

const SECRET_TITLE = "Secret Warehouse Party";

const unlockedPayload = () =>
  superjson.serialize({
    eventId: EVENT_ID,
    slug: "org/us/nashville/secret",
    event: {
      name: SECRET_TITLE,
      startsAt: new Date("2026-10-01T02:00:00.000Z"),
    },
  } as unknown as EventPageData);

const shellProps = {
  eventId: EVENT_ID,
  slug: "org/us/nashville/secret",
  title: "Secret Warehouse Party",
  heroImageUrl: null,
  gateDate: "2026-10-09",
  waitlistOpen: false,
  waitlistDescription: null,
} as const;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capturedBodyData = null;
  capturedPasswordProps = {};
  capturedApplicationProps = {};
  traceIgnoredError.mockClear();
  invalidateCardTiers.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

/** A probe that never settles — models the state the cached HTML is rendered in. */
const neverResolves = () => new Promise<Response>(() => {});

describe("GatedEventShell", () => {
  it("renders the gate and NO event content before the access probe answers", async () => {
    fetchMock.mockImplementation(neverResolves);
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    expect(screen.getByTestId("password-gate")).toBeTruthy();
    expect(screen.queryByTestId("event-page-body")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET_TITLE);
    expect(capturedBodyData).toBeNull();
  });

  it("keeps the gate up when the probe says locked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("password-gate")).toBeTruthy();
    expect(screen.queryByTestId("event-page-body")).toBeNull();
  });

  it("reveals the event only on an explicit unlocked verdict", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );
    expect(screen.queryByTestId("password-gate")).toBeNull();
    // superjson, not JSON.parse: the payload is full of Dates the renderer
    // calls date methods on.
    expect(capturedBodyData?.event.startsAt).toBeInstanceOf(Date);
  });

  it("drops the event's cached card tiers when the verdict is unlocked, not when locked", async () => {
    // A hover fetched while gated cached `{ tiers: [] }` for 2 minutes.
    fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");
    const first = render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(invalidateCardTiers).not.toHaveBeenCalled();
    first.unmount();

    fetchMock.mockResolvedValue(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
    await waitFor(() =>
      expect(invalidateCardTiers).toHaveBeenCalledWith({ eventId: EVENT_ID }),
    );
  });

  it("still opens the event when the card-tier invalidation throws synchronously", async () => {
    invalidateCardTiers.mockImplementationOnce(() => {
      throw new Error("procedure missing");
    });
    fetchMock.mockResolvedValue(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );
    expect(screen.queryByTestId("password-gate")).toBeNull();
    expect(traceIgnoredError).toHaveBeenCalledWith(
      "event.gate.invalidateCardTiers",
    );
    expect(traceIgnoredError).not.toHaveBeenCalledWith("event.gate.accessProbe");
  });

  it("still opens the event when the card-tier invalidation rejects", async () => {
    invalidateCardTiers.mockImplementationOnce(() =>
      Promise.reject(new Error("refetch failed")),
    );
    fetchMock.mockResolvedValue(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );
    expect(screen.queryByTestId("password-gate")).toBeNull();
    expect(traceIgnoredError).not.toHaveBeenCalledWith("event.gate.accessProbe");
  });

  it("probes the uncacheable POST endpoint with credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/events/${EVENT_ID}/unlocked-view`);
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("fails CLOSED and reports when the probe returns an HTTP error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() =>
      expect(traceIgnoredError).toHaveBeenCalledWith("event.gate.accessProbe"),
    );
    expect(screen.getByTestId("password-gate")).toBeTruthy();
    expect(screen.queryByTestId("event-page-body")).toBeNull();
  });

  it("fails CLOSED and reports when the probe rejects", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

    await waitFor(() =>
      expect(traceIgnoredError).toHaveBeenCalledWith("event.gate.accessProbe"),
    );
    expect(screen.getByTestId("password-gate")).toBeTruthy();
    expect(screen.queryByTestId("event-page-body")).toBeNull();
  });

  it("renders the APPLICATION wall for an application-gated event", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="APPLICATION" />);

    expect(screen.getByTestId("application-gate")).toBeTruthy();
    expect(screen.queryByTestId("password-gate")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("gives both walls an onUnlocked that re-probes instead of refreshing", async () => {
    // `router.refresh()` cannot work here: it refetches the same edge-cached RSC
    // payload, i.e. the gate again.
    fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    await act(async () => {
      await (capturedPasswordProps.onUnlocked as () => Promise<void>)();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );
  });

  it("hands the server-read application form to the application wall", async () => {
    // page.tsx reads the PUBLIC form definition so the form is the first
    // paint; dropping it here would bring the loading line (and the CLS) back.
    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");
    const applicationFormSeed = {
      form: {
        eventId: EVENT_ID,
        introText: null,
        opensAt: null,
        closesAt: null,
        questions: [],
      },
      fetchedAt: "2026-10-07T12:00:00.000Z",
    };

    render(
      <GatedEventShell
        {...shellProps}
        gateType="APPLICATION"
        applicationFormSeed={applicationFormSeed}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(capturedApplicationProps.formSeed).toBe(applicationFormSeed);
  });

  it("passes onUnlocked to the application wall too", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="APPLICATION" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(typeof capturedApplicationProps.onUnlocked).toBe("function");
  });

  it("coalesces an unlock that lands while the mount probe is still in flight", async () => {
    // Without the queue, a viewer who types the password fast enough has their
    // reveal dropped and sits on the gate holding a valid unlock cookie.
    let releaseFirst: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseFirst = resolve)),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Password submitted while probe #1 is still open.
    await act(async () => {
      void (capturedPasswordProps.onUnlocked as () => Promise<void>)();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    await act(async () => {
      releaseFirst(jsonResponse({ access: "locked" }));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );
  });

  // ── Binding the content to the right EVENT, not just the right viewer ──────
  //
  // App Router does not key a segment by its dynamic params, so a soft nav from
  // one gated event to another reconciles this component in place instead of
  // remounting it — the same mechanism documented on
  // `EventApplicationGateWrapper.onUnlocked`. `page.tsx` passes `key={eventId}`;
  // these pin the in-component belt for a caller who forgets it.

  it("re-walls when the eventId prop changes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    const { rerender } = render(
      <GatedEventShell {...shellProps} gateType="PASSWORD" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );

    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    await act(async () => {
      rerender(
        <GatedEventShell
          {...shellProps}
          eventId={OTHER_EVENT_ID}
          gateType="PASSWORD"
        />,
      );
    });

    expect(screen.queryByTestId("event-page-body")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET_TITLE);
    expect(screen.getByTestId("password-gate")).toBeTruthy();
  });

  it("re-probes the NEW event after the eventId prop changes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access: "unlocked", data: unlockedPayload() }),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    const { rerender } = render(
      <GatedEventShell {...shellProps} gateType="PASSWORD" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("event-page-body")).toBeTruthy(),
    );

    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    await act(async () => {
      rerender(
        <GatedEventShell
          {...shellProps}
          eventId={OTHER_EVENT_ID}
          gateType="PASSWORD"
        />,
      );
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/events/${OTHER_EVENT_ID}/unlocked-view`,
    );
  });

  it("ignores an unlocked verdict that lands for the PREVIOUS event", async () => {
    // The probe for event A is still open when the prop flips to B. Its payload
    // must never be rendered under B's URL — the reveal is tagged with the event
    // it was fetched for and the tag is checked during render.
    let releaseFirst: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseFirst = resolve)),
    );
    const { GatedEventShell } = await import("../GatedEventShell");

    const { rerender } = render(
      <GatedEventShell {...shellProps} gateType="PASSWORD" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValue(jsonResponse({ access: "locked" }));
    await act(async () => {
      rerender(
        <GatedEventShell
          {...shellProps}
          eventId={OTHER_EVENT_ID}
          gateType="PASSWORD"
        />,
      );
    });

    // Event A's probe now answers "unlocked" — too late, and for the wrong event.
    await act(async () => {
      releaseFirst(jsonResponse({ access: "unlocked", data: unlockedPayload() }));
    });

    expect(screen.queryByTestId("event-page-body")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET_TITLE);
    expect(screen.getByTestId("password-gate")).toBeTruthy();
  });

  // ── The unlock reveal ──────────────────────────────────────────────────────

  const UNLOCKED = () =>
    jsonResponse({ access: "unlocked", data: unlockedPayload() });
  const FLAG = `th-event-just-unlocked:${EVENT_ID}`;

  /**
   * A View Transition double whose `finished` the test controls. With
   * `deferUpdate`, the update callback waits for `runUpdate()`, as a real
   * browser runs it only after capturing the old frame.
   */
  function stubViewTransition(
    opts: { throws?: boolean; deferUpdate?: boolean } = {},
  ) {
    let finish: () => void = () => {};
    let fail: (e: unknown) => void = () => {};
    let runUpdate: () => Promise<void> = async () => {};
    const start = vi.fn((update: () => Promise<void> | void) => {
      if (opts.throws) throw new Error("InvalidStateError");
      const finished = new Promise<void>((res, rej) => {
        finish = res;
        fail = rej;
      });
      let updateCallbackDone: Promise<void>;
      if (opts.deferUpdate) {
        updateCallbackDone = new Promise<void>((res) => {
          runUpdate = async () => {
            await update();
            res();
          };
        });
      } else {
        updateCallbackDone = Promise.resolve(update());
      }
      return { ready: Promise.resolve(), updateCallbackDone, finished };
    });
    (document as unknown as { startViewTransition?: unknown }).startViewTransition =
      start;
    return {
      start,
      finish: () => finish(),
      fail: (e: unknown) => fail(e),
      runUpdate: () => runUpdate(),
    };
  }

  function stubReducedMotion(reduce: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduce })),
    );
  }

  describe("unlock reveal", () => {
    beforeEach(() => {
      stubReducedMotion(false);
    });
    afterEach(() => {
      delete (document as unknown as { startViewTransition?: unknown })
        .startViewTransition;
      document.documentElement.classList.remove("th-door-revealing");
      sessionStorage.clear();
    });

    it("animates when this tab just unlocked, and clears the html class after finished", async () => {
      sessionStorage.setItem(FLAG, "1");
      const vt = stubViewTransition();
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      expect(vt.start).toHaveBeenCalledTimes(1);
      expect(
        document.documentElement.classList.contains("th-door-revealing"),
      ).toBe(true);
      await act(async () => vt.finish());
      expect(
        document.documentElement.classList.contains("th-door-revealing"),
      ).toBe(false);
    });

    it("a waiter queued during an ANIMATED reveal gets the verdict without a second probe", async () => {
      // The animated path applies the reveal inside the transition's async
      // callback, after the probe has already cleared `checking`. The queue
      // drain must count the pending reveal, or it re-probes and the second
      // transition skips the first.
      sessionStorage.setItem(FLAG, "1");
      const vt = stubViewTransition({ deferUpdate: true });
      let releaseFirst: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (releaseFirst = resolve)),
      );
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="APPLICATION" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      let verdict: boolean | undefined;
      await act(async () => {
        void (
          capturedApplicationProps.onUnlocked as () => Promise<boolean>
        )().then((v) => (verdict = v));
      });
      await act(async () => {
        releaseFirst(UNLOCKED());
      });
      await waitFor(() => expect(vt.start).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(verdict).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vt.runUpdate();
      });
      expect(screen.getByTestId("event-page-body")).toBeTruthy();
      expect(vt.start).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT animate a returning visitor (no flag)", async () => {
      const vt = stubViewTransition();
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      expect(vt.start).not.toHaveBeenCalled();
      expect(
        document.documentElement.classList.contains("th-door-revealing"),
      ).toBe(false);
    });

    it("applies plainly under reduced motion", async () => {
      sessionStorage.setItem(FLAG, "1");
      stubReducedMotion(true);
      const vt = stubViewTransition();
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      expect(vt.start).not.toHaveBeenCalled();
    });

    it("applies plainly when the browser has no View Transitions API", async () => {
      sessionStorage.setItem(FLAG, "1");
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      expect(
        document.documentElement.classList.contains("th-door-revealing"),
      ).toBe(false);
    });

    it("removes the html class when the transition is skipped (finished rejects)", async () => {
      sessionStorage.setItem(FLAG, "1");
      const vt = stubViewTransition();
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      await act(async () => vt.fail(new Error("skipped")));
      expect(
        document.documentElement.classList.contains("th-door-revealing"),
      ).toBe(false);
    });

    it("removes the html class and still reveals when startViewTransition throws", async () => {
      sessionStorage.setItem(FLAG, "1");
      stubViewTransition({ throws: true });
      fetchMock.mockResolvedValue(UNLOCKED());
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);

      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      expect(
        document.documentElement.classList.contains("th-door-revealing"),
      ).toBe(false);
    });
  });

  describe("just-unlocked flag hygiene", () => {
    afterEach(() => {
      sessionStorage.clear();
    });

    it("clears the flag when a password unlock's probe comes back locked", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
      const { GatedEventShell } = await import("../GatedEventShell");
      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // The wrapper sets the flag, then calls onUnlocked.
      sessionStorage.setItem(FLAG, "1");
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
      await act(async () => {
        (capturedPasswordProps.onUnlocked as () => void)();
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(sessionStorage.getItem(FLAG)).toBeNull());
    });

    it("clears the flag when an application unlock's probe comes back locked", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
      const { GatedEventShell } = await import("../GatedEventShell");
      render(<GatedEventShell {...shellProps} gateType="APPLICATION" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      sessionStorage.setItem(FLAG, "1");
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
      let opened: unknown;
      await act(async () => {
        opened = await (
          capturedApplicationProps.onUnlocked as () => Promise<boolean>
        )();
      });

      expect(opened).toBe(false);
      expect(sessionStorage.getItem(FLAG)).toBeNull();
    });

    it("leaves the flag for EventDetail to consume when the unlock opens the event", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
      const { GatedEventShell } = await import("../GatedEventShell");
      render(<GatedEventShell {...shellProps} gateType="APPLICATION" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      sessionStorage.setItem(FLAG, "1");
      fetchMock.mockResolvedValueOnce(UNLOCKED());
      let opened: unknown;
      await act(async () => {
        opened = await (
          capturedApplicationProps.onUnlocked as () => Promise<boolean>
        )();
      });

      expect(opened).toBe(true);
      await waitFor(() =>
        expect(screen.getByTestId("event-page-body")).toBeTruthy(),
      );
      // EventDetail is mocked away here; the shell must not have removed it.
      expect(sessionStorage.getItem(FLAG)).toBe("1");
    });
  });

  describe("Door state across the unlock", () => {
    it("holds the Door in `revealing` through the probe, then resets on a closed verdict and reports it", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ access: "locked" }));
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(capturedPasswordProps.revealing).toBe(false);
      expect(capturedPasswordProps.unlockFailures).toBe(0);

      let release: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (release = resolve)),
      );
      await act(async () => {
        (capturedPasswordProps.onUnlocked as () => void)();
      });
      expect(capturedPasswordProps.revealing).toBe(true);

      await act(async () => {
        release(jsonResponse({ access: "locked" }));
      });
      await waitFor(() => expect(capturedPasswordProps.revealing).toBe(false));
      expect(capturedPasswordProps.unlockFailures).toBe(1);
    });

    it("keeps `revealing` until the QUEUED probe answers (unlock during the mount probe)", async () => {
      let releaseMount: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (releaseMount = resolve)),
      );
      const { GatedEventShell } = await import("../GatedEventShell");

      render(<GatedEventShell {...shellProps} gateType="PASSWORD" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await act(async () => {
        (capturedPasswordProps.onUnlocked as () => void)();
      });
      expect(capturedPasswordProps.revealing).toBe(true);

      // The queued probe is the one that decides; hold it open.
      let releaseQueued: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(
        () => new Promise<Response>((resolve) => (releaseQueued = resolve)),
      );
      await act(async () => {
        releaseMount(jsonResponse({ access: "locked" }));
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      // Mount probe is done, queued one still running: the Door must NOT
      // have been re-enabled (the bug resolved `false` immediately).
      expect(capturedPasswordProps.revealing).toBe(true);
      expect(capturedPasswordProps.unlockFailures).toBe(0);

      await act(async () => {
        releaseQueued(jsonResponse({ access: "locked" }));
      });
      await waitFor(() => expect(capturedPasswordProps.revealing).toBe(false));
      expect(capturedPasswordProps.unlockFailures).toBe(1);
    });
  });

  // ── Drift guard ────────────────────────────────────────────────────────────
  //
  // `GatedEventShell.revealWithTransition` registers its view transition on
  // `document.__reactViewTransition`, React's PRIVATE serialisation handle, so
  // React's page fade waits for the Door's reveal. If React renames or drops it
  // the reveal silently goes back to being skipped by the page-level fade.
  it("React still serialises view transitions on document.__reactViewTransition", () => {
    const webRequire = createRequire(path.join(process.cwd(), "package.json"));
    const nextDir = path.dirname(webRequire.resolve("next/package.json"));
    // `experimental.viewTransition: true` (next.config.ts) makes Next ship the
    // experimental React; check it and the stable channel, dev and prod.
    const builds = [
      "react-dom-experimental/cjs/react-dom-client.development.js",
      "react-dom-experimental/cjs/react-dom-client.production.js",
      "react-dom/cjs/react-dom-client.development.js",
      "react-dom/cjs/react-dom-client.production.js",
    ].map((rel) => path.join(nextDir, "dist/compiled", rel));
    for (const file of builds) {
      expect(
        readFileSync(file, "utf8").includes("__reactViewTransition"),
        `${file} no longer mentions __reactViewTransition. ` +
          "GatedEventShell.tsx (revealWithTransition) depends on that private " +
          "React field; update or remove the claim there.",
      ).toBe(true);
    }
  });
});
