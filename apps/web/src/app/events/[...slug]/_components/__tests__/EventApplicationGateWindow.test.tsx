/**
 * EventApplicationGateWrapper — application-window states + withdraw wiring
 * (spec Phase 2). The gate component's own rendering is covered in
 * `@th/ui`'s EventApplicationGate tests; here the pins are the WRAPPER's
 * responsibilities:
 *
 *   • window state derives from the form's opensAt/closesAt with the
 *     server's boundary semantics (exactly-at opensAt/closesAt is OPEN);
 *   • the PENDING withdraw affordance goes through a confirm dialog and
 *     calls `events.withdrawApplication` with the eventId;
 *   • a WITHDRAWN viewer gets a re-apply path that drops back into the form.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => React.createElement("div", { onClick: onPress }, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

const toastDanger = vi.hoisted(() => vi.fn());

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  // Diagnostic gate: echoes the wrapper-computed props this suite pins.
  const GateProbe = (props: {
    viewerSubmission?: { status: string; decisionReason?: string | null } | null;
    windowState?: string;
    opensAtLabel?: string | null;
    onWithdraw?: () => void;
    onReapply?: () => void;
    onViewEvent?: () => void;
    renderForm?: (args: { form: unknown; eventTitle: string }) => ReactNode;
    form?: unknown;
    eventTitle: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "gate", "data-window-state": props.windowState },
      props.opensAtLabel
        ? React.createElement(
            "span",
            { "data-testid": "opens-at-label" },
            props.opensAtLabel,
          )
        : null,
      props.viewerSubmission
        ? React.createElement(
            "span",
            { "data-testid": "viewer-status" },
            props.viewerSubmission.status,
          )
        : null,
      props.viewerSubmission?.decisionReason
        ? React.createElement(
            "span",
            { "data-testid": "viewer-decision-reason" },
            props.viewerSubmission.decisionReason,
          )
        : null,
      props.onWithdraw
        ? React.createElement(
            "button",
            { type: "button", onClick: props.onWithdraw },
            "withdraw",
          )
        : null,
      props.viewerSubmission?.status === "APPROVED" && props.onViewEvent
        ? React.createElement(
            "button",
            { type: "button", onClick: props.onViewEvent },
            "view-event",
          )
        : null,
      props.viewerSubmission?.status === "WITHDRAWN" &&
        props.windowState === "open" &&
        props.onReapply
        ? React.createElement(
            "button",
            { type: "button", onClick: props.onReapply },
            "reapply",
          )
        : null,
      !props.viewerSubmission &&
        props.windowState === "open" &&
        props.form &&
        props.renderForm
        ? React.createElement(
            "div",
            { "data-testid": "application-form" },
            props.renderForm({ form: props.form, eventTitle: props.eventTitle }),
          )
        : null,
    );
  const EventApplicationGate = Object.assign(GateProbe, {
    Card: Passthrough,
    // Records what the wrapper hands the form, and renders the contact-step
    // slot so the guest note is observable.
    Form: (props: { contactNote?: ReactNode }) => {
      testMocks.formProps(props);
      return React.createElement(
        "div",
        null,
        "form-fields",
        props.contactNote ?? null,
      );
    },
  });
  return {
    Text,
    EventApplicationGate,
    NextLinkAnchor: Passthrough,
    Button: ({ children }: { children?: ReactNode }) =>
      React.createElement("button", { type: "button" }, children),
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({ dateTime: () => "FORMATTED_DATE" }),
    useNotify: () => ({ toast: { danger: toastDanger, success: vi.fn() } }),
  };
});

// Confirm dialog stub: renders its confirm affordance only while open.
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: () => void;
  }) =>
    open ? (
      <button type="button" data-testid="confirm-withdraw" onClick={onConfirm}>
        confirm
      </button>
    ) : null,
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
  // The ORGANIZER-only read. Kept mocked purely so this suite can assert the
  // wrapper never touches it (see the regression test below).
  authedFormUseQuery: vi.fn(),
  withdrawMutate: vi.fn(),
  statusRefetch: vi.fn(),
  formProps: vi.fn(),
  submitOptions: {
    current: null as null | { onSuccess?: (result: unknown) => void },
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      getViewerApplicationStatus: { useQuery: testMocks.statusUseQuery },
      getPublicApplicationForm: { useQuery: testMocks.formUseQuery },
      getApplicationForm: { useQuery: testMocks.authedFormUseQuery },
      submitApplication: {
        useMutation: (opts: { onSuccess?: (result: unknown) => void }) => {
          testMocks.submitOptions.current = opts;
          return { mutate: vi.fn(), isPending: false };
        },
      },
      withdrawApplication: {
        useMutation: () => ({
          mutate: testMocks.withdrawMutate,
          isPending: false,
        }),
      },
    },
  },
}));

import {
  EventApplicationGateWrapper,
  resolveWindowState,
} from "../EventApplicationGateWrapper";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function statusResult(
  submission: {
    id: string;
    status: string;
    decisionReason?: string | null;
  } | null = null,
) {
  return {
    data: submission
      ? {
          hasSubmission: true,
          submission: {
            createdAt: new Date("2026-08-01T00:00:00Z"),
            reviewedAt: null,
            decisionReason: null,
            ...submission,
          },
        }
      : { hasSubmission: false, submission: null },
    isLoading: false,
    refetch: testMocks.statusRefetch,
  };
}

/**
 * The PUBLIC procedure's payload — deliberately FLAT
 * ({eventId, introText, opensAt, closesAt, questions}). It carries none of
 * the organizer-only fields (`defaults`, `maxSubmissions`, `autoApprove`,
 * form id, `updatedAt`) the authed `getApplicationForm` returns, so a wrapper
 * still reading `data.form.*` would silently see `undefined` everywhere.
 */
