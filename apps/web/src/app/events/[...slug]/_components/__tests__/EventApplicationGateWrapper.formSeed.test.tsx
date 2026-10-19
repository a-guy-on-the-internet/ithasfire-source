/**
 * EventApplicationGateWrapper — the server-seeded form (`formSeed`).
 *
 * The gated page sends the PUBLIC form definition in its HTML so the form is
 * the first paint, not a loading line that grows into it (0.30 CLS at 320px).
 * The pins:
 *
 *   • seeded: the SERVER render already shows the form, with the session
 *     still pending, and the hydrating client render produces the same markup
 *     even when the session resolves synchronously on the client;
 *   • seeded, signed in with a submission: the status card replaces the form;
 *   • seeded at a window boundary (the cached HTML says open, the client clock
 *     says closed): no hydration mismatch, then the live state after mount;
 *   • not seeded: today's loading path, unchanged;
 *   • the invite notice is still held until the status read settles.
 */
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import type { PublicApplicationFormSeed } from "@/server/events";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  // Renders ONE of the gate's states, in the gate's own precedence order
  // (loading → status → window → form), so markup differences between the
  // server and the hydrating render are real DOM differences.
  const GateProbe = (props: {
    isLoading?: boolean;
    viewerSubmission?: { status: string } | null;
    windowState?: string;
    opensAtLabel?: string | null;
    renderForm?: (args: { form: unknown; eventTitle: string }) => ReactNode;
    form?: unknown;
    eventTitle: string;
  }) => {
    if (props.isLoading) {
      return React.createElement(
        "div",
        { "data-testid": "application-loading" },
        "Loading the application…",
      );
    }
    if (props.viewerSubmission) {
      return React.createElement(
        "div",
        { "data-testid": "application-status" },
        props.viewerSubmission.status,
      );
    }
    if (props.windowState && props.windowState !== "open") {
      return React.createElement(
        "div",
        {
          "data-testid": "application-window-state",
          "data-window-state": props.windowState,
        },
        props.opensAtLabel ?? "no-date",
      );
    }
    if (props.form && props.renderForm) {
      return React.createElement(
        "div",
        { "data-testid": "application-form" },
        props.renderForm({ form: props.form, eventTitle: props.eventTitle }),
      );
    }
    return React.createElement("div", { "data-testid": "application-unavailable" });
  };
  const EventApplicationGate = Object.assign(GateProbe, {
    Card: Passthrough,
    Form: (props: {
      form: { questions: Array<{ id: string; label: string }> };
    }) =>
      React.createElement(
        "div",
        null,
        props.form.questions[0]?.label ?? "contact-only",
      ),
  });
  return {
    Text,
    EventApplicationGate,
    NextLinkAnchor: Passthrough,
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({ dateTime: () => "FORMATTED_DATE" }),
    useNotify: () => ({ toast: { danger: vi.fn(), success: vi.fn() } }),
  };
});

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const mockSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: mockSession },
}));
vi.mock("@/components/events/WaitlistJoinForm", () => ({
  WaitlistJoinForm: () => null,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: undefined, isLoading: false }),
}));

