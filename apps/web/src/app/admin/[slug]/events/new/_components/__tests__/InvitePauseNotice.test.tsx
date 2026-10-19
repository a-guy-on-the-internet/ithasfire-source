/**
 * Invite complaint auto-pause (W4, board option A) on the "Invited guests"
 * panel: the status → notice state machine, what the panel hides while
 * paused, "Ask for a review", and a send that races a fresh pause.
 *
 * The styling layer is replaced by DOM stand-ins (as in
 * EventInviteSettings.test.tsx) so the assertions target behaviour.
 */
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type|htmlFor)$/;
function domProps(rest: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (PASS_PROP.test(key)) out[key] = value;
  }
  return out;
}

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => React.createElement(tag ?? "div", domProps(rest), children);
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  // React 19: `ref` arrives as a prop; forward it so focus moves are testable.
  const Text = ({
    children,
    tag,
    ref,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    ref?: unknown;
    [key: string]: unknown;
  }) => React.createElement(tag ?? "span", { ...domProps(rest), ref }, children);
  return {
    Text,
    Badge: Text,
    Spinner: () => null,
    Modal: Object.assign(
      ({ open, children }: { open?: boolean; children?: ReactNode }) =>
        open ? React.createElement("div", { role: "dialog" }, children) : null,
      {
        Panel: ({ children }: { children?: ReactNode }) => React.createElement("div", null, children),
        Header: ({ title }: { title?: string }) => React.createElement("h2", null, title),
        Body: ({ children }: { children?: ReactNode }) => React.createElement("div", null, children),
        Footer: ({ children }: { children?: ReactNode }) => React.createElement("div", null, children),
      },
    ),
    StyledSelect: ({
      value,
      options,
      onChange,
      testId,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
      testId?: string;
    }) =>
      React.createElement(
        "select",
        {
          "data-testid": testId,
          value,
          onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        },
        [
          React.createElement("option", { key: "", value: "" }, "-"),
          ...options.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label)),
        ],
      ),
    Button: ({
      children,
      onPress,
      disabled,
      variant,
      textProps: _textProps,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      variant?: string;
      textProps?: unknown;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        { type: "button", onClick: onPress, disabled, "data-variant": variant, ...domProps(rest) },
        children,
      ),
    TextInput: ({
      testId,
      value,
      onChangeText,
      id,
    }: {
      testId?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      id?: string;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        id,
        value,
        onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value),
      }),
    CharCountTextarea: ({
      id,
      value,
      onChange,
      maxLength,
      testIdBase,
      disabled,
    }: {
      id?: string;
      value: string;
      onChange: (v: string) => void;
      maxLength?: number;
      testIdBase?: string;
      disabled?: boolean;
    }) =>
      React.createElement("textarea", {
        id,
        value,
        maxLength,
        disabled,
        "data-testid": testIdBase,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
      }),
    useFormatters: () => ({
      locale: "en",
      dateTime: (d: Date) => `D:${d.toISOString().slice(0, 10)}`,
    }),
    // Key-echoing translator; values are appended so assertions can see them.
    useTranslations:
      () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key,
  };
});

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/calendar/calendar-actions", () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}));

type StatusData = {
  paused: boolean;
  pause: {
    reason: "COMPLAINT_COUNT" | "COMPLAINT_RATE";
    pausedAt: Date;
    complaintCount: number;
    recipientCount: number;
    windowDays: number;
    reviewRequestedAt: Date | null;
    reviewRequestNote: string | null;
    canRequestReview: boolean;
  } | null;
  lastDecision: {
    decision: "LIFTED" | "KEPT";
    decidedAt: Date;
    note: string | null;
  } | null;
};