function formResult(form: { opensAt?: Date | null; closesAt?: Date | null }) {
  return {
    data: {
      eventId: EVENT_ID,
      introText: null,
      opensAt: form.opensAt ?? null,
      closesAt: form.closesAt ?? null,
      questions: [],
    },
    isLoading: false,
    refetch: vi.fn(),
  };
}

const renderWrapper = () =>
  render(
    <EventApplicationGateWrapper
      eventId={EVENT_ID}
      slug="apply-only"
      title="Apply Only"
      heroImageUrl={null}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockReturnValue({ data: { user: { id: "u1" } }, isPending: false });
  testMocks.statusUseQuery.mockReturnValue(statusResult());
  testMocks.formUseQuery.mockReturnValue(formResult({}));
  // Returns a VALID authed-shaped payload on purpose: if the wrapper ever
  // regressed to this procedure the UI would still render, so only the
  // explicit "not called" assertion below can catch it.
  testMocks.authedFormUseQuery.mockReturnValue({
    data: {
      form: {
        id: "form-1",
        eventId: EVENT_ID,
        introText: null,
        defaults: {
          includeName: true,
          includeReason: true,
          includeSocialLinks: false,
        },
        opensAt: null,
        closesAt: null,
        maxSubmissions: null,
        autoApprove: false,
        updatedAt: new Date(),
      },
      questions: [],
    },
    isLoading: false,
    refetch: vi.fn(),
  });
});

// ── resolveWindowState — server-parity boundary semantics ────────────────────

describe("resolveWindowState", () => {
  const opensAt = new Date("2026-09-01T10:00:00Z");
  const closesAt = new Date("2026-09-08T10:00:00Z");

  it("is notYetOpen strictly before opensAt and OPEN exactly at it", () => {
    expect(
      resolveWindowState(opensAt, null, new Date("2026-09-01T09:59:59Z")),
    ).toBe("notYetOpen");
    expect(resolveWindowState(opensAt, null, opensAt)).toBe("open");
  });

  it("is OPEN exactly at closesAt and closed strictly after it", () => {
    expect(resolveWindowState(null, closesAt, closesAt)).toBe("open");
    expect(
      resolveWindowState(null, closesAt, new Date("2026-09-08T10:00:01Z")),
    ).toBe("closed");
  });

  it("is open with no bounds at all", () => {
    expect(resolveWindowState(null, null, new Date())).toBe("open");
  });
});

// ── Wrapper wiring ───────────────────────────────────────────────────────────

describe("EventApplicationGateWrapper — window states", () => {
  it("passes notYetOpen + a formatted opensAt label before the window opens", () => {
    testMocks.formUseQuery.mockReturnValue(
      formResult({ opensAt: new Date(Date.now() + 86_400_000) }),
    );
    renderWrapper();

    expect(screen.getByTestId("gate")).toHaveAttribute(
      "data-window-state",
      "notYetOpen",
    );
    expect(screen.getByTestId("opens-at-label")).toHaveTextContent(
      "FORMATTED_DATE",
    );
    expect(screen.queryByTestId("application-form")).not.toBeInTheDocument();
  });

  it("passes closed after the window closes (no form rendered)", () => {
    testMocks.formUseQuery.mockReturnValue(
      formResult({ closesAt: new Date(Date.now() - 86_400_000) }),
    );
    renderWrapper();

    expect(screen.getByTestId("gate")).toHaveAttribute(
      "data-window-state",
      "closed",
    );
    expect(screen.queryByTestId("application-form")).not.toBeInTheDocument();
  });

  it("renders the form while the window is open", () => {
    renderWrapper();

    expect(screen.getByTestId("gate")).toHaveAttribute(
      "data-window-state",
      "open",
    );
    expect(screen.getByTestId("application-form")).toBeInTheDocument();
  });
});

