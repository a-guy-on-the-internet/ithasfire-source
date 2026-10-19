/**
 * A guest the organiser removed by resetting the shared invite link ("Remove
 * them too") comes back to the event page: the normal gate, with one line in
 * the dead-link strip saying why (owner ruling 2026-10-06). The probe says so
 * with `{ access: "locked", removedByInviteReset: true }`.
 *
 * Driven through the real `GatedEventShell` + `useInviteLink` +
 * `InviteDeadNotice`; the gate wrappers are stubs that render the `notice`
 * they are handed (same fakes as InviteLanding.test.tsx), plus an unlock
 * button so "gets in" can be driven.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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
  traceIgnoredError: () => () => undefined,
}));

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

// The real PasswordDoor autofocuses its field on mount; the stub does too.
vi.mock("../EventPasswordGateWrapper", async () => {
  const React = await import("react");
  return {
    EventPasswordGateWrapper: ({
      notice,
      onUnlocked,
    }: {
      notice?: ReactNode;
      onUnlocked: () => void;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "password-gate" },
        notice,
        React.createElement("input", {
          "aria-label": "Event password",
          type: "password",
          autoFocus: true,
        }),
        React.createElement(
          "button",
          { type: "button", onClick: onUnlocked },
          "Unlock",
        ),
      ),
  };
});

vi.mock("../EventApplicationGateWrapper", async () => {
  const React = await import("react");
  return {
    EventApplicationGateWrapper: ({
      notice,
      onUnlocked,
    }: {
      notice?: ReactNode;
      onUnlocked: () => Promise<boolean>;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "application-gate" },
        notice,
        React.createElement("button", { type: "button" }, "Apply"),
        React.createElement(
          "button",
          { type: "button", onClick: () => void onUnlocked() },
          "View event",
        ),
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

const REMOVED_PASSWORD =
  "The organiser reset the invite link, so it no longer lets you in. Ask them for a new one, or enter the password.";
const REMOVED_APPLICATION =
  "The organiser reset the invite link, so it no longer lets you in. Ask them for a new one, or apply.";

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

const REMOVED = { access: "locked", removedByInviteReset: true };

type Routes = {
  probe: () => Response | Promise<Response>;
  peek: () => Response | Promise<Response>;
  redeem: () => Response | Promise<Response>;
};

let routes: Routes;
let fetchMock: Mock<[string, RequestInit?], Promise<Response>>;

beforeEach(() => {
  sessionStorage.clear();
  routes = {
    probe: () => jsonResponse(REMOVED),
    peek: () =>
      jsonResponse({
        ok: true,
        kind: "SHARED",
        inviteeShortName: null,
        organizerName: "Night Owl Collective",
      }),
    redeem: () =>
      jsonResponse({ ok: true, grant: "INVITE_GRANT", slug: shellProps.slug }),
  };
  window.history.replaceState(null, "", PATH);
  fetchMock = vi.fn((url: string) => {
    if (url.endsWith("/unlocked-view")) return Promise.resolve(routes.probe());
    if (url.endsWith("/invite/peek")) return Promise.resolve(routes.peek());
    if (url.endsWith("/invite")) return Promise.resolve(routes.redeem());
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const PROBE_URL = `/api/events/${EVENT_ID}/unlocked-view`;
const PEEK_URL = `/api/events/${EVENT_ID}/invite/peek`;
const probeCount = () =>
  fetchMock.mock.calls.filter(([u]) => u === PROBE_URL).length;

/** The strip once its text has arrived (it mounts empty: see InviteDeadNotice). */
async function line(): Promise<HTMLElement> {
  const notice = await screen.findByTestId("invite-dead-notice");
  await waitFor(() => expect(notice.textContent).not.toBe(""));
  return notice;
}

async function renderShell(gateType: "PASSWORD" | "APPLICATION" = "PASSWORD") {
  const { GatedEventShell } = await import("../GatedEventShell");
  const inviteParamPresent =
    (new URL(window.location.href).searchParams.get("invite") ?? "").trim() !==
    "";
  return render(
    <GatedEventShell
      {...shellProps}
      gateType={gateType}
      inviteParamPresent={inviteParamPresent}
    />,
  );
}