const api = vi.hoisted(() => ({
  status: {
    isPending: false,
    isError: false,
    data: undefined as unknown,
  },
  requestReview: vi.fn(),
  requestPending: false,
  statusInvalidate: vi.fn(() => Promise.resolve()),
  statusSetData: vi.fn(),
  listInvalidate: vi.fn(() => Promise.resolve()),
  createGuestInvites: vi.fn(),
  resendGuestInvite: vi.fn(),
  revokeGuestInvite: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listInvites: { invalidate: api.listInvalidate, getData: () => undefined },
      },
      invitePauses: {
        status: { invalidate: api.statusInvalidate, setData: api.statusSetData },
      },
    }),
    invitePauses: {
      status: { useQuery: () => api.status },
      requestReview: {
        useMutation: () => ({
          mutateAsync: api.requestReview,
          isPending: api.requestPending,
        }),
      },
    },
    events: {
      createGuestInvites: {
        useMutation: () => ({ mutateAsync: api.createGuestInvites, isPending: false }),
      },
      resendGuestInvite: { useMutation: () => ({ mutateAsync: api.resendGuestInvite }) },
      revokeGuestInvite: { useMutation: () => ({ mutateAsync: api.revokeGuestInvite }) },
    },
    comms: {
      listAudiences: {
        useQuery: () => ({
          isLoading: false,
          isError: false,
          data: [{ id: "list-1", name: "Regulars" }],
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

import { EventGuestInvites, type GuestInvite } from "../EventGuestInvites";
import {
  INVITE_PAUSE_LIFTED_NOTICE_MS,
  canSendInvites,
  deriveInvitePauseView,
  isInvitesPausedError,
  isStaleReviewRequestError,
} from "../invite-pause-helpers";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = {
  ownerScope: "ORGANIZATION" as const,
  ownerId: "22222222-2222-4222-8222-222222222222",
};
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const MAYA: GuestInvite = {
  id: "inv-maya",
  name: "Maya Reyes",
  email: "maya@example.com",
  status: "SENT",
  copyUrl: "https://ithasfire.com/e/x?invite=maya",
};

function pausedStatus(overrides: Partial<NonNullable<StatusData["pause"]>> = {}, lastDecision: StatusData["lastDecision"] = null): StatusData {
  return {
    paused: true,
    pause: {
      reason: "COMPLAINT_COUNT",
      pausedAt: new Date("2026-10-05T09:00:00Z"),
      complaintCount: 3,
      recipientCount: 120,
      windowDays: 30,
      reviewRequestedAt: null,
      reviewRequestNote: null,
      canRequestReview: true,
      ...overrides,
    },
    lastDecision,
  };
}

const NOT_PAUSED: StatusData = { paused: false, pause: null, lastDecision: null };

const pausedError = () =>
  Object.assign(new Error("INVITES_PAUSED"), {
    data: { code: "FORBIDDEN", appCode: "INVITES_PAUSED", httpStatus: 403 },
  });

function setStatus(data: StatusData | undefined, flags: { isPending?: boolean; isError?: boolean } = {}) {
  api.status = {
    isPending: flags.isPending ?? false,
    isError: flags.isError ?? false,
    data,
  };
}

function renderPanel(guests: GuestInvite[] = [MAYA]) {
  return render(<EventGuestInvites eventId={EVENT_ID} owner={OWNER} guests={guests} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.requestPending = false;
  setStatus(NOT_PAUSED);
});

// ── The pure state machine ─────────────────────────────────────────────────

describe("deriveInvitePauseView", () => {
  const derive = (data: StatusData | undefined, flags: { isPending?: boolean; isError?: boolean } = {}) =>
    deriveInvitePauseView(
      { isPending: flags.isPending ?? false, isError: flags.isError ?? false, data },
      NOW,
    );

  it("is loading until the status resolves, and open when the read fails", () => {
    expect(derive(undefined, { isPending: true }).kind).toBe("loading");
    expect(derive(undefined, { isError: true }).kind).toBe("open");
  });

  it("is open when not paused and nothing was lifted", () => {
    expect(derive(NOT_PAUSED)).toEqual({ kind: "open" });
  });

  it("carries the counts for a fresh pause", () => {
    expect(derive(pausedStatus({ reason: "COMPLAINT_RATE", complaintCount: 2, recipientCount: 150 }))).toEqual({
      kind: "paused",
      reason: "COMPLAINT_RATE",
      complaintCount: 2,
      recipientCount: 150,
      windowDays: 30,
    });
  });

  it("is 'requested' while a review request waits, even after an earlier KEEP", () => {
    const view = derive(
      pausedStatus(
        { reviewRequestedAt: new Date("2026-10-06T10:00:00Z"), canRequestReview: false },
        { decision: "KEPT", decidedAt: new Date("2026-10-04T10:00:00Z"), note: "No." },
      ),
    );
    expect(view.kind).toBe("requested");
  });

  it("is 'kept' with the staff note after a KEEP", () => {
    const decidedAt = new Date("2026-10-06T15:00:00Z");
    expect(
      derive(pausedStatus({}, { decision: "KEPT", decidedAt, note: "Your list bought addresses." })),
    ).toEqual({ kind: "kept", decidedAt, note: "Your list bought addresses." });
  });

  it("says 'lifted' for 7 days after a LIFT, then goes quiet", () => {
    const recent = new Date(NOW.getTime() - 2 * DAY);
    const old = new Date(NOW.getTime() - INVITE_PAUSE_LIFTED_NOTICE_MS - 1);
    expect(derive({ ...NOT_PAUSED, lastDecision: { decision: "LIFTED", decidedAt: recent, note: null } })).toEqual({
      kind: "lifted",
      liftedAt: recent,
    });
    expect(derive({ ...NOT_PAUSED, lastDecision: { decision: "LIFTED", decidedAt: old, note: null } }).kind).toBe("open");
  });

  it("only lets the panel send when open or lifted", () => {
    expect(canSendInvites({ kind: "open" })).toBe(true);
    expect(canSendInvites({ kind: "lifted", liftedAt: NOW })).toBe(true);
    expect(canSendInvites({ kind: "loading" })).toBe(false);
    expect(canSendInvites({ kind: "requested", requestedAt: NOW })).toBe(false);
  });

  it("keeps the 'back on' line through a few minutes of clock skew", () => {
    const ahead = new Date(NOW.getTime() + 2 * 60 * 1000);
    expect(derive({ ...NOT_PAUSED, lastDecision: { decision: "LIFTED", decidedAt: ahead, note: null } }).kind).toBe("lifted");
  });

  it("recognises the paused refusal and the stale review refusals", () => {
    expect(isInvitesPausedError(pausedError())).toBe(true);
    expect(isInvitesPausedError(new Error("nope"))).toBe(false);
    expect(isStaleReviewRequestError({ message: "x", data: { code: "CONFLICT" } })).toBe(true);
    // Not paused any more: INVALID_STATUS (the transport maps it to CONFLICT).
    expect(
      isStaleReviewRequestError({
        message: "invites_not_paused",
        data: { code: "CONFLICT", appCode: "INVALID_STATUS" },
      }),
    ).toBe(true);
    expect(isStaleReviewRequestError({ message: "x", data: { appCode: "INVALID_STATUS" } })).toBe(true);
    expect(isStaleReviewRequestError({ message: "x", data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });
});

// ── The panel ──────────────────────────────────────────────────────────────

describe("EventGuestInvites while invites are paused", () => {
  it("renders no send controls while the status is loading", () => {
    setStatus(undefined, { isPending: true });
    renderPanel();
    expect(screen.queryByTestId("guest-invite-name")).toBeNull();
    expect(screen.queryByTestId("guest-invite-list-open")).toBeNull();
    expect(screen.queryByTestId(`guest-invite-resend-${MAYA.id}`)).toBeNull();
    expect(screen.queryByTestId("invite-pause-notice")).toBeNull();
    expect(screen.getByText("admin.ginGuestsDesc")).toBeTruthy();
  });

  it("keeps today's panel when the status read fails", () => {
    setStatus(undefined, { isError: true });
    renderPanel();
    expect(screen.getByTestId("guest-invite-name")).toBeTruthy();
    expect(screen.getByTestId("guest-invite-list-open")).toBeTruthy();
    expect(screen.getByTestId(`guest-invite-resend-${MAYA.id}`)).toBeTruthy();
  });

  it("replaces the send controls with the notice and keeps copy + revoke", () => {
    setStatus(pausedStatus());
    renderPanel();

    const notice = screen.getByTestId("invite-pause-notice");
    expect(notice.getAttribute("data-state")).toBe("paused");
    const status = within(notice).getByRole("status");
    expect(within(status).getByText("admin.ginPauseTitle")).toBeTruthy();
    expect(
      within(status).getByText('admin.ginPauseBodyCount {"count":3,"days":30}'),
    ).toBeTruthy();
    expect(within(status).getByText("admin.ginPauseStillWorks")).toBeTruthy();
    expect(within(notice).getByLabelText("admin.ginPauseNoteLabel")).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "admin.ginPauseAsk" })).toBeTruthy();

    // The description stays; the add-one row and the list button go.
    expect(screen.getByText("admin.ginGuestsDesc")).toBeTruthy();
    expect(screen.queryByTestId("guest-invite-name")).toBeNull();
    expect(screen.queryByTestId("guest-invite-send")).toBeNull();
    expect(screen.queryByTestId("guest-invite-list-open")).toBeNull();
    expect(screen.queryByText("admin.ginInviteListHint")).toBeNull();

    // Rows keep Copy link and Revoke; Resend is hidden.
    expect(screen.getByTestId(`guest-invite-copy-${MAYA.id}`)).toBeTruthy();
    expect(screen.getByTestId(`guest-invite-revoke-${MAYA.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`guest-invite-resend-${MAYA.id}`)).toBeNull();
  });

  it("hides Invite again on a revoked row while paused (it sends an email)", () => {
    setStatus(pausedStatus());
    renderPanel([{ ...MAYA, status: "REVOKED" }]);
    expect(screen.queryByTestId(`guest-invite-reinvite-${MAYA.id}`)).toBeNull();
  });

  it("states the 1-in-100 rule for a rate pause", () => {
    setStatus(pausedStatus({ reason: "COMPLAINT_RATE", complaintCount: 2, recipientCount: 150 }));
    renderPanel();
    expect(
      screen.getByText('admin.ginPauseBodyRate {"count":2,"invited":150,"days":30}'),
    ).toBeTruthy();
  });

  it("falls back to the count sentence when the rate has no countable sends", () => {
    setStatus(pausedStatus({ reason: "COMPLAINT_RATE", complaintCount: 1, recipientCount: 0 }));
    renderPanel();
    expect(screen.getByText('admin.ginPauseBodyCount {"count":1,"days":30}')).toBeTruthy();
    expect(screen.queryByText(/admin\.ginPauseBodyRate/)).toBeNull();
  });

  it("asks for a review with the note, stores the new status and focuses the title", async () => {
    setStatus(pausedStatus());
    const next = pausedStatus({ reviewRequestedAt: NOW, canRequestReview: false });
    api.requestReview.mockResolvedValueOnce(next);
    renderPanel();

    fireEvent.change(screen.getByTestId("invite-pause-note"), {
      target: { value: "  These are all past ticket buyers.  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-request"));
    });

    expect(api.requestReview).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      note: "These are all past ticket buyers.",
    });
    expect(api.statusSetData).toHaveBeenCalledWith({ eventId: EVENT_ID }, next);
    expect(document.activeElement?.textContent).toBe("admin.ginPauseTitle");
  });

  it("sends a null note when the box is empty", async () => {
    setStatus(pausedStatus());
    api.requestReview.mockResolvedValueOnce(pausedStatus({ reviewRequestedAt: NOW }));
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-request"));
    });
    expect(api.requestReview).toHaveBeenCalledWith({ eventId: EVENT_ID, note: null });
  });

  it("refetches quietly when a review was already asked for (CONFLICT)", async () => {
    setStatus(pausedStatus());
    api.requestReview.mockRejectedValueOnce(
      Object.assign(new Error("invite_pause_review_already_requested"), {
        data: { code: "CONFLICT", httpStatus: 409 },
      }),
    );
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-request"));
    });
    expect(api.statusInvalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(screen.queryByTestId("invite-pause-request-error")).toBeNull();
    // The button goes once the refetch lands; focus is already on the title.
    expect(document.activeElement?.textContent).toBe("admin.ginPauseTitle");
  });

  it("does not take focus when the page simply loads paused", () => {
    setStatus(pausedStatus());
    renderPanel();
    expect(document.activeElement).toBe(document.body);
  });

  it("shows other review failures inline", async () => {
    setStatus(pausedStatus());
    api.requestReview.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { data: { code: "INTERNAL_SERVER_ERROR" } }),
    );
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-request"));
    });
    const alert = screen.getByTestId("invite-pause-request-error");
    expect(alert.getAttribute("role")).toBe("alert");
  });

  it("says a review was asked for, with no button, once one waits", () => {
    setStatus(
      pausedStatus({ reviewRequestedAt: new Date("2026-10-06T10:00:00Z"), canRequestReview: false }),
    );
    renderPanel();
    const notice = screen.getByTestId("invite-pause-notice");
    expect(notice.getAttribute("data-state")).toBe("requested");
    expect(
      within(notice).getByText('admin.ginPauseRequested {"date":"D:2026-10-06"}'),
    ).toBeTruthy();
    expect(within(notice).getByText("admin.ginPauseStillWorks")).toBeTruthy();
    expect(within(notice).queryByRole("button")).toBeNull();
    expect(within(notice).queryByRole("textbox")).toBeNull();
  });

  it("quotes the staff note after a KEEP and offers Ask again", () => {
    setStatus(
      pausedStatus({}, {
        decision: "KEPT",
        decidedAt: new Date("2026-10-06T15:00:00Z"),
        note: "Most of these addresses never bought a ticket.",
      }),
    );
    renderPanel();
    const notice = screen.getByTestId("invite-pause-notice");
    expect(notice.getAttribute("data-state")).toBe("kept");
    expect(within(notice).getByText("admin.ginPauseTitleKept")).toBeTruthy();
    expect(
      within(notice).getByText('admin.ginPauseKeptIntro {"date":"D:2026-10-06"}'),
    ).toBeTruthy();
    const quote = within(notice).getByTestId("invite-pause-staff-note");
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote.textContent).toBe("Most of these addresses never bought a ticket.");
    expect(within(notice).getByRole("button", { name: "admin.ginPauseAskAgain" })).toBeTruthy();
    expect(within(notice).getByTestId("invite-pause-note")).toBeTruthy();
  });

  it("shows the normal panel plus one 'back on' line after a recent lift", () => {
    setStatus({
      ...NOT_PAUSED,
      lastDecision: { decision: "LIFTED", decidedAt: new Date(Date.now() - DAY), note: null },
    });
    renderPanel();
    const line = screen.getByTestId("invite-pause-lifted");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toMatch(/^admin\.ginPauseLifted /);
    expect(screen.queryByTestId("invite-pause-notice")).toBeNull();
    expect(screen.getByTestId("guest-invite-name")).toBeTruthy();
    expect(screen.getByTestId(`guest-invite-resend-${MAYA.id}`)).toBeTruthy();
  });
});

describe("EventGuestInvites when a send races a new pause", () => {
  it("explains a refused send and refetches the status", async () => {
    api.createGuestInvites.mockRejectedValueOnce(pausedError());
    renderPanel();
    fireEvent.change(screen.getByTestId("guest-invite-name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByTestId("guest-invite-email"), {
      target: { value: "ana@example.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("guest-invite-send"));
    });
    expect(screen.getByTestId("guest-invite-send-feedback").textContent).toBe(
      "admin.ginPauseRaced",
    );
    expect(api.statusInvalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it("explains a refused resend on the row and refetches the status", async () => {
    api.resendGuestInvite.mockRejectedValueOnce(pausedError());
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`guest-invite-resend-${MAYA.id}`));
    });
    expect(screen.getByTestId(`guest-invite-feedback-${MAYA.id}`).textContent).toBe(
      "admin.ginPauseRaced",
    );
    expect(api.statusInvalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });
});

describe("EventGuestInvites when a send races a new pause (focus and the list dialog)", () => {
  const panel = (guests: GuestInvite[] = [MAYA]) => (
    <EventGuestInvites eventId={EVENT_ID} owner={OWNER} guests={guests} />
  );

  it("moves focus to the notice title when the pressed Send unmounts", async () => {
    api.createGuestInvites.mockRejectedValueOnce(pausedError());
    const { rerender } = render(panel());
    fireEvent.change(screen.getByTestId("guest-invite-name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByTestId("guest-invite-email"), {
      target: { value: "ana@example.com" },
    });
    const send = screen.getByTestId("guest-invite-send");
    send.focus();
    await act(async () => {
      fireEvent.click(send);
    });
    // The refetched status says paused: the send row unmounts.
    setStatus(pausedStatus());
    rerender(panel());
    expect(screen.queryByTestId("guest-invite-send")).toBeNull();
    expect(document.activeElement?.textContent).toBe("admin.ginPauseTitle");
    expect(screen.getByTestId("guest-invite-send-feedback").textContent).toBe(
      "admin.ginPauseRaced",
    );
  });

  it("explains a refused Invite again on the row, refetches, then focuses the title", async () => {
    api.createGuestInvites.mockRejectedValueOnce(pausedError());
    const revoked = { ...MAYA, status: "REVOKED" as const };
    const { rerender } = render(panel([revoked]));
    const again = screen.getByTestId(`guest-invite-reinvite-${MAYA.id}`);
    again.focus();
    await act(async () => {
      fireEvent.click(again);
    });
    expect(screen.getByTestId(`guest-invite-feedback-${MAYA.id}`).textContent).toBe(
      "admin.ginPauseRaced",
    );
    expect(api.statusInvalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
    setStatus(pausedStatus());
    rerender(panel([revoked]));
    expect(screen.queryByTestId(`guest-invite-reinvite-${MAYA.id}`)).toBeNull();
    expect(document.activeElement?.textContent).toBe("admin.ginPauseTitle");
  });

  it("closes the list dialog on a paused refusal and says it in the panel", async () => {
    api.createGuestInvites.mockRejectedValueOnce(pausedError());
    const { rerender } = render(panel());
    fireEvent.click(screen.getByTestId("guest-invite-list-open"));
    fireEvent.change(screen.getByTestId("guest-invite-list-select"), {
      target: { value: "list-1" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("guest-invite-list-send"));
    });
    expect(api.createGuestInvites).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      contactListId: "list-1",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("guest-invite-list-summary").textContent).toBe(
      "admin.ginPauseRaced",
    );
    // onSent refreshes, which refetches the pause status.
    expect(api.statusInvalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
    setStatus(pausedStatus());
    rerender(panel());
    expect(screen.getByTestId("guest-invite-list-summary").textContent).toBe(
      "admin.ginPauseRaced",
    );
    expect(screen.getByTestId("invite-pause-notice")).toBeTruthy();
  });

  it("does not reopen the list dialog after a pause that closed it is lifted", () => {
    const { rerender } = render(panel());
    fireEvent.click(screen.getByTestId("guest-invite-list-open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // A background refetch says paused: the dialog goes.
    setStatus(pausedStatus());
    rerender(panel());
    expect(screen.queryByRole("dialog")).toBeNull();
    // Staff lift the pause later: the dialog stays shut until asked for.
    setStatus({
      ...NOT_PAUSED,
      lastDecision: { decision: "LIFTED", decidedAt: new Date(Date.now() - DAY), note: null },
    });
    rerender(panel());
    expect(screen.getByTestId("guest-invite-list-open")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus to the panel heading when a stale review request finds the pause ended", async () => {
    setStatus(pausedStatus());
    const { rerender } = render(panel());
    // The refetch lands (and the notice unmounts) before invalidate resolves.
    api.statusInvalidate.mockImplementationOnce(async () => {
      setStatus({
        ...NOT_PAUSED,
        lastDecision: { decision: "LIFTED", decidedAt: new Date(Date.now() - DAY), note: null },
      });
      rerender(panel());
    });
    api.requestReview.mockRejectedValueOnce(
      Object.assign(new Error("invites_not_paused"), {
        data: { code: "CONFLICT", appCode: "INVALID_STATUS", httpStatus: 409 },
      }),
    );
    const ask = screen.getByTestId("invite-pause-request");
    ask.focus();
    await act(async () => {
      fireEvent.click(ask);
    });
    expect(screen.queryByTestId("invite-pause-notice")).toBeNull();
    expect(screen.queryByTestId("invite-pause-request-error")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe("admin.ginGuestsTitle");
  });

  it("moves focus to the panel heading when the refetch lands after invalidate resolves", async () => {
    setStatus(pausedStatus());
    const { rerender } = render(panel());
    api.requestReview.mockRejectedValueOnce(
      Object.assign(new Error("invites_not_paused"), {
        data: { code: "CONFLICT", appCode: "INVALID_STATUS", httpStatus: 409 },
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-request"));
    });
    // Focus sits on the title, then the pause-ended status commits.
    expect(document.activeElement?.textContent).toBe("admin.ginPauseTitle");
    setStatus(NOT_PAUSED);
    // Awaited: the move waits a microtask for the notice to leave the DOM.
    await act(async () => {
      rerender(panel());
    });
    expect(screen.queryByTestId("invite-pause-notice")).toBeNull();
    expect(document.activeElement?.textContent).toBe("admin.ginGuestsTitle");
  });

  it("keeps focus on the title through StrictMode's simulated unmount", async () => {
    // Dev-only: StrictMode mounts, runs the layout cleanup, and remounts the
    // notice. The cleanup must not hand focus to the heading then.
    api.createGuestInvites.mockRejectedValueOnce(pausedError());
    const strict = () => <StrictMode>{panel()}</StrictMode>;
    const { rerender } = render(strict());
    fireEvent.change(screen.getByTestId("guest-invite-name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByTestId("guest-invite-email"), {
      target: { value: "ana@example.com" },
    });
    const send = screen.getByTestId("guest-invite-send");
    send.focus();
    await act(async () => {
      fireEvent.click(send);
    });
    setStatus(pausedStatus());
    await act(async () => {
      rerender(strict());
    });
    expect(document.activeElement?.textContent).toBe("admin.ginPauseTitle");
  });

  it("never renders the list dialog while paused", () => {
    setStatus(pausedStatus());
    render(panel());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("guest-invite-list-open")).toBeNull();
  });
});