describe("EventApplicationGateWrapper — decision reason", () => {
  it("hands the organizer's note to the gate as viewerSubmission.decisionReason", () => {
    testMocks.statusUseQuery.mockReturnValue(
      statusResult({
        id: "sub-1",
        status: "REJECTED",
        decisionReason: "We are full this month",
      }),
    );
    renderWrapper();

    expect(screen.getByTestId("viewer-decision-reason")).toHaveTextContent(
      "We are full this month",
    );
  });
});

describe("EventApplicationGateWrapper — view event after approval", () => {
  it("flags the unlock for the reveal and focus handoff BEFORE asking for access", () => {
    sessionStorage.clear();
    const flagKey = `th-event-just-unlocked:${EVENT_ID}`;
    let flagWhenAsked: string | null = null;
    const onUnlocked = vi.fn(() => {
      flagWhenAsked = sessionStorage.getItem(flagKey);
    });
    testMocks.statusUseQuery.mockReturnValue(
      statusResult({ id: "sub-1", status: "APPROVED" }),
    );
    render(
      <EventApplicationGateWrapper
        eventId={EVENT_ID}
        slug="apply-only"
        title="Apply Only"
        heroImageUrl={null}
        onUnlocked={onUnlocked}
      />,
    );

    try {
      fireEvent.click(screen.getByRole("button", { name: "view-event" }));

      expect(onUnlocked).toHaveBeenCalledTimes(1);
      expect(flagWhenAsked).toBe("1");
    } finally {
      // The mocked shell never mounts EventDetail, which is what consumes it.
      sessionStorage.removeItem(flagKey);
    }
  });
});