/** Let the mount probe settle, plus a frame for any notice to fill. */
async function settle() {
  await waitFor(() => expect(probeCount()).toBeGreaterThan(0));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("removed by an invite-link reset", () => {
  it("PASSWORD: the reset line over a usable gate; the password field keeps focus", async () => {
    await renderShell();
    const notice = await line();

    expect(notice.textContent).toBe(REMOVED_PASSWORD);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("data-reason")).toBe("removed");
    const gate = screen.getByTestId("password-gate");
    expect(gate.contains(notice)).toBe(true);
    const field = screen.getByLabelText("Event password");
    expect(document.activeElement).toBe(field);
    // Not veiled: the gate is interactive.
    expect(gate.parentElement?.getAttribute("aria-busy")).toBeNull();
    expect(gate.parentElement?.style.pointerEvents).not.toBe("none");
    expect(gate.parentElement?.hasAttribute("inert")).toBe(false);
  });

  it("APPLICATION: the reset line says “or apply.”", async () => {
    await renderShell("APPLICATION");
    const notice = await line();
    expect(notice.textContent).toBe(REMOVED_APPLICATION);
    expect(screen.getByTestId("application-gate").contains(notice)).toBe(true);
  });

  it("a bare locked answer → no line", async () => {
    routes.probe = () => jsonResponse({ access: "locked" });
    await renderShell();
    await settle();
    expect(screen.getByTestId("password-gate")).toBeTruthy();
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it("removedByInviteReset: false → no line", async () => {
    routes.probe = () =>
      jsonResponse({ access: "locked", removedByInviteReset: false });
    await renderShell();
    await settle();
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it("the guest then unlocks with the password → the line goes at once, and the event opens", async () => {
    await renderShell();
    await line();

    let answer: (r: Response) => void = () => {};
    routes.probe = () =>
      new Promise<Response>((r) => {
        answer = r;
      });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    // Gone while the reveal probe is still in flight.
    await waitFor(() =>
      expect(screen.queryByTestId("invite-dead-notice")).toBeNull(),
    );

    await act(async () => {
      answer(jsonResponse({ access: "unlocked", data: unlockedPayload() }));
      await Promise.resolve();
    });
    await screen.findByTestId("event-page-body");
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it("the guest unlocks, the follow-up probe stays bare-locked → the line stays gone; the flag returning brings it back, re-announced", async () => {
    await renderShell();
    const first = await line();

    routes.probe = () => jsonResponse({ access: "locked" });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() =>
      expect(screen.queryByTestId("invite-dead-notice")).toBeNull(),
    );
    await settle();
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();

    // A later probe says the flag again (the server's answer wins).
    routes.probe = () => jsonResponse(REMOVED);
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const again = await screen.findByTestId("invite-dead-notice");
    // A fresh live region: it mounts empty, then the line arrives.
    expect(again).not.toBe(first);
    expect(again.textContent).toBe("");
    await waitFor(() => expect(again.textContent).toBe(REMOVED_PASSWORD));
    expect(again.getAttribute("role")).toBe("status");
  });

  it("the shell is reused for another event that answers bare locked → no line", async () => {
    const { GatedEventShell } = await import("../GatedEventShell");
    const view = render(
      <GatedEventShell {...shellProps} gateType="PASSWORD" />,
    );
    await line();

    routes.probe = () => jsonResponse({ access: "locked" });
    const OTHER = "22222222-2222-4222-8222-222222222222";
    view.rerender(
      <GatedEventShell {...shellProps} eventId={OTHER} gateType="PASSWORD" />,
    );
    // Gone on the very render the event changes, before its probe answers.
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([u]) => u)).toContain(
        `/api/events/${OTHER}/unlocked-view`,
      ),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it("an approved applicant opening the event → the line goes", async () => {
    await renderShell("APPLICATION");
    await line();
    routes.probe = () =>
      jsonResponse({ access: "unlocked", data: unlockedPayload() });
    fireEvent.click(screen.getByRole("button", { name: "View event" }));
    await screen.findByTestId("event-page-body");
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });
});

describe("removed by an invite-link reset: a fresh ?invite= landing wins", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `${PATH}?invite=${TOKEN}`);
  });

  it("while the peek is pending → no reset line", async () => {
    routes.peek = () => new Promise<Response>(() => {});
    await renderShell();
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([u]) => u)).toContain(PEEK_URL),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it("a live link → the Door, no reset line", async () => {
    await renderShell();
    await screen.findByTestId("invite-door");
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it("a new invite opened from the Door, the follow-up probe still locked → the Door says so, no reset line", async () => {
    // Every probe here carries the flag; the Door is the landing, so the
    // reset line never shows. (The Door never falls back to the plain gate,
    // so `onInviteRedeemed` clearing the flag is not visible in the DOM on
    // its own; this pins the visible contract around it.)
    await renderShell();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open the event" }),
    );
    await screen.findByTestId("invite-door-error");
    expect(screen.getByTestId("invite-door")).toBeTruthy();
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
    expect(probeCount()).toBe(2);
  });

  it("a dead link → only that link's dead line, never both", async () => {
    routes.peek = () => jsonResponse({ ok: false, reason: "REVOKED" });
    await renderShell();
    const notice = await line();
    expect(screen.getAllByTestId("invite-dead-notice")).toHaveLength(1);
    expect(notice.getAttribute("data-reason")).toBe("dead");
    expect(notice.textContent).toBe(
      "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or enter the password.",
    );
  });
});