const testMocks = vi.hoisted(() => ({
  statusUseQuery: vi.fn(),
  formUseQuery: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      getViewerApplicationStatus: { useQuery: testMocks.statusUseQuery },
      getPublicApplicationForm: { useQuery: testMocks.formUseQuery },
      submitApplication: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      withdrawApplication: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

import { EventApplicationGateWrapper } from "../EventApplicationGateWrapper";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_QUESTION = "What will you bring?";

const makeSeed = (
  over: Partial<PublicApplicationFormSeed["form"]> = {},
  fetchedAt = new Date().toISOString(),
): PublicApplicationFormSeed => ({
  form: {
    eventId: EVENT_ID,
    introText: null,
    opensAt: null,
    closesAt: null,
    questions: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "SHORT_TEXT",
        label: FIRST_QUESTION,
        description: null,
        options: null,
        isRequired: true,
        order: 0,
      },
    ],
    ...over,
  },
  fetchedAt,
});

const PENDING_SESSION = { data: null, isPending: true };
const GUEST_SESSION = { data: null, isPending: false };
const SIGNED_IN_SESSION = { data: { user: { id: "u1" } }, isPending: false };

/** A React Query-shaped result: honours `initialData` the way useQuery does. */
function formQueryHonouringSeed(
  _input: unknown,
  opts?: { initialData?: unknown },
) {
  return opts?.initialData !== undefined
    ? { data: opts.initialData, isLoading: false, refetch: vi.fn() }
    : { data: undefined, isLoading: true, refetch: vi.fn() };
}

function statusResult(submission: { status: string } | null, isLoading = false) {
  return {
    data: isLoading
      ? undefined
      : submission
        ? {
            hasSubmission: true,
            submission: {
              id: "sub-1",
              createdAt: new Date("2026-08-01T00:00:00Z"),
              reviewedAt: null,
              decisionReason: null,
              ...submission,
            },
          }
        : { hasSubmission: false, submission: null },
    isLoading,
    refetch: vi.fn(),
  };
}

const gate = (seed: PublicApplicationFormSeed | null, notice?: ReactNode) => (
  <EventApplicationGateWrapper
    eventId={EVENT_ID}
    slug="apply-only"
    title="Apply Only"
    heroImageUrl={null}
    formSeed={seed}
    notice={notice}
  />
);

let roots: Root[] = [];

/**
 * Server-render with `serverSession`, then hydrate with `clientSession`
 * (auth's store can resolve synchronously on the client's first render).
 * Returns the container and every recoverable error React reported —
 * a hydration mismatch lands there, not necessarily on console.error.
 */
async function serverRenderThenHydrate(
  element: ReactNode,
  serverSession: unknown,
  clientSession: unknown,
) {
  mockSession.mockReturnValue(serverSession);
  const html = renderToString(element);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  mockSession.mockReturnValue(clientSession);
  const recoverable: unknown[] = [];
  await act(async () => {
    roots.push(
      hydrateRoot(container, element, {
        onRecoverableError: (err) => recoverable.push(err),
      }),
    );
  });
  return { html, container, recoverable };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockReturnValue(PENDING_SESSION);
  testMocks.statusUseQuery.mockReturnValue(statusResult(null));
  testMocks.formUseQuery.mockImplementation(formQueryHonouringSeed);
});

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  document.body.innerHTML = "";
});