describe("EventApplicationGateWrapper — view event when access stays closed", () => {
  const renderApproved = (onUnlocked: () => Promise<boolean>) => {
    testMocks.statusUseQuery.mockReturnValue(
      statusResult({ id: "sub-1", status: "APPROVED" }),
    );
    render(
      <EventApplicationGateWrapper
        eventId={EVENT_ID}
        slug="apply-only"
        title="Apply Only"
        heroImageUrl={null}
        onUnlocked={onUnlocked}
      />,
    );
  };

  it("says so and re-reads the status when the probe does not open the event", async () => {
    toastDanger.mockClear();
    testMocks.statusRefetch.mockClear();
    renderApproved(vi.fn(async () => false));

    fireEvent.click(screen.getByRole("button", { name: "view-event" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(toastDanger.mock.calls[0][0]).toMatchObject({
      title: "eventDetail.appGenericError",
    });
    expect(testMocks.statusRefetch).toHaveBeenCalled();
    sessionStorage.clear();
  });

  it("stays quiet when the event opens", async () => {
    toastDanger.mockClear();
    testMocks.statusRefetch.mockClear();
    const onUnlocked = vi.fn(async () => true);
    renderApproved(onUnlocked);

    fireEvent.click(screen.getByRole("button", { name: "view-event" }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(toastDanger).not.toHaveBeenCalled();
    expect(testMocks.statusRefetch).not.toHaveBeenCalled();
    sessionStorage.clear();
  });

  it("does not toast on the next page when the viewer left before the verdict", async () => {
    toastDanger.mockClear();
    let release: (v: boolean) => void = () => {};
    const onUnlocked = vi.fn(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    testMocks.statusUseQuery.mockReturnValue(
      statusResult({ id: "sub-1", status: "APPROVED" }),
    );
    const { unmount } = render(
      <EventApplicationGateWrapper
        eventId={EVENT_ID}
        slug="apply-only"
        title="Apply Only"
        heroImageUrl={null}
        onUnlocked={onUnlocked}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "view-event" }));
    unmount();
    await act(async () => release(false));
    expect(toastDanger).not.toHaveBeenCalled();
    sessionStorage.clear();
  });

  it("ignores a second press while the first probe is in flight", async () => {
    let release: (v: boolean) => void = () => {};
    const onUnlocked = vi.fn(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    renderApproved(onUnlocked);
    const button = screen.getByRole("button", { name: "view-event" });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(onUnlocked).toHaveBeenCalledTimes(1);

    await act(async () => release(true));
    fireEvent.click(button);
    expect(onUnlocked).toHaveBeenCalledTimes(2);
    sessionStorage.clear();
  });
});

describe("EventApplicationGateWrapper — withdraw", () => {
  it("confirms, calls withdrawApplication with the eventId, then refetches status", () => {
    testMocks.statusUseQuery.mockReturnValue(
      statusResult({ id: "sub-1", status: "PENDING" }),
    );
    testMocks.withdrawMutate.mockImplementation(
      (_input: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    renderWrapper();

    // No mutation before the dialog is confirmed.
    fireEvent.click(screen.getByText("withdraw"));
    expect(testMocks.withdrawMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-withdraw"));
    expect(testMocks.withdrawMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.withdrawMutate.mock.calls[0]![0]).toEqual({
      eventId: EVENT_ID,
    });
    expect(testMocks.statusRefetch).toHaveBeenCalled();
  });
});

describe("EventApplicationGateWrapper — re-apply after withdrawal", () => {
  it("shows the re-apply affordance on WITHDRAWN and drops back into the form", () => {
    testMocks.statusUseQuery.mockReturnValue(
      statusResult({ id: "sub-1", status: "WITHDRAWN" }),
    );
    renderWrapper();

    expect(screen.getByTestId("viewer-status")).toHaveTextContent("WITHDRAWN");
    expect(screen.queryByTestId("application-form")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("reapply"));

    // The withdrawn card yields to the form (submission suppressed).
    expect(screen.queryByTestId("viewer-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("application-form")).toBeInTheDocument();
  });
});

// ── The Phase-3 blocker regression ───────────────────────────────────────────
//
// `events.getApplicationForm` runs behind `ensureActorCanEditEvent`. This gate
// ONLY renders for viewers who are locked out — i.e. never editors — so
// reading the form from that procedure returns INSUFFICIENT_ROLE, `form`
// resolves null, and NOBODY can apply to any application-gated event. These
// pins are what the previous mocks could not catch: they stubbed
// `getApplicationForm` directly, so the wrapper was green while pointed at the
// procedure that fails in production.

describe("EventApplicationGateWrapper — reads the PUBLIC form procedure", () => {
  it("never calls the organizer-only getApplicationForm", () => {
    renderWrapper();

    expect(testMocks.formUseQuery).toHaveBeenCalled();
    expect(testMocks.authedFormUseQuery).not.toHaveBeenCalled();
  });

  it("enables the form read with NO session (guests must see the form)", () => {
    renderWrapper();

    // Second arg is the react-query options bag. `enabled` must not depend on
    // auth — a guest with no session still needs the definition.
    const options = testMocks.formUseQuery.mock.calls[0]![1] as {
      enabled: boolean;
    };
    expect(options.enabled).toBe(true);
  });

  it("reads the FLAT public payload, not data.form.*", () => {
    const opensAt = new Date(Date.now() + 86_400_000);
    testMocks.formUseQuery.mockReturnValue(formResult({ opensAt }));
    renderWrapper();

    // Window state is derived from the flat opensAt. A wrapper still reading
    // `data.form.opensAt` would see undefined here and fall through to "open".
    expect(screen.getByTestId("gate")).toHaveAttribute(
      "data-window-state",
      "notYetOpen",
    );
  });
});

describe("EventApplicationGateWrapper — anonymous applicants", () => {
  it("renders the FORM for a signed-out viewer instead of a sign-in wall", () => {
    mockSession.mockReturnValue({ data: null, isPending: false });
    renderWrapper();

    expect(screen.getByTestId("application-form")).toBeInTheDocument();
    // The old anonymous short-circuit rendered a "Sign in to apply" card in
    // place of the gate entirely.
    expect(screen.getByTestId("gate")).toBeInTheDocument();
  });

  it("still fetches the form when signed out", () => {
    mockSession.mockReturnValue({ data: null, isPending: false });
    renderWrapper();

    expect(testMocks.formUseQuery).toHaveBeenCalled();
    expect(testMocks.authedFormUseQuery).not.toHaveBeenCalled();
  });
});

// ── Direction D page frame (2026-09-30) ──────────────────────────────────────

describe("EventApplicationGateWrapper — page frame + contact step", () => {
  it("renders the title as the page h1 under the 'Application required' kicker", () => {
    renderWrapper();

    expect(
      screen.getByRole("heading", { level: 1, name: "Apply Only" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("eventDetail.appGateKicker"),
    ).toBeInTheDocument();
    // No poster → the narrow single column, no rail.
    expect(screen.getByTestId("application-gate-page")).toHaveClass(
      "th-appgate--posterless",
    );
  });

  it("puts the guest 'sign in to track it' note on the contact step for a signed-out viewer", () => {
    mockSession.mockReturnValue({ data: null, isPending: false });
    renderWrapper();

    const note = screen.getByTestId("application-guest-note");
    expect(note).toHaveTextContent("eventDetail.appSignInToTrackBody");
    expect(note).toHaveTextContent("eventDetail.appSignInToTrackCta");
    // It rides INSIDE the form (the contact-step slot), not below the gate.
    expect(screen.getByTestId("application-form")).toContainElement(note);
  });

  it("passes no guest note once signed in", () => {
    renderWrapper();

    expect(
      screen.queryByTestId("application-guest-note"),
    ).not.toBeInTheDocument();
    const props = testMocks.formProps.mock.calls.at(-1)![0] as {
      contactNote?: unknown;
      contactErrors?: unknown;
    };
    expect(props.contactNote).toBeNull();
    // Contact errors start empty and are handed down inline.
    expect(props.contactErrors).toEqual({ email: undefined, phone: undefined });
  });
});

describe("EventApplicationGateWrapper — a guest's own result", () => {
  it("shows the submit response's status to a signed-out applicant, without withdraw", () => {
    mockSession.mockReturnValue({ data: null, isPending: false });
    renderWrapper();
    expect(screen.getByTestId("application-form")).toBeInTheDocument();

    act(() => {
      testMocks.submitOptions.current?.onSuccess?.({
        eventId: EVENT_ID,
        submissionId: "22222222-2222-4222-8222-222222222222",
        status: "PENDING",
        bypassed: false,
      });
    });

    expect(screen.getByTestId("viewer-status")).toHaveTextContent("PENDING");
    expect(screen.queryByTestId("application-form")).not.toBeInTheDocument();
    // Withdraw is an authed call — never offered on a guest's result.
    expect(screen.queryByText("withdraw")).not.toBeInTheDocument();
    // ...and the session-keyed status read is not fired for a guest.
    expect(testMocks.statusRefetch).not.toHaveBeenCalled();
  });
});

describe("EventApplicationGateWrapper — the invite line (dead or reset link)", () => {
  // The real strip: its copy ends "…or apply.", so it belongs over the form
  // only. The @th/ui mock translates key → key.
  const renderWithNotice = async (reason: "dead" | "removed") => {
    const { InviteDeadNotice } = await import("../InviteDoor");
    return render(
      <EventApplicationGateWrapper
        eventId={EVENT_ID}
        slug="apply-only"
        title="Apply Only"
        heroImageUrl={null}
        notice={
          <InviteDeadNotice
            gateType="APPLICATION"
            surface="paper"
            reason={reason}
          />
        }
      />,
    );
  };
  const KEY = {
    dead: "eventDetail.inviteDeadApplication",
    removed: "eventDetail.inviteRemovedApplication",
  } as const;

  it.each(["dead", "removed"] as const)(
    "%s: shown over the form when there is no application",
    async (reason) => {
      await renderWithNotice(reason);
      const notice = screen.getByTestId("invite-dead-notice");
      await waitFor(() => expect(notice).toHaveTextContent(KEY[reason]));
      expect(screen.getByTestId("application-form")).toBeInTheDocument();
    },
  );

  it.each([
    ["dead", "PENDING"],
    ["dead", "REJECTED"],
    ["removed", "PENDING"],
    ["removed", "REJECTED"],
    ["removed", "APPROVED"],
  ] as const)(
    "%s: not shown over a signed-in %s status card",
    async (reason, status) => {
      testMocks.statusUseQuery.mockReturnValue(
        statusResult({ id: "sub-1", status }),
      );
      await renderWithNotice(reason);
      expect(screen.getByTestId("viewer-status")).toHaveTextContent(status);
      expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
    },
  );

  it("not shown while the signed-in status read loads (no flash, then vanish)", async () => {
    testMocks.statusUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      refetch: testMocks.statusRefetch,
    });
    await renderWithNotice("removed");
    expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
  });

  it.each(["dead", "removed"] as const)(
    "%s: goes once a guest applies (their own PENDING result)",
    async (reason) => {
      mockSession.mockReturnValue({ data: null, isPending: false });
      await renderWithNotice(reason);
      expect(screen.getByTestId("invite-dead-notice")).toBeInTheDocument();

      act(() => {
        testMocks.submitOptions.current?.onSuccess?.({
          eventId: EVENT_ID,
          submissionId: "22222222-2222-4222-8222-222222222222",
          status: "PENDING",
          bypassed: false,
        });
      });

      expect(screen.getByTestId("viewer-status")).toHaveTextContent("PENDING");
      expect(screen.queryByTestId("invite-dead-notice")).toBeNull();
    },
  );
});