describe("EventApplicationGateWrapper — server-seeded form", () => {
  // The hydration assertions below are only worth something if this harness
  // actually reports a mismatch. Planted one: the session-derived markup the
  // wrapper keeps behind `hasMounted`, rendered without it.
  it("harness self-check: a server/client markup difference IS reported", async () => {
    const Leaky = () => {
      const session = mockSession() as { isPending: boolean };
      return session.isPending ? <p>pending</p> : <div>resolved</div>;
    };
    const { recoverable } = await serverRenderThenHydrate(
      <Leaky />,
      PENDING_SESSION,
      GUEST_SESSION,
    );

    expect(recoverable.length).toBeGreaterThan(0);
  });

  it("server-renders the form, not the loading line, while the session is pending", () => {
    mockSession.mockReturnValue(PENDING_SESSION);
    const html = renderToString(gate(makeSeed()));

    expect(html).toContain('data-testid="application-form"');
    expect(html).toContain(FIRST_QUESTION);
    expect(html).not.toContain("Loading the application");
  });

  it("hydrates without a mismatch when the client's session resolves on its first render", async () => {
    testMocks.statusUseQuery.mockReturnValue(statusResult(null, true));
    const { container, recoverable } = await serverRenderThenHydrate(
      gate(makeSeed()),
      PENDING_SESSION,
      SIGNED_IN_SESSION,
    );

    expect(recoverable).toEqual([]);
    // Signed in, status still in flight: the form stays (never form →
    // loading → form).
    expect(
      container.querySelector('[data-testid="application-form"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="application-loading"]'),
    ).toBeNull();
  });

  it("swaps the form for the status card once a signed-in viewer's submission is known", async () => {
    testMocks.statusUseQuery.mockReturnValue(statusResult({ status: "PENDING" }));
    const { html, container, recoverable } = await serverRenderThenHydrate(
      gate(makeSeed()),
      PENDING_SESSION,
      SIGNED_IN_SESSION,
    );

    // The server could not know; it painted the form.
    expect(html).toContain('data-testid="application-form"');
    expect(recoverable).toEqual([]);
    expect(
      container.querySelector('[data-testid="application-status"]')
        ?.textContent,
    ).toBe("PENDING");
    expect(
      container.querySelector('[data-testid="application-form"]'),
    ).toBeNull();
  });

  it("seeds the query with the revived shape and the server's read time", () => {
    const seed = makeSeed(
      {
        opensAt: "2026-09-01T10:00:00.000Z",
        closesAt: "2099-09-08T10:00:00.000Z",
      },
      "2026-10-07T12:00:00.000Z",
    );
    render(gate(seed));

    const [input, opts] = testMocks.formUseQuery.mock.calls[0]!;
    expect(input).toEqual({ eventId: EVENT_ID });
    expect(opts.initialData.opensAt).toEqual(
      new Date("2026-09-01T10:00:00.000Z"),
    );
    expect(opts.initialData.closesAt).toEqual(
      new Date("2099-09-08T10:00:00.000Z"),
    );
    expect(opts.initialData.questions[0].label).toBe(FIRST_QUESTION);
    expect(opts.initialDataUpdatedAt).toBe(
      Date.parse("2026-10-07T12:00:00.000Z"),
    );
  });

  it("ignores a seed for a different event", () => {
    mockSession.mockReturnValue(PENDING_SESSION);
    const html = renderToString(
      gate(makeSeed({ eventId: "33333333-3333-4333-8333-333333333333" })),
    );

    expect(html).toContain("Loading the application");
    expect(testMocks.formUseQuery.mock.calls[0]![1].initialData).toBeUndefined();
  });

  it("agrees with the server at a window boundary, then shows the live state", async () => {
    // The HTML was rendered while the window was open; it closed since.
    const closesAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const fetchedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { html, container, recoverable } = await serverRenderThenHydrate(
      gate(makeSeed({ closesAt }, fetchedAt)),
      PENDING_SESSION,
      GUEST_SESSION,
    );

    expect(html).toContain('data-testid="application-form"');
    expect(recoverable).toEqual([]);
    expect(
      container
        .querySelector('[data-testid="application-window-state"]')
        ?.getAttribute("data-window-state"),
    ).toBe("closed");
  });

  it("holds the time-zone-dependent opens-at label until mount", async () => {
    const opensAt = new Date(Date.now() + 86_400_000).toISOString();
    const { html, container, recoverable } = await serverRenderThenHydrate(
      gate(makeSeed({ opensAt })),
      PENDING_SESSION,
      GUEST_SESSION,
    );

    expect(html).toContain("no-date");
    expect(html).not.toContain("FORMATTED_DATE");
    expect(recoverable).toEqual([]);
    expect(
      container.querySelector('[data-testid="application-window-state"]')
        ?.textContent,
    ).toBe("FORMATTED_DATE");
  });

  it("holds the invite notice until the status read settles", () => {
    const notice = <p data-testid="invite-notice">dead link</p>;
    mockSession.mockReturnValue(SIGNED_IN_SESSION);
    testMocks.statusUseQuery.mockReturnValue(statusResult(null, true));
    const { rerender } = render(gate(makeSeed(), notice));

    expect(screen.getByTestId("application-form")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-notice")).not.toBeInTheDocument();

    testMocks.statusUseQuery.mockReturnValue(statusResult(null));
    rerender(gate(makeSeed(), notice));

    expect(screen.getByTestId("invite-notice")).toBeInTheDocument();
  });

  it("never shows the invite notice over a returning applicant's status card", () => {
    const notice = <p data-testid="invite-notice">dead link</p>;
    mockSession.mockReturnValue(SIGNED_IN_SESSION);
    testMocks.statusUseQuery.mockReturnValue(statusResult({ status: "PENDING" }));
    render(gate(makeSeed(), notice));

    expect(screen.getByTestId("application-status")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-notice")).not.toBeInTheDocument();
  });
});

describe("EventApplicationGateWrapper — no server form (fallback)", () => {
  it("server-renders the loading line, as before", () => {
    mockSession.mockReturnValue(PENDING_SESSION);
    const html = renderToString(gate(null));

    expect(html).toContain("Loading the application");
    expect(html).not.toContain('data-testid="application-form"');
    expect(testMocks.formUseQuery.mock.calls[0]![1].initialData).toBeUndefined();
  });

  it("keeps loading while the signed-in status read is in flight, even with the form fetched", () => {
    mockSession.mockReturnValue(SIGNED_IN_SESSION);
    testMocks.statusUseQuery.mockReturnValue(statusResult(null, true));
    testMocks.formUseQuery.mockReturnValue({
      data: makeSeed().form,
      isLoading: false,
      refetch: vi.fn(),
    });
    render(gate(null));

    expect(screen.getByTestId("application-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("application-form")).not.toBeInTheDocument();
  });

  it("shows the form once the session and the client fetch resolve", () => {
    mockSession.mockReturnValue(GUEST_SESSION);
    testMocks.formUseQuery.mockReturnValue({
      data: makeSeed().form,
      isLoading: false,
      refetch: vi.fn(),
    });
    render(gate(null));

    expect(screen.getByTestId("application-form")).toHaveTextContent(
      FIRST_QUESTION,
    );
  });
});
